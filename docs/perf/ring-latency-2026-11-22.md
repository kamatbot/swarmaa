# Ring → action latency review (2026-11-22)

Review by Fable of commits `f6462b0..a1f45be` (ring voice agent). Read-only code review; every figure is an estimate until the `Timings ms:` line in `ring.log` and `voice_intents.exec_ms` are read on real hardware. Line numbers refer to `a1f45be`.

**Bottom line:** the design target (BLE download + ~1.5 s) was not met in the common case: the relay "warm" was a no-op once the app had been opened (F1), a half-open socket turned the action into a 15 s stall plus the slow Assistant route (F2), and every reminder paid an osascript cold start, a full-list marker scan and possibly an app launch (F5–F7). The 2–5 s BLE download is free time to warm the whole chain.

## Fast local path ("remind me to call mom at 5"), 10 s memo, phone locked

| # | Stage | Before | Achievable |
|---|---|---|---|
| 1 | Idle push → count reply | 0.05–0.1 s | same |
| 2 | 0x40 → 150 ms → 0x34 → first packet | 0.2–0.3 s (+1.5 s on resend) | 0.2 s |
| 3 | BLE download (ring-paced; decode + recognizer append per frame) | 2–5 s | same |
| 4 | `RingMemoFile.save` on the main actor before `endAudio` | 0.15–0.4 s (2–3 s for 5 min) | off the action path |
| 5 | Final transcript | 0.3–1.0 s live; 2–25 s file fallback | 0.2–0.6 s |
| 6 | Relay socket | not warmed: 0.2–0.6 s handshake, or 15 s stall | 0 |
| 7 | `voice_intent` round trip (phone → relay DO → Mac relay agent → loopback HTTP) | 0.1–0.3 s | same |
| 8 | Intent transaction + parse | 10–30 ms (parse < 1 ms) | ~10 ms |
| 9 | osascript one-shot + marker scan + create (+ app launch) | 0.4 s – several s (+1–3 s cold app) | 0.1–0.2 s |
| 10 | Finalize + response | 10–25 ms | 5–10 ms |
| 11 | Local notification | 20 ms, silent | with sound |
| 12 | Audio upload | trails (off path) | same |
| | **Last BLE packet → lock-screen confirmation** | **1.5–3 s warm, 3–7 s cold, 15 s+ on a stale socket** | **~0.6–1.0 s** |

## Assistant path (free-form memo)

Same through stage 8, then: wake 10–50 ms → serial claim/checkpoint/context 30–90 ms → CLI spawn + first token 2–5 s (1–2 s with `turn_model`/low `turn_effort`) → rest of turn 5–25 s (2–6 s with a fast model and the two-sentence objective) → finish 40–100 ms → turn actions 0.3–3 s each → "Replied" push 1–3 s. **~10–35 s now, ~5–10 s achievable.**

## Findings

| ID | Sev | Where | Problem → fix |
|---|---|---|---|
| F1 | P0 | `RingLink.swift` `warmRelay`/`acquireRelay` | `Runtime.model.connected` means "has a service", not "socket up", so the foreground relay is never connected at the idle edge → always connect, and send `voice_warm`. |
| F2 | P0 | `SwarmaRelayTransport.swift`, `AppCore.swift` `bounded`, `RingIntent.send` | Half-open socket: send succeeds, no reply, 15 s timeout, then fallback to audio + Assistant → `voice_warm` probe with 1.5 s bound at idle edge; `voice_intent` own 6 s bound with one resend on timeout (host dedupes); pong deadline in the transport. |
| F3 | P1 | `SwarmaRelayTransport.scheduleReconnect` | Reconnect after backoff opens a second socket over one a caller already opened → reconnect via `ensureConnected`. |
| F4 | P1 | new `voice_warm` tool | Nothing warms the Mac side during the download → `voice_warm {}` (thread:write, no workers): `SELECT 1`, warm the action helper and apps. |
| F5 | P1 | `src/local/actions.ts` | osascript cold-started per action (0.2–0.4 s) → persistent JXA helper (line-delimited JSON over stdin/stdout), one-shot fallback; `check` stays one-shot and must not hold the queue. |
| F6 | P1 | runner `warm()` | Reminders/Calendar launch on first use (1–3 s) → pre-launch in `warm()`/server start, only for apps whose last check was `ok`. |
| F7 | P1 | `src/local/jxa.ts` | Marker scan over the whole list on every create → skip on attempt 1 (`fresh: true`); keep for sweep retries. |
| F8 | P1 | `RingLink.swift` finish/save | `endAudio` waits for the M4A save, which blocks the main actor → end the stream first, save off-main, ack after save as before, deliver in parallel. |
| F9 | P1 | `RingLink.swift` deliver | Live timeout `max(6, 1.5×dur)` exceeds background time → `min(8, 2+0.05×dur)`, file fallback `min(20, 4+0.5×dur)`; cancel the file task on timeout. |
| F10 | P1 bug | `RingLink.swift` | Saved memo tracked only in memory; app kill after save orphans it (ring copy already deleted) → persist `ring.undelivered`, replay on start/foreground. |
| F11 | P1 bug | `RingLink.abort` | Aborted downloads aren't retried until the next idle push → bounded re-check (≤3). |
| F12 | P2 | `RingLink.deliver` | Failed background transcription defers to app open → upload audio anyway (Assistant `no_transcript`). |
| F13 | P2 | `RingIntent.notify`, `voice.ts` | Silent notification; `running` shown as done → sound, "Working on it…", one follow-up poll; server waits on replay of a running action. |
| F14 | P2 | `RingLink`/`RingAudioStream` | Recognizer created mid-transfer; 30 ms poll → create at `beginDownload`, continuation instead of poll. |
| F15 | P2 | `PhoneMemos.swift` | Second whole-file transcription of fresh ring memos; double SHA-256 → skip young files / skip hash for unattempted. |
| F16 | P2 | `RingProtocol`/`RingAudioStream`/`note()` | Per-packet allocations; log rewritten to UserDefaults every status → contiguous buffers, debounce log. |
| F17 | P2 | `voice.ts`, `watch-services.ts` | ~30 serial queries per memo; O(n²) chunk re-read on put → merge queries, build response from RETURNING, count chunks until last. Tenant lock is not held across osascript (verified). |
| F18 | P2 | `actions.ts` summary | Card time uses the Mac's zone, not the phone's → pass the intent zone. |
| F19 | P2 bug | `RingLink.hold/release` | Background task leaks on signed-out return and after upload → release. |
| F20 | P2 | `worker.ts`, Assistant agent config | Serial checkpoint+context; no fast turn model → `Promise.all`; set `turn_model`/`turn_effort` on the Assistant (config only); run turn actions in parallel across apps. |

Fix status is recorded in the PR description.
