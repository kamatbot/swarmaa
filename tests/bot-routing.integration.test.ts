import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, {type Pool} from 'pg';
import { CoreService } from '../src/core/index.js';
import { tickBotSchedules } from '../src/core/bot-routing.js';
import { DEFAULT_POLICY } from '../src/core/routing.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';
const connectionString = process.env.TEST_DATABASE_URL;
describe('B2 bot routing', {skip:!connectionString,concurrency:false}, () => {
  const schema = `bots_b2_${randomUUID().replaceAll('-','')}`;
  let control:Pool, pool:Pool, core:CoreService;
  before(async () => {
    control = new pg.Pool({connectionString,max:1});
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({connectionString,max:8,options:`-c search_path=${schema},public`});
    for (const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    core = new CoreService(pool);
  });
  after(async () => {await pool?.end();if (control) {await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();}});
  const call = async(p:Principal,name:string,args:Record<string,unknown>={}) => core.call(p,name,args) as Promise<any>;
  async function fixture(rules:Record<string,unknown>={},routing:Record<string,unknown>={}) {
    const tenantId = randomUUID();
    const make = (name:string,role:Principal['role']):Principal => ({id:randomUUID(),tenantId,name,role,scopes:['project:a'],permissions:[...ROLE_PERMISSIONS[role],'task:patch',...(role==='frontend' ? ['routing:manage' as const] : [])]});
    const user = make('owner','frontend'), worker = make('worker','worker');
    for (const p of [user,worker]) await pool.query('INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash,last_seen_at,worker_slots) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),10)',[p.id,p.tenantId,p.name,p.role,p.scopes,p.permissions,randomUUID()]);
    const agent = randomUUID(),thread = randomUUID(),bot = randomUUID();
    await pool.query(`INSERT INTO agents(id,tenant_id,scope,name,role,instructions,runner,created_by) VALUES($1,$2,'project:a','Lead','Lead','','{"mode":"auto"}',$3)`,[agent,tenantId,user.id]);
    await pool.query(`INSERT INTO threads(id,tenant_id,scope,kind,lead_agent_id) VALUES($1,$2,'project:a','bot',$3)`,[thread,tenantId,agent]);
    await pool.query('INSERT INTO thread_members(thread_id,agent_id,tenant_id) VALUES($1,$2,$3)',[thread,agent,tenantId]);
    await pool.query(`INSERT INTO bots(id,tenant_id,scope,name,job,thread_id,lead_agent_id,rules,routing,created_by) VALUES($1,$2,'project:a','Test bot','Do the job',$3,$4,$5,$6,$7)`,[bot,tenantId,thread,agent,JSON.stringify(rules),JSON.stringify(routing),user.id]);
    return {user,worker,bot,thread,agent};
  }
  async function report(w:Principal,claude:number,codex:number) {
    await call(w,'usage_report',{slots:10,reports:['claude','codex','antigravity'].map((provider,i) => ({provider,ok:true,fetched_at:new Date().toISOString(),windows:[{name:'5h',used_percent:[claude,codex,99][i]},{name:'weekly',used_percent:0}]}))});
  }
  async function submit(f:Awaited<ReturnType<typeof fixture>>,kind='review',bot=true) {
    const {task} = await call(f.user,'task_submit',{scope:'project:a',kind,objective:'Implement the bot objective',idempotency_key:randomUUID(),required_capability:kind==='patch' ? 'auto.patch' : 'auto.read',...(kind==='patch' ? {resource_key:randomUUID()} : {})});
    if (bot) await pool.query('UPDATE tasks SET bot_id=$2 WHERE id=$1',[task.id,f.bot]);
    return task;
  }
  const claim = (w:Principal,caps=['auto.read','claude.read','codex.read'],kinds=['review','research']) => call(w,'task_claim',{scope:'project:a',capabilities:caps,kinds});
  const editResult = {head_commit:'a'.repeat(40),base_commit:'b'.repeat(40),branch:'swarmaa/claude/edit',served:{provider:'claude'}};
  async function finishEdit(f:Awaited<ReturnType<typeof fixture>>) {
    await submit(f,'patch');
    const lease = await claim(f.worker,['auto.patch','claude.patch'],['patch']);
    assert.ok(lease.task);
    const args = {task_id:lease.task.id,lease_token:lease.lease_token,lease_generation:lease.lease_generation,outcome:'completed',result:editResult};
    await call(f.worker,'task_finish',args);
    return {args,id:lease.task.id};
  }
  it('floor skips a low provider only for bot tasks and claim proceeds to next queued task',async () => {
    const f = await fixture({quota_floor_pct:15});await report(f.worker,86,20);
    const botTask = await submit(f),normal = await submit(f,'review',false);
    const c = await claim(f.worker,['auto.read','claude.read']);
    assert.equal(c.task.id,normal.id);assert.equal(c.route.provider,'claude');
    const b = await claim(f.worker,['auto.read','codex.read']);assert.equal(b.task.id,botTask.id);assert.equal(b.route.provider,'codex');assert.ok(!b.route.allowed.includes('claude'));
  });
  it('zero floor permits 99 percent use and routes exactly like a non-bot task, global fallback included',async () => {
    const f = await fixture({quota_floor_pct:0});await report(f.worker,99,99);
    const policy = structuredClone(DEFAULT_POLICY);policy.providers.forEach(p => {p.max_five_hour_pct=100;p.max_weekly_pct=100;});
    await call(f.user,'routing_set',{policy});await submit(f);assert.equal((await claim(f.worker)).route.provider,'claude');
    // Over the global maxima, most_headroom still places a plain auto task; a floor-0 bot task must not wait forever.
    await call(f.user,'routing_set',{policy:DEFAULT_POLICY});
    await submit(f,'review',false);const plain=await claim(f.worker);assert.ok(plain.task,'most_headroom places the plain task');
    await submit(f);const bot=await claim(f.worker);assert.ok(bot.task,'and the floor-0 bot task too');
    assert.equal(bot.route?.provider ?? null,plain.route?.provider ?? null);
  });
  it('named runners bypass the bot floor while preserving enabled-kind policy',async () => {
    const f=await fixture({quota_floor_pct:50});await report(f.worker,99,99);
    const task=await submit(f);await pool.query("UPDATE tasks SET required_capability='claude.read' WHERE id=$1",[task.id]);
    assert.equal((await claim(f.worker,['claude.read'])).task.id,task.id);
  });
  it('bot edit queues one review excluding author; completion replay is idempotent',async () => {
    const f = await fixture();const e = await finishEdit(f);await call(f.worker,'task_finish',e.args);
    const rows = (await pool.query(`SELECT * FROM tasks WHERE bot_id=$1 AND kind='review'`,[f.bot])).rows;
    assert.equal(rows.length,1);assert.deepEqual(rows[0].excluded_providers,['claude']);assert.equal(rows[0].base_ref,editResult.branch);assert.equal(rows[0].initiator_kind,'bot_check');assert.equal(rows[0].required_capability,'auto.read');assert.match(rows[0].objective,/Implement the bot objective/);
    const r = await claim(f.worker,['auto.read','codex.read']);assert.equal(r.task.id,rows[0].id);assert.equal(r.route.provider,null);assert.ok(!r.route.allowed.includes('claude'));
  });
  it('review_edits false queues none and no different enabled reviewer posts a notice',async () => {
    const f = await fixture({review_edits:false});await finishEdit(f);assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE bot_id=$1 AND kind='review'`,[f.bot])).rowCount,0);
    const g = await fixture();const policy=structuredClone(DEFAULT_POLICY);policy.providers.forEach(p => {if(p.provider!=='claude') p.enabled=false;});await call(g.user,'routing_set',{policy});await finishEdit(g);
    assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE bot_id=$1 AND kind='review'`,[g.bot])).rowCount,0);assert.match((await pool.query('SELECT body FROM messages WHERE thread_id=$1',[g.thread])).rows[0].body,/no different provider/);
  });
  for (const passed of [true,false]) it(`require_tests queues an idempotent pinned tests_pass check; ${passed ? 'pass' : 'failure'} lands on edit result.check`,async () => {
    const f=await fixture({require_tests:true,review_edits:false}),e=await finishEdit(f);await call(f.worker,'task_finish',e.args);
    assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE bot_id=$1 AND kind='check'`,[f.bot])).rowCount,1);
    const c=await claim(f.worker,['bridge.check','codex.patch'],['check']);assert.ok(c.task);assert.equal(c.task.flow.check.type,'tests_pass');assert.equal(c.task.flow.commit,editResult.head_commit);assert.equal(c.task.initiator_kind,'bot_check');
    const fact={type:'tests_pass',commit:editResult.head_commit,base_commit:editResult.base_commit,passed,exit_code:passed ? 0 : 1,stop_reason:null,output_tail:'tests',duration_ms:1};
    const args={task_id:c.task.id,lease_token:c.lease_token,lease_generation:c.lease_generation,outcome:passed ? 'completed' : 'blocked',result:{observed_commit:editResult.head_commit,served:{provider:'bridge'},tests_run_by_bridge:true,check:fact}};
    if(passed) await assert.rejects(call(f.worker,'task_finish',{...args,result:{...args.result,tests_run_by_bridge:false}}),/passing deterministic bridge check/);
    await call(f.worker,'task_finish',args);await call(f.worker,'task_finish',args);
    assert.deepEqual((await call(f.user,'task_get',{task_id:e.id})).task.result.check,{status:passed ? 'passed':'failed',task_id:c.task.id});
  });
  it('bot_routing_preview returns all kinds and enforces permission tenant and exact scope isolation',async () => {
    const f=await fixture();await report(f.worker,20,30);const r=await call(f.user,'bot_routing_preview',{bot_id:f.bot});assert.deepEqual(Object.keys(r).sort(),['patch','research','review','summary']);assert.equal(r.research.provider_now,'claude');for(const v of Object.values(r) as any[]) {assert.ok(v.runner);assert.equal(typeof v.reason,'string');}
    await assert.rejects(call({...f.user,tenantId:randomUUID()},'bot_routing_preview',{bot_id:f.bot}),/not found/i);
    await assert.rejects(call({...f.user,scopes:['project:other']},'bot_routing_preview',{bot_id:f.bot}),/not found/i);
    await assert.rejects(call({...f.user,permissions:[]},'bot_routing_preview',{bot_id:f.bot}),/agent:read/i);
    await assert.rejects(call(f.user,'bot_routing_preview',{bot_id:f.bot,extra:true}),/Unknown argument/);
  });
  it('a schedule that never fires is paused with a notice and does not stop other bots',async () => {
    const bad=await fixture(),good=await fixture();
    await pool.query(`UPDATE bots SET schedule='0 0 30 2 *',next_run_at=NULL WHERE id=$1`,[bad.bot]);
    await pool.query(`UPDATE bots SET schedule='* * * * *',next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[good.bot]);
    await tickBotSchedules(pool);
    assert.equal((await pool.query(`SELECT next_run_at='infinity' AS parked FROM bots WHERE id=$1`,[bad.bot])).rows[0].parked,true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages m JOIN bots b ON b.thread_id=m.thread_id WHERE b.id=$1 AND m.kind='notice' AND m.body LIKE 'Schedule paused:%'`,[bad.bot])).rows[0].n,1);
    assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE bot_id=$1 AND initiator_kind='schedule'`,[good.bot])).rowCount,1,'the good bot still fired');
    await tickBotSchedules(pool);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages m JOIN bots b ON b.thread_id=m.thread_id WHERE b.id=$1 AND m.kind='notice'`,[bad.bot])).rows[0].n,1,'parked, so no repeat notice');
  });
  it('schedule tick initializes, posts and queues once under concurrent ticks, skips busy lead and advances',async () => {
    const f=await fixture();await pool.query(`UPDATE bots SET schedule='* * * * *' WHERE id=$1`,[f.bot]);await tickBotSchedules(pool);let b=(await pool.query('SELECT next_run_at FROM bots WHERE id=$1',[f.bot])).rows[0];assert.ok(b.next_run_at>new Date());assert.equal((await pool.query('SELECT 1 FROM tasks WHERE bot_id=$1',[f.bot])).rowCount,0);
    await pool.query(`UPDATE bots SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[f.bot]);await Promise.all([tickBotSchedules(pool),tickBotSchedules(pool)]);
    await pool.query(`UPDATE bots SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[f.bot]);
    await tickBotSchedules(pool);assert.equal((await pool.query('SELECT 1 FROM tasks WHERE bot_id=$1',[f.bot])).rowCount,1);
    const scheduled = await claim(f.worker,['auto.read','codex.read'],['turn']);assert.ok(scheduled.task);
    let tasks=(await pool.query('SELECT * FROM tasks WHERE bot_id=$1',[f.bot])).rows;assert.equal(tasks.length,1);assert.equal(tasks[0].initiator_kind,'schedule');assert.equal(tasks[0].required_capability,'auto.read');assert.equal((await pool.query(`SELECT 1 FROM messages WHERE thread_id=$1 AND body='Scheduled run'`,[f.thread])).rowCount,1);
    await pool.query(`UPDATE bots SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,[f.bot]);await tickBotSchedules(pool);b=(await pool.query('SELECT next_run_at FROM bots WHERE id=$1',[f.bot])).rows[0];assert.ok(b.next_run_at>new Date());assert.equal((await pool.query('SELECT 1 FROM tasks WHERE bot_id=$1',[f.bot])).rowCount,1);
    await call(f.worker,'task_finish',{task_id:scheduled.task.id,lease_token:scheduled.lease_token,lease_generation:scheduled.lease_generation,outcome:'completed',result:{answer:'Scheduled job done'}});
    assert.equal((await pool.query("SELECT 1 FROM messages WHERE thread_id=$1 AND body='Scheduled job done'",[f.thread])).rowCount,1);
  });
});
