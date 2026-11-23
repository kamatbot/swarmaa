/** Needs a disposable PostgreSQL database via TEST_DATABASE_URL; skipped otherwise. Uses a fake local action runner (never osascript). */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { CoreService } from '../src/core/index.js';
import { setLocalActionRunner, setLocalActionWait, sweepLocalActions } from '../src/core/voice.js';
import { ROLE_PERMISSIONS } from '../src/policy.js';
import type { Principal } from '../src/types.js';
import type { LocalAction, LocalActionResult, LocalActionRunner, LocalActionRunOptions } from '../src/voice/types.js';

const connectionString = process.env.TEST_DATABASE_URL;

describe('voice service', { skip: !connectionString, concurrency: false }, () => {
  const schema = `voice_service_test_${randomUUID().replaceAll('-', '')}`;
  let control: Pool, pool: Pool, core: CoreService, dir: string;
  const runs: Array<{ id: string; action: LocalAction; opts?: LocalActionRunOptions }> = [], undos: Array<{ id: string; handle: string }> = [];
  let next: (action: LocalAction) => LocalActionResult = a => ({ ok: true, handle: `h-${runs.length}`, summary: `Done: ${a.type}` });
  const fake: LocalActionRunner = {
    async run(id, action, opts) { runs.push({ id, action, opts }); return next(action); },
    async undo(id, _action, handle) { undos.push({ id, handle }); return { ok: true, summary: 'Removed' }; },
    async check() { return { reminders: 'ok', calendar: 'disabled', notes: 'ok' }; },
    async warm() { warms++; },
  };
  let warms = 0;

  before(async () => {
    control = new pg.Pool({ connectionString, max: 1 });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema},public` });
    for (const file of (await readdir(new URL('../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    core = new CoreService(pool);
    setLocalActionRunner(fake);
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'voice-service-')));
    process.env.SWARMAA_MEMO_DIR = path.join(dir, 'memos');
  });

  after(async () => {
    setLocalActionRunner(undefined); setLocalActionWait(4000);
    await new Promise(r => setTimeout(r, 200)); // let background runs settle
    await pool?.end();
    if (control) { await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.end(); }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const call = async (p: Principal, name: string, args: Record<string, unknown>) => await core.call(p, name, args) as Record<string, any>;
  const rejects = (promise: Promise<unknown>, status: number, code: string) =>
    assert.rejects(promise, (e: any) => { assert.equal(e.code, code); assert.equal(e.status, status); return true; });
  async function principal(tenantId: string, role: Principal['role'] = 'frontend') {
    const p: Principal = { id: randomUUID(), tenantId, name: `p-${randomUUID()}`, role, scopes: ['project:a'], permissions: [...ROLE_PERMISSIONS[role]] };
    await pool.query(`INSERT INTO principals(id, tenant_id, name, role, scopes, permissions, token_hash, last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`, [p.id, tenantId, p.name, p.role, p.scopes, p.permissions, randomUUID()]);
    return p;
  }
  async function bot(user: Principal, name: string, rules: Record<string, unknown> = {}) {
    const lead = (await call(user, 'agent_create', { name: `${name}Lead`, role: 'Lead', instructions: 'Help', scope: 'project:a', runner: { provider: 'codex' } })).agent;
    return await call(user, 'bot_create', { name, job: 'Help', scope: 'project:a', lead_agent_id: lead.id, member_agent_ids: [], rules: { first_reply: 'off', ...rules } });
  }
  async function setup() {
    const tenant = randomUUID(), user = await principal(tenant);
    const assistant = await bot(user, 'Assistant', { dispatch_all_projects: true, local_actions: true });
    return { tenant, user, thread: assistant.thread.id as string, assistant };
  }
  const memo = (thread: string, transcript: string, extra: Record<string, unknown> = {}) => ({
    memo_id: randomUUID(), thread_id: thread, transcript, captured_at: '2026-11-22T03:00:00Z', spoken_at: '2026-11-22T03:00:05Z',
    time_zone: 'Asia/Bangkok', source: 'ring', duration_seconds: 4, timings: { idle: 0, transcribed: 1200 }, ...extra });
  const memoMessages = async (thread: string) => (await pool.query("SELECT id, body, ref, author FROM messages WHERE thread_id=$1 AND body LIKE '🎙 Voice memo%'", [thread])).rows;
  const turns = async (thread: string) => (await pool.query("SELECT objective FROM tasks WHERE thread_id=$1 AND kind='turn' AND status='queued'", [thread])).rows;
  const cards = async (thread: string) => (await pool.query("SELECT body, ref FROM messages WHERE thread_id=$1 AND kind='notice' AND ref ? 'local_action'", [thread])).rows;

  it('runs a local action once per memo and rejects a different transcript', async () => {
    const ctx = await setup(), outsider = await setup();
    const req = memo(ctx.thread, 'Remind me to call mom at 5 pm');
    await rejects(call(outsider.user, 'voice_intent', req), 404, 'thread_not_found');
    const before = runs.length;
    const res = await call(ctx.user, 'voice_intent', req);
    assert.equal(res.route, 'local');
    assert.equal(res.actions.length, 1);
    assert.equal(res.actions[0].type, 'reminder.create');
    assert.equal(res.actions[0].status, 'done');
    assert.equal(res.actions[0].undoable, true);
    assert.ok(res.message_seq > 0);
    const again = await call(ctx.user, 'voice_intent', req);
    assert.deepEqual(again, res);
    assert.equal(runs.length - before, 1);
    assert.equal(runs.at(-1)!.action.type, 'reminder.create');
    assert.equal((await memoMessages(ctx.thread)).length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM local_actions WHERE thread_id=$1", [ctx.thread])).rows[0].n, 1);
    const card = await cards(ctx.thread);
    assert.equal(card.length, 1);
    assert.equal(card[0].ref.local_action.status, 'done');
    assert.equal(card[0].ref.local_action.title, 'Call mom');
    assert.equal((await turns(ctx.thread)).length, 0);
    await rejects(call(ctx.user, 'voice_intent', { ...req, transcript: 'Remind me to call dad' }), 409, 'memo_conflict');
    const row = (await pool.query('SELECT parse_ms, exec_ms, timings FROM voice_intents WHERE memo_id=$1', [req.memo_id])).rows[0];
    assert.equal(typeof row.parse_ms, 'number'); assert.equal(typeof row.exec_ms, 'number'); assert.equal(row.timings.transcribed, 1200);
  });

  it('attaches later audio to the memo message and queues no turn', async () => {
    const { user, thread } = await setup();
    const req = memo(thread, 'Note to self buy milk');
    assert.equal((await call(user, 'voice_intent', req)).route, 'local');
    const data = Buffer.alloc(1_000, 3); data.write('ftypM4A ', 4, 'ascii');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' }); // memo storage is Mac-only; the file I/O works anywhere
    try {
      const put = await call(user, 'watch_memo_put', { memo_id: req.memo_id, thread_id: thread, sha256: createHash('sha256').update(data).digest('hex'),
        byte_length: data.length, captured_at: '2026-11-22T03:00:00Z', index: 0, data_base64: data.toString('base64'), transcript: 'Note to self buy milk' });
      assert.equal(put.status, 'stored');
    } finally { Object.defineProperty(process, 'platform', platform); }
    const msgs = await memoMessages(thread);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].ref.voice_memo.memo_id, req.memo_id);
    assert.equal(msgs[0].ref.voice_intent.memo_id, req.memo_id);
    assert.equal((await turns(thread)).length, 0);
  });

  it('routes free-form memos to exactly one Assistant turn', async () => {
    const { user, thread } = await setup();
    const req = memo(thread, 'I wonder whether the blue design is better');
    const res = await call(user, 'voice_intent', req);
    assert.equal(res.route, 'assistant'); assert.deepEqual(res.actions, []);
    await call(user, 'voice_intent', req);
    const queued = await turns(thread);
    assert.equal(queued.length, 1);
    assert.match(queued[0].objective, /local_action/);
    assert.doesNotMatch(queued[0].objective, /Remind me later/);
  });

  it('delegates "ask <bot>" into that bot\'s thread as the person', async () => {
    const { user, thread } = await setup();
    const ledger = await bot(user, 'Ledger');
    const res = await call(user, 'voice_intent', memo(thread, 'Ask Ledger to check the budget'));
    assert.equal(res.route, 'delegate');
    assert.deepEqual(res.delegated_to, { bot_id: ledger.bot.id, name: 'Ledger' });
    const posted = (await pool.query('SELECT body, author, ref FROM messages WHERE thread_id=$1 ORDER BY seq DESC LIMIT 1', [ledger.thread.id])).rows[0];
    assert.equal(posted.author.kind, 'human'); assert.equal(posted.author.id, user.id);
    assert.match(posted.body, /check the budget/);
    const queued = (await pool.query("SELECT context_versions FROM tasks WHERE thread_id=$1 AND kind='turn' AND status='queued'", [ledger.thread.id])).rows;
    assert.equal(queued.length, 1);
    assert.equal(queued[0].context_versions.dispatched_from.thread_id, thread);
    assert.equal((await turns(thread)).length, 0);
  });

  it('refuses workers and principals without thread:write', async () => {
    const { tenant, thread } = await setup();
    const worker = await principal(tenant, 'worker');
    await rejects(call(worker, 'voice_intent', memo(thread, 'Remind me to stretch')), 403, 'forbidden');
    await rejects(call(worker, 'local_action_check', {}), 403, 'forbidden');
    const writerWorker = { ...worker, permissions: [...worker.permissions, 'thread:read', 'thread:write'] as Principal['permissions'] };
    await rejects(call(writerWorker, 'voice_intent', memo(thread, 'Remind me to stretch')), 403, 'forbidden');
    await rejects(call(writerWorker, 'local_action_list', { thread_id: thread }), 403, 'forbidden');
  });

  it('falls back to the Assistant when the action is disabled', async () => {
    const { user, thread } = await setup();
    next = () => ({ ok: false, code: 'action_disabled', summary: 'Reminders are turned off' });
    try {
      const res = await call(user, 'voice_intent', memo(thread, 'Remind me to water the plants tomorrow at 9'));
      assert.equal(res.route, 'assistant');
      assert.equal(res.actions[0].status, 'failed');
      assert.equal(res.actions[0].code, 'action_disabled');
    } finally { next = a => ({ ok: true, handle: `h-${runs.length}`, summary: `Done: ${a.type}` }); }
    assert.equal((await turns(thread)).length, 1);
    assert.equal((await cards(thread)).length, 0);
  });

  it('runs, lists, checks and undoes tool actions idempotently', async () => {
    const { user, thread } = await setup();
    const action = { type: 'note.append', text: 'Buy oat milk', notebook: 'inbox' };
    const before = runs.length;
    const run = await call(user, 'local_action_run', { thread_id: thread, action, idempotency_key: 'k1' });
    assert.equal(run.action.status, 'done');
    assert.deepEqual(await call(user, 'local_action_run', { thread_id: thread, action, idempotency_key: 'k1' }), run);
    assert.equal(runs.length - before, 1);
    await rejects(call(user, 'local_action_run', { thread_id: thread, action: { ...action, text: 'Other' }, idempotency_key: 'k1' }), 409, 'idempotency_conflict');
    await rejects(call(user, 'local_action_run', { thread_id: thread, action: { type: 'shell', cmd: 'rm' }, idempotency_key: 'k2' }), 400, 'invalid_action');
    const undone = await call(user, 'local_action_undo', { action_id: run.action.id });
    assert.equal(undone.action.status, 'undone'); assert.equal(undone.action.undoable, false);
    assert.equal(undos.at(-1)!.id, run.action.id);
    await call(user, 'local_action_undo', { action_id: run.action.id });
    assert.equal(undos.filter(u => u.id === run.action.id).length, 1);
    const card = await cards(thread);
    assert.equal(card.length, 1); assert.equal(card[0].ref.local_action.status, 'undone');
    const list = await call(user, 'local_action_list', { thread_id: thread });
    assert.equal(list.actions.length, 1); assert.equal(list.actions[0].origin_kind, 'tool');
    assert.deepEqual((await call(user, 'local_action_check', {})).apps, { reminders: 'ok', calendar: 'disabled', notes: 'ok' });
  });

  it('returns running after the wait and the sweep reruns stale rows', async () => {
    const { user, thread } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const original = fake.run;
    fake.run = async (id, a) => { await gate; return original(id, a); };
    setLocalActionWait(50);
    try {
      const res = await call(user, 'local_action_run', { thread_id: thread, action: { type: 'timer.start', label: 'Tea', fire_at: '2026-11-22T04:00:00Z' }, idempotency_key: 'slow' });
      assert.equal(res.action.status, 'running');
    } finally { release(); fake.run = original; setLocalActionWait(4000); }
    // A row left queued (crash after commit) is rerun by the sweep once it is 30 s old.
    const id = randomUUID();
    await pool.query(`INSERT INTO local_actions (id,tenant_id,scope,thread_id,origin_kind,origin_id,ordinal,type,action,action_sha256,created_by,updated_at)
      VALUES ($1,$2,'project:a',$3,'tool',$4,0,'note.append',$5::jsonb,$6,$7,clock_timestamp() - interval '1 minute')`,
    [id, user.tenantId, thread, `${user.id}:stale`, JSON.stringify({ type: 'note.append', text: 'Stale' }), 'a'.repeat(64), user.id]);
    assert.ok(await sweepLocalActions(pool) >= 1);
    assert.equal((await pool.query('SELECT status FROM local_actions WHERE id=$1', [id])).rows[0].status, 'done');
  });

  it('applies a local_action turn action only for bots with rules.local_actions', async () => {
    const { tenant, user, thread } = await setup();
    const plain = await bot(user, 'Plain');
    const worker = await principal(tenant, 'worker');
    const answer = 'Set.\n\n```swarmaa-actions\n' + JSON.stringify([{ type: 'local_action', action: { type: 'reminder.create', title: 'Pay rent', due_at: '2026-11-23T02:00:00Z' } }]) + '\n```';
    const turn = async (threadId: string) => {
      await call(user, 'thread_post', { thread_id: threadId, body: 'Remind me to pay rent tomorrow', idempotency_key: randomUUID() });
      const claim = await call(worker, 'task_claim', { scope: 'project:a', capabilities: ['codex.read'], kinds: ['turn'] });
      assert.ok(claim.task);
      if (threadId === thread) assert.equal(claim.task.local_actions, true);
      await call(worker, 'task_finish', { task_id: claim.task.id, lease_token: claim.lease_token, lease_generation: claim.lease_generation, outcome: 'completed', result: { answer } });
      return claim.task.id as string;
    };
    const taskId = await turn(thread);
    let row: any;
    for (let i = 0; i < 50 && row?.status !== 'done'; i++) {
      await new Promise(r => setTimeout(r, 20));
      row = (await pool.query("SELECT * FROM local_actions WHERE origin_kind='turn' AND origin_id=$1", [taskId])).rows[0];
    }
    assert.equal(row?.status, 'done');
    assert.equal(row?.runner, 'mac', 'turn-origin actions never run on a device');
    for (let i = 0; i < 50 && !(await cards(thread)).length; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await cards(thread)).length, 1);
    const plainTask = await turn(plain.thread.id);
    assert.equal((await pool.query("SELECT 1 FROM local_actions WHERE origin_id=$1", [plainTask])).rowCount, 0);
    assert.ok((await pool.query("SELECT 1 FROM messages WHERE thread_id=$1 AND body LIKE 'Turn action rejected: local_action%'", [plain.thread.id])).rowCount);
  });

  it('voice_warm: closed schema, no workers, never waits on the runner', async () => {
    const { tenant, user } = await setup();
    const worker = await principal(tenant, 'worker');
    await rejects(call(worker, 'voice_warm', {}), 403, 'forbidden');
    const writerWorker = { ...worker, permissions: [...worker.permissions, 'thread:read', 'thread:write'] as Principal['permissions'] };
    await rejects(call(writerWorker, 'voice_warm', {}), 403, 'forbidden');
    await rejects(call(user, 'voice_warm', { thread_id: randomUUID() }), 400, 'invalid_arguments');
    const reader = { ...user, permissions: user.permissions.filter(x => x !== 'thread:write') };
    await rejects(call(reader, 'voice_warm', {}), 403, 'forbidden');
    const before = warms;
    const original = fake.warm;
    fake.warm = () => new Promise(() => {}); // a hung osascript launch must not hold the reply
    try { assert.deepEqual(await call(user, 'voice_warm', {}), { ok: true, device_pending: 0 }); } finally { fake.warm = original; }
    assert.deepEqual(await call(user, 'voice_warm', {}), { ok: true, device_pending: 0 });
    assert.equal(warms, before + 1);
    assert.ok(core.listTools(user).some(t => t.name === 'voice_warm'));
    assert.ok(!core.listTools(worker).some(t => t.name === 'voice_warm'));
  });

  it('passes fresh on attempt 1 and the memo zone to the card; a sweep rerun is not fresh', async () => {
    const { user, thread } = await setup();
    const req = memo(thread, 'Remind me to call mom at 5 pm');
    await call(user, 'voice_intent', req);
    const first = runs.at(-1)!;
    assert.deepEqual(first.opts, { fresh: true, timeZone: 'Asia/Bangkok' });
    // A row left running by a crash (attempt 1 claimed, never finished) is rerun with the marker lookup.
    const id = randomUUID();
    await pool.query(`INSERT INTO local_actions (id,tenant_id,scope,thread_id,origin_kind,origin_id,ordinal,type,action,action_sha256,created_by,status,attempts,updated_at)
      VALUES ($1,$2,'project:a',$3,'tool',$4,0,'timer.start',$5::jsonb,$6,$7,'running',1,clock_timestamp() - interval '1 minute')`,
    [id, user.tenantId, thread, `${user.id}:crashed`, JSON.stringify({ type: 'timer.start', label: 'Tea', fire_at: '2026-11-22T04:00:00Z' }), 'b'.repeat(64), user.id]);
    await sweepLocalActions(pool);
    const rerun = runs.find(r => r.id === id)!;
    assert.deepEqual(rerun.opts, { fresh: false }, 'tool origin: no zone, default formatting');
    assert.equal((await pool.query('SELECT status FROM local_actions WHERE id=$1', [id])).rows[0].status, 'done');
  });

  it('a replayed memo whose action is still running waits for it and answers done', async () => {
    const { user, thread } = await setup();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const original = fake.run;
    fake.run = async (id, a, o) => { await gate; return original(id, a, o); };
    const req = memo(thread, 'Remind me to stretch at 6 pm');
    let actionId = '';
    try {
      setLocalActionWait(50);
      const slow = await call(user, 'voice_intent', req);
      assert.equal(slow.actions[0].status, 'running');
      setLocalActionWait(4000);
      setTimeout(release, 100);
      const replay = await call(user, 'voice_intent', req);
      assert.equal(replay.route, 'local');
      assert.equal(replay.actions[0].status, 'done');
      assert.equal(replay.actions[0].undoable, true);
      assert.equal(replay.actions[0].id, slow.actions[0].id);
      actionId = slow.actions[0].id;
      assert.deepEqual(await call(user, 'voice_intent', req), replay);
    } finally { release(); fake.run = original; setLocalActionWait(4000); }
    assert.equal(runs.filter(r => r.id === actionId).length, 1, 'the replay joined the running execution');
  });
  // ---- device actions (docs/RING-AGENT.md §11)
  const ALL = ['reminders', 'calendar', 'alarms'];
  const card1 = async (thread: string, id: string) => (await cards(thread)).find(c => c.ref.local_action.id === id)!;
  const auditRows = async (id: string) => (await pool.query("SELECT operation, details FROM audit_log WHERE subject_id=$1 AND details->>'runner'='device' ORDER BY created_at", [id])).rows;

  it('runs an advertised reminder on the iPhone: queued card, report, repeat, conflict, replay', async () => {
    const { user, thread } = await setup();
    const dev = randomUUID(), other = randomUUID();
    const req = memo(thread, 'Remind me to call mom at 5 pm', { device_id: dev, device_actions: ALL });
    const before = runs.length;
    const res = await call(user, 'voice_intent', req);
    assert.equal(res.route, 'device');
    assert.equal(runs.length, before, 'the Mac runner is not called');
    const a = res.actions[0];
    assert.equal(a.runner, 'device'); assert.equal(a.status, 'queued'); assert.equal(a.undoable, false);
    assert.deepEqual(a.action, { type: 'reminder.create', title: 'Call mom', due_at: '2026-11-22T10:00:00.000Z' });
    assert.match(a.summary, /^Reminder set: Call mom · .*17:00$/, 'success text in the phone zone');
    let card = await card1(thread, a.id);
    assert.match(card.body, /^Reminder: Call mom · .*17:00 · waiting for your iPhone$/);
    assert.equal(card.ref.local_action.status, 'queued'); assert.equal(card.ref.local_action.runner, 'device');
    assert.equal((await turns(thread)).length, 0);
    const vi = (await pool.query('SELECT route, device_capable FROM voice_intents WHERE memo_id=$1', [req.memo_id])).rows[0];
    assert.deepEqual(vi, { route: 'local', device_capable: true });
    assert.deepEqual(await call(user, 'voice_intent', req), res, 'replay: same shape, current status');
    assert.equal((await call(user, 'voice_warm', {})).device_pending, 1);
    assert.deepEqual((await call(user, 'local_action_pending', { device_id: other })).actions, [], 'claimed by the sending device');
    const pending = (await call(user, 'local_action_pending', { device_id: dev })).actions;
    assert.equal(pending.length, 1); assert.equal(pending[0].id, a.id); assert.equal(pending[0].op, 'run'); assert.deepEqual(pending[0].action, a.action);

    const done = await call(user, 'local_action_report', { action_id: a.id, status: 'done', handle: 'ek-1', exec_ms: 30 });
    assert.equal(done.action.status, 'done'); assert.equal(done.action.undoable, true); assert.match(done.action.summary, /^Reminder set: Call mom/);
    card = await card1(thread, a.id);
    assert.match(card.body, /^Reminder set: Call mom/); assert.equal(card.ref.local_action.undoable, true);
    assert.deepEqual(await call(user, 'local_action_report', { action_id: a.id, status: 'done', handle: 'ek-1' }), done, 'repeat is a no-op');
    await rejects(call(user, 'local_action_report', { action_id: a.id, status: 'failed', code: 'permission_denied' }), 409, 'action_conflict');
    const replay = await call(user, 'voice_intent', req);
    assert.equal(replay.route, 'device'); assert.equal(replay.actions[0].status, 'done');
    assert.equal(runs.length, before);
    assert.equal((await call(user, 'voice_warm', {})).device_pending, 0);
    assert.deepEqual((await auditRows(a.id)).map(r => r.operation), ['local_action.create', 'local_action.run']);
  });

  it('undoes a device row through the phone: undoing, pending op undo, failed → done, undone', async () => {
    const { user, thread } = await setup();
    const dev = randomUUID();
    const res = await call(user, 'voice_intent', memo(thread, 'Remind me to stretch at 6 pm', { device_id: dev, device_actions: ['reminders'] }));
    const id = res.actions[0].id;
    await call(user, 'local_action_report', { action_id: id, status: 'done', handle: 'ek-2' });
    const undosBefore = undos.length;
    const u = await call(user, 'local_action_undo', { action_id: id });
    assert.equal(u.action.status, 'undoing'); assert.equal(u.action.undoable, false);
    assert.equal(undos.length, undosBefore, 'the Mac undo is not called');
    assert.match((await card1(thread, id)).body, /^Undoing on your iPhone…/);
    assert.equal((await call(user, 'local_action_undo', { action_id: id })).action.status, 'undoing', 'repeat undo is a no-op');
    let pending = (await call(user, 'local_action_pending', { device_id: dev })).actions;
    assert.equal(pending.length, 1); assert.equal(pending[0].op, 'undo'); assert.equal(pending[0].handle, 'ek-2');
    const failed = await call(user, 'local_action_report', { action_id: id, status: 'failed', code: 'failed' });
    assert.equal(failed.action.status, 'done', 'a failed undo returns to done'); assert.equal(failed.action.undoable, true);
    assert.match((await card1(thread, id)).body, /^Reminder set: Stretch/);
    await call(user, 'local_action_undo', { action_id: id });
    pending = (await call(user, 'local_action_pending', { device_id: dev })).actions;
    assert.equal(pending[0].op, 'undo');
    const undone = await call(user, 'local_action_report', { action_id: id, status: 'undone' });
    assert.equal(undone.action.status, 'undone');
    const card = await card1(thread, id);
    assert.match(card.body, /^Undone: Reminder set: Stretch/); assert.equal(card.ref.local_action.status, 'undone');
    assert.deepEqual(await call(user, 'local_action_report', { action_id: id, status: 'undone' }), undone);
    await rejects(call(user, 'local_action_report', { action_id: id, status: 'failed' }), 409, 'action_conflict');
    assert.deepEqual((await auditRows(id)).map(r => r.operation), ['local_action.create', 'local_action.run', 'local_action.fail', 'local_action.undo']);
  });

  it('runner choice: not advertised → Mac, notes always Mac, unknown names ignored, timers on alarms or reminders', async () => {
    const { user, thread } = await setup();
    const dev = randomUUID();
    let before = runs.length;
    const mac = await call(user, 'voice_intent', memo(thread, 'Remind me to call mom at 5 pm', { device_id: dev, device_actions: ['calendar', 'contacts'] }));
    assert.equal(mac.route, 'local'); assert.equal(mac.actions[0].runner, 'mac'); assert.equal(mac.actions[0].status, 'done');
    assert.equal(mac.actions[0].action, undefined);
    assert.equal(runs.length - before, 1);
    before = runs.length;
    const note = await call(user, 'voice_intent', memo(thread, 'Note to self buy milk', { device_id: dev, device_actions: ALL }));
    assert.equal(note.route, 'local'); assert.equal(note.actions[0].runner, 'mac'); assert.equal(runs.length - before, 1);
    const unknown = await call(user, 'voice_intent', memo(thread, 'Remind me to water the plants', { device_id: dev, device_actions: ['home', 'reminders'] }));
    assert.equal(unknown.route, 'device');
    const wake = await call(user, 'voice_intent', memo(thread, 'Wake me at 7', { device_id: dev, device_actions: ['alarms'] }));
    assert.equal(wake.route, 'device'); assert.equal(wake.actions[0].action.kind, 'alarm'); assert.match(wake.actions[0].summary, /^Alarm set: Wake up/);
    assert.match((await card1(thread, wake.actions[0].id)).body, /^Alarm: Wake up · .* · waiting for your iPhone$/);
    const timer = await call(user, 'voice_intent', memo(thread, 'Timer for 5 minutes', { device_id: dev, device_actions: ['reminders'] }));
    assert.equal(timer.route, 'device'); assert.equal(timer.actions[0].action.kind, 'timer');
    before = runs.length;
    const timerMac = await call(user, 'voice_intent', memo(thread, 'Timer for 5 minutes', { device_id: dev, device_actions: ['calendar'] }));
    assert.equal(timerMac.route, 'local'); assert.equal(timerMac.actions[0].runner, 'mac'); assert.equal(runs.length - before, 1);
    assert.equal(runs.at(-1)!.action.type, 'timer.start');
  });

  it('flips a Mac permission failure to the phone only for device-capable requests', async () => {
    const { user, thread } = await setup();
    const dev = randomUUID();
    next = () => ({ ok: false, code: 'permission_denied', summary: 'Couldn\'t set the reminder: Swarmaa needs Reminders access' });
    try {
      const before = runs.length;
      const res = await call(user, 'voice_intent', memo(thread, 'Remind me to pay rent tomorrow at 9', { device_id: dev, device_actions: [] }));
      assert.equal(runs.length - before, 1, 'the Mac tried first');
      assert.equal(res.route, 'device'); assert.equal(res.actions[0].runner, 'device'); assert.equal(res.actions[0].status, 'queued');
      assert.equal(res.actions[0].code, undefined); assert.equal(res.actions[0].action.title, 'Pay rent');
      assert.match((await card1(thread, res.actions[0].id)).body, /waiting for your iPhone$/);
      assert.equal((await turns(thread)).length, 0, 'no Assistant turn');
      assert.equal((await call(user, 'local_action_pending', { device_id: dev })).actions[0].id, res.actions[0].id);
      // The iPhone has no access either: it reports permission_denied and the card says where to allow it.
      const failed = await call(user, 'local_action_report', { action_id: res.actions[0].id, status: 'failed', code: 'permission_denied' });
      assert.equal(failed.action.status, 'failed');
      assert.equal(failed.action.summary, "Couldn't set the reminder: allow Reminders in Swarmaa › This iPhone on your iPhone");
      const old = await call(user, 'voice_intent', memo(thread, 'Remind me to pay rent tomorrow at 10'));
      assert.equal(old.route, 'local', 'old client: today\'s behaviour'); assert.equal(old.actions[0].status, 'failed');
      assert.equal(old.actions[0].code, 'permission_denied'); assert.equal(old.actions[0].runner, 'mac');
      next = () => ({ ok: false, code: 'action_disabled', summary: 'off' });
      const disabled = await call(user, 'voice_intent', memo(thread, 'Remind me to pay rent tomorrow at 11', { device_id: dev, device_actions: [] }));
      assert.equal(disabled.route, 'device');
      const note = await call(user, 'voice_intent', memo(thread, 'Note to self disabled notes', { device_id: dev, device_actions: ALL }));
      assert.equal(note.route, 'assistant', 'a note never flips');
    } finally { next = a => ({ ok: true, handle: `h-${runs.length}`, summary: `Done: ${a.type}` }); }
  });

  it('pending claims by device_id: unclaimed rows go to the first device that asks', async () => {
    const { user, thread } = await setup();
    const a = randomUUID(), b = randomUUID(), id = randomUUID();
    await pool.query(`INSERT INTO local_actions (id,tenant_id,scope,thread_id,origin_kind,origin_id,ordinal,type,action,action_sha256,created_by,runner,summary)
      VALUES ($1,$2,'project:a',$3,'tool',$4,0,'reminder.create',$5::jsonb,$6,$7,'device','Reminder set: Unclaimed')`,
    [id, user.tenantId, thread, `${user.id}:unclaimed`, JSON.stringify({ type: 'reminder.create', title: 'Unclaimed' }), 'c'.repeat(64), user.id]);
    const got = (await call(user, 'local_action_pending', { device_id: a, limit: 5 })).actions;
    assert.deepEqual(got.map((x: any) => x.id), [id]);
    assert.deepEqual((await call(user, 'local_action_pending', { device_id: b })).actions, []);
    assert.equal((await call(user, 'local_action_pending', { device_id: a })).actions.length, 1, 'still pending for its device until reported');
    const outsider = await setup();
    assert.deepEqual((await call(outsider.user, 'local_action_pending', { device_id: a })).actions, []);
    await rejects(call(outsider.user, 'local_action_report', { action_id: id, status: 'done' }), 404, 'not_found');
  });

  it('the sweep never runs device rows, expires them after 24 h, and a late done wins', async () => {
    const { user, thread } = await setup();
    const dev = randomUUID();
    const res = await call(user, 'voice_intent', memo(thread, 'Remind me to renew the passport', { device_id: dev, device_actions: ['reminders'] }));
    const id = res.actions[0].id, before = runs.length;
    await pool.query("UPDATE local_actions SET updated_at=clock_timestamp() - interval '1 minute' WHERE id=$1", [id]);
    await sweepLocalActions(pool);
    assert.equal(runs.length, before); assert.equal((await pool.query('SELECT status FROM local_actions WHERE id=$1', [id])).rows[0].status, 'queued');
    await pool.query("UPDATE local_actions SET updated_at=clock_timestamp() - interval '25 hours' WHERE id=$1", [id]);
    await sweepLocalActions(pool);
    assert.equal(runs.length, before);
    const row = (await pool.query('SELECT status, code, summary FROM local_actions WHERE id=$1', [id])).rows[0];
    assert.deepEqual(row, { status: 'failed', code: 'timeout', summary: "Couldn't set the reminder: your iPhone didn't pick it up" });
    assert.equal((await card1(thread, id)).body, row.summary);
    const late = await call(user, 'local_action_report', { action_id: id, status: 'done', handle: 'ek-late' });
    assert.equal(late.action.status, 'done'); assert.match((await card1(thread, id)).body, /^Reminder set: Renew the passport/);
    await call(user, 'local_action_undo', { action_id: id });
    await pool.query("UPDATE local_actions SET updated_at=clock_timestamp() - interval '25 hours' WHERE id=$1", [id]);
    await sweepLocalActions(pool);
    assert.equal((await pool.query('SELECT status FROM local_actions WHERE id=$1', [id])).rows[0].status, 'done', 'a stale undo returns to done');
    assert.equal(runs.length, before);
  });

  it('device tools: workers refused, closed schemas, bounded device_actions', async () => {
    const { tenant, user, thread } = await setup();
    const worker = await principal(tenant, 'worker');
    const writerWorker = { ...worker, permissions: [...worker.permissions, 'thread:read', 'thread:write'] as Principal['permissions'] };
    await rejects(call(writerWorker, 'local_action_report', { action_id: randomUUID(), status: 'done' }), 403, 'forbidden');
    await rejects(call(writerWorker, 'local_action_pending', { device_id: randomUUID() }), 403, 'forbidden');
    const dev = randomUUID();
    await rejects(call(user, 'voice_intent', memo(thread, 'Remind me to x', { device_actions: ['reminders'] })), 400, 'invalid_arguments');
    await rejects(call(user, 'voice_intent', memo(thread, 'Remind me to x', { device_id: dev, device_actions: ['reminders', 'reminders'] })), 400, 'invalid_arguments');
    await rejects(call(user, 'voice_intent', memo(thread, 'Remind me to x', { device_id: dev, device_actions: Array.from({ length: 9 }, (_, i) => `c${i}`) })), 400, 'invalid_arguments');
    await rejects(call(user, 'voice_intent', memo(thread, 'Remind me to x', { device_id: dev, device_actions: ['x'.repeat(33)] })), 400, 'invalid_arguments');
    await rejects(call(user, 'voice_intent', memo(thread, 'Remind me to x', { device_id: 'phone', device_actions: [] })), 400, 'invalid_arguments');
    await rejects(call(user, 'local_action_pending', {}), 400, 'invalid_arguments');
    await rejects(call(user, 'local_action_pending', { device_id: dev, limit: 21 }), 400, 'invalid_arguments');
    await rejects(call(user, 'local_action_pending', { device_id: dev, extra: 1 }), 400, 'invalid_arguments');
    const mac = await call(user, 'local_action_run', { thread_id: thread, action: { type: 'note.append', text: 'Mac only' }, idempotency_key: 'mac-row' });
    await rejects(call(user, 'local_action_report', { action_id: mac.action.id, status: 'done' }), 409, 'action_conflict');
    const res = await call(user, 'voice_intent', memo(thread, 'Remind me to call the bank', { device_id: dev, device_actions: ['reminders'] }));
    await rejects(call(user, 'local_action_report', { action_id: res.actions[0].id, status: 'done', code: 'failed' }), 400, 'invalid_arguments');
    await rejects(call(user, 'local_action_report', { action_id: res.actions[0].id, status: 'running' }), 400, 'invalid_arguments');
    await rejects(call(user, 'local_action_report', { action_id: res.actions[0].id, status: 'done', summary: 'Hacked' }), 400, 'invalid_arguments');
    await rejects(call(user, 'local_action_report', { action_id: res.actions[0].id, status: 'undone' }), 409, 'action_conflict');
    const list = await call(user, 'local_action_list', { thread_id: thread });
    assert.deepEqual(list.actions.map((a: any) => a.runner).sort(), ['device', 'mac']);
    assert.ok(core.listTools(user).some(t => t.name === 'local_action_report'));
    assert.ok(!core.listTools(worker).some(t => t.name === 'local_action_pending'));
  });
});
