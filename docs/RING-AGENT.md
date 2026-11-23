# Ring Agent: voice memo → action

Status: design for one PR (architecture by Fable, 2026-11-22). Verified by reading code only; latency numbers are estimates until the instrumentation in §6.1 lands.

## 1. Goal

A ring memo such as "remind me to call mom at 5" becomes a real Apple Reminder on the Mac about 1.5 s after the audio leaves the ring, with a lock-screen confirmation and an Undo. No LLM runs for that path. Free-form memos and "ask/tell <bot>" go to the Assistant bot, which can use the same actions and delegate.

## 2. What exists today

| Step | Where |
|---|---|
| Idle edge 0x2F → `hold(); checkNow()` (0x3D count) | `iOS-app/Sources/RingLink.swift:173-189` |
| `beginDownload`: 0x40 stop, hard-coded 1 s sleep, 0x34 | `RingLink.swift:140-153` |
| Ring streams 0x34 frames; one notification = one frame | `RingLink.swift:191-197`, `RingProtocol.swift:243-285` |
| `finish`: Opus → PCM → AAC M4A → re-read → 0x36 delete-ack | `RingLink.swift:214-230`, `RingMemoFile.save` |
| `deliver`: transcribe whole M4A, 25 s timeout, background deferral | `RingLink.swift:234-250`, `MemoTranscriber.swift` |
| `uploadOnce`: fresh `RelayService` when not foreground-connected; `bot_list` every time | `RingLink.swift:260-292` |
| `flush`: re-hash, `watch_memo_status` (404 for new memos), sequential 128 KiB `watch_memo_put` | `iOS-app/Sources/PhoneMemos.swift:92-142` |
| Mac stores M4A, `announce` posts "🎙 Voice memo", `enqueueAgentTurn` with `MEMO_OBJECTIVE` | `src/core/watch-services.ts:127-152` |
| Bridge wakes from the event stream, runs a full CLI turn | `src/bridge/worker.ts:120-230` |
| Agents act through a fenced `swarmaa-actions` block | `src/core/actions.ts`, `src/core/tasks.ts` |
| Push is content-free ("Replied", "Needs you") | `src/push.ts` |
| iOS deployment target 18.0, Swift 6, strict concurrency | `iOS-app/project.yml` |

Every memo costs a relay connect, 3 round trips and a cold LLM CLI turn, and ends as a question instead of an action.

## 3. Architecture

```
ring ──BLE──> iPhone RingLink
                ├─ stream-decode Opus → live transcriber (during download)
                ├─ save M4A, delete-ack                (unchanged durability rule)
                ├─ voice_intent(transcript)  ── 1 RPC ──> Mac service
                │       <── result card data ──           ├─ parseIntent (TS, <1 ms)
                ├─ local notification "Reminder set …"    ├─ local action (osascript/JXA or notebook file)
                └─ watch_memo_put (audio, trails)         └─ or Assistant turn / bot dispatch
```

- **Parsing runs on the Mac, in TypeScript.** The round trip is needed anyway; one parser serves ring, Watch and typed input and is testable on Linux. The phone sends transcript, time zone and the time speech ended.
- **Transcript first, audio trails.** `voice_intent` is small; the audio upload no longer gates the action.
- **Deterministic first, LLM only when needed.**
- **Execution is a fixed JXA script run by `/usr/bin/osascript` through `execFile`.** No shell, no path or command from input. Notes go to a markdown notebook written by Node.

## 4. Intent layer

### 4.1 Trigger grammar (leading position, after stripping "hey/ok assistant", "please", fillers)

