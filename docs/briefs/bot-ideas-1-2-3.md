# Brief: three bot improvements (ideas from OpenMausBot's docs — ideas only, no code from it)

Three independent tasks, each built by its own agent on its own branch. Shared rules for all three:

- Read the code you touch end to end first. Match the surrounding style (terse TypeScript, SwiftUI as in the existing files).
- Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`. Don't run `npm run deploy:local`, restart launchd jobs, or touch running bridges.
- No new npm or Swift package dependencies. Never copy code from OpenMausBot or OpenBot.
- Never create an iOS simulator. Use the existing "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`. Don't run `xcodegen` unless you add files to the iOS or Mac target; if you must, it's fine inside your own worktree.
- Keep UI edits to what's named here; don't restyle anything else. Put new SwiftUI views in new code inside the named files rather than rewriting existing views, so the three branches merge cleanly.
- Commit on your branch with a conventional commit message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push. Don't merge.
- Acceptance for every task: `npx tsc --noEmit` and `npm test` pass (one existing test, `tests/sandbox.test.ts` "light profile…", fails when run inside a sandbox — ignore only that one). If you change Swift: the Mac app builds (`xcodebuild -project Mac-app/Codenotch.xcodeproj -scheme Codenotch -configuration Debug build`), and iOS tests pass (`xcodebuild test -project iOS-app/Swarmaa.xcodeproj -scheme Swarmaa -destination 'id=B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56' -only-testing:SwarmaaTests`). Add at least one test that fails without your change.
- End with a short report: what changed, files, test results, anything left undone.

## Task 1 — Quiet scheduled runs (server only)

Problem: `tickBotSchedules`/`fireSchedule` in `src/core/bot-routing.ts` start a model turn on every tick and post a "Scheduled run" notice, even when nothing changed, burning quota and cluttering the thread.

Build:
1. **Skip when nothing changed.** Before queueing the scheduled turn, check whether anything relevant happened in the bot's scope since the bot's last scheduled run: rows in `events` for that tenant+scope (`message.created`, `task.updated` with action `finished`, `memory.changed`, `question.created`), excluding events caused by the bot's own previous scheduled run and its "Scheduled run" notice. If nothing → advance `next_run_at`, post nothing, start nothing. Record the last run time (new nullable column on `bots`, migration `db/migrations/030_bot_quiet_runs.sql`; the server is at 029). A failed check must count as "run it", never as "nothing new".
2. **Opt-out per bot.** `rules.quiet_schedule` boolean, default true. When false, keep today's behaviour. Validate it where other `rules` keys are validated (`src/core/bots.ts`) and accept it in `bot_update`.
3. **Quiet replies.** Tell the scheduled turn (in its objective) that if it has nothing worth reporting it must reply with exactly `{"quiet":true}`. When a scheduled turn finishes with that as its whole answer, don't post the reply message and remove that run's "Scheduled run" notice (or don't post the notice until the turn produces a real reply — your call, pick the simpler correct one). Find where turn replies are posted (`src/core/tasks.ts`, around `replyMsgId`).
4. Tests in `tests/` with the existing DB test helpers: no events → no task queued and no notice; an event → task queued; `quiet_schedule:false` → always runs; a `{"quiet":true}` answer → no reply message in the thread.

## Task 2 — Fold a bot's working notes in threads (Mac + iOS)

Problem: bot threads fill with intermediate rows — "Assistant handed this to claude-opus-5-5 for a fuller answer", handoff and system notices, delegation notes — so the actual answer is hard to find, especially on the phone.

Build:
1. **Client-side fold** in both apps: a run of consecutive non-human rows between a human message and the agent's final text reply (kinds such as `notice`, `handoff`, and system-authored messages; NOT `task` cards, `question`s, or the final `text` reply) collapses into one row: "Worked for 3m · 4 steps" (duration = first to last folded row). Tap/click expands it in place; state is per-thread, in memory only. A run with only one such row is not folded. Never fold rows that need the user (questions, failed/review-ready task cards).
   - Mac: `Mac-app/Sources/Teams/ThreadView.swift` (`MessageRow` and the list that renders messages; message model in `TeamsModel.swift`).
   - iOS: the thread list in `iOS-app/Sources/SwarmaaApp.swift` (message rendering near `message.kind == "task"`); model in `iOS-app/Sources/AppCore.swift`.
   - Put the grouping logic in one small pure function per app and unit-test it (Mac: an existing test target if there is one, otherwise a test in the iOS target is enough plus a Mac build).
2. **Finished without a summary (server).** If a bot turn (task kind `turn` with `bot_id`) finishes with an empty answer, post a short notice "Finished without a summary" in the thread instead of nothing. Don't re-ask the model. Test it in `tests/`.

## Task 3 — Schedule card (server + Mac + iOS)

Problem: a bot's schedule is a cron string hidden in Bot settings; nobody can tell when it will fire.

Build:
1. **Card message.** When a bot is created with a schedule, or `bot_update` changes/clears/pauses its schedule, post one message of a new kind `schedule` into the bot's thread, replacing (updating in place, via the existing `message.updated` mechanism) the previous schedule card for that bot rather than stacking new ones. Payload: the cron expression, a plain-English description (write a small formatter for the common cases: every N minutes/hours, daily at HH:MM, weekdays at HH:MM, weekly on <day> at HH:MM; otherwise show the raw expression), the timezone, the next 3 run times (reuse `nextCronRun` from `src/core/bot-routing.ts`), and `paused` state. Server code in `src/core/bots.ts` / `src/core/bot-routing.ts`; tests in `tests/`.
2. **Pause / resume.** If there is no way to pause a schedule without deleting it, add one: `rules.schedule_paused` boolean (or reuse the existing `next_run_at='infinity'` parking) exposed through `bot_update`. The ticker must skip paused bots. Resuming recomputes `next_run_at`.
3. **Render the card** in both apps: rule text, timezone, next 3 runs as relative times, and two buttons — Pause/Resume (calls `bot_update`) and Edit (opens the existing Bot settings sheet/screen on that bot). Mac: `Mac-app/Sources/Teams/ThreadView.swift` + `BotsViews.swift`. iOS: `iOS-app/Sources/SwarmaaApp.swift`. Unknown message kinds must keep rendering as they do today in older clients.
