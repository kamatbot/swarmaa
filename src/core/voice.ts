// Ring voice agent service (docs/RING-AGENT.md §5.3–5.6, §8.2, §11): transcript in, local action (on the Mac or the
// iPhone), delegation or Assistant turn out.
import type { Pool } from 'pg';
import { transaction } from '../db.js';
import { AppError, requireCondition } from '../errors.js';
import { canAccessScope, requirePermission, requireScope } from '../policy.js';
import { redactSecrets } from '../safety/redact.js';
import type { Principal } from '../types.js';
import { integer, object, string, uuid } from '../validation.js';
import { parseIntent, validateLocalAction } from '../voice/intent.js';
import { createLocalActionRunner, successSummary } from '../local/actions.js';
import { DEVICE_CAPABILITIES, type AssistantHint, type DeviceActionView, type DeviceCapability, type LocalAction, type LocalActionCode,
  type LocalActionResult, type LocalActionRunner, type LocalActionRunnerKind, type LocalActionStatus } from '../voice/types.js';
import { audit, canonicalJson, event, newId, noExtraKeys, sha256, teamsLock, type Db } from './shared.js';
import { dispatchToBot } from './swarms.js';
import { assignThreadSeq, clipUtf8, enqueueAgentTurn, type AgentRow, type ThreadRow } from './teams.js';

// ---- runner injection: tests set a fake; production builds the osascript runner on first use.
let runner: LocalActionRunner | undefined;
export function setLocalActionRunner(next: LocalActionRunner | undefined): void { runner = next; }
function localRunner(): LocalActionRunner { return runner ??= createLocalActionRunner(); }
/** Fire-and-forget: start the action helper and launch apps known to work (server start, voice_warm). Never throws. */
export function warmLocalActions(): void {
  try { const r = localRunner(); if (r.warm) void r.warm().catch(() => {}); } catch { /* best effort */ }
}

const WAIT_MS = 4000, STALE_SECONDS = 30, MAX_ATTEMPTS = 3, DEVICE_EXPIRY_HOURS = 24;
let waitMs = WAIT_MS;
/** Test hook: how long voice_intent / local_action_run wait for the action before returning `running`. */
export function setLocalActionWait(ms: number): void { waitMs = ms; }

const FREEFORM_OBJECTIVE = 'The user just sent a voice memo (see the latest "Voice memo" message). Act on it: use local_action for reminders, events and notes when you can, project_dispatch for work in a project, and question_ask only when it is genuinely ambiguous or needs approval. Reply in at most two sentences.';
const MEETING_OBJECTIVE = 'The user just sent a voice memo to recap (see the latest "Voice memo" message). Write a recap with "Decisions" and "Next steps", save it with a local_action note.append (notebook "meetings") when you can, and add a local_action reminder.create for each dated next step that has an owner. Reply with the recap.';
const NO_TRANSCRIPT_OBJECTIVE = 'The user just sent a voice memo but it has no transcript (see the latest "Voice memo" message). Say in one sentence that it could not be transcribed and ask them to repeat it.';
/** Turn objective for a memo the Assistant handles, by parser hint. */
export function memoObjective(hint: AssistantHint): string {
  return hint === 'meeting' ? MEETING_OBJECTIVE : hint === 'no_transcript' ? NO_TRANSCRIPT_OBJECTIVE : FREEFORM_OBJECTIVE;
}

interface ActionRow {
  id: string; tenant_id: string; scope: string; thread_id: string; origin_kind: 'memo' | 'turn' | 'tool'; origin_id: string; ordinal: number;
  type: LocalAction['type']; action: LocalAction; status: LocalActionStatus; attempts: number; code: string | null; handle: string | null;
  summary: string; message_id: string | null; created_by: string; created_at: Date; updated_at: Date;
  runner: LocalActionRunnerKind; device_id: string | null;
  /** Only on a claimed row: the memo's phone zone (voice_intents.time_zone), null for turn/tool origins. */
  time_zone?: string | null;
}

type ActionView = DeviceActionView & { code?: string };
const actionView = (r: ActionRow): ActionView => ({ id: r.id, type: r.type, status: r.status, summary: r.summary || pendingSummary(r.action),
  undoable: r.status === 'done' && !!r.handle, runner: r.runner ?? 'mac', ...(r.code ? { code: r.code } : {}),
  ...(r.runner === 'device' ? { action: r.action } : {}) });
/** local_action_pending: what the phone runs (op run) or undoes (op undo, with the handle it reported). */
const pendingView = (r: ActionRow): ActionView => ({ ...actionView(r), action: r.action, op: r.status === 'undoing' ? 'undo' : 'run',
  ...(r.status === 'undoing' && r.handle ? { handle: r.handle } : {}) });
const actionTitle = (a: LocalAction): string =>
  a.type === 'timer.start' ? a.label : a.type === 'note.append' ? (a.title ?? a.text.split('\n')[0] ?? '') : a.title;
const pendingSummary = (a: LocalAction): string => clipUtf8(`${{ 'reminder.create': 'Reminder', 'event.create': 'Event', 'note.append': 'Note', 'timer.start': 'Timer' }[a.type]}: ${actionTitle(a)}`, 200);

// ---- device actions (docs/RING-AGENT.md §11). All card text is written here; the phone sends only id, status, handle, code.
/** §11.1 rule 1: the advertised capability that lets this action run on the phone. Notes never do. */
function deviceRunnable(a: LocalAction, caps: ReadonlySet<DeviceCapability>): boolean {
  switch (a.type) {
    case 'reminder.create': return caps.has('reminders');
    case 'event.create': return caps.has('calendar');
    case 'timer.start': return caps.has('alarms') || caps.has('reminders'); // the phone picks AlarmKit or a reminder
    default: return false;
  }
}
/** §11.1 rule 3: Mac outcomes that send a device-capable memo's action to the phone instead of the Assistant. */
const FLIP_CODES = new Set<string>(['permission_denied', 'action_disabled', 'unavailable']);
const isAlarm = (a: LocalAction) => a.type === 'timer.start' && a.kind === 'alarm';
const DEVICE_APP: Record<LocalAction['type'], string> = { 'reminder.create': 'Reminders', 'event.create': 'Calendar', 'timer.start': 'Alarms or Reminders', 'note.append': 'Notes' };
const deviceVerb = (a: LocalAction, undo: boolean): string => a.type === 'reminder.create' ? (undo ? 'remove the reminder' : 'set the reminder')
  : a.type === 'event.create' ? (undo ? 'remove the event' : 'add the event')
  : a.type === 'timer.start' ? `${undo ? 'cancel' : 'set'} the ${isAlarm(a) ? 'alarm' : 'timer'}` : (undo ? 'remove the note' : 'save the note');