| Trigger (case-insensitive) | Route | Notes |
|---|---|---|
| `remind me (to/about/that)`, `reminder`, `set a reminder`, `don't let me forget` | `reminder.create` | time optional |
| `todo`, `to do`, `task`, `add a todo/task` | `reminder.create`, `list:'todo'` | no due date unless spoken |
| `add (an) event`, `schedule`, `calendar`, `book`, `put … on my calendar` | `event.create` | needs a start time, else Assistant |
| `note`, `note to self`, `take a note`, `memo`, `jot down`, `remember that`, `idea` | `note.append` | |
| `set a timer for`, `timer`, `alarm at/for`, `wake me (up) at` | `timer.start` | a reminder due at fire time |
| `ask/tell/have/get <bot name> (to)` | delegate | only when the name matches exactly one live bot (longest first) |
| `summarize`, `summary`, `recap`, `meeting notes`, or duration > 120 s | Assistant, hint `meeting` | |
| anything else | Assistant, hint `freeform` | |

Fail-safes: one deterministic action per memo (a second trigger after "and (also)" → Assistant, `multi`); time-like words the parser did not consume → Assistant, `unparsed_time` (a spoken time is never silently dropped); empty title → Assistant.

### 4.2 Date/time parser (`src/voice/datetime.ts`, no new dependency)

Reference instant is `spoken_at`; zone is the phone's IANA zone via `Intl.DateTimeFormat`.
Supported: `in N minutes/hours/days/weeks`, `in half an hour`, `at 5`, `at 5 pm`, `5:30 p.m.`, `17:00`, `noon`, `midnight`, `today`, `tonight`, `tomorrow`, `day after tomorrow`, `this morning/afternoon/evening`, weekdays, `next <weekday>`, `on March 3rd`, `3 March`, `for N minutes/hours` (event duration), number words one–twelve.
Defaults: date without time → 09:00; tonight 20:00; morning 09:00, afternoon 15:00, evening 19:00; bare `at 5` → next occurrence preferring 07:00–22:59; events 30 min; a time in the past rolls forward one day.

### 4.3 LLM fallback

No new LLM client: the Assistant's normal turn with a memo-specific objective (§5.4).

## 5. Core local actions

### 5.1 Closed set

| Action | Effect | Mechanism | Auto? | Undo |
|---|---|---|---|---|
| `reminder.create` | Apple Reminders, owner-configured list | JXA | yes | delete by id |
| `event.create` | Apple Calendar, owner-configured calendar, no attendees | JXA | yes | delete by uid |
| `note.append` | `~/.swarmaa/notes/<notebook>/YYYY-MM-DD.md` | Node fs | yes | remove marked block |
| `timer.start` | Reminder due at `fire_at` (Clock is not scriptable) | JXA | yes | delete by id |
| delegate | message + turn in the target bot's thread | existing dispatch path | yes | no |
| anything external (send, publish, buy) | not in the set | Assistant `question_ask` | asks | n/a |

The markdown notebook is the primary note store: no TCC grant, instant, testable, and agents can reorganise it. An Apple Notes mirror is deferred.

### 5.2 Executor (`src/local/`)

- Script text is a TS constant (`src/local/jxa.ts`) passed with `-l JavaScript -e`.
- Request JSON on **stdin**, never argv (transcripts stay out of `ps`).
- `execFile('/usr/bin/osascript', …)`, env `{PATH:'/usr/bin:/bin'}`, timeout 8 s, SIGKILL, 64 KiB output cap, one run at a time.
- Non-darwin: `local_actions_unavailable`; `note.append` still works.
- Owner config (env): `SWARMAA_LOCAL_ACTIONS` (comma list of `reminders,calendar,notes`; default all three — kamat asked for full automation on his own Mac), `SWARMAA_REMINDERS_LIST`, `SWARMAA_TODO_LIST`, `SWARMAA_CALENDAR_NAME` (unset = app default list/calendar), `SWARMAA_NOTES_DIR` (absolute, owner-only checks as in `watch-services.ts` `safeDir`). A disabled action returns `action_disabled` and the memo falls to the Assistant.

### 5.3 Idempotency

1. Row claim: `local_actions UNIQUE (tenant_id, origin_kind, origin_id, ordinal)`; for memos `origin_id = memo_id`. A retry returns the stored result.
2. Effect marker: each created object carries `swarmaa:<action_id>` (reminder body, event description, HTML comment in markdown). Script and notebook writer look it up before creating, so a crash between effect and DB record cannot duplicate.

