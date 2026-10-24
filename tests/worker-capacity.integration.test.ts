/** Requires an explicitly selected disposable TEST_DATABASE_URL. Authored, not run. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { AppError } from '../src/errors.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const connectionString = process.env.TEST_DATABASE_URL;
const schema = `swarmaa_capacity_${randomUUID().replaceAll('-','')}`;
const scopes = ['project:a','project:b','project:c'];
type Result = Record<string,any>;

describe('server-enforced worker capacity',{skip:!connectionString,concurrency:false},() => {
  let control:Pool, pool:Pool, core:CoreService;
  before(async () => {
    assert.ok(connectionString,'Set TEST_DATABASE_URL to a disposable PostgreSQL database. Never use DATABASE_URL.');
    control = new pg.Pool({connectionString,max:2});
    await control.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({connectionString,max:12,options:`-c search_path=${schema},public`});
    const directory = new URL('../db/migrations/',import.meta.url);
    for (const filename of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(filename,directory),'utf8'));
    }
    core = new CoreService(pool);
  });
  after(async () => {
    if (pool) await pool.end();
    if (control) { try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await control.end(); } }
  });
  const call = async (p:Principal,name:string,args:Record<string,unknown>):Promise<Result> => await core.call(p,name,args) as Result;
  const lease = (result:Result) => ({task_id:result.task.id,lease_token:result.lease_token,lease_generation:result.lease_generation});
  const claim = (p:Principal,scope:string) => call(p,'task_claim',{scope,capabilities:['claude.read'],lease_seconds:30});
  const claimAny = (p:Principal) => call(p,'task_claim',{projects:scopes.map(scope => ({scope,capabilities:['claude.read']})),lease_seconds:30});
  const finish = (p:Principal,result:Result) => call(p,'task_finish',{...lease(result),outcome:'completed',result:{execution_completed:true,acceptance_criteria_verified:false}});
  const liveCount = async (p:Principal):Promise<number> => (await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM tasks
    WHERE tenant_id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>clock_timestamp()`,[p.tenantId,p.id])).rows[0]!.count;
  async function fixture() {
    const tenantId = randomUUID();
    const front:Principal = {id:randomUUID(),tenantId,name:'dot',role:'frontend',scopes,permissions:[...ROLE_PERMISSIONS.frontend]};
    const worker:Principal = {id:randomUUID(),tenantId,name:'worker-one',role:'worker',scopes,permissions:[...ROLE_PERMISSIONS.worker]};
    const worker2:Principal = {...worker,id:randomUUID(),name:'worker-two'};
    // Leave worker_slots NULL so these cases exercise the server's default capacity.
    for (const p of [front,worker,worker2]) await pool.query(`INSERT INTO principals (id,tenant_id,name,role,scopes,permissions,token_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[p.id,p.tenantId,p.name,p.role,p.scopes,p.permissions,randomUUID()]);
    return {front,worker,worker2};
  }
  async function submit(p:Principal,scope:string):Promise<Result> {
    return (await call(p,'task_submit',{scope,kind:'research',objective:'Read the selected project and report sourced findings.',
      constraints:['No file changes.'],acceptance_criteria:['Report evidence.'],required_capability:'claude.read',idempotency_key:randomUUID()})).task;
  }

  it('shares the default slot across concurrent claims in every project, while other workers have their own capacity',async () => {
    const f = await fixture();
    await Promise.all(scopes.map(scope => submit(f.front,scope)));
    const attempts = await Promise.all([...scopes,...scopes,...scopes].map(scope => claim(f.worker,scope)));
    const granted = attempts.filter(result => result.task !== null);
    assert.equal(granted.length,1);
    assert.equal(await liveCount(f.worker),1);
    assert.equal((await claimAny(f.worker)).task,null);
    const secondWorker = await claimAny(f.worker2);
    assert.ok(secondWorker.task);
    assert.notEqual(secondWorker.task.id,granted[0]!.task.id);
    assert.equal(await liveCount(f.worker2),1);
    assert.equal(await liveCount(f.worker),1);
  });

  it('allows exactly the reported number of slots and reuses one only after a task finishes',async () => {
    const f = await fixture();
    await call(f.worker,'usage_report',{reports:[],slots:2});
    await Promise.all(scopes.map(scope => submit(f.front,scope)));
    const attempts = await Promise.all(scopes.map(scope => claim(f.worker,scope)));
    const granted = attempts.filter(result => result.task !== null);
    assert.equal(granted.length,2);
    assert.equal(await liveCount(f.worker),2);
    assert.equal((await claimAny(f.worker)).task,null);
    await finish(f.worker,granted[0]!);
    assert.equal(await liveCount(f.worker),1);
    const replacement = await claimAny(f.worker);
    assert.ok(replacement.task);
    assert.ok(!granted.some(result => result.task.id === replacement.task.id));
    assert.equal(await liveCount(f.worker),2);
    assert.equal((await call(f.front,'task_get',{task_id:granted[1]!.task.id})).task.status,'running');
  });

  it('drains at zero slots without revoking an existing lease, including after that task finishes',async () => {
    const f = await fixture();
    await submit(f.front,'project:a');
    const active = await claim(f.worker,'project:a');
    const waiting = await submit(f.front,'project:b');
    await call(f.worker,'usage_report',{reports:[],slots:0});
    assert.equal((await claim(f.worker,'project:b')).task,null);
    const renewed = await call(f.worker,'task_heartbeat',{...lease(active),lease_seconds:30});
    assert.equal(renewed.task.status,'running');
    assert.equal(await liveCount(f.worker),1);
    await finish(f.worker,active);
    assert.equal(await liveCount(f.worker),0);
    assert.equal((await claimAny(f.worker)).task,null);
    assert.equal((await call(f.front,'task_get',{task_id:waiting.id})).task.status,'queued');
    await call(f.worker,'usage_report',{reports:[],slots:1});
    assert.equal((await claim(f.worker,'project:b')).task.id,waiting.id);
  });

  it('does not count an expired lease in another project and still fences the stale attempt',async () => {
    const f = await fixture();
    await submit(f.front,'project:a');
    const stale = await claim(f.worker,'project:a');
    const waiting = await submit(f.front,'project:b');
    await pool.query("UPDATE tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[stale.task.id]);
    const next = await claim(f.worker,'project:b');
    assert.equal(next.task.id,waiting.id);
    assert.equal(await liveCount(f.worker),1);
    // The expired row has not yet been swept in project:a, but cannot consume a live slot or renew.
    assert.equal((await call(f.front,'task_get',{task_id:stale.task.id})).task.status,'running');
    await assert.rejects(() => call(f.worker,'task_heartbeat',{...lease(stale),lease_seconds:30}),
      (error:unknown) => error instanceof AppError && error.code === 'lease_lost');
    assert.equal((await claim(f.worker,'project:a')).task,null);
    await finish(f.worker,next);
    const recovered = await claim(f.worker,'project:a');
    assert.equal(recovered.task.id,stale.task.id);
    assert.equal(recovered.lease_generation,stale.lease_generation+1);
    assert.equal(await liveCount(f.worker),1);
  });
});
