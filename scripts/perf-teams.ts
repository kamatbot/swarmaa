/** Disposable Teams benchmark. Node 24: npx tsx --env-file=.env.test scripts/perf-teams.ts */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { parseEnv } from 'node:util';
import pg, { type Pool, type PoolClient } from 'pg';
import { AuthService, hashToken, newToken } from '../src/auth.js';
import { CoreService } from '../src/core/index.js';
import { createHttpHandler } from '../src/http.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal, ServerConfig } from '../src/types.js';

type Identity = Principal & { token: string };
type Query = { sql: string; values: unknown[] };
type Trace = { op: string; commit?: number; queries?: Query[] };
type Metric = { scenario: number; name: string; samples: number[]; elapsed: number; units?: number };
const uid = randomUUID, now = () => performance.now(), scope = 'project:perf';
const metrics: Metric[] = [], notes: string[] = [];
const plans: { label: string; query: Query; plan?: any; times: number[]; elapsed?: number }[] = [];
const locks: { phase: string; kind: string; ms: number }[] = [];
const context = new AsyncLocalStorage<Trace>(), requests = new Map<string, Trace>();
let phase = '', pool: Pool, server: Server | undefined, origin = '';
const f = (n: number) => n.toFixed(3);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)]!;
const metric = (scenario: number, name: string, samples: number[], elapsed = samples.reduce((a, b) => a + b, 0), units?: number) => {
  assert(samples.length && samples.every(Number.isFinite), `Invalid samples: ${name}`);
  metrics.push({ scenario, name, samples, elapsed, units });
};
async function measure(scenario: number, name: string, count: number, fn: (i: number) => Promise<unknown>) {
  const samples: number[] = [], start = now();
  for (let i = 0; i < count; i++) { const t = now(); await fn(i); samples.push(now() - t); }
  metric(scenario, name, samples, now() - start);
}