States `queued → running → done | failed`, `done → undone`. Rows are inserted `queued` in a transaction, executed after commit, swept on start and by a timer (`queued`/`running` older than 30 s, max 3 attempts).

### 5.4 Assistant as orchestrator

- New turn action in the `swarmaa-actions` block: `{"type":"local_action","action":<LocalAction>}`, max 5 per turn, allowed only when the bot has `rules.local_actions: true` (owner-set, like `dispatch_all_projects`). Rows get `origin_kind:'turn'`, `origin_id:<task id>`.
- Add `local_action` to `ROUTER_ACTIONS` and the adapter prompt (`src/bridge/adapters.ts`).
- Replace `MEMO_OBJECTIVE` with hint-specific objectives:
  - `freeform`/`multi`/`unparsed_time`: act on the memo; use local_action for reminders, events, notes; project_dispatch for project work; question_ask only when genuinely ambiguous or needing approval; reply in two sentences.
  - `meeting`: recap with Decisions and Next steps, saved via `note.append` (notebook `meetings`), plus reminders for dated next steps with an owner.
- Delegate: reuse the dispatch body in `swarms.ts`, extracted into a shared function, human as author.

### 5.5 Service tools

| Tool | Permission | Purpose |
|---|---|---|
| `voice_intent` | `thread:write` | transcript in, action or routing out (§8.2) |
| `local_action_run` | `thread:write` | run one `LocalAction`, `idempotency_key` required |
| `local_action_undo` | `thread:write` | undo a `done` action |
| `local_action_list` | `thread:read` | recent actions for a thread |
| `local_action_check` | `thread:read` | probe per app: `ok`/`permission_denied`/`disabled` |

All reject `role === 'worker'`.

### 5.6 Result card and confirmation

- Card: a `notice` message with `ref.local_action = {id, type, status, title, detail, undoable}` and plain body, e.g. `Reminder set: Call mom · Today 17:00` (no `messages.kind` change; old clients show the body).
- Lock screen: the phone still holds background time when `voice_intent` returns, so it posts a **local** notification with the result. Content never passes through APNs.
- `voice_intent` posts the "🎙 Voice memo" message with key `voice-memo:<memo>`. When the audio lands, `announce` finds it, attaches `ref.voice_memo`, and does **not** enqueue a second turn.

### 5.7 macOS permissions (TCC)

- When Swarmaa.app spawns node, TCC should attribute `osascript` to Swarmaa.app, which then needs `com.apple.security.automation.apple-events` and `NSAppleEventsUsageDescription`. **Unverified; confirm on the Mac.** From a LaunchAgent/Terminal the prompt names node/osascript/Terminal.
- Grant once while at the Mac: run `local_action_check`; macOS asks "Swarmaa wants to control Reminders/Calendar". Later: System Settings › Privacy & Security › Automation.
- Error −1743 → `permission_denied`; the card says where to enable it. The first run must be attended.
- Apple Events launch Reminders/Calendar if not running (1–3 s on the first action). An EventKit helper in the Mac app would remove that; out of scope.

## 6. Latency review

### 6.1 Measure first

Timestamps in `ring.log`, sent as `timings` in `voice_intent`: `idle`, `count_reply`, `first_packet`, `last_packet`, `saved`, `transcribed`, `intent_ack`, `audio_stored`. Server adds `parse_ms`, `exec_ms`.

### 6.2 Budget, 10 s memo, phone in pocket (estimates)

