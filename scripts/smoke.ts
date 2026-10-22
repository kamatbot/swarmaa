// End-to-end check of the running swarm on this Mac: every project an app can submit to has a live
// worker, and a real task submitted the way Grok or the notch would goes queued → running → completed,
// shows in swarm_status while active and as a swarm chat afterwards. Prints PASS/FAIL per step; exit 1 on any FAIL.
//   npm run smoke [-- --scope project:general] [--as notchtrader]
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { values } = parseArgs({ options: { scope: { type: 'string', default: 'project:general' }, as: { type: 'string', default: 'notchtrader' } } });
const base = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const token = (JSON.parse(readFileSync(`.local/${values.as}.json`, 'utf8')) as { token: string }).token;
let failed = 0;
const pass = (m: string) => console.log(`PASS  ${m}`);
const fail = (m: string) => { failed++; console.log(`FAIL  ${m}`); };
const warn = (m: string) => console.log(`WARN  ${m}`);

async function call<T = any>(tool: string, args: object): Promise<T> {
  const r = await fetch(`${base}/api/tools/${tool}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json() as { result?: T; error?: { code: string; message: string } };
  if (j.error) throw new Error(`${tool}: ${j.error.code} ${j.error.message}`);
  return j.result as T;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 1. Coverage: projects the apps can submit to vs projects a live worker serves.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const rows = (await pool.query<{ name: string; role: string; scopes: string[]; live: boolean }>(
  `SELECT name,role,scopes,coalesce(last_seen_at>now()-interval '60 seconds',false) AS live FROM principals WHERE NOT disabled AND role IN ('frontend','worker')`)).rows;
await pool.end();
const served = new Set(rows.filter(r => r.role === 'worker' && r.live).flatMap(r => r.scopes));
// Expected workers are the ones this Mac runs: one per .local/bridge-*.json, named by its token file.
const expected = readdirSync('.local').filter(f => /^bridge-.+\.json$/u.test(f))
  .map(f => basename(String((JSON.parse(readFileSync(`.local/${f}`, 'utf8')) as { token_file?: string }).token_file ?? ''), '.json')).filter(Boolean);
const down = expected.filter(n => !rows.some(r => r.name === n && r.live));
expected.length && !down.length ? pass(`workers live: ${expected.join(', ')}`) : fail(`workers down: ${down.join(', ') || 'none configured'}`);
const main = new Set(['grok', 'notchtrader', 'macbook', 'claude-interactive', 'codex-interactive', 'antigravity-interactive']);
for (const f of rows.filter(r => r.role === 'frontend')) {
  const missing = f.scopes.filter(s => s !== '*' && !served.has(s));
  if (!missing.length) continue;
  (main.has(f.name) ? fail : warn)(`${f.name} can submit to ${missing.join(', ')} but no live worker serves it`);
}
if (!failed) pass('every project the main apps use has a live worker');

// 2. A real task, end to end, as the notch would see it.
const t0 = Date.now();
const sub = await call<{ task: { id: string }; warning?: string }>('task_submit', {
  scope: values.scope, kind: 'research', required_capability: 'auto.read', idempotency_key: `smoke-${t0}`,
  objective: 'Swarmaa smoke test: reply with exactly the word ok. Do not read files or run commands.',
});
const id = sub.task.id;
sub.warning ? fail(`submit warned: ${sub.warning}`) : pass(`submitted ${id.slice(0, 8)} to ${values.scope}`);

let claimedAt = 0, seenActive = false, status = 'queued', task: any;
while (Date.now() - t0 < 300_000) {
  task = (await call<{ task: any }>('task_get', { task_id: id })).task;
  status = task.status;
  const scopes = (await call<{ scopes: { scope: string; queued: number; running: number }[] }>('swarm_status', {})).scopes;
  const s = scopes.find(x => x.scope === values.scope);
  if (s && s.queued + s.running > 0) seenActive = true;
  if (status !== 'queued' && !claimedAt) claimedAt = Date.now();
  if (!claimedAt && Date.now() - t0 > 60_000) break;
  if (['completed', 'failed', 'blocked', 'cancelled'].includes(status)) break;
  await sleep(2000);
}
claimedAt ? pass(`picked up after ${Math.round((claimedAt - t0) / 1000)}s by ${task.result?.provider ?? task.worker ?? 'a worker'}`) : fail('no worker picked the task up within 60s');
status === 'completed' ? pass(`completed in ${Math.round((Date.now() - t0) / 1000)}s: "${String(task.result?.answer ?? '').trim().slice(0, 40)}"`) : fail(`task ended ${status}${task.result?.code ? ` (${task.result.code})` : ''}`);
seenActive ? pass('notch status showed the project as active while it ran') : warn('finished before a status poll caught it active (fine for a fast task)');

if (status === 'completed') {
  const recent = (await call<{ recent: { id: string }[] }>('swarm_status', {})).recent;
  recent.some(r => r.id === id) ? pass('appears in swarm_status.recent (notch activity card)') : fail('missing from swarm_status.recent');
  const sessions = (await call<{ sessions: unknown[] }>('session_list', { scope: values.scope, swarm_only: true, task_id: id })).sessions;
  sessions.length ? pass('recorded as a swarm chat (/swarm)') : fail('no swarm chat recorded');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
