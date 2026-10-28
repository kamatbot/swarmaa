# Bot hide/delete — Task C checkpoint

- Objective: implement only iOS Task C of docs/briefs/bot-hide-delete.md against the shared contract.
- Baseline: 2c9b6c8c36621f2bf610ce6eb6ffe46ef9616bd7, branch swarmaa/codex/8ba054ff; initially clean and writable.
- Scope/risk: routine iOS model and UI change, including a destructive action requiring an already-hidden bot and exact saved-name confirmation. Server transaction enforcement belongs to Task A.
- Owned implementation: Sources/AppCore.swift and Sources/SwarmaaApp.swift. Tests: Tests/AppTests.swift, new Tests/BotVisibilityTests.swift, UITests/NavigationTests.swift.
- Behavior: complete bot inventory fetched with include_archived; local Show hidden filter defaults off; hidden rows dimmed; bottom settings actions; hide returns home; unhide uses server response; delete clears cached/open thread; deletion events and confirmed missing-thread reads return home quietly. The existing schedule card already renders “Paused”.
- No server/Mac implementation, dependencies, bridge changes, service access, deployment, push, merge or commit. The worker's explicit no-commit instruction overrides the brief's commit request; bridge owns committing.
- Node runtime checked: v24.21.0, /opt/homebrew/opt/node@24/bin first.
- TypeScript: npx --no-install tsc --noEmit passed.
- iOS: all 25 SwarmaaTests passed on required simulator B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56, including 4 new visibility/deletion tests. Final model/source run: /tmp/swarma-task-c-final-ios.log.
- Regression proof: temporarily removing only deleted-event handling makes testDeletedEventClosesOpenThreadWithoutReadingIt fail 3 assertions (exit 65); handler restored and test passes. /tmp/swarma-task-c-regression.log.
- npm test: 485 tests, 475 passed, 9 skipped, 1 failed. Existing tests/sandbox.test.ts:32 expects sandbox-exec child exit 0 but receives 71 in this worker environment. Sandbox source left untouched. /tmp/swarma-task-c-npm.log.
- Mac build not run: Mac-app/Codenotch.xcodeproj absent. No Mac files added, so did not generate its project.
- Database integration not run: no explicitly supplied throwaway TEST_DATABASE_URL; no credential files consulted.
- Representative flow: home → Show hidden → hidden bot → Bot settings; visible settings show Hide bot; hidden settings show Unhide/Delete bot at bottom. UI test status recorded below.
- Still requires integrated Task A service smoke test for actual archive/unarchive/delete, typed-name alert interaction, and larger-text UI review. Demo prevents mutations and never connects to a host.
- Simplicity review: no dependencies or speculative abstraction added. Lean already. Ship.
- UI result: testHiddenOptionAndSettingsActionsAtBottom passed on the required iPhone SE simulator. Verified toggle in bottom half, hidden row appears when enabled, hidden settings show Unhide/Delete only, visible settings show Hide only, and destructive actions sit below screen midpoint. First test attempt tapped the row center rather than the switch; corrected to the switch hit target and reran only that test. /tmp/swarma-task-c-ui-final.log.
- Final git diff --check passed. All edits remain uncommitted for bridge review/commit. Next: integrate Task A and run the outstanding service/database/Mac checks; investigate the existing sandbox test in a suitable environment.
