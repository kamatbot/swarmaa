/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `collective_test_${randomUUID().replaceAll('-','')}`;
describe('swarm usage routing and status', {skip:!connectionString,concurrency:false}, () => {
  let control:Pool;
  let pool:Pool;
  let core:CoreService;

  before(async () => {
    control = new pg.Pool({connectionString,max:2});
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const file of ['001_identity.sql','002_core.sql','005_swarm.sql','006_sessions.sql','008_lessons.sql','010_routing_policy.sql','011_patch_routing.sql','012_session_task.sql','013_worker_slots.sql','016_worker_slots_drain.sql','019_inbox.sql','020_inbox_receipts.sql','018_events_xid.sql']) {
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
    const make = (name:string,role:Principal['role'],scopes:string[]):Principal => ({id:randomUUID(),tenantId,name,role,scopes,permissions:[...ROLE_PERMISSIONS[role]]});
    const ps = {front:make('dot','frontend',['project:a']),claude:make('worker-claude','worker',['project:a']),
      codex:make('worker-codex','worker',['project:a']),outsider:make('grok-b','frontend',['project:b'])};
    for (const p of Object.values(ps)) await pool.query(`INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[p.id,p.tenantId,p.name,p.role,p.scopes,p.permissions,randomUUID()]);
    return ps;
  }
  const report = (provider:string,used:number) => ({reports:[{provider,ok:true,fetched_at:new Date().toISOString(),
    windows:[{name:'5h',used_percent:used,resets_at:new Date(Date.now()+3600e3).toISOString()}]}]});
  const submit = (key:string,kind='review') => ({scope:'project:a',kind,objective:'Review the project.',idempotency_key:key,required_capability:'auto.read'});

  it('routes auto.read to the live provider with most headroom', async () => {
    const {front,claude,codex} = await fixture();
    await call(claude,'usage_report',report('claude',90));
    await call(codex,'usage_report',report('codex',20));
    const task = (await call(front,'task_submit',submit('k1'))).task;
    assert.equal((await call(claude,'task_claim',{scope:'project:a',capabilities:['claude.read','auto.read']})).task,null);
    assert.equal((await call(codex,'task_claim',{scope:'project:a',capabilities:['codex.read','auto.read']})).task.id,task.id);
  });

  it('falls back to any worker when the best provider has no live worker', async () => {
    const {front,claude,codex} = await fixture();
    await call(claude,'usage_report',report('claude',90));
    await call(codex,'usage_report',report('codex',20));
    await pool.query(`UPDATE principals SET last_seen_at=now()-interval '5 minutes' WHERE id=$1`,[codex.id]);
    const task = (await call(front,'task_submit',submit('k2'))).task;
    assert.equal((await call(claude,'task_claim',{scope:'project:a',capabilities:['claude.read','auto.read']})).task.id,task.id);
  });

  it('rejects auto-routed patches and usage reports from non-workers', async () => {
    const {front} = await fixture();
    await assert.rejects(() => call(front,'task_submit',{...submit('k3','patch'),resource_key:'repo'}),(e:unknown) => e instanceof AppError && e.code === 'invalid_arguments');
    await assert.rejects(() => call(front,'usage_report',report('claude',10)),(e:unknown) => e instanceof AppError && e.code === 'forbidden');
  });

  it('swarm_status shows scoped workers, usage and counts without leaking other scopes', async () => {
    const {front,claude,codex,outsider} = await fixture();
    await call(claude,'usage_report',report('claude',40));
    await call(codex,'usage_report',report('codex',70));
    await call(front,'task_submit',submit('k4'));
    const status = await call(front,'swarm_status',{});
    assert.deepEqual(status.workers.map((w:any) => [w.name,w.live]),[['worker-claude',true],['worker-codex',true]]);
    assert.deepEqual(status.usage.map((u:any) => [u.provider,u.headroom]),[['claude',60],['codex',30]]);
    assert.equal(status.usage[0].windows[0].name,'5h');
    assert.deepEqual(status.scopes,[{scope:'project:a',queued:1,running:0,blocked:0,completed_24h:0,failed_24h:0}]);
    const hidden = await call(outsider,'swarm_status',{});
    assert.deepEqual([hidden.workers,hidden.recent],[[],[]]);
    assert.deepEqual(hidden.scopes,[{scope:'project:b',queued:0,running:0,blocked:0,completed_24h:0,failed_24h:0}]);
    await assert.rejects(() => call(outsider,'swarm_status',{scope:'project:a'}),(e:unknown) => e instanceof AppError && e.code === 'scope_forbidden');
  });

  it('task_submit warns when no live worker serves the project, and not once one does', async () => {
    const {front,claude} = await fixture();
    await pool.query(`UPDATE principals SET last_seen_at=NULL WHERE role='worker'`);
    const lonely = await call(front,'task_submit',submit('k-warn-1'));
    assert.match(lonely.warning,/No live worker serves project:a/);
    await call(claude,'usage_report',report('claude',10));
    const served = await call(front,'task_submit',submit('k-warn-2'));
    assert.equal(served.warning,undefined);
    assert.match(served.message,/^Swarm started: task [0-9a-f]{8} is queued in project:a\. 1 live worker with 1 free slot serve it, so it should start within seconds\./);
  });

  it('a draining worker reports zero slots and stays live with no negative free slots', async () => {
    const {front,claude} = await fixture();
    await call(claude,'usage_report',{...report('claude',10),slots:2});
    await call(front,'task_submit',submit('k-draining'));
    await call(claude,'task_claim',{scope:'project:a',capabilities:['claude.read','auto.read']});
    await call(claude,'usage_report',{reports:[],slots:0});
    const worker = (await call(front,'swarm_status',{})).workers.find((w:any) => w.name === 'worker-claude');
    assert.equal(worker.live,true);
    assert.equal(worker.slots,0);
    assert.equal(worker.running.length,1);
    assert.equal(worker.free_slots,0);
  });

  it('swarm_status describes running tasks and the branch a finished task landed on', async () => {
    const {front,claude} = await fixture();
    const task = (await call(front,'task_submit',submit('k-act'))).task;
    const claim = await call(claude,'task_claim',{scope:'project:a',capabilities:['claude.read','auto.read']});
    const running = (await call(front,'swarm_status',{})).workers.find((w:any) => w.name === 'worker-claude').running[0];
    assert.deepEqual([running.task_id,running.kind,running.objective,running.required_capability,typeof running.started_at],[task.id,task.kind,task.objective.slice(0,140),task.required_capability,'string']);
    // The bridge checkpoints after every heartbeat, bumping updated_at; started_at stays the attempt's start.
    await new Promise(r => setTimeout(r,50));
    await call(claude,'task_checkpoint',{task_id:task.id,lease_token:claim.lease_token,lease_generation:claim.lease_generation,checkpoint:{phase:'running'}});
    const after = (await call(front,'swarm_status',{})).workers.find((w:any) => w.name === 'worker-claude').running[0];
    assert.equal(after.started_at,running.started_at);
    assert.ok(Date.parse((await call(front,'task_get',{task_id:task.id})).task.updated_at) > Date.parse(running.started_at));
    await call(claude,'task_finish',{task_id:task.id,lease_token:claim.lease_token,lease_generation:claim.lease_generation,outcome:'completed',result:{provider:'claude',branch:'swarma/claude/abc12345',changed_files:2}});
    const recent = (await call(front,'swarm_status',{})).recent.find((r:any) => r.id === task.id);
    assert.deepEqual([recent.provider,recent.branch,recent.changed_files],['claude','swarma/claude/abc12345',2]);
  });

  it('lets workers tag a chat with a task in its scope; frontends and cross-scope tasks are refused', async () => {
    const {front,claude} = await fixture();
    const task = (await call(front,'task_submit',submit('k-sess'))).task;
    const turns = [{role:'user',text:'Review the project.'}];
    const rec = {harness:'claude-code',session_id:`swarm:${task.id}`,scope:'project:a',turns,task_id:task.id};
    await assert.rejects(() => call(front,'session_record',rec),(e:unknown) => e instanceof AppError && e.code === 'worker_required');
    await assert.rejects(() => call(claude,'session_record',{...rec,task_id:randomUUID()}),(e:unknown) => e instanceof AppError && e.code === 'invalid_arguments');
    await pool.query(`UPDATE tasks SET scope='project:b' WHERE id=$1`,[task.id]);
    await assert.rejects(() => call(claude,'session_record',rec),(e:unknown) => e instanceof AppError && e.code === 'invalid_arguments');
    await pool.query(`UPDATE tasks SET scope='project:a' WHERE id=$1`,[task.id]);
    assert.equal((await call(claude,'session_record',rec)).session.task_id,task.id);
    await call(front,'session_record',{harness:'codex',session_id:'plain',scope:'project:a',turns});
    const listed = await call(front,'session_list',{});
    assert.deepEqual(listed.sessions.map((s:any) => [s.session_id,s.task_id]).sort(),[['plain',null],[`swarm:${task.id}`,task.id]].sort());
    assert.equal((await call(front,'session_get',{id:listed.sessions.find((s:any) => s.task_id).id})).session.task_id,task.id);
    // swarm_only / task_id filters and session_get by task_id
    assert.deepEqual((await call(front,'session_list',{swarm_only:true})).sessions.map((s:any) => s.task_id),[task.id]);
    assert.deepEqual((await call(front,'session_list',{task_id:task.id})).sessions.map((s:any) => s.session_id),[`swarm:${task.id}`]);
    assert.deepEqual((await call(front,'session_list',{task_id:randomUUID()})).sessions,[]);
    assert.equal((await call(front,'session_get',{task_id:task.id})).session.session_id,`swarm:${task.id}`);
    assert.equal((await call(front,'session_get',{task_id:task.id,harness:'claude-code'})).session.task_id,task.id);
    for (const bad of [{}, {id:listed.sessions[0].id,task_id:task.id}, {id:listed.sessions[0].id,harness:'codex'}])
      await assert.rejects(() => call(front,'session_get',bad),(e:unknown) => e instanceof AppError && e.code === 'invalid_arguments');
    for (const miss of [{task_id:task.id,harness:'codex'},{task_id:randomUUID()}])
      await assert.rejects(() => call(front,'session_get',miss),(e:unknown) => e instanceof AppError && e.code === 'not_found');
  });

  it('records chats per harness, lists them across harnesses and keeps other identities out', async () => {
    const {front,claude,outsider} = await fixture();
    const turns = [{role:'user',text:'Fix the login redirect'},{role:'assistant',text:'Patched the callback URL check.'}];
    const rec = await call(front,'session_record',{harness:'claude-code',session_id:'s-1',scope:'project:a',cwd:'/x',turns});
    assert.equal(rec.session.title,'Fix the login redirect');
    assert.equal(rec.session.active,true);
    await call(front,'session_record',{harness:'claude-code',session_id:'s-1',scope:'project:a',turns:[...turns,{role:'user',text:'Thanks'}],ended:true});
    const listed = await call(front,'session_list',{harness:'claude-code'});
    assert.deepEqual(listed.sessions.map((s:any) => [s.session_id,s.turn_count,s.last_text,s.ended,s.active]),[['s-1',3,'Thanks',true,false]]);
    const got = await call(front,'session_get',{id:listed.sessions[0].id});
    assert.equal(got.session.turns.length,3);
    await assert.rejects(() => call(claude,'session_record',{harness:'claude-code',session_id:'s-1',scope:'project:a',turns}),(e:unknown) => e instanceof AppError && e.code === 'forbidden');
    await assert.rejects(() => call(outsider,'session_get',{id:listed.sessions[0].id}),(e:unknown) => e instanceof AppError && e.code === 'not_found');
    assert.deepEqual((await call(outsider,'session_list',{})).sessions,[]);
    await assert.rejects(() => call(outsider,'session_record',{harness:'codex',session_id:'s-2',scope:'project:a',turns}),(e:unknown) => e instanceof AppError && e.code === 'scope_forbidden');
  });

  it('swarm_status explains routing and shows active chats', async () => {
    const {front,claude,codex} = await fixture();
    await call(claude,'usage_report',report('claude',95));
    await call(codex,'usage_report',report('codex',10));
    await call(front,'session_record',{harness:'codex',session_id:'c-1',scope:'project:a',turns:[{role:'user',text:'Review auth'}]});
    const status = await call(front,'swarm_status',{});
    assert.equal(status.routing.recommended,'codex');
    assert.match(status.routing.reason,/^claude: 5-hour window at 95% ≥ 90% limit → codex \(5-hour 10%, weekly 10%\)$/);
    assert.deepEqual(status.sessions.map((s:any) => [s.harness,s.title]),[['codex','Review auth']]);
  });
});