| # | Stage | Where | Now | Target | Cut |
|---|---|---|---|---|---|
| 1 | Idle edge → count reply | `RingLink.swift` | 0.1 s | 0.1 s | none |
| 2 | Stop + fixed sleep | `beginDownload` | 1.0 s | 0.15 s | 150 ms; resend 0x34 once if no packet in 1.5 s |
| 3 | BLE download | ring-paced | 2–5 s | same | measure; vendor question |
| 4 | Decode + AAC + re-read + ack | `finish` | 0.2 s | off the action path | ack rule unchanged |
| 5 | Transcription | `deliver` | 2–4 s after save | ~0.4 s after last packet | incremental Opus decode into a buffer recognizer during download |
| 6 | Relay connect | `uploadOnce` | 0.5–1.5 s | 0 (warm) | connect at the idle edge, keep the owned service 60 s |
| 7 | `bot_list` | `uploadOnce` | 1 RTT | 0 | cache target thread; refresh on `thread_not_found` |
| 8 | `watch_memo_status` | `flush` | 1 RTT | 0 | skip for never-attempted deliveries |
| 9 | Audio `watch_memo_put` | `flush` | blocks action | trails | after `voice_intent` |
| 10 | Parse + DB claim | new | – | ~10 ms | |
| 11 | Local action | new | – | 0.3–1.5 s JXA, ~5 ms note | wait up to 4 s, else return `running` |
| 12 | Bridge wake + CLI turn | bridge | 10–30 s | 0 on fast path | Assistant route only |
| | **Tap-off → done** | | **~17–43 s, ends in a question** | **download + ~1.5 s** | |

### 6.3 Notes

- **Streaming transcription:** one long-lived `AVAudioConverter`, PCM appended as frames arrive. iOS 26: `SpeechAnalyzer`/`SpeechTranscriber` behind `#available`; iOS 18–25: `SFSpeechAudioBufferRecognitionRequest` with `requiresOnDeviceRecognition`. The M4A path stays as fallback.
- **Background recognition:** live finalisation timeout `min(8, 2 + 0.05 × duration)` s, file fallback `min(20, 4 + 0.5 × duration)` s (review F9); if both fail in the background, the audio still uploads and the Assistant gets a `no_transcript` turn. Log which engine answered.
- **Memo id** allocated in `beginDownload` so `voice_intent` can go as soon as the transcript finalises.
- **Live mode (0x30 mode 2):** the ring reports live recording off; experiment after this PR.

## 7. Privacy and security

- Transcripts are untrusted: they select from a closed action set and fill bounded text (title ≤ 200, notes ≤ 4000). They never choose a list, calendar, path, script or binary.
- All text passes `redactSecrets` before storage, cards and action fields.
- JXA gets JSON on stdin and treats fields as strings; no `eval`, no `doShellScript`.
- Only bots with the owner-set `local_actions` rule may emit `local_action`.
- Audit `local_action.create|run|undo|fail`, metadata only.
- Service tokens stay out of the osascript environment. Notebook dir 0700, files 0600, no symlinks.

## 8. Shared contract (frozen)

### 8.1 `src/voice/types.ts`

```ts
export type LocalAction =
  | { type: 'reminder.create'; title: string; due_at?: string; notes?: string; list?: 'default' | 'todo' }
  | { type: 'event.create'; title: string; start_at: string; end_at: string; all_day?: boolean; location?: string; notes?: string }
  | { type: 'note.append'; text: string; notebook?: 'daily' | 'inbox' | 'meetings'; title?: string }
  | { type: 'timer.start'; label: string; fire_at: string };          // all times ISO 8601 UTC
export type AssistantHint = 'freeform' | 'multi' | 'unparsed_time' | 'meeting' | 'no_transcript';
export type Intent =
  | { route: 'local'; action: LocalAction }
  | { route: 'delegate'; bot_id: string; body: string }
  | { route: 'assistant'; hint: AssistantHint };
export interface IntentInput { transcript: string; spokenAt: Date; timeZone: string; durationSeconds?: number; bots: { id: string; name: string }[] }
export function parseIntent(input: IntentInput): Intent;                       // src/voice/intent.ts, pure
export function validateLocalAction(value: unknown): LocalAction | string;     // src/voice/intent.ts; string = refusal reason

export type LocalActionStatus = 'queued' | 'running' | 'done' | 'failed' | 'undone';
export interface LocalActionResult { ok: boolean; code?: 'permission_denied' | 'action_disabled' | 'timeout' | 'unavailable' | 'failed'; handle?: string; summary: string }
export interface LocalActionRunner {
  run(id: string, action: LocalAction): Promise<LocalActionResult>;
  undo(id: string, action: LocalAction, handle: string): Promise<LocalActionResult>;
  check(): Promise<Record<'reminders' | 'calendar' | 'notes', 'ok' | 'permission_denied' | 'disabled'>>;
}
export function createLocalActionRunner(opts?: { exec?: (script: string, stdin: string) => Promise<{ stdout: string; code: number }>; env?: NodeJS.ProcessEnv; now?: () => Date }): LocalActionRunner; // src/local/actions.ts
```

