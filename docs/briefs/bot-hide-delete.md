# Brief: hide and delete bots, plus two bot fixes

Flow: Bot settings → **Hide bot** removes it from the bot list (reversible: the list's **Show hidden** toggle shows hidden bots with an **Unhide** action) · **Delete bot…** asks for confirmation, then removes the bot and its chat for good.

Three tasks on three branches, built against this contract. Shared rules:
- Read the code you touch end to end first; match the surrounding style.
- Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`. Don't run `npm run deploy:local`, restart launchd jobs or touch running bridges.
- No new dependencies. Never create an iOS simulator; use "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`. Run `xcodegen` only inside your own worktree, and only if you add files.
- Change only the UI named here. Destructive controls go at the bottom of Bot settings, below everything else, in the app's existing destructive/danger style if there is one (else a plain red-text button). Thumb rule on iOS: actions in the lower half.
- Commit on your branch, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge.
- Acceptance: `npx tsc --noEmit`; `npm test`; database tests with a throwaway DB: `TEST_DATABASE_URL=… npm run test:integration` (serial). Swift: Mac builds (`xcodebuild -project Mac-app/Codenotch.xcodeproj -scheme Codenotch -configuration Debug build`), iOS tests pass (`xcodebuild test -project iOS-app/Swarmaa.xcodeproj -scheme Swarmaa -destination 'id=B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56' -only-testing:SwarmaaTests`). Add at least one test that fails without your change. End with a short report.

## Contract

- `bot_archive {bot_id}` (exists, `src/core/bots.ts` `botArchive`): hides the bot and cancels its queued tasks. Keep as is unless broken; it also clears the star.
- **New** `bot_unarchive {bot_id}` → `{bot}`: clears `archived`. Does not restore the star or cancelled tasks. Schedule stays as it was; recompute `next_run_at` if it has a schedule and isn't paused.
- **New** `bot_delete {bot_id, confirm_name}` → `{deleted: true}`. The bot must already be archived (`409 bot_not_archived` otherwise), so delete is always two steps. `confirm_name` must equal the bot's name exactly (`400 confirm_mismatch`). In one transaction: set `tasks.thread_id = NULL` for tasks in the bot's thread, then delete the bot row (`tasks.bot_id` is `ON DELETE SET NULL`, push cooldowns cascade), then delete its thread (messages, questions and members cascade). Don't delete agents. Audit it. Emit `bot.updated` with `reason: 'deleted'`.
- Permissions: the same as `bot_archive` (see `src/core/index.ts:32` and the tool spec in `src/core/tools.ts`).
- `bot_list {include_archived: true}` (exists) returns hidden bots with `archived: true`.

## Task A — server

1. `bot_unarchive` and `bot_delete` per the contract: tool specs in `src/core/tools.ts`, dispatch in `src/core/index.ts`, implementation in `src/core/bots.ts`.
2. **Bug: "Crew updated." on every update.** `src/core/bots.ts` `bot_update` sets `crewChanged` whenever `lead_agent_id` or `member_agent_ids` is present (around line 699). Clients send the full crew on every save, so pausing a schedule posts "Crew updated." Treat the crew as changed only if the lead differs or the member set differs (order-insensitive) from the current crew.
3. Tests (integration, `tests/`): unarchive; delete refused unless archived, refused on wrong name, and on success removes bot, thread and messages while keeping tasks (with `bot_id`/`thread_id` NULL); updating with the same crew posts no notice, while a real crew change still does.

## Task B — Mac app

Files: `Mac-app/Sources/Teams/BotsViews.swift` (Bot settings and bot list), `BotsModels.swift`, `TeamsModel.swift`, `Mac-app/Sources/Providers/SwarmaTeamsClient.swift`.
1. Bot settings, bottom: **Hide bot** (calls `bot_archive`, then returns to the list) and **Delete bot…** (only offered after hiding, i.e. on hidden bots; a confirmation sheet where you type the bot's name, then `bot_delete`).
2. Bot list: a small **Show hidden** toggle at the bottom of the list (next to New bot). When on, the list includes hidden bots (`include_archived: true`), dimmed, with an **Unhide** action (context menu and in their settings).
3. **Bug:** when a bot's schedule is paused (`rules.schedule_paused`), the list row shows "Paused" instead of "SCHEDULED · in 0 sec" (it currently formats a missing `next_run_at` as now).
4. Unit-test the list filtering and the paused label as pure functions.

## Task C — iOS app

Files: `iOS-app/Sources/SwarmaaApp.swift`, `iOS-app/Sources/AppCore.swift`.
1. Same actions as Task B in the bot's settings screen: **Hide bot**, and for hidden bots **Unhide** and **Delete bot…**, with a confirmation that requires typing the name. Put them at the bottom of the screen.
2. Home: a **Show hidden** option (in the existing bottom area, not the top row) that includes hidden bots, dimmed.
3. If iOS shows a schedule label for paused bots, it shows "Paused". If a bot is deleted while its thread is open, go back to the list without an error.
4. Unit tests for the model calls (`bot_archive` / `bot_unarchive` / `bot_delete` with `confirm_name`) and the hidden filter, using the existing test stubs.
