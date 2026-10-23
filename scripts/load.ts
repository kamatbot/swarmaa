// Load test: hundreds of swarms against the real CoreService on a throwaway schema in TEST_DATABASE_URL.
// Workers behave like the bridge (one pass over every project, claim while a slot is free, heartbeat, finish),
// frontends poll swarm_status and events_poll like notches and agents do. Prints per-tool latency and errors.
//   node --env-file=.env.test --import tsx scripts/load.ts [--scopes 100] [--tasks 500] [--workers 6] [--slots 16] [--pollers 30] [--pool 12]
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { CoreService } from '../src/core/index.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';

const { values: v } = parseArgs({ options: {
  scopes: { type: 'string', default: '100' }, tasks: { type: 'string', default: '500' }, workers: { type: 'string', default: '6' },
  slots: { type: 'string', default: '16' }, pollers: { type: 'string', default: '30' }, pool: { type: 'string', default: '12' },
  work: { type: 'string', default: '1500' }, poll: { type: 'string', default: '2000' },
} });
const N = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])) as Record<keyof typeof v, number>;
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');

const schema = `collective_load_${randomUUID().replaceAll('-', '')}`;
const control = new pg.Pool({ connectionString: url, max: 2 });
await control.query(`CREATE SCHEMA "${schema}"`);
const pool = new pg.Pool({ connectionString: url, max: N.pool, connectionTimeoutMillis: 30_000, statement_timeout: 30_000, options: `-c search_path=${schema},public` });
for (const f of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort())
  await pool.query(await readFile(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8'));
const core = new CoreService(pool);

const tenantId = randomUUID();
const scopes = Array.from({ length: N.scopes }, (_, i) => `project:p${i}`);
const make = (name: string, role: Principal['role']): Principal => ({ id: randomUUID(), tenantId, name, role, scopes, permissions: [...ROLE_PERMISSIONS[role]] });
const front = make('front', 'frontend');
const workers = Array.from({ length: N.workers }, (_, i) => make(`worker-${i}`, 'worker'));
const pollers = Array.from({ length: N.pollers }, (_, i) => make(`notch-${i}`, 'frontend'));
for (const p of [front, ...workers, ...pollers]) await pool.query(
  'INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [p.id, p.tenantId, p.name, p.role, p.scopes, p.permissions, randomUUID()]);

const stats = new Map<string, number[]>(); const errors = new Map<string, number>();
async function call(p: Principal, tool: string, args: Record<string, unknown>): Promise<any> {
  const t = performance.now();
  try { return await core.call(p, tool, args); }
  catch (e: any) { const k = `${tool}: ${e?.code ?? e?.message ?? e}`; errors.set(k, (errors.get(k) ?? 0) + 1); return undefined; }
  finally { (stats.get(tool) ?? stats.set(tool, []).get(tool)!).push(performance.now() - t); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let done = 0, stop = false;
const t0 = performance.now();

for (const w of workers) await call(w, 'usage_report', { reports: [{ provider: 'claude', ok: true, fetched_at: new Date().toISOString(), windows: [{ name: '5h', used_percent: 10, resets_at: new Date(Date.now() + 3600e3).toISOString() }] }], slots: N.slots });

async function runTask(w: Principal, claim: any): Promise<void> {
  const lease = { task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation };
  const end = performance.now() + N.work * (0.5 + Math.random());
  while (performance.now() < end) { await sleep(1000); await call(w, 'task_heartbeat', { ...lease, lease_seconds: 60 }); }
  await call(w, 'task_finish', { ...lease, outcome: 'completed', result: { summary: 'ok' } });
  done++;
}
async function worker(w: Principal): Promise<void> {
  let inflight = 0; const running = new Set<Promise<void>>();
  while (!stop) {
    let claimed = false;
    for (const scope of scopes) {
      while (!stop && inflight < N.slots) {
        const c = await call(w, 'task_claim', { scope, capabilities: ['claude.read', 'auto.read'], lease_seconds: 60 });
        if (!c?.task) break;
        claimed = true; inflight++;
        const r = runTask(w, c).finally(() => { inflight--; running.delete(r); }); running.add(r);
      }
    }
    if (!claimed) await sleep(N.poll);
  }
  await Promise.allSettled([...running]);
}
async function poller(p: Principal): Promise<void> {
  const cursors = new Map<string, string>();
  while (!stop) {
    await call(p, 'swarm_status', {});
    for (const scope of [0, 1, 2].map(() => scopes[Math.floor(Math.random() * scopes.length)])) {
      const r = await call(p, 'events_poll', { scope, after: cursors.get(scope) ?? '0' });
      if (r) cursors.set(scope, r.next_cursor);
    }
    await sleep(N.poll);
  }
}

const loops = [...workers.map(worker), ...pollers.map(poller)];
await Promise.all(Array.from({ length: N.tasks }, (_, i) => call(front, 'task_submit', {
  scope: scopes[i % scopes.length], kind: 'research', objective: `Load test task ${i}.`, idempotency_key: `load-${i}`, required_capability: 'auto.read' })));
const submitted = performance.now();
while (done < N.tasks && performance.now() - t0 < 600_000) await sleep(500);
const finished = performance.now();
stop = true; await Promise.all(loops);

const pct = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
console.log(`scopes=${N.scopes} tasks=${N.tasks} workers=${N.workers}x${N.slots} pollers=${N.pollers} pool=${N.pool} work≈${N.work}ms`);
console.log(`submit all: ${((submitted - t0) / 1000).toFixed(1)}s · completed ${done}/${N.tasks} in ${((finished - t0) / 1000).toFixed(1)}s (ideal ≈ ${(Math.ceil(N.tasks / (N.workers * N.slots)) * N.work / 1000).toFixed(1)}s)`);
console.log('tool             calls   p50ms   p95ms   p99ms   maxms');
for (const [tool, a] of [...stats].sort()) { a.sort((x, y) => x - y);
  console.log(`${tool.padEnd(15)} ${String(a.length).padStart(6)} ${[0.5, 0.95, 0.99, 1].map(q => pct(a, q).toFixed(0).padStart(7)).join(' ')}`); }
console.log(errors.size ? `errors: ${JSON.stringify(Object.fromEntries(errors))}` : 'errors: none');
await pool.end();
try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await control.end(); }
process.exit(done === N.tasks && !errors.size ? 0 : 1);