`summary` is the card body. JXA stdin: `{"op":"run"|"undo"|"check","id":…,"action":…,"handle":…,"config":{reminders_list,todo_list,calendar}}`; stdout one JSON line `{"ok":true,"handle":"…"}` or `{"ok":false,"code":"…"}`.

Additions (latency review 2026-11-22, F4–F7, F18; all optional, old callers unchanged):

```ts
export interface LocalActionRunOptions { fresh?: boolean; timeZone?: string }
interface LocalActionRunner {
  run(id: string, action: LocalAction, opts?: LocalActionRunOptions): Promise<LocalActionResult>;
  warm?(): Promise<void>;   // best effort, never throws
}
```

- `fresh: true` is passed on a row's first claimed attempt (`attempts === 1`) and sent to JXA as `"fresh":true`, which skips the `swarmaa:<id>` marker scan (nothing can exist yet). Sweep reruns and any one-shot fallback after a helper failure send `fresh:false` and keep the scan.
- `timeZone` is the memo's `voice_intents.time_zone`; the card summary is formatted in it. Turn and tool origins use `SWARMAA_TIME_ZONE`/system zone as before. Note file dates stay in the Mac's zone.
- Persistent helper: run, undo and warm requests go to one long-lived `/usr/bin/osascript -l JavaScript -e <JXA_SCRIPT> loop` (spawn, no shell, env `PATH=/usr/bin:/bin`). Loop mode reads stdin with `availableData`, answers each `\n`-terminated request line with one response line on stdout; both directions are ASCII-only JSON (non-ASCII `\u`-escaped). One request at a time; a request past 8 s SIGKILLs the helper (respawned on the next request) and returns `timeout`; a helper that has been idle 10 min is closed; a spawn failure, exit, broken pipe or non-JSON line falls back to the one-shot `execFile` for that request. `check` is always one-shot (60 s) on its own queue and never holds runs.
- `warm()` spawns the helper and, for each enabled app whose last `check` (or last run) in this process was `ok`, sends a `check` read (`Application('Reminders').lists.length` / `Application('Calendar').calendars.length`), which launches the app. An app never seen ok is never touched. Called once at service start and by `voice_warm`.

### 8.4 `voice_warm`

`voice_warm {}` → `{ ok: true }`. Permission `thread:write`, `role === 'worker'` refused, closed schema. Runs `SELECT 1` and calls `runner.warm()` fire-and-forget (never waits on osascript). The phone sends it at the ring's idle edge so the relay socket, DB pool, helper and apps are warm while the memo downloads.

`voice_intent` replay (same memo, same transcript) whose action is `queued` or `running` now runs or joins that execution and waits up to the normal 4 s before answering, so a resend after a lost reply returns `done` instead of `running`.

### 8.2 `voice_intent`

Request: `{ memo_id: uuid, thread_id: uuid, transcript: string(≤16384), captured_at: date-time, spoken_at: date-time, time_zone: string(≤64), duration_seconds?: number, source: 'ring'|'watch'|'phone', timings?: object }`.
Response: `{ memo_id, route: 'local'|'delegate'|'assistant', message_seq: number, actions: [{ id, type, status, summary, undoable }], delegated_to?: { bot_id, name } }`.
Idempotent on `(tenant, thread_id, memo_id)`; a repeat with a different transcript is `409 memo_conflict`.

