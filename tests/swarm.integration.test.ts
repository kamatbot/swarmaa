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
    for (const file of ['001_identity.sql','002_core.sql','005_swarm.sql']) {
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
    assert.deepEqual([hidden.workers,hidden.scopes,hidden.recent],[[],[],[]]);
    await assert.rejects(() => call(outsider,'swarm_status',{scope:'project:a'}),(e:unknown) => e instanceof AppError && e.code === 'scope_forbidden');
  });
});
