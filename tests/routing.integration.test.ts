/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { DEFAULT_POLICY, type RoutingPolicy } from '../src/core/routing.js';
import { parseBridgeConfig } from '../src/bridge/config.js';
import { BridgeWorker } from '../src/bridge/worker.js';
import type { ToolClient } from '../src/bridge/types.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `collective_test_${randomUUID().replaceAll('-','')}`;
const code = (c:string) => (e:unknown) => e instanceof AppError && e.code === c;

describe('routing policy', {skip:!connectionString,concurrency:false}, () => {
  let control:Pool;
  let pool:Pool;
  let core:CoreService;

  before(async () => {
    control = new pg.Pool({connectionString,max:2});
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const file of ['001_identity.sql','002_core.sql','005_swarm.sql','006_sessions.sql','008_lessons.sql','010_routing_policy.sql','011_patch_routing.sql','012_session_task.sql','013_worker_slots.sql']) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    core = new CoreService(pool);
  });
  after(async () => {
    if (pool) await pool.end();
    if (control) {
      try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await control.end(); }
    }
  });

  const call = async (p:Principal,name:string,args:Record<string,unknown>) => await core.call(p,name,args) as Record<string,any>;
  async function fixture() {
    const tenantId = randomUUID();
    const make = (name:string,role:Principal['role'],extra:Principal['permissions'] = []):Principal => ({id:randomUUID(),tenantId,name,role,scopes:['project:a'],permissions:[...ROLE_PERMISSIONS[role],...extra]});
    const ps = {front:make('dot','frontend'),owner:make('owner-ui','frontend',['routing:manage']),claude:make('w-claude','worker'),codex:make('w-codex','worker'),agy:make('w-agy','worker')};
    for (const p of Object.values(ps)) await pool.query(`INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[p.id,p.tenantId,p.name,p.role,p.scopes,p.permissions,randomUUID()]);
    return ps;
  }
  const policy = (edit:(p:RoutingPolicy) => void):RoutingPolicy => { const p = structuredClone(DEFAULT_POLICY); edit(p); return p; };
  const entry = (p:RoutingPolicy,name:string) => p.providers.find(x => x.provider === name)!;
  const report = (provider:string,five:number,weekly:number) => ({reports:[{provider,ok:true,fetched_at:new Date().toISOString(),
    windows:[{name:'5h',used_percent:five},{name:'weekly',used_percent:weekly}]}]});
  const submit = (key:string,kind='review',capability='auto.read') => ({scope:'project:a',kind,objective:'Look at the project.',idempotency_key:key,required_capability:capability});
  const claim = (w:Principal,capabilities:string[]) => call(w,'task_claim',{scope:'project:a',capabilities});

  it('returns the built-in default until a policy is saved', async () => {
    const {front,claude} = await fixture();
    const got = await call(claude,'routing_get',{});
    assert.deepEqual(got,{policy:DEFAULT_POLICY,is_default:true,updated_at:null,default_policy:DEFAULT_POLICY});
    assert.deepEqual(DEFAULT_POLICY.providers.map(p => [p.provider,p.kinds]),[['claude',['review','research','patch']],['codex',['review','research','patch']],['antigravity',['review','patch']]]);
    assert.equal((await call(front,'swarm_status',{})).routing.is_default,true);
  });

  it('rejects invalid policies and lists the problems', async () => {
    const {owner} = await fixture();
    const bad = async (p:unknown,pattern:RegExp) => await assert.rejects(() => call(owner,'routing_set',{policy:p}),(e:unknown) => code('invalid_policy')(e) && pattern.test((e as AppError).message));
    await bad({providers:[],fallback:'none'},/must include claude.*must include codex.*must include antigravity/);
    await bad({...DEFAULT_POLICY,fallback:'x'},/fallback must be/);
    await bad(policy(p => { entry(p,'claude').max_weekly_pct = 0; }),/max_weekly_pct must be an integer from 1 to 100/);
    await bad(policy(p => { entry(p,'claude').max_five_hour_pct = 90.5; }),/max_five_hour_pct/);
    await bad(policy(p => { entry(p,'claude').kinds = []; }),/kinds must be a non-empty/);
    await bad(policy(p => { (entry(p,'claude').kinds as string[]).push('patch'); }),/kinds must be a non-empty/);
    await bad(policy(p => { p.providers[1]!.provider = 'claude'; }),/listed twice.*must include codex/);
    await bad(policy(p => { (entry(p,'claude') as any).extra = 1; }),/extra is not allowed/);
    await bad(policy(p => { for (const x of p.providers) if (x.provider !== 'claude') x.enabled = false; entry(p,'claude').kinds = ['review']; }),/enabled provider must allow research/);
    assert.equal((await call(owner,'routing_get',{})).is_default,true);
  });

  it('needs routing:manage to set, lets anyone with memory:read get, and audits changes', async () => {
    const {front,owner,claude} = await fixture();
    const next = policy(p => { entry(p,'claude').max_five_hour_pct = 80; });
    await assert.rejects(() => call(front,'routing_set',{policy:next}),code('forbidden'));
    await assert.rejects(() => call(claude,'routing_set',{policy:next}),code('forbidden'));
    assert.ok(!core.listTools(front).some(t => t.name === 'routing_set') && core.listTools(owner).some(t => t.name === 'routing_set'));
    const set = await call(owner,'routing_set',{policy:next});
    assert.deepEqual(set.policy,next);
    const got = await call(claude,'routing_get',{});
    assert.deepEqual([got.policy,got.is_default,got.updated_at],[next,false,set.updated_at]);
    assert.deepEqual(got.default_policy,DEFAULT_POLICY);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND operation='routing.set' AND actor_id=$2`,[owner.tenantId,owner.id])).rows[0].n,1);
  });

  it('walks providers in priority order using the 5-hour and weekly ceilings', async () => {
    const {front,claude,codex} = await fixture();
    await call(codex,'usage_report',report('codex',12,3));
    await call(claude,'usage_report',report('claude',92,10));
    let r = (await call(front,'swarm_status',{})).routing;
    assert.equal(r.by_kind.review.provider,'codex');
    assert.equal(r.recommended,'codex');
    assert.match(r.by_kind.review.reason,/^claude: 5-hour window at 92% ≥ 90% limit → codex \(5-hour 12%, weekly 3%\)$/);
    const task = (await call(front,'task_submit',submit('o1'))).task;
    assert.equal((await claim(claude,['claude.read','auto.read'])).task,null);
    assert.equal((await claim(codex,['codex.read','auto.read'])).task.id,task.id);
    // Weekly ceiling alone also disqualifies.
    await call(claude,'usage_report',report('claude',10,91));
    r = (await call(front,'swarm_status',{})).routing;
    assert.match(r.by_kind.research.reason,/^claude: weekly window at 91% ≥ 90% limit → codex/);
    // Under both ceilings, the first provider in priority order wins even with less headroom.
    await call(claude,'usage_report',report('claude',89,89));
    await call(codex,'usage_report',report('codex',0,0));
    r = (await call(front,'swarm_status',{})).routing;
    assert.equal(r.by_kind.review.provider,'claude');
  });

  it('honours a reordered priority and lowered ceilings', async () => {
    const {owner,front,claude,codex} = await fixture();
    await call(owner,'routing_set',{policy:policy(p => { p.providers.reverse(); entry(p,'codex').max_five_hour_pct = 50; })});
    await call(claude,'usage_report',report('claude',10,10));
    await call(codex,'usage_report',report('codex',40,10));
    assert.equal((await call(front,'swarm_status',{})).routing.by_kind.research.provider,'codex');
    await call(codex,'usage_report',report('codex',50,10));
    assert.equal((await call(front,'swarm_status',{})).routing.by_kind.research.provider,'claude');
  });

  it('never routes research to antigravity, but may route review to it', async () => {
    const {owner,front,claude,codex,agy} = await fixture();
    await call(owner,'routing_set',{policy:policy(p => { p.providers = [entry(p,'antigravity'),entry(p,'claude'),entry(p,'codex')]; })});
    await call(agy,'usage_report',report('antigravity',1,1));
    await call(claude,'usage_report',report('claude',95,10));
    await call(codex,'usage_report',report('codex',96,10));
    const by = (await call(front,'swarm_status',{})).routing.by_kind;
    assert.equal(by.review.provider,'antigravity');
    assert.notEqual(by.research.provider,'antigravity');
    assert.equal(by.research.provider,'claude');
    const research = (await call(front,'task_submit',submit('r1','research'))).task;
    const review = (await call(front,'task_submit',submit('r2','review'))).task;
    const agyCaps = ['antigravity.read','auto.read'];
    assert.equal((await claim(agy,agyCaps)).task.id,review.id);
    assert.equal((await claim(agy,agyCaps)).task,null);
    assert.equal((await claim(codex,['codex.read','auto.read'])).task,null);
    assert.equal((await claim(claude,['claude.read','auto.read'])).task.id,research.id);
  });

  it('skips disabled providers for routing, submission and claiming', async () => {
    const {owner,front,claude,codex} = await fixture();
    const queued = (await call(front,'task_submit',submit('d0','review','claude.read'))).task;
    await call(owner,'routing_set',{policy:policy(p => { entry(p,'claude').enabled = false; })});
    await call(claude,'usage_report',report('claude',1,1));
    await call(codex,'usage_report',report('codex',60,60));
    assert.equal((await call(front,'swarm_status',{})).routing.by_kind.review.provider,'codex');
    await assert.rejects(() => call(front,'task_submit',submit('d1','review','claude.read')),code('provider_disabled'));
    // Already-queued explicit work is not run by a disabled provider.
    assert.equal((await claim(claude,['claude.read'])).task,null);
    const auto = (await call(front,'task_submit',submit('d2'))).task;
    assert.equal((await claim(claude,['claude.read','auto.read'])).task,null);
    assert.equal((await claim(codex,['codex.read','auto.read'])).task.id,auto.id);
    await call(owner,'routing_set',{policy:policy(() => {})});
    assert.equal((await claim(claude,['claude.read'])).task.id,queued.id);
  });

  it('applies fallback most_headroom or none when every provider is over its ceiling', async () => {
    const {owner,front,claude,codex} = await fixture();
    await call(claude,'usage_report',report('claude',99,20));
    await call(codex,'usage_report',report('codex',97,20));
    let by = (await call(front,'swarm_status',{})).routing.by_kind;
    assert.equal(by.review.provider,'codex');
    assert.match(by.review.reason,/ → codex by most headroom \(5-hour 97%, weekly 20%\)$/);
    const task = (await call(front,'task_submit',submit('f1'))).task;
    assert.equal((await claim(claude,['claude.read','auto.read'])).task,null);
    assert.equal((await claim(codex,['codex.read','auto.read'])).task.id,task.id);
    await call(owner,'routing_set',{policy:policy(p => { p.fallback = 'none'; })});
    by = (await call(front,'swarm_status',{})).routing.by_kind;
    assert.equal(by.review.provider,null);
    assert.match(by.review.reason,/fallback is none/);
    await call(front,'task_submit',submit('f2'));
    assert.equal((await claim(claude,['claude.read','auto.read'])).task,null);
    assert.equal((await claim(codex,['codex.read','auto.read'])).task,null);
  });

  it('lets any enabled worker that allows the kind claim when there are no fresh readings', async () => {
    const {front,claude,agy} = await fixture();
    const research = (await call(front,'task_submit',submit('n1','research'))).task;
    const review = (await call(front,'task_submit',submit('n2','review'))).task;
    const agyCaps = ['antigravity.read','auto.read'];
    assert.equal((await claim(agy,agyCaps)).task.id,review.id);
    assert.equal((await claim(agy,agyCaps)).task,null);
    assert.equal((await claim(claude,['claude.read','auto.read'])).task.id,research.id);
    assert.match((await call(front,'swarm_status',{})).routing.by_kind.review.reason,/^No fresh quota reading/);
  });

  it('rejects explicit capabilities the policy does not allow and refuses to claim them', async () => {
    const {front,owner,agy} = await fixture();
    await assert.rejects(() => call(front,'task_submit',submit('x1','research','antigravity.read')),(e:unknown) => code('kind_not_allowed')(e)
      && (e as AppError).message === 'Antigravity takes review and in-project edit tasks, not research (it cannot reach outside the project). Use auto.read or codex.read for research.');
    const ok = (await call(front,'task_submit',submit('x2','review','antigravity.read'))).task;
    assert.equal((await claim(agy,['antigravity.read'])).task.id,ok.id);
    await call(owner,'routing_set',{policy:policy(p => { entry(p,'codex').kinds = ['review']; })});
    await assert.rejects(() => call(front,'task_submit',submit('x3','research','codex.read')),code('kind_not_allowed'));
  });

  it('skips queued explicit work whose kind was removed from the provider', async () => {
    const {front,owner,codex} = await fixture();
    const queued = (await call(front,'task_submit',submit('s1','research','codex.read'))).task;
    await call(owner,'routing_set',{policy:policy(p => { entry(p,'codex').kinds = ['review']; })});
    assert.equal((await claim(codex,['codex.read'])).task,null);
    await call(owner,'routing_set',{policy:policy(() => {})});
    assert.equal((await claim(codex,['codex.read'])).task.id,queued.id);
  });
  it('routes auto.patch to the decided provider and accepts <provider>.patch', async () => {
    const {front,claude,codex,agy} = await fixture();
    await call(claude,'usage_report',report('claude',95,10));
    await call(codex,'usage_report',report('codex',10,10));
    const task = (await call(front,'task_submit',{...submit('p1','patch','auto.patch'),objective:'Edit it.'})).task;
    assert.equal(task.resource_key,null);
    const args = (w:Principal,caps:string[]) => call(w,'task_claim',{scope:'project:a',capabilities:caps,kinds:['patch']});
    for (const w of [claude,codex,agy]) w.permissions.push('task:patch');
    assert.equal((await args(claude,['claude.read','claude.patch','auto.read','auto.patch'])).task,null);
    const got = await args(codex,['codex.read','codex.patch','auto.read','auto.patch']);
    assert.equal(got.task.id,task.id);
    assert.equal((await call(front,'swarm_status',{})).routing.by_kind.patch.provider,'codex');
    const fin = {branch:'swarma/codex/x',base_ref:'main',base_commit:'a'.repeat(40),head_commit:null,changed_files:2,diffstat:' a | 1 +',commands_allowed:true};
    const done = await call(codex,'task_finish',{task_id:task.id,lease_token:got.lease_token,lease_generation:got.lease_generation,outcome:'completed',result:fin});
    assert.deepEqual(done.task.result,fin);
    await call(front,'task_submit',{...submit('p2','patch','antigravity.patch'),objective:'Edit it.'});
    await assert.rejects(() => call(front,'task_submit',submit('p3','research','antigravity.patch')),code('invalid_arguments'));
    await assert.rejects(() => call(front,'task_submit',submit('p4','research','antigravity.read')),code('kind_not_allowed'));
    await assert.rejects(() => call(front,'task_submit',submit('p5','patch','auto.read')),code('invalid_arguments'));
    await assert.rejects(() => call(front,'task_submit',submit('p6','review','auto.patch')),code('invalid_arguments'));
    await assert.rejects(() => call(codex,'task_finish',{task_id:task.id,lease_token:'x',lease_generation:1,outcome:'completed',result:{changed_files:'2'}}),code('invalid_arguments'));
  });

  it('stores and returns base_ref and rejects malformed or non-patch values', async () => {
    const {front,codex} = await fixture();
    const sub = (key:string,extra:Record<string,unknown>) => ({...submit(key,'patch','codex.patch'),...extra});
    const t = (await call(front,'task_submit',sub('b1',{base_ref:'feature/x-1.0',resource_key:'repo:a'}))).task;
    assert.equal(t.base_ref,'feature/x-1.0');
    codex.permissions.push('task:patch');
    const got = await call(codex,'task_claim',{scope:'project:a',capabilities:['codex.patch'],kinds:['patch']});
    assert.equal(got.task.base_ref,'feature/x-1.0');
    assert.equal((await call(front,'task_get',{task_id:t.id})).task.base_ref,'feature/x-1.0');
    for (const [i,bad] of ['-rf','a..b','a b','x'.repeat(201)].entries()) await assert.rejects(() => call(front,'task_submit',sub(`b-bad${i}`,{base_ref:bad})),code('invalid_arguments'));
    await assert.rejects(() => call(front,'task_submit',{...submit('b2','review'),base_ref:'main'}),code('invalid_arguments'));
  });

  it('adds patch to a saved policy that predates it', async () => {
    const {owner,front} = await fixture();
    const old = structuredClone(DEFAULT_POLICY);
    for (const p of old.providers) p.kinds = p.kinds.filter(k => k !== 'patch');
    await pool.query('INSERT INTO routing_policies(tenant_id,policy,updated_by) VALUES($1,$2::jsonb,$3)',[owner.tenantId,JSON.stringify(old),owner.id]);
    // Reads never rewrite a stored policy; the SQL migration upgrades existing rows once.
    assert.deepEqual((await call(front,'routing_get',{})).policy.providers.map((p:any) => p.kinds),old.providers.map(p => p.kinds));
    await pool.query(await readFile(new URL('../db/migrations/011_patch_routing.sql',import.meta.url),'utf8').then(sql => sql.split('UPDATE routing_policies').slice(1).map(x => 'UPDATE routing_policies'+x).join('\n')));
    const row = await pool.query('SELECT policy FROM routing_policies WHERE tenant_id=$1',[owner.tenantId]);
    assert.deepEqual(row.rows[0].policy.providers.map((p:any) => p.kinds),DEFAULT_POLICY.providers.map(p => p.kinds));
  });

  it('keeps an owner-removed patch kind: get round-trips, explicit submit and auto claim honour it', async () => {
    const {owner,front,claude} = await fixture();
    claude.permissions.push('task:patch');
    const pol = policy(p => { entry(p,'claude').kinds = ['review','research']; });
    await call(owner,'routing_set',{policy:pol});
    assert.deepEqual((await call(front,'routing_get',{})).policy,pol);
    await assert.rejects(() => call(front,'task_submit',{...submit('np1','patch','claude.patch'),objective:'Edit it.'}),code('kind_not_allowed'));
    await call(front,'task_submit',{...submit('np2','patch','auto.patch'),objective:'Edit it.'});
    const got = await call(claude,'task_claim',{scope:'project:a',capabilities:['claude.read','claude.patch','auto.read','auto.patch'],kinds:['patch']});
    assert.equal(got.task,null);
  });

  describe('router decision binds bridge execution', () => {
    const bridge = (w:Principal) => {
      const calls:string[] = [];
      const client:ToolClient = {call:async <T,>(name:string,args:Record<string,unknown>) => { calls.push(name); return await core.call(w,name,args) as T; }};
      const cfg = parseBridgeConfig({service_url:'http://localhost:8080',
        agents:[{id:'codex',provider:'codex',binary:'/bin/codex',sandbox:false},{id:'claude',provider:'claude',binary:'/bin/claude',sandbox:false}],
        projects:[{scope:'project:a',root:'/projects/a',agents:['codex','claude']}]});
      const ran:string[] = [];
      const res = {exit_code:0,signal:null,stdout:'{"type":"turn.completed"}',stderr:'',duration_ms:1,stop_reason:null};
      const worker = new BridgeWorker(cfg,client,() => {},async r => { ran.push(r.command); return res; },async () => []);
      return {ran,run:() => worker.claimAndRun(cfg.projects[0]!,new AbortController().signal)};
    };

    it('never runs a disabled provider on auto.read', async () => {
      const {owner,front,claude} = await fixture();
      await call(owner,'routing_set',{policy:policy(p => { entry(p,'codex').enabled = false; })});
      const t = (await call(front,'task_submit',submit('br1'))).task;
      const b = bridge(claude);
      assert.equal(await b.run(),true);
      assert.deepEqual(b.ran,['/bin/claude']);
      assert.equal((await call(front,'task_get',{task_id:t.id})).task.result.provider,'claude');
    });

    it('runs codex when claude is over its quota ceiling', async () => {
      const {owner,front,claude} = await fixture();
      await call(owner,'routing_set',{policy:policy(() => {})});
      await call(claude,'usage_report',{reports:[report('claude',95,10).reports[0],report('codex',10,10).reports[0]]});
      const t = (await call(front,'task_submit',submit('br2'))).task;
      const b = bridge(claude);
      assert.equal(await b.run(),true);
      assert.deepEqual(b.ran,['/bin/codex']);
      assert.equal((await call(front,'task_get',{task_id:t.id})).task.result.provider,'codex');
    });
  });
});