### 8.3 Other names

- Tools: `local_action_run {thread_id, action, idempotency_key}`, `local_action_undo {action_id}`, `local_action_list {thread_id, limit?}`, `local_action_check {}`.
- Turn action `{type:'local_action', action}`; bot rule `local_actions: boolean`.
- Message `kind:'notice'`, `ref.local_action = {id, type, status, title, detail, undoable}`.
- Migration `voice_actions`: tables `voice_intents` (PK tenant_id, thread_id, memo_id) and `local_actions` (UNIQUE tenant_id, origin_kind, origin_id, ordinal).
- Swift `iOS-app/Sources/RingIntent.swift`: `VoiceIntentRequest`, `VoiceIntentResult { route; actions: [Action{id,type,status,summary,undoable}] }`, `enum RingIntent { send(_:service:), notify(_:) }`.

## 9. Testing

- `tests/voice-intent.test.ts`, `tests/voice-datetime.test.ts`: table-driven; fixed `spokenAt`, zones incl. a DST change and `Asia/Bangkok`; every trigger and fail-safe.
- `tests/local-actions.test.ts`: fake `exec`; no argv payload, marker present, timeout → `timeout`, −1743 → `permission_denied`, idempotent re-run.
- `tests/local-notebook.test.ts`: append, idempotent re-append, undo, symlink refusal, modes.
- `tests/voice-service.integration.test.ts` (`TEST_DATABASE_URL` only): `voice_intent` twice → one message, one action; later audio attaches and enqueues no turn; assistant route enqueues one turn; worker refused.
- Swift (on the Mac): `iOS-app/Tests/RingIntentTests.swift`.
- Manual on the Mac: `local_action_check`, five spoken phrases, Undo.

## 10. Open points for the owner

1. TCC attribution for `osascript` under Swarmaa.app is unverified (§5.7).
2. Whether on-device recognition runs in the background decides how often memos defer; the timings log will show it.
3. Reminders/calendar use the app's default list and calendar unless `SWARMAA_REMINDERS_LIST` / `SWARMAA_CALENDAR_NAME` are set.
4. BLE download time is unmeasured and may dominate.

## 11. Device actions: Reminders, Calendar and Alarms on the iPhone (2026-11-23)

Owner requirement: ask permissions in the iOS app (the ring is connected to the phone), and **keep the Mac path and its permissions as a fallback**. `reminder.create`, `event.create` and `timer.start` run on the iPhone when it has access (EventKit / AlarmKit); iCloud syncs them to the Mac. `note.append`, delegate and Assistant routes are unchanged. The parser stays in TS on the Mac; the phone still makes one `voice_intent` round trip. Design by Fable (two revisions folded together).

### 11.1 Runner choice

For `reminder.create`, `event.create`, `timer.start` (notes are always Mac). First match wins.

| Origin | Rule |
|---|---|
| memo from a phone | 1. Capability advertised in the request's `device_actions` → `runner='device'`. `timer.start` matches on `alarms` **or** `reminders`; the phone picks the mechanism. 2. Otherwise → `mac`, as today. 3. If the Mac run ends `permission_denied`, `action_disabled` or `unavailable` **and** the request carried a `device_actions` field → the row flips to `runner='device'`, `queued`, response route `device`; the phone asks for permission (§11.5) and runs it once granted (24 h expiry). 4. Old client (no field) → today's behaviour. |
| turn, tool, Watch, other | `mac`, as today. |

- Mac JXA defaults (`SWARMAA_LOCAL_ACTIONS`) are unchanged.
- Undo of a device row from a thread card: row → `undoing`; the phone picks it up on next contact (app active, `voice_warm` answering `device_pending > 0`, or after any `voice_intent`). The phone notification's Undo action is immediate. No push.
- Multiple devices (iPad runs the same app): a row is claimed by `device_id` so only one device executes it.
- The server formats all card text (`successSummary`, phone zone); the phone never sends free text.

