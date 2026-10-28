# Brief: iOS push notifications

Flow: a bot event on the Mac host (reply, question, task failed / review-ready) → host server sends an APNs push to the owner's registered iPhones → tap opens that bot's thread.

## Contract (both sides build against this)

- Tool `push_register` (permission `agent:read`), input `{ token: string (hex, 64–200 chars), environment: "sandbox" | "production" }`, returns `{ ok: true }`. Upsert keyed by token; re-registering moves the token to the caller's tenant/principal.
- Tool `push_unregister` `{ token }` → `{ ok: true }`. The app calls it on sign-out.
- Push payload (content-free, no message text ever):
  ```json
  { "aps": { "alert": { "title": "<bot name>", "body": "Needs you" | "Replied" | "Task failed" | "Ready for review" }, "sound": "default", "thread-id": "<bot_id>" },
    "bot_id": "<bot_id>" }
  ```
  `apns-collapse-id` = bot_id, `apns-push-type: alert`, `apns-priority: 10`, topic = `APNS_BUNDLE_ID`.

## Server (`~/Projects/swarma`, TypeScript)

1. Migration `db/migrations/029_push_devices.sql`: `push_devices (token text primary key, tenant_id, principal_id, environment text check in ('sandbox','production'), created_at, updated_at)` plus a single-row cursor table `push_cursor (id int primary key default 1, last_event_id ...)` or equivalent — follow how existing migrations name and type columns.
2. Register the two tools in `src/core/tools.ts` and dispatch in `src/core/index.ts` the same way `bot_list` is (`src/core/tools.ts:85`, `src/core/index.ts:145`).
3. `src/push.ts`: APNs sender. Copy the approach of `~/Documents/Claude/Projects/Wealthtracker/retireodds/lib/apns-sender/{jwt.js,client.js}` (ES256 JWT cached ≤ 50 min, Node `http2`, one session per host). Every request has a 10 s timeout and one retry; `410` or `400 BadDeviceToken`/`Unregistered` deletes the device row. Config from env: `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`. If any is missing the worker logs once and stays off. Never log the key, JWT, or full device tokens (last 6 chars only).
4. Push worker in the server process: `LISTEN swarmaa_events` (emitted by `event()` in `src/core/shared.ts:88`), read `events` rows after the cursor in id/creation order, and push for:
   - `question.created` in a bot's thread → "Needs you"
   - `message.created` in a bot thread whose author is an agent (not the human owner), kinds that are replies/notices → "Replied"
   - task finished for a task with `bot_id`: failed → "Task failed"; completed with `result.head_commit` → "Ready for review" (same rule as `needs_you_count` in `src/core/bots.ts:836-845`)
   Map thread → bot via `bots.thread_id`. Send to every device of that tenant. Coalesce: at most one push per bot per 20 s. Advance the cursor after processing; catch up on startup but skip events older than 10 minutes.
5. Tests in `tests/` (vitest, like the existing ones): register/unregister, event → payload mapping (including "no message text in payload"), BadDeviceToken deletes the row. Use a fake sender, no network.

Rules: don't touch `src/bridge/sandbox.ts` or `providerEnvironment`. Don't restart running bridges or run `npm run deploy:local`. Commit with a conventional commit message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; don't push.

Acceptance: `npm test` and `npm run build` (or `npx tsc --noEmit`) pass; `git diff --stat` touches only the files above plus tests.

## iOS (`~/Projects/swarma/iOS-app`, SwiftUI + XcodeGen)

1. `project.yml`: add the Push Notifications entitlement (`aps-environment: development`; release builds get production via signing) and `UIBackgroundModes` is NOT needed. Run `xcodegen` in your own worktree only.
2. On successful pairing and on every launch while paired: request alert/sound/badge authorization (only once, after the first bot list loads, not on the connect screen), `registerForRemoteNotifications`, then call `push_register` with the hex token and `environment` = `sandbox` for DEBUG builds, `production` otherwise. Use the existing `call(_:_:)` in `Sources/AppCore.swift:206`.
3. On sign-out call `push_unregister` (ignore failure) before clearing the Keychain.
4. `UNUserNotificationCenterDelegate`: show banners while in foreground unless that bot's thread is open; on tap read `bot_id` and open that thread with the existing `open(bot)` path in `Sources/SwarmaaApp.swift`.
5. Tests: unit test for token hex encoding and the tap → `bot_id` routing. Keep the existing tests passing.

Rules: never create a simulator; reuse "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`. Don't run xcodegen in the main checkout (Xcode may have it open). Don't change layout beyond what's named. Commit with a conventional commit ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; don't push.

Acceptance: `xcodebuild test -scheme <app scheme> -destination 'id=B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56'` passes.