function deviceFailure(a: LocalAction, code: LocalActionCode | 'expired'): string {
  const app = DEVICE_APP[a.type];
  const why = code === 'permission_denied' ? `allow ${app} in Swarmaa › This iPhone on your iPhone`
    : code === 'action_disabled' ? `${app} is turned off on your iPhone`
    : code === 'timeout' ? 'its time had already passed'
    : code === 'expired' ? "your iPhone didn't pick it up"
    : code === 'unavailable' ? `${app} isn't available on your iPhone`
    : `${app} reported an error on your iPhone`;
  return clipUtf8(`Couldn't ${deviceVerb(a, false)}: ${why}`, 2000);
}
function deviceSuccess(a: LocalAction, timeZone?: string | null): string {
  try { return clipUtf8(redactSecrets(successSummary(a, new Date(), timeZone ?? undefined)), 2000); } catch { return pendingSummary(a); }
}
/** Card text while the phone has not run it yet: "Reminder: Call mom · Today 17:00 · waiting for your iPhone". */
function waitingText(r: ActionRow): string {
  const noun = r.action.type === 'reminder.create' ? (r.action.list === 'todo' ? 'To-do' : 'Reminder') : r.action.type === 'event.create' ? 'Event' : isAlarm(r.action) ? 'Alarm' : 'Timer';
  const at = r.summary.indexOf(': ');
  return `${noun}: ${at >= 0 ? r.summary.slice(at + 2) : actionTitle(r.action)} · waiting for your iPhone`;
}
const cardBody = (r: ActionRow): string => r.status === 'undone' ? `Undone: ${r.summary}`
  : r.runner === 'device' && r.status === 'queued' ? waitingText(r)
  : r.runner === 'device' && r.status === 'undoing' ? `Undoing on your iPhone… (${actionTitle(r.action)})`
  : r.summary;

/** Redacts every free-text field after the closed-shape check (docs/RING-AGENT.md §7). */
function redactAction(a: LocalAction): LocalAction {
  const out: Record<string, unknown> = { ...a };
  for (const k of ['title', 'notes', 'text', 'label', 'location'] as const) if (typeof out[k] === 'string') out[k] = redactSecrets(out[k] as string);
  return out as unknown as LocalAction;
}
function checkedAction(value: unknown): LocalAction {
  const action = validateLocalAction(value);
  if (typeof action === 'string') throw new AppError(400, 'invalid_action', action);
  return redactAction(action);
}

/** Inserts a queued local action (caller's transaction); runs after commit. Returns the row id (existing on replay). */
export async function queueLocalAction(db: Db, p: Principal, o: { scope: string; threadId: string; originKind: 'memo' | 'turn' | 'tool'; originId: string; ordinal?: number; action: LocalAction;
  runner?: LocalActionRunnerKind; deviceId?: string; summary?: string }): Promise<string> {
  const runner = o.runner ?? 'mac';
  const action = redactAction(o.action), hash = sha256(canonicalJson(action));
  const ordinal = o.ordinal ?? Number((await db.query('SELECT count(*)::int AS n FROM local_actions WHERE tenant_id=$1 AND origin_kind=$2 AND origin_id=$3', [p.tenantId, o.originKind, o.originId])).rows[0].n);
  const id = newId();
  const inserted = (await db.query(`INSERT INTO local_actions (id,tenant_id,scope,thread_id,origin_kind,origin_id,ordinal,type,action,action_sha256,created_by,runner,device_id,summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) ON CONFLICT (tenant_id,origin_kind,origin_id,ordinal) DO NOTHING RETURNING id`,
  [id, p.tenantId, o.scope, o.threadId, o.originKind, o.originId, ordinal, action.type, JSON.stringify(action), hash, p.id, runner, o.deviceId ?? null, o.summary ?? ''])).rows[0];
  if (inserted) { await audit(db, p, o.scope, 'local_action.create', id, { type: action.type, origin_kind: o.originKind, ...(runner === 'device' ? { runner } : {}) }); return id; }
  const existing = (await db.query('SELECT id,thread_id,action_sha256 FROM local_actions WHERE tenant_id=$1 AND origin_kind=$2 AND origin_id=$3 AND ordinal=$4', [p.tenantId, o.originKind, o.originId, ordinal])).rows[0];
  requireCondition(existing.thread_id === o.threadId && existing.action_sha256 === hash, 409, 'idempotency_conflict', 'Idempotency key reused with a different action.');
  return existing.id;
}

const actor = (r: ActionRow): Principal => ({ id: r.created_by, tenantId: r.tenant_id, name: 'service', role: 'frontend', scopes: [r.scope], permissions: [] });
const appOf = (t: LocalAction['type']) => t === 'event.create' ? 'calendar' : t === 'note.append' ? 'notes' : 'reminders';
/** A memo with a row on the iPhone answers route 'device' (storage keeps 'local'); one whose action was turned off or
 * impossible went to the Assistant (finalize switches the route in the same transaction). */
const memoRoute = (route: string, rows: ActionRow[]) => rows.some(r => r.runner === 'device') ? 'device'
  : rows.some(r => r.status === 'failed' && (r.code === 'action_disabled' || r.code === 'unavailable')) ? 'assistant' : route;

