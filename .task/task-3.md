Task 3: persistent schedule card, pause/resume, Mac/iOS rendering. No Task 1/2 behavior, dependencies, service access, commits or release actions.
Baseline a15715cb08bf1e14336c8236e5d990ae778451d7; clean writable worktree; Node v24.21.0.
Risk: scheduler timing and durable message updates. Source rollback point: baseline. Ownership: schedule-specific server/client code and tests; migration 031 (030 reserved for Task 1).
Checks: focused schedule regression, TypeScript, brief-required npm test, Mac build, existing iOS simulator tests. UI flow: create schedule -> one card -> pause -> resume -> edit/clear, version conflict/error.
External actions: none authorized. Bridge owns commit (overrides brief commit instruction).

Implemented:
- src/core/bots.ts + bot-routing.ts: validated partial pause rule; immediate next-run calculation on create/edit/resume; paused ticker guards before and under locks; cron formatter, three timezone-aware dates, one durable schedule message updated at fixed id/seq and refreshed by ticks.
- src/core/tools.ts: pause and nullable schedule wire schemas. Migration 031 adds schedule kind and uniqueness; no edits to applied migrations or Task 1/2 behavior.
- Mac: ThreadView/BotsViews render card/actions, BotsModels/SwarmaTeamsClient decode payload and preserve optional pause rule.
- iOS: SwarmaaApp card/actions and schedule editor; AppCore includes schedule in saved settings. Unknown kinds retain existing fallback.
- New tests: tests/schedule-card{,.integration}.test.ts, both apps' Tests/ScheduleCardTests.swift.

Evidence (Node v24.21.0):
- Before implementation: new pause regression failed with `Unknown argument: schedule_paused`.
- npx tsc --noEmit: clean (typecheck.log).
- Focused initial bot/cron/regression unit checks: 27/27; expanded schedule unit checks: 4/4 (schedule-tests.log).
- Disposable local PostgreSQL 17, random per-suite schemas: schedule-card, bot-routing and bots integration suites 25/25 passed (db-tests.log). Instance created only for tests under .task, then stopped; no service credentials or production database used.
- npm test: 484 tests, 474 passed, 9 skipped, 1 failed: only the brief-exempt sandbox light-profile real-process test (npm-test.log).
- Added native test target source files; generated both previously absent Xcode projects with xcodegen, per brief exception.
- Existing specified iPhone SE simulator: xcodebuild test -only-testing:SwarmaaTests passed 19/19 (ios-test.log).
- Mac build blocked before source compilation: SwiftPM manifest sandbox_apply Operation not permitted (mac-build.log). Process-local workaround flag rejected as unsupported (mac-build-retry.log); no settings changed. Edited Mac source and new Mac test pass swiftc -frontend -parse (mac-parse.log); this is not a successful build/typecheck.
- git diff --check passed. Manual final diff review found no actionable dead-code/abstraction reduction.

Unfinished acceptance: full Mac build + Mac test execution in an environment allowing SwiftPM manifest sandbox; interactive card/navigation checks at representative layouts/states. No live service connection or UI interaction claimed. Schedule cards deliberately show no upcoming runs while paused/cleared.
No commits, pushes, merges, deployments, messages, account changes, bridge restarts, or new simulator creation. Bridge owns commit despite conflicting brief/JSON commit instruction.
