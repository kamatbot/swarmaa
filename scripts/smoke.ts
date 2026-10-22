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

// 2. A swarm, end to end: one auto-routed task plus one per service, all submitted at once, so a broken
// worker can't hide behind another and the tasks must run in parallel.
const t0 = Date.now();
const runs = [
  { label: 'auto', capability: 'auto.read', kind: 'research' },
  { label: 'claude', capability: 'claude.read', kind: 'research' },
  { label: 'codex', capability: 'codex.read', kind: 'research' },
  { label: 'antigravity', capability: 'antigravity.read', kind: 'review' }, // Antigravity takes no research
].filter(r => r.label === 'auto' || served.has(values.scope) && rows.some(w => w.role === 'worker' && w.live && w.name.includes(r.label === 'antigravity' ? 'agy' : r.label)));
const tasks = await Promise.all(runs.map(async r => {
  const sub = await call<{ task: { id: string }; warning?: string }>('task_submit', {
    scope: values.scope, kind: r.kind, required_capability: r.capability, idempotency_key: `smoke-${t0}-${r.label}`,
    objective: 'Swarmaa smoke test: reply with exactly the word ok. Do not read files, search the web or run commands.',
  });
  if (sub.warning) fail(`${r.label}: submit warned: ${sub.warning}`);
  return { ...r, id: sub.task.id, status: 'queued', task: undefined as any, claimedAt: 0 };
}));
pass(`submitted ${tasks.length} tasks at once to ${values.scope}: ${tasks.map(t => t.label).join(', ')}`);

let seenActive = false, peak = 0;
const done = (t: { status: string }) => ['completed', 'failed', 'blocked', 'cancelled'].includes(t.status);
while (Date.now() - t0 < 300_000 && !tasks.every(done)) {
  for (const t of tasks.filter(x => !done(x))) {
    t.task = (await call<{ task: any }>('task_get', { task_id: t.id })).task;
    t.status = t.task.status;
    if (t.status !== 'queued' && !t.claimedAt) t.claimedAt = Date.now();
  }
  peak = Math.max(peak, tasks.filter(t => t.status === 'running').length);
  const s = (await call<{ scopes: { scope: string; queued: number; running: number }[] }>('swarm_status', {})).scopes.find(x => x.scope === values.scope);
  if (s && s.queued + s.running > 0) seenActive = true;
  if (tasks.some(t => !t.claimedAt) && Date.now() - t0 > 90_000) break;
  await sleep(2000);
}
for (const t of tasks) {
  const who = t.task?.result?.provider ?? 'a worker';
  if (!t.claimedAt) { fail(`${t.label}: no worker picked it up within 90s`); continue; }
  t.status === 'completed'
    ? pass(`${t.label}: ${who} picked it up after ${Math.round((t.claimedAt - t0) / 1000)}s and completed: "${String(t.task.result?.answer ?? '').trim().slice(0, 30)}"`)
    : fail(`${t.label}: ended ${t.status} on ${who}${t.task?.result?.exit_code !== undefined ? ` (exit ${t.task.result.exit_code})` : ''}`);
}
tasks.length > 1 && (peak > 1 ? pass(`ran in parallel: up to ${peak} tasks at once`) : warn('never saw two tasks running at the same moment (they may simply have been fast)'));
seenActive ? pass('notch status showed the project as active while it ran') : warn('finished before a status poll caught it active');

const ok = tasks.filter(t => t.status === 'completed');
if (ok.length) {
  const recent = (await call<{ recent: { id: string }[] }>('swarm_status', {})).recent;
  ok.every(t => recent.some(r => r.id === t.id)) ? pass('all appear in swarm_status.recent (notch activity card)') : fail('some missing from swarm_status.recent');
  const chats = await Promise.all(ok.map(t => call<{ sessions: unknown[] }>('session_list', { scope: values.scope, swarm_only: true, task_id: t.id })));
  chats.every(c => c.sessions.length) ? pass('all recorded as swarm chats (/swarm)') : fail('some have no swarm chat');
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