/** Claims a queued (or stale running) row, runs it outside any transaction, then records the result. Returns the final row. */
async function execute(pool: Pool, id: string): Promise<ActionRow | undefined> {
  const claimed = (await pool.query<ActionRow>(`UPDATE local_actions la SET status='running', attempts=attempts+1, updated_at=clock_timestamp()
    WHERE id=$1 AND runner='mac' AND attempts<$2 AND (status='queued' OR (status='running' AND updated_at < clock_timestamp() - $3 * interval '1 second'))
    RETURNING la.*, (SELECT v.time_zone FROM voice_intents v WHERE la.origin_kind='memo' AND v.tenant_id=la.tenant_id AND v.thread_id=la.thread_id AND v.memo_id::text=la.origin_id) AS time_zone`,
  [id, MAX_ATTEMPTS, STALE_SECONDS])).rows[0];
  if (!claimed) return undefined;
  const started = Date.now();
  let result: LocalActionResult;
  // Attempt 1 cannot have created anything yet, so the script skips its marker scan; sweep reruns keep it.
  try { result = await localRunner().run(claimed.id, claimed.action, { fresh: claimed.attempts === 1, ...(claimed.time_zone ? { timeZone: claimed.time_zone } : {}) }); }
  catch { result = { ok: false, code: 'failed', summary: 'The action failed.' }; }
  return finalize(pool, claimed, result, Date.now() - started);
}

// In-process executions by row id: a replayed voice_intent waits on the run already in flight instead of answering `running`.
const inflight = new Map<string, Promise<ActionRow | undefined>>();
function track(pool: Pool, id: string): Promise<ActionRow | undefined> {
  const running = inflight.get(id);
  if (running) return running;
  const p = execute(pool, id).finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
}