// Observe only this pool. Preserve the advisory key, order and transaction lifetime.
// A materialized timestamp before the original lock measures server-side acquisition
// time (wait + a few microseconds of executor work), excluding pool/network delay.
function instrument(client: PoolClient) {
  const query = client.query.bind(client);
  client.query = function (...args: any[]) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const trace = context.getStore();
    if (trace?.queries && /^\s*SELECT\b/i.test(sql)) trace.queries.push({ sql, values: args[1] ?? [] });
    const lock = typeof sql === 'string' && sql.startsWith('SELECT pg_advisory_xact_lock(');
    const lockPhase = phase;
    if (lock) {
      args[0] = `WITH perf_start AS MATERIALIZED (SELECT clock_timestamp() AS t),
        perf_lock AS MATERIALIZED (${sql} FROM perf_start)
        SELECT extract(epoch FROM clock_timestamp()-perf_start.t)*1000 AS perf_lock_ms FROM perf_start, perf_lock`;
    }
    const result = (query as any)(...args);
    if (!result?.then) return result; // Pool.query's callback path stays untouched.
    return result.then((r: any) => {
      if (sql === 'COMMIT' && trace) trace.commit = now();
      if (lock && lockPhase) locks.push({ phase: lockPhase, kind: sql.includes("'teams:'") ? 'teams' : 'scope:tasks', ms: Number(r.rows[0].perf_lock_ms) });
      return r;
    });
  } as typeof client.query;
}
async function startHttp() {
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  const config: ServerConfig = {
    host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1', allowedOrigins: [], allowInsecureLocalhost: true,
    maxBodyBytes: 131072, oauthEnabled: false, oauthRedirectHosts: [], eventCallbackHosts: [], eventEncryptionKey: '0'.repeat(64)
  };
  const handler = createHttpHandler({ pool, core: new CoreService(pool), auth: new AuthService(pool), config });
  server = createServer((req, res) => context.run(requests.get(String(req.headers['x-perf-id'])) ?? { op: 'stream' }, () => handler(req, res)));
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  config.port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${config.port}`;
}
async function call(p: Identity, op: string, args: Record<string, unknown> = {}, trace: Trace = { op }): Promise<any> {
  const id = uid(); requests.set(id, trace);
  try {
    const response = await fetch(`${origin}/api/tools/${op}`, {
      method: 'POST', headers: { Authorization: `Bearer ${p.token}`, 'Content-Type': 'application/json', 'x-perf-id': id },
      body: JSON.stringify(args), signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200, `${op}: HTTP ${response.status} ${JSON.stringify(body)}`);
    assert(Object.hasOwn(body, 'result'), `${op}: missing result`);
    return body.result;
  } finally { requests.delete(id); }
}
async function identity(tenantId: string = uid(), role: Principal['role'] = 'frontend'): Promise<Identity> {
  const p: Identity = { id: uid(), tenantId, name: `${role}-${uid()}`, role, scopes: [scope], permissions: [...ROLE_PERMISSIONS[role]], token: newToken() };
  await pool.query(`INSERT INTO principals(id,tenant_id,name,role,scopes,permissions,token_hash,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`, [p.id, tenantId, p.name, role, p.scopes, p.permissions, hashToken(p.token)]);
  return p;
}
async function agents(p: Identity, n: number) {
  const rows: any[] = [];
  for (let i = 0; i < n; i++) rows.push((await call(p, 'agent_create', {
    name: `Agent-${uid()}`, role: 'Benchmark', instructions: 'Return a short answer.', scope, runner: { provider: 'codex' }
  })).agent);
  return rows;
}
const post = (p: Identity, a: any) => call(p, 'thread_post', { thread_id: a.main_thread_id, body: 'Benchmark turn', idempotency_key: uid() });
const claim = (p: Identity, trace?: Trace) => call(p, 'task_claim', { scope, capabilities: ['codex.read'], lease_seconds: 300 }, trace);
const finish = (p: Identity, c: any, answer = 'Done.') => {
  assert(c.task, 'No turn claimed');
  return call(p, 'task_finish', { task_id: c.task.id, lease_token: c.lease_token, lease_generation: c.lease_generation, outcome: 'completed', result: { answer } });
};
function capture(label: string, trace: Trace) {
  const seen = new Set<string>();
  for (const q of trace.queries ?? []) {
    if (!/\bFROM\s+(messages|tasks|swarm_steps|agents|threads|questions|principals|thread_reads)\b/i.test(q.sql) || /pg_advisory/.test(q.sql)) continue;
    const key = q.sql.replace(/\s+/g, ' ');
    if (!seen.has(key)) { seen.add(key); plans.push({ label: `${label}/${seen.size}`, query: q, times: [] }); }
  }
}
async function seedMessages(p: Identity, a: any, count: number) {
  await pool.query(`INSERT INTO messages(id,tenant_id,scope,thread_id,seq,author,kind,body)
    SELECT gen_random_uuid(),$1,$2,$3,g,jsonb_build_object('kind','human','id',$4::text),'text',repeat('benchmark ',20)
    FROM generate_series(1,$5::integer) g`, [p.tenantId, scope, a.main_thread_id, p.id, count]);
}

async function scenarios() {
  await startHttp();
  const p1 = await identity(), a1 = await agents(p1, 20);
  phase = 'posts';
  await measure(1, 'thread_post, serial, 20 agents', 500, i => post(p1, a1[i % 20]));
  phase = '';
  const queued = Number((await pool.query('SELECT count(*) FROM tasks WHERE tenant_id=$1 AND status=\'queued\'', [p1.tenantId])).rows[0].count);
  assert.equal(queued, 20);
  assert.equal(Number((await pool.query('SELECT count(*) FROM messages WHERE tenant_id=$1', [p1.tenantId])).rows[0].count), 500);
  notes.push(`Scenario 1 stored 500 messages and 20 queued turns: posts coalesce while an agent already has a queued/running turn. First 20 create turns; remaining 480 use that existing-turn path.`);

  await startHttp();
  const p2 = await identity(), w2 = await identity(p2.tenantId, 'worker'), a2 = await agents(p2, 50);
  await seedMessages(p2, a2[0], 5000);
  await pool.query('ANALYZE messages');
  let tr: Trace = { op: 'thread_read', queries: [] };
  await call(p2, 'thread_read', { thread_id: a2[0].main_thread_id, limit: 100 }, tr); capture('read-first', tr);
  tr = { op: 'thread_read', queries: [] };
  await call(p2, 'thread_read', { thread_id: a2[0].main_thread_id, before_seq: 2501, limit: 100 }, tr); capture('read-before', tr);
  await measure(2, 'latest 100 / 5,000 messages', 100, async () => {
    const r = await call(p2, 'thread_read', { thread_id: a2[0].main_thread_id, limit: 100 });
    assert.equal(r.messages.length, 100); assert.equal(r.messages[0].seq, 4901); assert(r.has_more);
  });
  const pageTimes: number[] = [], pageStart = now();
  for (let sweep = 0; sweep < 3; sweep++) {
    let before = 5001, total = 0;
    for (let page = 0; page < 50; page++) {
      const t = now(), r = await call(p2, 'thread_read', { thread_id: a2[0].main_thread_id, before_seq: before, limit: 100 });
      pageTimes.push(now() - t); assert.equal(r.messages.length, 100);
      assert.equal(r.messages.at(-1).seq, before - 1); assert.equal(r.messages[0].seq, before - 100);
      before = r.messages[0].seq; total += r.messages.length; assert.equal(r.has_more, page < 49);
    }
    assert.equal(total, 5000); assert.equal(before, 1);
  }
  metric(2, 'before_seq pages of 100, 3 full reverse sweeps', pageTimes, now() - pageStart);

  await startHttp();
  for (const a of a2.slice(1)) await seedMessages(p2, a, 100);
  await call(p2, 'thread_mark_read', { thread_id: a2[0].main_thread_id, seq: 2500 });
  await pool.query(`INSERT INTO tasks(id,tenant_id,scope,kind,agent_id,thread_id,objective,permission_envelope,required_capability,
    resource_key,status,created_by,idempotency_key,request_hash,lease_owner,lease_hash,lease_expires_at,result,updated_at)
    SELECT gen_random_uuid(),$1,$2,'turn',($4::uuid[])[1+(g%50)],($5::uuid[])[1+(g%50)],'Benchmark fixture','{}','codex.read',
    'agent:'||($4::uuid[])[1+(g%50)]::text,(ARRAY['queued','running','completed','failed','blocked','cancelled'])[1+(g%6)],$3,
    g::text,g::text,CASE WHEN g%6=1 THEN $6::uuid END,CASE WHEN g%6=1 THEN 'fixture' END,
    CASE WHEN g%6=1 THEN clock_timestamp()+interval '1 hour' END,
    CASE WHEN g%6=2 THEN '{"review_required":true,"head_commit":"fixture","changed_files":1}'::jsonb ELSE '{}'::jsonb END,
    clock_timestamp()-g*interval '1 second' FROM generate_series(1,1000) g`,
  [p2.tenantId, scope, p2.id, a2.map(a => a.id), a2.map(a => a.main_thread_id), w2.id]);
  await pool.query(`INSERT INTO questions(id,tenant_id,scope,thread_id,agent_id,prompt,options,free_text)
    SELECT gen_random_uuid(),$1,$2,$3,$4,'Choose a benchmark option','["A","B"]',true FROM generate_series(1,25)`,
  [p2.tenantId, scope, a2[0].main_thread_id, a2[0].id]);
  for (const table of ['tasks', 'messages', 'agents', 'threads', 'questions']) await pool.query(`ANALYZE ${table}`);
  for (const [op, args] of [['agent_list', { scope, limit: 50 }], ['thread_list', { limit: 50 }], ['attention_list', { scope, limit: 100 }], ['question_list', { limit: 50 }]] as const) {
    tr = { op, queries: [] }; const result = await call(p2, op, args, tr); capture(op, tr);
    if (op === 'agent_list') { assert.equal(result.agents.length, 50); assert.equal(result.agents.find((a: any) => a.id === a2[0].id).unread_count, 2500); }
    if (op === 'thread_list') assert.equal(result.threads.length, 50);
    if (op === 'attention_list') { assert.equal(result.items.length, 100); assert(result.has_more); }
    if (op === 'question_list') assert.equal(result.questions.length, 25);
    const queryCount = tr.queries!.length;
    await measure(3, `${op} (${op === 'question_list' ? '25 open questions' : '50 agents; 1,000 mixed tasks'})`, 75, () => call(p2, op, args));
    assert.equal(tr.queries!.length, queryCount, 'Query attribution escaped its HTTP request');
    if (op === 'agent_list') notes.push(`agent_list executes ${queryCount} SELECTs for 50 agents (including authentication, status/worker checks and sections).`);
  }
  tr = { op: 'task_claim', queries: [] };
  const fixtureClaim = await claim(w2, tr); assert(fixtureClaim.task); capture('claim-mixed-1000', tr);
  await finish(w2, fixtureClaim);

  await startHttp();
  const p4 = await identity(), w4 = await identity(p4.tenantId, 'worker'), a4 = await agents(p4, 11);
  const action = { type: 'swarm_start', title: 'Ten steps', goal: 'Benchmark actions', steps: a4.slice(1).map((a, i) => ({ key: `s${i}`, title: `Step ${i}`, assignee_agent_id: a.id, needs: [] })) };
  const actionTimes: number[] = [];
  for (let i = 0; i < 50; i++) {
    await post(p4, a4[0]); const t = now(), c = await claim(w4); assert.equal(c.task.agent_id, a4[0].id);
    await finish(w4, c, `Planned.\n\n\`\`\`swarmaa-actions\n${JSON.stringify([action])}\n\`\`\``);
    actionTimes.push(now() - t);
    const sw = (await call(p4, 'swarm_list', { scope })).swarms;
    assert.equal(sw.length, 1); assert.equal(sw[0].steps.length, 10); assert(sw[0].steps.every((s: any) => s.task_id));
    const reply = await call(p4, 'thread_read', { thread_id: a4[0].main_thread_id, before_seq: 1_000_000, limit: 10 });
    assert(reply.messages.some((m: any) => m.kind === 'text' && m.body === 'Planned.'));
    assert(!reply.messages.some((m: any) => m.kind === 'notice' && /reject|refus/i.test(m.body)));
    await call(p4, 'swarm_cancel', { swarm_id: sw[0].id, expected_version: sw[0].version });
  }
  metric(4, 'claim + finish(actions → 10 ready steps)', actionTimes);
  notes.push('Scenario 4 times claim request through finish response; untimed setup posts and verification/cancellation are excluded. All 50 action blocks produced 10 task-backed steps and a stripped reply.');

  await startHttp();
  const p5 = await identity(), a5 = await agents(p5, 11), workers = await Promise.all(Array.from({ length: 10 }, () => identity(p5.tenantId, 'worker')));
  const swarmTimes: number[] = [];
  for (let run = 0; run < 10; run++) {
    const steps = Array.from({ length: 20 }, (_, i) => ({ key: `s${i}`, title: `Step ${i}`, assignee_agent_id: a5[1 + i % 10].id,
      needs: i < 10 ? [] : Array.from({ length: 10 }, (_, j) => `s${j}`) }));
    phase = 'swarm'; const t = now();
    const sw = (await call(p5, 'swarm_start', { title: 'Two waves of ten', goal: 'Benchmark DAG', scope, owner_agent_id: a5[0].id, thread_id: a5[0].main_thread_id, steps, idempotency_key: uid() })).swarm;
    for (let wave = 0; wave < 2; wave++) {
      const claims = await Promise.all(workers.map(w => claim(w)));
      assert.equal(new Set(claims.map(c => c.task?.swarm_step_id)).size, 10); assert(claims.every(c => c.task?.swarm_step_id));
      await Promise.all(workers.map((w, i) => finish(w, claims[i])));
    }
    swarmTimes.push(now() - t); phase = '';
    tr = { op: 'swarm_get', queries: run === 0 ? [] : undefined };
    const done = (await call(p5, 'swarm_get', { swarm_id: sw.id }, tr)).swarm;
    if (run === 0) capture('swarm-steps', tr);
    assert.equal(done.status, 'done'); assert.equal(done.steps.filter((s: any) => s.status === 'done').length, 20);
    const summary = await claim(workers[0]); assert.equal(summary.task.agent_id, a5[0].id); await finish(workers[0], summary);
  }
  metric(5, '20-step swarm total, two waves × 10 workers', swarmTimes);
  for (const kind of ['teams', 'scope:tasks']) metric(5, `${kind} acquisition during swarm`, locks.filter(l => l.phase === 'swarm' && l.kind === kind).map(l => l.ms), swarmTimes.reduce((a, b) => a + b, 0));
  await startHttp();
  const same = await identity(), sameAgents = await agents(same, 20), many = await Promise.all(Array.from({ length: 20 }, () => identity()));
  const manyAgents: any[] = [];
  for (const p of many) manyAgents.push((await agents(p, 1))[0]);
  const comparisons = ['one-tenant', '20-tenants'].map(mode => ({ mode, posts: [] as number[], batches: [] as number[] }));
  for (let batch = 0; batch < 20; batch++) {
    for (let order = 0; order < 2; order++) {
      const { mode, posts, batches } = comparisons[(batch + order) % 2]; phase = mode;
      const t = now();
      await Promise.all(many.map(async (p, i) => { const start = now(); await post(mode === 'one-tenant' ? same : p, mode === 'one-tenant' ? sameAgents[i] : manyAgents[i]); posts.push(now() - start); }));
      batches.push(now() - t);
    }
  }
  phase = '';
  for (const { mode, posts, batches } of comparisons) {
    const elapsed = batches.reduce((a, b) => a + b, 0);
    metric(5, `${mode}: posts, concurrency 20`, posts, elapsed);
    metric(5, `${mode}: batch of 20 wall time`, batches);
    metric(5, `${mode}: teamsLock acquisition`, locks.filter(l => l.phase === mode && l.kind === 'teams').map(l => l.ms), elapsed);
  }

  await streamScenario();
  for (const table of ['messages', 'tasks', 'swarm_steps', 'agents', 'threads', 'questions', 'principals']) await pool.query(`ANALYZE ${table}`);
  for (const p of plans) {
    const t = now();
    for (let i = 0; i < 20; i++) {
      const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${p.query.sql}`, p.query.values);
      p.plan = r.rows[0]['QUERY PLAN'][0]; p.times.push(p.plan['Execution Time']);
    }
    p.elapsed = now() - t;
    metric(7, p.label, p.times, p.elapsed);
  }
}

type Frame = { event: string; id: string; data: any; at: number };
async function stream(p: Identity, after: string) {
  const controller = new AbortController(), frames: Frame[] = [];
  const response = await fetch(`${origin}/api/stream?after=${encodeURIComponent(after)}`, { headers: { Authorization: `Bearer ${p.token}` }, signal: controller.signal });
  assert.equal(response.status, 200, 'SSE connection');
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  const done = (async () => {
    try {
      for (;;) {
        const r = await reader.read(); if (r.done) break;
        buffer += decoder.decode(r.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1], id = /^id: (.+)$/m.exec(block)?.[1];
          if (event && data && id) frames.push({ event, id, data: JSON.parse(data), at: now() });
        }
      }
    } catch (e) { if (!controller.signal.aborted) throw e; }
  })();
  return { frames, close: async () => { controller.abort(); await done; } };
}
async function until(test: () => boolean, label: string, timeout = 15_000) {
  const deadline = now() + timeout;
  while (!test()) { assert(now() < deadline, `Timeout: ${label}`); await new Promise(r => setTimeout(r, 5)); }
}
async function streamScenario() {
  await startHttp();
  const p = await identity(), [a] = await agents(p, 1), streams = await Promise.all(Array.from({ length: 4 }, () => stream(p, 'now')));
  try {
    await until(() => streams.every(s => s.frames.some(e => e.event === 'cursor')), 'four now cursors');
    const latencies: number[] = [], perClient: number[][] = streams.map(() => []), started = now(), committed: { id: string; at: number }[] = [];
    for (let i = 0; i < 100; i++) {
      const trace: Trace = { op: 'thread_post' };
      const r = await call(p, 'thread_post', { thread_id: a.main_thread_id, body: 'Stream benchmark', idempotency_key: uid() }, trace);
      assert(trace.commit !== undefined, 'Missing server COMMIT acknowledgement');
      committed.push({ id: r.message.id, at: trace.commit });
      await new Promise(r => setTimeout(r, 5 + i % 7 * 3)); // Vary posting intervals independently of event arrivals.
    }
    await until(() => streams.every(s => committed.every(c => s.frames.some(e => e.event === 'message.created' && e.data.subject_id === c.id))), '100 messages on all streams');
    for (const c of committed) {
      streams.forEach((s, j) => {
        const event = s.frames.find(e => e.event === 'message.created' && e.data.subject_id === c.id)!;
        const latency = event.at - c.at; assert(latency >= 0, 'Event precedes COMMIT acknowledgement');
        latencies.push(latency); perClient[j].push(latency);
      });
    }
    metric(6, 'commit acknowledgement → message.created, 4 clients', latencies, now() - started);
    perClient.forEach((xs, i) => metric(6, `live stream client ${i + 1}`, xs, now() - started));
  } finally { await Promise.all(streams.map(s => s.close())); }
  // Genuine saved cursor, then 1,000 real HTTP posts/commits while disconnected.
  const channel = (await call(p, 'channel_create', { name: 'Missed events', scope, members: [] })).channel;
  const writers = await Promise.all([identity(p.tenantId), identity(p.tenantId)]);
  const checkpoint = await stream(p, 'now');
  await until(() => checkpoint.frames.some(e => e.event === 'cursor'), 'saved cursor');
  const cursor = checkpoint.frames.find(e => e.event === 'cursor')!.id; await checkpoint.close();
  for (let i = 0; i < 1000; i++) await call(writers[i % 2], 'thread_post', { thread_id: channel.id, body: 'Missed message', idempotency_key: uid() });
  const [xid, seq] = cursor.split('.');
  const ids = await pool.query('SELECT id FROM events WHERE tenant_id=$1 AND (xid,seq)>($2::xid8,$3::bigint)', [p.tenantId, xid, seq]);
  assert.equal(ids.rowCount, 1000);
  const expected = new Set(ids.rows.map(r => r.id)), catchups: number[] = [];
  for (let run = 0; run < 10; run++) {
    const t = now(), s = await stream(p, cursor);
    try {
      await until(() => s.frames.filter(e => expected.has(e.data.id)).length >= 1000, '1,000-event catch-up');
      const received = s.frames.filter(e => expected.has(e.data.id));
      assert.equal(received.length, 1000); assert.equal(new Set(received.map(e => e.id)).size, 1000);
      catchups.push(received.at(-1)!.at - t);
    } finally { await s.close(); }
  }
  metric(6, 'cursor reconnect → all 1,000 missed events', catchups, undefined, 10_000);
  notes.push('Live SSE uses transactional LISTEN/NOTIFY, a 2 s safety poll and immediate full-batch draining and default 15 s heartbeat. Posts are spaced by 5–23 ms plus HTTP time, independently of event arrivals; observed delivery rate is not a saturation test. Commit timestamps are server-side COMMIT acknowledgements, slightly after the database commit, not HTTP response completion. Four clients each received all 100 posted message ids. Reconnect replays exactly 1,000 real channel posts/events in separate HTTP transactions, checked for missing/duplicate cursors, ten times; event generation is excluded.');
}

function nodes(plan: any): any[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
function render(meta: Record<string, string>) {
  const lines = ['# Teams service performance — 2026-10-28', '', ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`), '',
    '## Method and limits', '',
    'Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx --env-file=.env.test scripts/perf-teams.ts`. Only TEST_DATABASE_URL from .env.test is accepted; no production configuration is read. A random schema uses the same sorted SQL migration list and search_path as tests/swarms.integration.test.ts, and is dropped in finally. Real AuthService/CoreService/HTTP handler, random loopback port, generated hashed bearer tokens; no provider subprocesses. Existing pg/tsx dependencies only.', '',
    'HTTP timings include authentication, JSON transfer and parsing on this Mac; no TLS or remote network. Single run, warmed data/cache, no CPU/storage isolation. Read fixtures are bulk seeded outside timed regions, then ANALYZE. Each scenario refreshes the handler to bound per-principal rate accounting; rate/concurrency controls are unchanged (loopback already skips the IP limiter). Pool max=8 as in the swarm integration harness; 20-way tests also include pool queueing. Percentiles are nearest-rank; p99=max for n<100. Throughput is completed operations / measured wall seconds, without untimed fixture/verification work. Locks report acquisitions/s; reconnect reports events/s; swarm total reports swarms/s.', '',
    'Benchmark-only client instrumentation wraps the unchanged advisory-lock SELECT in materialized timestamp CTEs. Lock samples are server acquisition duration (blocking plus executor overhead), excluding pool and network wait; they are not pure pg_stat_activity wait samples. Overlapping lock durations must not be added to swarm wall time. No service or migration source was edited.', '', ...notes.map(n => `- ${n}`), ''];
  for (let scenario = 1; scenario <= 7; scenario++) {
    lines.push(`## ${scenario}. ${['', 'Posting and turn queueing', 'Thread reads and reverse pagination', 'Sidebar, attention and questions', 'Turn actions: claim through swarm creation', 'Fan-out and tenant lock comparison', 'SSE delivery and reconnect', 'EXPLAIN (ANALYZE, BUFFERS)'][scenario]}`, '',
      '| Measurement | n | p50 ms | p95 ms | p99 ms | max ms | Throughput /s |', '|---|---:|---:|---:|---:|---:|---:|');
    for (const m of metrics.filter(m => m.scenario === scenario)) lines.push(`| ${m.name} | ${m.samples.length} | ${f(pct(m.samples, .5))} | ${f(pct(m.samples, .95))} | ${f(pct(m.samples, .99))} | ${f(Math.max(...m.samples))} | ${f((m.units ?? m.samples.length) * 1000 / m.elapsed)} |`);
    lines.push('');
  }
  lines.push('EXPLAIN latencies above are PostgreSQL Execution Time (planning/client time excluded); throughput includes planning and round trips. Twenty executions per actual captured SELECT and actual bound parameters. Read/list/claim SELECTs are captured from the handler, not approximated queries; duplicate per-agent status SQL is sampled once. Row locks from EXPLAIN claim selection are released by autocommit. Each plan below is the final execution, with root shared buffers (hits/reads).', '',
    '| Query | Execution nodes (relation/index) | Shared hits / reads | Seq scans on messages/tasks/swarm_steps |', '|---|---|---:|---|');
  for (const p of plans) {
    const ns = nodes(p.plan.Plan), scans = ns.filter(n => n['Node Type'] === 'Seq Scan' && ['messages', 'tasks', 'swarm_steps'].includes(n['Relation Name']));
    const path = ns.filter(n => n['Relation Name'] || n['Index Name']).map(n => `${n['Node Type']} ${n['Relation Name'] ?? ''}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`).join('; ');
    lines.push(`| ${p.label} | ${path || p.plan.Plan['Node Type']} | ${p.plan.Plan['Shared Hit Blocks'] ?? 0} / ${p.plan.Plan['Shared Read Blocks'] ?? 0} | ${scans.map(n => `${n['Relation Name']} (${n['Actual Rows']} rows × ${n['Actual Loops']} loops; ${n['Rows Removed by Filter'] ?? 0} removed)`).join('; ') || 'none'} |`);
  }
  const get = (name: string) => metrics.find(m => m.name.startsWith(name))!;
  const one = get('one-tenant: posts'), many = get('20-tenants: posts'), taskLock = get('scope:tasks acquisition'), teamLock = get('teams acquisition during swarm');
  const scanPlans = plans.filter(p => nodes(p.plan.Plan).some(n => n['Node Type'] === 'Seq Scan' && ['messages', 'tasks', 'swarm_steps'].includes(n['Relation Name'])));
  lines.push('', '## Ranked findings and concrete proposed fixes', '',
    `1. **Tenant-wide Teams lock limits independent posting.** Twenty tenants deliver ${f(many.samples.length * 1000 / many.elapsed)} posts/s versus ${f(one.samples.length * 1000 / one.elapsed)} in one tenant (${f(one.elapsed / many.elapsed)}×). Same-tenant lock p95 is ${f(pct(get('one-tenant: teamsLock').samples, .95))} ms versus ${f(pct(get('20-tenants: teamsLock').samples, .95))} ms spread out. Batches alternate order to reduce time drift. **Fix:** replace the tenant-only Teams key with ordered thread/agent/swarm keys; acquire every affected key for multi-object turn actions in a single consistent order. Review atomicity and deadlock ordering before changing it.`, '',
    `2. **Swarm workers queue on the task-scope lock, ahead of Teams.** Twenty-step total p50 is ${f(pct(get('20-step swarm total').samples, .5))} ms. Task-scope acquisition p50/p95 is ${f(pct(taskLock.samples, .5))}/${f(pct(taskLock.samples, .95))} ms; Teams p95 is only ${f(pct(teamLock.samples, .95))} ms. Across ten runs, summed task-scope acquisition is ${f(taskLock.samples.reduce((a, b) => a + b, 0))} ms and Teams is ${f(teamLock.samples.reduce((a, b) => a + b, 0))} ms (overlapping worker waits, not wall time). **Fix:** shorten the scope-wide task critical section and fence independent work with agent/resource leases and worker-slot rows; preserve claim/finish lock order. Narrowing Teams alone will not improve this path.`, '',
    `3. **SSE latency follows the fixed idle poll.** Commit-ack-to-arrival p50/p95 is ${f(pct(get('commit acknowledgement').samples, .5))}/${f(pct(get('commit acknowledgement').samples, .95))} ms. Replaying 1,000 real events takes p50 ${f(pct(get('cursor reconnect').samples, .5))} ms. **Fix:** wake the existing events SELECT on transactional LISTEN/NOTIFY and immediately drain full batches instead of sleeping 10 ms per batch; retain durable events and the xmin/cursor no-skip predicate. These are separate latency and catch-up improvements, not missing-data repairs.`, '',
    `4. **Sidebar status has an N+1 query cost.** ${notes.find(n => n.startsWith('agent_list executes'))} HTTP p95 is ${f(pct(get('agent_list (').samples, .95))} ms. **Fix:** batch running-task status by agent ids and live-worker availability by scope, then join/map once; retain the indexed unread-count query. An additional messages index does not remove these round trips.`, '',
    `5. **Attention can use purpose-built ordered partial indexes as history grows.** HTTP p95 is ${f(pct(get('attention_list (').samples, .95))} ms; the captured plans below separate database execution from HTTP time. **Fix candidates:** \`CREATE INDEX tasks_attention_failed ON tasks (tenant_id, scope, updated_at DESC) WHERE status='failed' AND resolved_at IS NULL;\` and \`CREATE INDEX tasks_attention_review ON tasks (tenant_id, scope, updated_at DESC) WHERE status='completed' AND resolved_at IS NULL AND kind IN ('patch','turn') AND (result->>'review_required')::boolean IS TRUE AND result->>'head_commit' IS NOT NULL;\`. Re-measure before attributing HTTP tails to SQL: this run does not establish either index as a measured win.`, '',
    `6. **Sequential-scan audit:** ${scanPlans.length ? scanPlans.map(p => p.label).join(', ') : 'no captured plan'} contains a planned scan on messages/tasks/swarm_steps; see actual loops above. The non-flow fixture can leave the claim sibling subplan unexecuted (0 loops), so a planned scan is not evidence of runtime table scanning. **Conditional fix for the sibling lookup:** \`CREATE INDEX tasks_flow_unhealthy ON tasks (flow_id) WHERE flow_id IS NOT NULL AND status IN ('blocked','failed','cancelled');\`. The existing tasks_flow_step index already leads with flow_id; validate with representative nonempty flows before adding a redundant index. Thread reads and swarm-step lookup already use messages_thread_seq_idx and swarm_steps_swarm_idx; no new index is justified there.`, '',
    'All fixes are proposals only. Source/migrations are unchanged. Synthetic task fixtures, fake worker execution and small warm-cache plans do not validate real provider latency, long production histories, cold storage, remote TLS or question-answer/reassignment correctness. No full CI, commit, push, restart or deployment was performed. Next action: coordinator reviews the lock changes first, then validates chosen fixes with this benchmark and focused concurrency tests.', '', '## Query and plan evidence', '');
  for (const p of plans) {
    lines.push(`### ${p.label}`, '', '```sql', p.query.sql.trim(), '```', '', `Planning ${f(p.plan['Planning Time'])} ms; execution ${f(p.plan['Execution Time'])} ms.`, '', '```text');
    const walk = (n: any, depth = 0) => {
      lines.push(`${'  '.repeat(depth)}${n['Node Type']} ${n['Relation Name'] ?? ''}${n['Alias'] ? ` as ${n['Alias']}` : ''}${n['Index Name'] ? ` using ${n['Index Name']}` : ''}: actual ${n['Actual Startup Time']}..${n['Actual Total Time']} ms, rows ${n['Actual Rows']}, loops ${n['Actual Loops']}, estimate ${n['Plan Rows']}, shared hit/read ${n['Shared Hit Blocks'] ?? 0}/${n['Shared Read Blocks'] ?? 0}${n.Filter ? `, filter ${n.Filter}, removed ${n['Rows Removed by Filter'] ?? 0}` : ''}`);
      for (const child of n.Plans ?? []) walk(child, depth + 1);
    };
    walk(p.plan.Plan); lines.push('```', '');
  }
  return lines.join('\n');
}