### 11.2 Protocol

```
phone  voice_intent{…, device_id, device_actions:['reminders','calendar','alarms']}  ─►  parse, validate, INSERT runner=device, card "waiting for your iPhone"
       ◄─ {route:'device', actions:[{id,type,status:'queued',summary,undoable:false,runner:'device',action}]}
       EventKit/AlarmKit save (marker swarmaa:<id>) → ledger → local notification   ← critical path ends (~30 ms)
       local_action_report{action_id,status:'done',handle,exec_ms}  ─►  row done, card "Reminder set: …"   (trails, before audio upload)
```

`voice_intents.route` stays `'local'` in storage; the response says `'device'` when any memo row has `runner='device'`. A replay returns the same shape with current status. Mac `execute`, `runWithWait`, `runOriginActions` and the sweep only touch `runner='mac'`. The sweep fails device rows still `queued` after 24 h (`timeout`, "your iPhone didn't pick it up") and returns `undoing` rows older than 24 h to `done`.

### 11.3 Contract (additive)

```ts
// src/voice/types.ts
export type DeviceCapability = 'reminders' | 'calendar' | 'alarms';      // open: 'contacts' | 'location' | 'home' later
export type LocalActionRunnerKind = 'mac' | 'device';
export type LocalActionStatus = 'queued' | 'running' | 'done' | 'failed' | 'undoing' | 'undone';
// timer.start gains: kind?: 'timer' | 'alarm'   (absent = 'timer'; "wake me at / alarm at" → 'alarm')
export interface DeviceActionView { id: string; type: LocalActionType; status: LocalActionStatus; summary: string; undoable: boolean;
  runner: LocalActionRunnerKind; action?: LocalAction; op?: 'run' | 'undo'; handle?: string }   // action/op/handle only for device rows
```

| Tool | Request | Response / rules |
|---|---|---|
| `voice_intent` | adds `device_id?: uuid`, `device_actions?: string(≤32)[]` (≤8, unique; requires `device_id`; unknown names ignored) | `route` adds `'device'`; each action adds `runner`, and `action` for device rows |
| `local_action_report` | `{action_id, status:'done'\|'failed'\|'undone', handle?: string(≤1024), code?: LocalActionCode, exec_ms?: int}` | `{action: view}`. `queued→done\|failed`; `done\|undoing→undone`; `failed` while `undoing` → back to `done`; `done` over `failed/timeout` wins; repeat = no-op; else `409 action_conflict` |
| `local_action_pending` | `{device_id, limit?: 1..20}` | `{actions: DeviceActionView[]}` — device rows `queued` (`op:'run'`) or `undoing` (`op:'undo'`, with `handle`), unclaimed or claimed by this device; the call claims them |
| `local_action_undo` | unchanged | device row `done → undoing`, card "Undoing on your iPhone…" |
| `voice_warm` | unchanged | adds `device_pending: number` |
| `local_action_list` | unchanged | rows add `runner` |

All `thread:write` (pending/list read as usual), worker role refused, closed schemas. Audit `local_action.run|fail|undo` with `runner:'device'`.

Migration `045_device_actions.sql`: `local_actions` adds `runner text NOT NULL DEFAULT 'mac' CHECK (runner IN ('mac','device'))`, `device_id uuid`; status CHECK adds `undoing`; pending index restricted to `runner='mac'`; new index on device rows `queued|undoing`; `voice_intents` adds `device_capable boolean NOT NULL DEFAULT false`.

Swift (`iOS-app/Sources/DeviceActions.swift`, `DevicePermissions.swift`): `DeviceAction` (Codable, snake_case keys), `DeviceOutcome`, `DeviceStore` protocol (fakeable), `@MainActor DeviceActions.shared` with `deviceID` (random UUID in `ring.deviceID`), `capabilities()`, `run(id:action:)`, `undo(id:handle:)`, `drain(service:)`. `VoiceIntentResult.Action` gains `runner` (default `"mac"`) and `action`; `VoiceIntentRequest` gains `deviceID`, `deviceActions`.

