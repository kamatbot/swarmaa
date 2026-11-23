# SR116 ring voice memos (iOS)

Swarmaa's iOS app owns the SR116 ring's **recordings**; FitOdds only reads its
health history (disjoint command sets, so both can share the ring's BLE link).
Protocol reference: kamatbot/fitodds `docs/SR116-PROTOCOL.md`; codec copy in
`iOS-app/Sources/RingProtocol.swift` (keep in sync).

Flow (`iOS-app/Sources/RingLink.swift`):

1. Restorable `CBCentralManager` (`app.swarmaa.ring.v1`, `bluetooth-central`
   background mode) holds a pending connection to the paired ring (56FF,
   write 33F3, notify 33F4), so iOS wakes Swarmaa on ring notifications.
2. Ring pushes audio state 0x2F: 0x50 recording → 0x40 idle. On that falling
   edge, and on every (re)connect, Swarmaa asks for the file count (0x3D) and
   acts only on a count reply to its own request (other apps' replies are
   broadcast on the same channel).
3. Download: 0x40 stop stale transfer, 1 s, 0x34. Packets 1…T must arrive in
   order (fail closed); 20 s inactivity aborts. Ring sends 0x36 + remaining.
4. Opus (16 kHz mono, 40-byte packets) → AAC M4A in the Watch memo folder,
   re-read to verify, then **0x36 delete-ack** echoing the remaining count. An
   incomplete or unsaved transfer is never acked; the ring keeps the file.
5. On-device transcript (`MemoTranscriber`), assign to the ring's bot (default
   "Assistant", then starred, then first), and `PhoneMemos.flush` uploads with
   `watch_memo_put`; the host announces it and the bot acts on it.

Limits: the iPhone copy is the durable copy once acked (Watch-memo cap of 20
files applies). Force-quitting Swarmaa stops background wakes until reopened.

## Voice agent: memo → action

Design and frozen contract: [RING-AGENT.md](RING-AGENT.md). Service side
(`src/core/voice.ts`, migration `044_voice_actions`):

- `voice_intent` (transcript first, audio trails) posts the "🎙 Voice memo"
  message (key `voice-memo:<memo>`), parses it with `src/voice/intent.ts`, and
  either queues one closed local action (reminder, event, note, timer; run
  after commit, waited on up to 4 s, result card = `notice` with
  `ref.local_action`), delegates "ask/tell <bot>" into that bot's thread as the
  person, or queues one Assistant turn with a hint-specific objective. A
  disabled/unavailable action falls back to the Assistant. Idempotent per
  `(tenant, thread, memo)`; a different transcript is `409 memo_conflict`.
- When the audio later lands (`watch_memo_put`), `announce` attaches
  `ref.voice_memo` to that message and queues no second turn. Audio-only memos
  keep the old path (one Assistant turn).
- `local_action_run|undo|list|check` expose the runner directly; bots with
  `rules.local_actions: true` may emit `{type:'local_action', action}` (≤ 5
  per turn). Rows left queued/running are rerun by a server sweep (30 s, 3
  attempts).
- Device actions (migration `045_device_actions`, RING-AGENT.md §11): when the
  phone sends `device_id` + `device_actions`, reminders, events and
  timers/alarms run on the iPhone (`route: 'device'`), which reports with
  `local_action_report` and drains undo/retries with `local_action_pending`.
  The Mac stays the fallback. Permissions per side: [LOCAL-ACTIONS.md](LOCAL-ACTIONS.md);
  tools: [API.md](API.md#voice-memos-and-local-actions-migrations-044045).