async function main() {
  assert(/^v24\./.test(process.version), 'Use Node 24.x');
  const testEnv = parseEnv(await readFile(new URL('../.env.test', import.meta.url), 'utf8'));
  const connectionString = testEnv.TEST_DATABASE_URL;
  assert(connectionString && process.env.TEST_DATABASE_URL === connectionString, 'Load the explicit TEST_DATABASE_URL from .env.test');
  assert(/test/i.test(new URL(connectionString).pathname), 'TEST_DATABASE_URL must identify a disposable test database');
  const schema = `swarms_test_${uid().replaceAll('-', '')}`, control = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  let created = false, clean = false;
  const migrations = (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort();
  const meta: Record<string, string> = {
    Source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    Machine: `${execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim()}; ${execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim()} bytes RAM`,
    Runtime: `${process.version}; ${process.platform}/${process.arch}; pg pool max=8`,
    Started: new Date().toISOString(), Migrations: migrations.join(', ')
  };
  try {
    await control.query(`CREATE SCHEMA ${schema}`); created = true;
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public`, application_name: 'teams-perf', connectionTimeoutMillis: 10_000, statement_timeout: 30_000 });
    // pg-pool may invoke a queued checkout under the releasing request's context.
    // Bind callback checkouts to their caller before attributing SELECTs/commits.
    const connect = pool.connect.bind(pool);
    pool.connect = ((callback?: (...args: any[]) => void) => callback
      ? (connect as any)(AsyncLocalStorage.bind(callback)) : connect()) as typeof pool.connect;
    pool.on('connect', instrument);
    meta.PostgreSQL = (await pool.query('SELECT version() AS version')).rows[0].version;
    for (const file of migrations) await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    console.log('Isolated schema migrated; starting seven scenarios.');
    await scenarios();
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
    await pool?.end();
    try {
      if (created) {
        await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        clean = !(await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount;
        assert(clean, 'Schema cleanup verification failed');
      }
    } finally { await control.end(); }
    console.log(`Schema cleanup: ${clean ? 'verified absent' : 'not created'}.`);
  }
  meta.Finished = new Date().toISOString(); meta.Cleanup = 'random schema dropped; pg_namespace confirms absent';
  await mkdir(new URL('../docs/perf/', import.meta.url), { recursive: true });
  const report = new URL('../docs/perf/teams-2026-10-28.md', import.meta.url);
  if (process.argv.includes('--after-fixes')) {
    const lines = ['\n## After fixes', '', ...Object.entries(meta).map(([k, v]) => `- **${k}:** ${v}`),
      '- Source is the uncommitted service-fix patch on the recorded baseline; original measurements above are preserved.',
      '- LISTEN/NOTIFY wakes streams; 2 s safety poll; full batches drain without sleeps. Default thread reads select the latest page.',
      ...notes.filter(n => n.startsWith('agent_list')).map(n => `- ${n}`), '',
      '| Scenario | Measurement | n | p50 ms | p95 ms | p99 ms | max ms | Throughput /s |',
      '|---|---|---:|---:|---:|---:|---:|---:|'];
    for (const m of metrics.filter(m => m.scenario === 3 || m.scenario === 6)) lines.push(`| ${m.scenario} | ${m.name} | ${m.samples.length} | ${f(pct(m.samples, .5))} | ${f(pct(m.samples, .95))} | ${f(pct(m.samples, .99))} | ${f(Math.max(...m.samples))} | ${f((m.units ?? m.samples.length) * 1000 / m.elapsed)} |`);
    await appendFile(report, lines.join('\n') + '\n');
  } else await writeFile(report, render(meta));
  console.log(`Report written: ${metrics.length} metric rows; ${plans.length} real query plans.`);
}
main().catch(error => { console.error(`Benchmark failed: ${String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted database URL]')}`); process.exitCode = 1; });
