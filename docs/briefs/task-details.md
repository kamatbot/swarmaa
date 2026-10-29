# Brief: select several tasks, and see who did what

Flow, in the Mac Tasks pane:

- **Select:** a Select button in the Tasks top bar turns on selection. Each row shows a checkbox, and ⌘-click or ⇧-click selects without it. With anything selected, a bottom bar reads "N selected" and offers **Resolve** and **Unresolve** (each disabled when none of the selection can take it), plus Cancel. Running or queued tasks can't be selected for either.
- **Details:** clicking a task row outside selection opens a detail panel on the right, which closes with Esc or ×. It shows the objective and state; which agent and service ran it, on which model and effort, and how long it took; every run (attempt), with its worker, provider, model, start, end and outcome; the branch, changed files and summary; and tokens (input, cached input, output) when recorded, "Not recorded" otherwise.

Two tasks on two branches.

## Shared rules

- Read the code you touch end to end first; match the surrounding style (terse TypeScript; SwiftUI with `KS.*` colours and fonts and `L10n.t` copy). The Mac app has just moved to soft shades instead of hard ink lines between sections, so don't add ink dividers.
- Change only what this brief names. Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`. Don't run `npm run deploy:local`, restart launchd jobs or touch running bridges. No new dependencies.
- If `Mac-app/Codenotch.xcodeproj` is missing in your worktree, run `xcodegen` in `Mac-app/` in your own worktree (never in the main checkout).
- Commit on your branch, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge.

## Contract between the two tasks

A finished task's `result` gains an optional `usage`: `{ input_tokens: number, cached_input_tokens?: number, output_tokens: number }`, summed over the provider turns of that attempt. It's absent when the provider doesn't report usage (Antigravity) or the output can't be parsed. `task_get` and `task_list` already return `result`, `served`, `runs` and `permission_envelope.runner`; nothing else changes shape.

## Task 1: record token usage (service and bridge)

Files: `src/bridge/adapters.ts`, `src/bridge/worker.ts`, and a test in `tests/`.

1. Parse usage from the provider's JSON output: Codex's `turn.completed` events carry `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`); Claude's `result` event carries `usage` (`input_tokens`, `cache_read_input_tokens` as cached, `output_tokens`; add `cache_creation_input_tokens` into input). Sum across events. Write it to the finished task's `result.usage` where the bridge assembles `result` for `task_finish`.
2. Never fail a task because usage is missing or malformed: drop it instead.
3. Tests with recorded sample output for each provider, plus one malformed case. Acceptance: `npx tsc --noEmit` and `npm test` pass (`tests/sandbox.test.ts` "light profile…" fails inside a sandbox; ignore only that one).

## Task 2: Mac Tasks pane, multi-select and details

Files: `Mac-app/Sources/Teams/TasksViews.swift`, `Mac-app/Sources/Teams/TeamsModel.swift`, `Mac-app/Sources/Providers/SwarmaTeamsClient.swift` (task decoding), `Mac-app/Tests/` (unit tests and a `TeamsSnapshotRender` case).

1. Selection and bulk actions as described above. Bulk resolve calls the existing `task_resolve` once per task with its `expected_version`, at most 4 at a time. It reports partial failure in one line ("Resolved 3 of 4. 1 changed since you loaded it; try again."), then refreshes.
2. Task detail panel as described above. Decode what you need from `result` (`agent`, `summary`, `branch`, `changed_files`, `duration_ms`, `usage`), `served` (`provider`, `model`), `runs` (`worker_id`, `status`, `started_at`, `ended_at`) and `permission_envelope.runner` (`model`, `effort`). Format token counts as 12.4k. For a task that belongs to a bot or swarm, show the bot or swarm name and the crew agent if the model already knows it.
3. Unit-test the bulk-action rules as pure functions (which tasks can be resolved or unresolved; the partial-failure message) and the token formatting. Render snapshots of selection mode with 3 selected, and of the detail panel with and without usage.
4. Acceptance: the Mac app builds (`xcodebuild -project Codenotch.xcodeproj -scheme Codenotch -configuration Debug build`), and `xcodebuild test … -only-testing:CodenotchTests/TeamsSnapshotRender` plus your new tests pass with `TEST_RUNNER_SWARMAA_SNAPSHOT_DIR` set. End with a short report listing the PNG paths.
