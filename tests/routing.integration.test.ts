/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { DEFAULT_POLICY, type RoutingPolicy } from '../src/core/routing.js';
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
    for (const file of ['001_identity.sql','002_core.sql','005_swarm.sql','006_sessions.sql','008_lessons.sql','010_routing_policy.sql']) {
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
    assert.deepEqual(DEFAULT_POLICY.providers.map(p => [p.provider,p.kinds]),[['claude',['review','research']],['codex',['review','research']],['antigravity',['review']]]);
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
      && (e as AppError).message === 'Antigravity takes review tasks only (it cannot run commands or reach outside the project). Use auto.read or codex.read.');
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
});
