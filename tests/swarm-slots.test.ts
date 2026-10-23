import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { SwarmService } from '../src/core/swarm.js';
import { TOOLS } from '../src/core/tools.js';
import type { Principal } from '../src/types.js';

test('usage_report accepts zero and swarm_status clamps occupied draining slots to zero', async () => {
  const principal: Principal = {id:'worker',tenantId:'tenant',name:'worker-claude',role:'worker',scopes:['project:a'],permissions:[]};
  let slots = 2, live = false;
  const pool = { async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith('UPDATE principals SET worker_slots')) slots = values[1] as number;
    if (sql.startsWith('UPDATE principals SET last_seen_at')) live = true;
    if (sql.includes('FROM principals w WHERE')) return {rows:[{name:principal.name,slots,live,running:[{task_id:'running'}],providers:['claude']}]};
    if (sql.startsWith('SELECT provider,ok,headroom')) return {rows:[{provider:'claude',ok:true,headroom:90,windows:{windows:[]},fetched_at:new Date()}]};
    return {rows:[]};
  } } as unknown as Pool;
  const swarm = new SwarmService(pool);
  assert.deepEqual(await swarm.report(principal,{reports:[],slots:0}),{accepted:0});
  const status = await swarm.status(principal,{}) as {workers:{slots:number;free_slots:number;live:boolean}[];routing:{providers:{live_worker:boolean}[]}};
  assert.deepEqual(status.workers.map(w => [w.slots,w.free_slots,w.live]),[[0,0,true]]);
  assert.equal(status.routing.providers[0]!.live_worker,false);
  for (const value of [-1,17,0.5]) await assert.rejects(swarm.report(principal,{reports:[],slots:value}),/integer from 0 to 16/);
  const properties = TOOLS.find(t => t.name === 'usage_report')!.inputSchema.properties as Record<string,Record<string,unknown>>;
  assert.equal(properties.slots!.minimum,0);
});