### 11.4 iPhone executor

- **Ledger** `ring.deviceActions` (UserDefaults): `action_id → {state: started|saved|blocked|reported, identifier?, action, at}`; `started` before save, `saved` after; prune > 24 h, `reported` > 1 h.
- **Idempotency**: a `saved` entry returns its identifier; a `started` entry without identifier scans for the marker (incomplete reminders in the target list; events ±1 day of `start_at`); a fresh id skips the scan. Marker `swarmaa:<action_id>` is the last line of `notes`.
- **Reminder**: `EKReminder`, `dueDateComponents` + one absolute `EKAlarm` when `due_at` is set; handle `calendarItemIdentifier`.
- **Event**: `EKEvent`, no attendees, `isAllDay`; handle `eventIdentifier` (none if calendar access is write-only → not undoable).
- **Timer/alarm**: (1) iOS 26 + AlarmKit authorized → `AlarmManager` schedule with id = action id (`kind:'timer'` countdown of `fire_at − now`, `kind:'alarm'` fixed date); handle `alarm:<id>`, undo = cancel. (2) else Reminders allowed → `⏱ <label>` reminder due at `fire_at`. Past `fire_at` → `failed/timeout`.
- **Lists/calendars**: picked only in the app (`ring.remindersList`, `ring.todoList`, `ring.calendar`); default list/calendar otherwise. A transcript never picks one.
- **Permission missing at run time**: entry `blocked`, no report, row stays `queued`; notification "Allow Reminders to finish: Call mom · Today 17:00" opens the This iPhone section; granting drains blocked entries.
- **Notification**: category `RING_ACTION` with a background "Undo" action (`userInfo`: action_id, handle).
- **Report**: fire-and-forget on the warm relay after the notification, before the audio upload; unreported entries are retried by `drain` (app active, `device_pending > 0`, after every `voice_intent`).

### 11.5 "This iPhone" permissions

A connectors-style list (embedded in the Ring sheet / Settings): one row per capability with icon, title, subtitle and an **Allow** button that triggers the iOS prompt and then shows **Allowed**; denied → **Open Settings**; Calendar add-only → "Allowed · undo unavailable". If never tapped, the app asks the first time a memo needs it (foreground: prompt at once; background: one local notification per capability).

| Row | Subtitle | Grants |
|---|---|---|
| Reminders | Set and check reminders | `requestFullAccessToReminders` |
| Calendar | See your day and add events | `requestFullAccessToEvents` |
| Alarms | Set alarms and timers | AlarmKit authorization (iOS 26; otherwise "Needs iOS 26 — timers use Reminders") |
| Speech recognition | Transcribe ring memos on this iPhone | status row; denied loses the fast path |
| Notifications | Confirm what your ring did | status row |
| Bluetooth | Stay connected to your ring | status row |

Row model: `protocol DevicePermission { capability, icon, title, subtitle, state() async, request() async }`; `DevicePermissions.all` lists them, so Contacts/Location/Home are one new type each. `device_actions` = capabilities of rows that are allowed/limited (status-only rows have no capability).

Info.plist + `project.yml` keys: `NSRemindersFullAccessUsageDescription`, `NSCalendarsFullAccessUsageDescription`, `NSCalendarsWriteOnlyAccessUsageDescription`, `NSAlarmKitUsageDescription`; reword `NSSpeechRecognitionUsageDescription` to cover ring memos.

### 11.6 Privacy delta

- The Mac path and its Automation grant remain as the fallback (§5.7).
- The phone reads only the configured list (marker scan) or one item by identifier; nothing read leaves the phone — reports carry id, status, handle, code only.
- Actions come from the closed set, validated and redacted on the Mac; the phone re-checks type, lengths and dates and ignores unknown types.
- `device_id` is a random per-install UUID.