async function finalize(pool: Pool, row: ActionRow, result: LocalActionResult, execMs: number): Promise<ActionRow | undefined> {
  return transaction(pool, async db => {
    await teamsLock(db, row.tenant_id);
    const p = actor(row);
    const status: LocalActionStatus = result.ok ? 'done' : 'failed';
    const code = result.ok ? null : (result.code ?? 'failed');
    const summary = clipUtf8(redactSecrets(String(result.summary ?? '')), 2000) || pendingSummary(row.action);
    const handle = result.ok && typeof result.handle === 'string' && result.handle.length > 0 ? clipUtf8(result.handle, 1024) : null;
    // §11.1 rule 3: the Mac cannot do it, but the memo came from a current iPhone client → the phone runs it once allowed.
    if (row.origin_kind === 'memo' && row.runner === 'mac' && code && FLIP_CODES.has(code) && row.type !== 'note.append') {
      const memo = (await db.query<{ device_capable: boolean; time_zone: string }>('SELECT device_capable, time_zone FROM voice_intents WHERE tenant_id=$1 AND thread_id=$2 AND memo_id::text=$3',
        [row.tenant_id, row.thread_id, row.origin_id])).rows[0];
      if (memo?.device_capable) {
        const flipped = (await db.query<ActionRow>(`UPDATE local_actions SET runner='device', status='queued', code=NULL, handle=NULL, summary=$3, exec_ms=$4, updated_at=clock_timestamp()
          WHERE id=$1 AND status='running' AND attempts=$2 AND runner='mac' RETURNING *`, [row.id, row.attempts, deviceSuccess(row.action, memo.time_zone), execMs])).rows[0];
        if (!flipped) return undefined;
        await audit(db, p, row.scope, 'local_action.fail', row.id, { type: row.type, origin_kind: row.origin_kind, code, exec_ms: execMs, runner: 'mac', next_runner: 'device' });
        await postCard(db, p, flipped);
        return flipped;
      }
    }
    // Fenced on the claimed attempt: a stale rerun that lost the race does not overwrite a newer result.
    // The memo's exec_ms is recorded in the same statement.
    const updated = (await db.query<ActionRow>(`WITH u AS (UPDATE local_actions SET status=$3, code=$4, handle=$5, summary=$6, exec_ms=$7, updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND attempts=$2 RETURNING *),
      v AS (UPDATE voice_intents vi SET exec_ms=$7, updated_at=clock_timestamp() FROM u
        WHERE u.origin_kind='memo' AND vi.tenant_id=u.tenant_id AND vi.thread_id=u.thread_id AND vi.memo_id::text=u.origin_id RETURNING 1)
      SELECT * FROM u`, [row.id, row.attempts, status, code, handle, summary, execMs])).rows[0];
    if (!updated) return undefined;
    await audit(db, p, row.scope, result.ok ? 'local_action.run' : 'local_action.fail', row.id, { type: row.type, origin_kind: row.origin_kind, ...(code ? { code } : {}), exec_ms: execMs });
    // A memo whose action is turned off or impossible here goes to the Assistant instead of failing.
    if (row.origin_kind === 'memo' && (code === 'action_disabled' || code === 'unavailable')) {
      await db.query("UPDATE voice_intents SET route='assistant', hint='freeform', updated_at=clock_timestamp() WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3", [row.tenant_id, row.thread_id, row.origin_id]);
      const thread = (await db.query<ThreadRow>('SELECT * FROM threads WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [row.thread_id, row.tenant_id])).rows[0];
      const seq = (await db.query('SELECT message_seq FROM voice_intents WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3', [row.tenant_id, row.thread_id, row.origin_id])).rows[0]?.message_seq;
      if (thread && seq) await assistantTurn(db, p, thread, Number(seq), 'freeform');
      return updated;
    }
    await postCard(db, p, updated);
    return updated;
  });
}

/** Posts or refreshes the result card: a notice with ref.local_action (docs/RING-AGENT.md §5.6). Caller holds teamsLock. */
async function postCard(db: Db, p: Principal, r: ActionRow): Promise<void> {
  const body = clipUtf8(cardBody(r), 16384) || '(local action)';
  const card = { id: r.id, type: r.type, status: r.status, title: clipUtf8(actionTitle(r.action), 200), detail: clipUtf8(r.status === 'undone' ? r.summary : body, 2000),
    undoable: r.status === 'done' && !!r.handle, ...(r.runner === 'device' ? { runner: 'device' } : {}) };
  const author = { kind: 'system', id: 'service' };
  if (r.message_id) {
    const m = (await db.query<{ seq: string }>('UPDATE messages SET body=$3, ref=$4::jsonb, edited_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 RETURNING seq', [r.message_id, r.tenant_id, body, JSON.stringify({ local_action: card })])).rows[0];
    if (m) await event(db, p, r.scope, 'message.updated', r.message_id, { thread_id: r.thread_id, message_id: r.message_id, seq: Number(m.seq), kind: 'notice' });
    return;
  }
  const seq = await assignThreadSeq(db, r.tenant_id, r.thread_id), id = newId();
  // One round trip: the card, its link on the action row, and the thread's activity time.
  await db.query(`WITH m AS (INSERT INTO messages (id,tenant_id,scope,thread_id,seq,author,kind,body,ref,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'notice',$7,$8::jsonb,$9) RETURNING id),
      a AS (UPDATE local_actions SET message_id=$1 WHERE id=$10),
      t AS (UPDATE threads SET updated_at=clock_timestamp() WHERE id=$4)
    SELECT 1`,
  [id, r.tenant_id, r.scope, r.thread_id, seq, JSON.stringify(author), body, JSON.stringify({ local_action: card }), `local-action:${r.id}`, r.id]);
  await event(db, p, r.scope, 'message.created', id, { thread_id: r.thread_id, message_id: id, seq: Number(seq), kind: 'notice', author });
}

/** Queues the bot thread's lead turn for a memo. Caller holds teamsLock and the thread row. Returns the task id. */
async function assistantTurn(db: Db, p: Principal, thread: ThreadRow, seq: number, hint: AssistantHint): Promise<string | undefined> {
  if (thread.kind !== 'bot') return undefined;
  const bot = (await db.query('SELECT id,routing,rules,lead_agent_id FROM bots WHERE thread_id=$1 AND tenant_id=$2 AND NOT archived', [thread.id, p.tenantId])).rows[0];
  const agent = bot && (await db.query<AgentRow>('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [bot.lead_agent_id])).rows[0];
  if (!bot || !agent) return undefined;
  return enqueueAgentTurn(db, p, { thread, agent, bot, seq, initiatorKind: 'person', objective: memoObjective(hint) });
}

/** Runs (or joins the in-flight run of) each row in order, for up to the wait. Returns the rows that finished. */
async function runWithWait(pool: Pool, ids: string[]): Promise<Map<string, ActionRow>> {
  const done = new Map<string, ActionRow>();
  const all = (async () => { for (const id of ids) { const r = await track(pool, id); if (r) done.set(id, r); } })().catch(() => {
    process.stderr.write('Local action run failed. Check database health.\n');
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([all, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); timer.unref?.(); })]);
  clearTimeout(timer);
  return done;
}

/** After a turn commits: run its queued local_action rows in the background, apps in parallel, each app in order. */
export function runOriginActions(pool: Pool, tenantId: string, originKind: 'turn', originId: string): void {
  void (async () => {
    const rows = (await pool.query<{ id: string; type: LocalAction['type'] }>("SELECT id,type FROM local_actions WHERE tenant_id=$1 AND origin_kind=$2 AND origin_id=$3 AND status='queued' AND runner='mac' ORDER BY ordinal", [tenantId, originKind, originId])).rows;
    const byApp = new Map<string, string[]>();
    for (const r of rows) byApp.set(appOf(r.type), [...(byApp.get(appOf(r.type)) ?? []), r.id]);
    await Promise.all([...byApp.values()].map(async ids => { for (const id of ids) await track(pool, id).catch(() => undefined); }));
  })().catch(() => { /* the sweep retries */ });
}

/** Server timer: reruns Mac queued/running rows older than 30 s (max 3 attempts), fails rows that ran out of attempts,
 * and expires device rows the phone left for 24 h (never runs them). */
export async function sweepLocalActions(pool: Pool): Promise<number> {
  const stale = (await pool.query<ActionRow>(`SELECT * FROM local_actions WHERE status IN ('queued','running') AND runner='mac'
    AND updated_at < clock_timestamp() - $1 * interval '1 second' ORDER BY updated_at LIMIT 20`, [STALE_SECONDS])).rows;
  for (const row of stale) {
    if (inflight.has(row.id)) continue; // still running in this process: not a crash leftover
    if (row.attempts < MAX_ATTEMPTS) { await track(pool, row.id); continue; }
    if (row.status === 'running') await finalize(pool, row, { ok: false, code: 'timeout', summary: `${pendingSummary(row.action)} (timed out)` }, 0);
    else await pool.query("UPDATE local_actions SET status='failed', code='failed', updated_at=clock_timestamp() WHERE id=$1 AND status='queued' AND runner='mac'", [row.id]);
  }
  return stale.length + await expireDeviceActions(pool);
}

/** Device rows still queued after 24 h fail (timeout, "your iPhone didn't pick it up"); undoing rows return to done. */
async function expireDeviceActions(pool: Pool): Promise<number> {
  const old = (await pool.query<ActionRow>(`SELECT * FROM local_actions WHERE runner='device' AND status IN ('queued','undoing')
    AND updated_at < clock_timestamp() - $1 * interval '1 hour' ORDER BY updated_at LIMIT 20`, [DEVICE_EXPIRY_HOURS])).rows;
  for (const row of old) {
    await transaction(pool, async db => {
      await teamsLock(db, row.tenant_id);
      const p = actor(row);
      const updated = (await db.query<ActionRow>(`UPDATE local_actions SET status=CASE status WHEN 'queued' THEN 'failed' ELSE 'done' END,
          code=CASE status WHEN 'queued' THEN 'timeout' ELSE code END, summary=CASE status WHEN 'queued' THEN $2 ELSE summary END, updated_at=clock_timestamp()
        WHERE id=$1 AND runner='device' AND status=$3 AND updated_at < clock_timestamp() - $4 * interval '1 hour' RETURNING *`,
      [row.id, deviceFailure(row.action, 'expired'), row.status, DEVICE_EXPIRY_HOURS])).rows[0];
      if (!updated) return;
      await audit(db, p, row.scope, 'local_action.fail', row.id, { type: row.type, origin_kind: row.origin_kind, code: 'timeout', runner: 'device', op: row.status === 'undoing' ? 'undo' : 'run' });
      await postCard(db, p, updated);
    });
  }
  return old.length;
}

// ---- input checks
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;
function dateTime(value: unknown, name: string): Date {
  const text = string(value, name, 40);
  requireCondition(ISO.test(text) && Number.isFinite(Date.parse(text)), 400, 'invalid_arguments', `${name} must be an ISO-8601 date-time.`);
  return new Date(text);
}
function timeZone(value: unknown): string {
  const zone = string(value, 'time_zone', 64);
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { throw new AppError(400, 'invalid_arguments', 'time_zone must be an IANA time zone.'); }
  return zone;
}
function timings(value: unknown): Record<string, number | string> {
  if (value === undefined) return {};
  const o = object(value), out: Record<string, number | string> = {};
  requireCondition(Object.keys(o).length <= 16, 400, 'invalid_arguments', 'timings has at most 16 entries.');
  for (const [k, v] of Object.entries(o)) {
    requireCondition(/^[a-z][a-z0-9_]{0,31}$/.test(k) && ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 40 && ISO.test(v))), 400, 'invalid_arguments', 'timings values must be numbers or ISO date-times.');
    out[k] = v as number | string;
  }
  return out;
}

async function authorizeThread(db: Db, p: Principal, threadId: string, write: boolean): Promise<ThreadRow> {
  requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use voice or local actions.');
  requirePermission(p, 'thread:read'); if (write) requirePermission(p, 'thread:write');
  const thread = (await db.query<ThreadRow>(`SELECT * FROM threads WHERE id=$1 AND tenant_id=$2${write ? ' FOR UPDATE' : ''}`, [threadId, p.tenantId])).rows[0];
  requireCondition(thread, 404, 'thread_not_found', 'Thread not found.');
  requireScope(p, thread.scope);
  return thread;
}

const CODES: LocalActionCode[] = ['permission_denied', 'action_disabled', 'timeout', 'unavailable', 'failed'];
const allScopes = (p: Principal) => p.role === 'admin' && p.scopes.includes('*');

/** voice_intent device fields (§11.3): device_actions ≤ 8 unique names ≤ 32 chars, unknown ignored; needs device_id. */
function deviceInput(input: Record<string, unknown>): { deviceId?: string; caps?: ReadonlySet<DeviceCapability> } {
  const deviceId = input.device_id === undefined ? undefined : uuid(input.device_id, 'device_id').toLowerCase();
  if (input.device_actions === undefined) return deviceId ? { deviceId } : {};
  const names = input.device_actions;
  requireCondition(Array.isArray(names) && names.length <= 8 && names.every(n => typeof n === 'string' && n.length >= 1 && n.length <= 32), 400, 'invalid_arguments', 'device_actions must be at most 8 names of at most 32 characters.');
  requireCondition(new Set(names).size === names.length, 400, 'invalid_arguments', 'device_actions must be unique.');
  requireCondition(deviceId, 400, 'invalid_arguments', 'device_id is required with device_actions.');
  return { deviceId, caps: new Set((names as string[]).filter((n): n is DeviceCapability => (DEVICE_CAPABILITIES as readonly string[]).includes(n))) };
}

/** local_action_report transitions (§11.3): queued→done|failed; done|undoing→undone; failed while undoing → done;
 * done over failed/timeout wins; a repeat is a no-op; anything else conflicts. */
function reportStep(r: ActionRow, status: 'done' | 'failed' | 'undone'): 'done' | 'failed' | 'undo_failed' | 'undone' | 'noop' | 'conflict' {
  const s = r.status;
  if (status === 'done') return s === 'queued' || (s === 'failed' && r.code === 'timeout') ? 'done' : s === 'done' || s === 'undoing' || s === 'undone' ? 'noop' : 'conflict';
  if (status === 'failed') return s === 'queued' ? 'failed' : s === 'undoing' ? 'undo_failed' : s === 'failed' ? 'noop' : 'conflict';
  return s === 'done' || s === 'undoing' ? 'undone' : s === 'undone' ? 'noop' : 'conflict';
}

export class VoiceService {
  constructor(private readonly pool: Pool) {}

  async voiceIntent(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['memo_id', 'thread_id', 'transcript', 'captured_at', 'spoken_at', 'time_zone', 'duration_seconds', 'source', 'timings', 'device_id', 'device_actions']);
    requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use voice or local actions.');
    const memo = uuid(input.memo_id, 'memo_id').toLowerCase(), threadId = uuid(input.thread_id, 'thread_id').toLowerCase();
    requireCondition(typeof input.transcript === 'string' && Buffer.byteLength(input.transcript, 'utf8') <= 16384 && !input.transcript.includes('\u0000'), 400, 'invalid_arguments', 'transcript must be a string of at most 16 KB.');
    const transcript = input.transcript as string;
    const captured = dateTime(input.captured_at, 'captured_at'), spoken = dateTime(input.spoken_at, 'spoken_at'), zone = timeZone(input.time_zone);
    const duration = input.duration_seconds === undefined ? undefined : input.duration_seconds as number;
    requireCondition(duration === undefined || (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 86400), 400, 'invalid_arguments', 'duration_seconds must be between 0 and 86400.');
    requireCondition(['ring', 'watch', 'phone'].includes(input.source as string), 400, 'invalid_arguments', 'source must be ring, watch or phone.');
    const source = input.source as string, clientTimings = timings(input.timings), hash = sha256(transcript);
    const { deviceId, caps } = deviceInput(input);

    type Planned = { route: string; seq: number; delegated?: { bot_id: string; name: string }; ids: string[]; rows?: ActionRow[] };
    const planned = await transaction(this.pool, async (db): Promise<Planned> => {
      await teamsLock(db, p.tenantId);
      const thread = await authorizeThread(db, p, threadId, true);
      // One read for both idempotency checks: this memo's intent record, and an announce that got here first.
      const prior = (await db.query(`SELECT v.transcript_sha256, v.route, v.message_seq, v.delegated_bot_id, v.delegated_name, m.id AS announced_id, m.seq AS announced_seq
        FROM (SELECT 1) one LEFT JOIN voice_intents v ON v.tenant_id=$1 AND v.thread_id=$2 AND v.memo_id=$3
        LEFT JOIN LATERAL (SELECT id, seq FROM messages WHERE tenant_id=$1 AND thread_id=$2 AND idempotency_key=$4 LIMIT 1) m ON true`,
      [p.tenantId, threadId, memo, `voice-memo:${memo}`])).rows[0];
      if (prior.transcript_sha256) {
        requireCondition(prior.transcript_sha256 === hash, 409, 'memo_conflict', 'This memo was already sent with a different transcript.');
        const rows = (await db.query<ActionRow>("SELECT * FROM local_actions WHERE tenant_id=$1 AND origin_kind='memo' AND origin_id=$2 AND thread_id=$3 ORDER BY ordinal", [p.tenantId, memo, threadId])).rows;
        // A retry runs an action that never started (crash after commit) and waits for one still running, so the
        // phone's resend gets the result instead of `running`; execute() claims each row at most once.
        return { route: prior.route, seq: Number(prior.message_seq), ...(prior.route === 'delegate' && prior.delegated_bot_id ? { delegated: { bot_id: prior.delegated_bot_id, name: prior.delegated_name } } : {}),
          ids: rows.filter(r => r.runner === 'mac' && (r.status === 'queued' || r.status === 'running')).map(r => r.id), rows };
      }
      const record = async (route: string, hint: string | null, msg: { id: string; seq: number }, extra: { parse_ms?: number; bot?: { id: string; name: string } } = {}) =>
        db.query(`INSERT INTO voice_intents (tenant_id,scope,thread_id,memo_id,principal_id,transcript_sha256,source,route,hint,message_id,message_seq,delegated_bot_id,delegated_name,captured_at,spoken_at,time_zone,duration_seconds,timings,parse_ms,device_capable)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20)`,
        [p.tenantId, thread.scope, threadId, memo, p.id, hash, source, route, hint, msg.id, msg.seq, extra.bot?.id ?? null, extra.bot?.name ?? null,
          captured, spoken, zone, duration ?? null, JSON.stringify({ ...clientTimings, ...(extra.parse_ms !== undefined ? { parse_ms: extra.parse_ms } : {}) }), extra.parse_ms ?? null, caps !== undefined]);
      // The audio arrived first and announce already queued a turn: record the memo and add nothing.
      if (prior.announced_id) {
        await record('assistant', 'freeform', { id: prior.announced_id, seq: Number(prior.announced_seq) });
        return { route: 'assistant', seq: Number(prior.announced_seq), ids: [] };
      }

      // This thread's own bot (sorted first) and the delegation names: other live bots in scopes this connection may use.
      const live = (await db.query<{ id: string; name: string; scope: string; thread_id: string }>('SELECT id,name,scope,thread_id FROM bots WHERE tenant_id=$1 AND NOT archived ORDER BY (thread_id=$2) DESC, created_at LIMIT 201', [p.tenantId, threadId])).rows;
      const ownBot = thread.kind === 'bot' ? live.find(b => b.thread_id === threadId) : undefined;
      const bots = live.filter(b => b.thread_id !== threadId).slice(0, 200)
        .filter(b => canAccessScope(p, b.scope)).map(b => ({ id: b.id, name: b.name.trim() }));
      const t0 = performance.now();
      let intent = parseIntent({ transcript, spokenAt: spoken, timeZone: zone, ...(duration !== undefined ? { durationSeconds: duration } : {}), bots });
      let action: LocalAction | undefined;
      if (intent.route === 'local') {
        try { action = checkedAction(intent.action); } catch { intent = { route: 'assistant', hint: 'freeform' }; }
      }
      const parseMs = Math.round(performance.now() - t0);

      const author = { kind: 'human' as const, id: p.id };
      const body = clipUtf8(redactSecrets(`🎙 Voice memo\n\n${transcript.trim() || '(no transcript)'}`), 16384);
      const seq = Number(await assignThreadSeq(db, p.tenantId, threadId)), msgId = newId();
      await db.query(`INSERT INTO messages (id,tenant_id,scope,thread_id,seq,author,kind,body,ref,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'text',$7,$8::jsonb,$9)`,
        [msgId, p.tenantId, thread.scope, threadId, seq, JSON.stringify(author), body, JSON.stringify({ voice_intent: { memo_id: memo, source, route: intent.route } }), `voice-memo:${memo}`]);
      await db.query('UPDATE threads SET updated_at=clock_timestamp() WHERE id=$1', [threadId]);
      await audit(db, p, thread.scope, 'message.create', msgId, { thread_id: threadId, seq, voice_route: intent.route });
      await event(db, p, thread.scope, 'message.created', msgId, { thread_id: threadId, message_id: msgId, seq, kind: 'text', author });

      if (intent.route === 'local') {
        await record('local', null, { id: msgId, seq }, { parse_ms: parseMs });
        // §11.1: an advertised capability runs it on the phone; device_id is kept on Mac rows too, for a rule-3 flip.
        const onDevice = caps !== undefined && deviceRunnable(action!, caps);
        const id = await queueLocalAction(db, p, { scope: thread.scope, threadId, originKind: 'memo', originId: memo, ordinal: 0, action: action!,
          ...(deviceId ? { deviceId } : {}), ...(onDevice ? { runner: 'device' as const, summary: deviceSuccess(action!, zone) } : {}) });
        if (!onDevice) return { route: 'local', seq, ids: [id] };
        const row = (await db.query<ActionRow>('SELECT * FROM local_actions WHERE id=$1', [id])).rows[0]!;
        await postCard(db, p, row);
        return { route: 'local', seq, ids: [], rows: [row] };
      }
      if (intent.route === 'delegate') {
        const target = bots.find(b => b.id === intent.bot_id);
        requireCondition(target, 500, 'intent_invalid', 'Delegation target is not an allowed bot.');
        await record('delegate', null, { id: msgId, seq }, { parse_ms: parseMs, bot: target });
        await dispatchToBot(db, p, {
          botId: target.id, body: clipUtf8(redactSecrets(intent.body), 16384), author, initiatorKind: 'person', idempotencyKey: `voice-memo:${memo}`,
          ref: { voice_intent: { memo_id: memo, source, route: 'delegate' } },
          from: ownBot ? { thread_id: threadId, scope: thread.scope, bot_id: ownBot.id } : null
        });
        return { route: 'delegate', seq, delegated: { bot_id: target.id, name: target.name }, ids: [] };
      }
      await record('assistant', intent.hint, { id: msgId, seq }, { parse_ms: parseMs });
      await assistantTurn(db, p, thread, seq, intent.hint);
      return { route: 'assistant', seq, ids: [] };
    });
    const response = (rows: ActionRow[]) => ({ memo_id: memo, route: memoRoute(planned.route, rows), message_seq: planned.seq, actions: rows.map(actionView),
      ...(planned.delegated ? { delegated_to: planned.delegated } : {}) });
    if (!planned.ids.length) return response(planned.rows ?? []);
    const finished = await runWithWait(this.pool, planned.ids);
    // Every pending row finished in the wait: answer from the rows execute() returned instead of re-reading.
    if (planned.ids.every(id => finished.has(id)) && (planned.rows || planned.ids.length === 1)) {
      return response(planned.rows ? planned.rows.map(r => finished.get(r.id) ?? r) : [finished.get(planned.ids[0]!)!]);
    }
    return this.intentResponse(p, threadId, memo);
  }

  private async intentResponse(p: Principal, threadId: string, memo: string): Promise<unknown> {
    const row = (await this.pool.query('SELECT * FROM voice_intents WHERE tenant_id=$1 AND thread_id=$2 AND memo_id=$3', [p.tenantId, threadId, memo])).rows[0];
    const actions = (await this.pool.query<ActionRow>("SELECT * FROM local_actions WHERE tenant_id=$1 AND origin_kind='memo' AND origin_id=$2 AND thread_id=$3 ORDER BY ordinal", [p.tenantId, memo, threadId])).rows;
    return { memo_id: memo, route: memoRoute(row.route, actions), message_seq: Number(row.message_seq), actions: actions.map(actionView),
      ...(row.route === 'delegate' && row.delegated_bot_id ? { delegated_to: { bot_id: row.delegated_bot_id, name: row.delegated_name } } : {}) };
  }

  async run(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['thread_id', 'action', 'idempotency_key']);
    const threadId = uuid(input.thread_id, 'thread_id').toLowerCase(), key = string(input.idempotency_key, 'idempotency_key', 200);
    const action = checkedAction(input.action);
    const id = await transaction(this.pool, async db => {
      const thread = await authorizeThread(db, p, threadId, true);
      return queueLocalAction(db, p, { scope: thread.scope, threadId, originKind: 'tool', originId: `${p.id}:${key}`, ordinal: 0, action });
    });
    const finished = await runWithWait(this.pool, [id]);
    return { action: actionView(finished.get(id) ?? await this.row(id)) };
  }

  /** voice_warm: the phone calls this at the ring's idle edge, while the memo downloads. Never waits on osascript. */
  async warm(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, []);
    requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use voice or local actions.');
    requirePermission(p, 'thread:write');
    // The DB round trip doubles as the device backlog count, so the phone knows to drain (docs/RING-AGENT.md §11.1).
    const pending = (await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM local_actions WHERE tenant_id=$1 AND runner='device'
      AND status IN ('queued','undoing') AND (scope = ANY($2::text[]) OR $3)`, [p.tenantId, p.scopes, allScopes(p)])).rows[0]!.n;
    warmLocalActions();
    return { ok: true, device_pending: pending };
  }

  async undo(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['action_id']);
    const id = uuid(input.action_id, 'action_id');
    const row = await transaction(this.pool, async db => {
      const r = (await db.query<ActionRow>('SELECT * FROM local_actions WHERE id=$1 AND tenant_id=$2', [id, p.tenantId])).rows[0];
      requireCondition(r, 404, 'not_found', 'Local action not found.');
      await authorizeThread(db, p, r.thread_id, true);
      return r;
    });
    if (row.status === 'undone' || row.status === 'undoing') return { action: actionView(row) };
    requireCondition(row.status === 'done' && row.handle, 409, 'not_undoable', 'Only a finished action can be undone.');
    if (row.runner === 'device') {
      // The phone deletes it on next contact (local_action_pending op undo) and reports undone.
      await transaction(this.pool, async db => {
        await teamsLock(db, p.tenantId);
        const updated = (await db.query<ActionRow>("UPDATE local_actions SET status='undoing', updated_at=clock_timestamp() WHERE id=$1 AND status='done' AND runner='device' RETURNING *", [id])).rows[0];
        if (updated) await postCard(db, p, updated);
      });
      return { action: actionView(await this.row(id)) };
    }
    let result: LocalActionResult;
    try { result = await localRunner().undo(row.id, row.action, row.handle!); }
    catch { result = { ok: false, code: 'failed', summary: 'Undo failed.' }; }
    if (!result.ok) throw new AppError(502, result.code ?? 'failed', clipUtf8(redactSecrets(result.summary || 'Undo failed.'), 500));
    await transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      const updated = (await db.query<ActionRow>("UPDATE local_actions SET status='undone', updated_at=clock_timestamp() WHERE id=$1 AND status='done' RETURNING *", [id])).rows[0];
      if (!updated) return;
      await audit(db, p, row.scope, 'local_action.undo', id, { type: row.type, origin_kind: row.origin_kind });
      await postCard(db, p, updated);
    });
    return { action: actionView(await this.row(id)) };
  }

  /** local_action_pending: the phone fetches device rows to run or undo and claims them for its device_id. */
  async pending(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['device_id', 'limit']);
    requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use voice or local actions.');
    requirePermission(p, 'thread:read'); requirePermission(p, 'thread:write');
    const device = uuid(input.device_id, 'device_id').toLowerCase(), limit = input.limit === undefined ? 20 : integer(input.limit, 'limit', 1, 20);
    const rows = (await this.pool.query<ActionRow>(`WITH c AS (SELECT id FROM local_actions WHERE tenant_id=$1 AND runner='device' AND status IN ('queued','undoing')
        AND (device_id IS NULL OR device_id=$2) AND (scope = ANY($3::text[]) OR $4) ORDER BY created_at, ordinal LIMIT $5 FOR UPDATE SKIP LOCKED)
      UPDATE local_actions la SET device_id=$2 FROM c WHERE la.id=c.id RETURNING la.*`, [p.tenantId, device, p.scopes, allScopes(p), limit])).rows;
    rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.ordinal - b.ordinal);
    return { actions: rows.map(pendingView) };
  }

  /** local_action_report: the phone's outcome for a device row. Card text comes from the action and code, never the phone. */
  async report(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['action_id', 'status', 'handle', 'code', 'exec_ms']);
    requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use voice or local actions.');
    const id = uuid(input.action_id, 'action_id').toLowerCase();
    requireCondition(['done', 'failed', 'undone'].includes(input.status as string), 400, 'invalid_arguments', 'status must be done, failed or undone.');
    const status = input.status as 'done' | 'failed' | 'undone';
    const handle = input.handle === undefined ? undefined : string(input.handle, 'handle', 1024);
    requireCondition(input.code === undefined || (status === 'failed' && CODES.includes(input.code as LocalActionCode)), 400, 'invalid_arguments', 'code is one of the local action codes and only goes with status failed.');
    const code = (input.code as LocalActionCode | undefined) ?? 'failed';
    const execMs = input.exec_ms === undefined ? null : integer(input.exec_ms, 'exec_ms', 0, 86_400_000);
    await transaction(this.pool, async db => {
      await teamsLock(db, p.tenantId);
      const r = (await db.query<ActionRow>(`SELECT la.*, (SELECT v.time_zone FROM voice_intents v WHERE la.origin_kind='memo' AND v.tenant_id=la.tenant_id AND v.thread_id=la.thread_id AND v.memo_id::text=la.origin_id) AS time_zone
        FROM local_actions la WHERE la.id=$1 AND la.tenant_id=$2 FOR UPDATE`, [id, p.tenantId])).rows[0];
      requireCondition(r, 404, 'not_found', 'Local action not found.');
      await authorizeThread(db, p, r.thread_id, true);
      requireCondition(r.runner === 'device', 409, 'action_conflict', 'This action does not run on a device.');
      const step = reportStep(r, status);
      if (step === 'noop') return;
      requireCondition(step !== 'conflict', 409, 'action_conflict', `Cannot report ${status} for an action that is ${r.status}.`);
      const set = step === 'done' ? { status: 'done', code: null, handle: handle ?? null, summary: deviceSuccess(r.action, r.time_zone) }
        : step === 'failed' ? { status: 'failed', code, handle: null, summary: deviceFailure(r.action, code) }
        : step === 'undo_failed' ? { status: 'done', code: r.code, handle: r.handle, summary: r.summary }
        : { status: 'undone', code: r.code, handle: r.handle, summary: r.summary };
      const updated = (await db.query<ActionRow>(`UPDATE local_actions SET status=$2, code=$3, handle=$4, summary=$5, exec_ms=COALESCE($6, exec_ms), updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [id, set.status, set.code, set.handle, set.summary, execMs])).rows[0]!;
      const op = step === 'undone' || step === 'undo_failed' ? 'local_action.undo' : step === 'done' ? 'local_action.run' : 'local_action.fail';
      await audit(db, p, r.scope, step === 'undo_failed' ? 'local_action.fail' : op, id, { type: r.type, origin_kind: r.origin_kind, runner: 'device',
        ...(step === 'failed' ? { code } : {}), ...(step === 'undo_failed' ? { op: 'undo' } : {}), ...(execMs !== null ? { exec_ms: execMs } : {}) });
      await postCard(db, p, updated);
    });
    return { action: actionView(await this.row(id)) };
  }

  async list(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, ['thread_id', 'limit']);
    const threadId = uuid(input.thread_id, 'thread_id').toLowerCase(), limit = input.limit === undefined ? 20 : integer(input.limit, 'limit', 1, 100);
    await authorizeThread(this.pool, p, threadId, false);
    const rows = (await this.pool.query<ActionRow>('SELECT * FROM local_actions WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at DESC, ordinal LIMIT $3', [p.tenantId, threadId, limit])).rows;
    return { actions: rows.map(r => ({ ...actionView(r), origin_kind: r.origin_kind, created_at: new Date(r.created_at).toISOString() })) };
  }

  async check(p: Principal, input: Record<string, unknown>): Promise<unknown> {
    noExtraKeys(input, []);
    requireCondition(p.role !== 'worker', 403, 'forbidden', 'Workers cannot use voice or local actions.');
    requirePermission(p, 'thread:read');
    return { apps: await localRunner().check() };
  }

  private async row(id: string): Promise<ActionRow> {
    return (await this.pool.query<ActionRow>('SELECT * FROM local_actions WHERE id=$1', [id])).rows[0]!;
  }
}
