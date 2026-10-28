Task 2 — implemented; Mac acceptance remains blocked.

Baseline: a15715cb08bf1e14336c8236e5d990ae778451d7; initially clean worktree; writable; Node v24.21.0.
Scope: Mac TeamsModel/ThreadView, iOS AppCore/SwarmaaApp, task finish path, new regression tests. No schedules, dependencies, bridge changes, credentials, commits, pushes, merges or deployments.

Behavior: pure client grouping folds consecutive notice/handoff/system-text rows only when loaded human and later agent-text boundaries exist. Single notes, live tails, partial history, final replies, humans and every card stay visible. Disclosure expansion is per-thread, in-memory model state; timestamps span only folded rows (unknown timestamps omit duration). Empty successful bot turns post a system notice in the fenced completion transaction; completion replay does not duplicate it or re-ask the model.

Evidence:
- npx tsc --noEmit: pass, Node 24.21.0.
- npm test: 480 tests, 470 pass, 9 skipped, only failure is the brief-exempt sandbox light-profile test (nested sandbox operation not permitted).
- New disposable PostgreSQL 17 instance; no production configuration read. New summary suite: 6/6 pass. Original tasks.ts restored temporarily: 4 empty-answer cases fail as expected, 2 real-answer controls pass; fixed source restored and 6/6 pass again.
- Existing bots integration: 14/14 pass. Focused Teams delegation/completion/grant checks: 5/5 pass. Disposable DB stopped and removed.
- iOS SwarmaaTests: 20/20 pass, including 2 new grouping/state tests, on existing Piano Review iPhone SE B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56.
- iOS WorkingNotesUITests: 1/1 pass on that device: collapsed notes, expand, navigate away/reopen with expansion retained, collapse, task/question controls still accessible. Fixtures require -demo and -working-notes-demo and contact no host.
- Mac changed Swift files and tests: swiftc -frontend -parse passes. Full build blocked before compilation by SwiftPM manifest sandbox: sandbox-exec: sandbox_apply: Operation not permitted (swift-nio). Xcode rejected -IDEPackageSupportDisableManifestSandbox as an invalid option; no settings changed. Mac grouping tests and visual interaction remain unexecuted.
- Xcode projects initially absent; generated only after adding new test target files, as permitted by the brief. Generated project/build artifacts are not source changes.
- git diff --check: pass. Source review found no actionable simplification.

Next: run Mac build and WorkingNotesTests plus disclosure interaction in a native session that permits SwiftPM's manifest sandbox before accepting all brief criteria. Bridge owns committing; explicit worker prohibition overrides brief/JSON commit instructions.
