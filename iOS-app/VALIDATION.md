# I2 task checkpoint and validation

Objective: implement I2 of `docs/briefs/ios-app.md`, including the nine native screens, relay pairing/stream, Keychain storage, bot/task/usage actions and the two App Intents. Non-goals: service/I1 changes, production connections, publication, signing/distribution and deployment.

Baseline: `e64e029` on `swarmaa/codex/9bb23f32`. The worktree was clean and writable at entry. `swarmaa/antigravity/c3058682` (`465431ed5122920f9184e5bebb0e72e4e1f02dd3`) merged cleanly with `git merge --no-commit --no-ff`. That merge adds only the shared transport and its tests under `Mac-app/`; neither was edited afterward. All additional owned files are in `iOS-app/` and `design/launch-kit/screens-ios/`. The baseline plus the recorded merge is the rollback/reference point; no reset was performed.

The JSON brief requests a commit, while the enclosing worker instructions explicitly prohibit commits and assign them to the bridge. The enclosing restriction was followed: **no commit, branch change, push, publication or deployment**. The merge is deliberately pending for the bridge's commit. No service writes, real messages, real pairing codes or account settings were used. No dependencies were installed.

Risk: new client behavior, secure storage and mutation retries. Requests retain server authorization boundaries; untrusted content is rendered as text. Failed/uncertain posts and bot creation reuse idempotency keys. The app handles optimistic bot versions. Tests use a fake relay WebSocket and generated fixtures, including a separate, random Keychain service for each storage test.

## Final evidence

`xcodegen` succeeded with XcodeGen 2.46.0. Xcode 27.1 (27A9275) built the Swift 6 app targeting iOS 18.0. The final command completed with **exit 0 / TEST SUCCEEDED**:

```sh
cd iOS-app
xcodebuild -project Swarmaa.xcodeproj -scheme Swarmaa \
  -destination 'platform=iOS Simulator,name=Piano Review iPhone SE' \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  -test-timeouts-enabled YES -maximum-test-execution-time-allowance 60 test
```

**24 tests passed:** 11 app tests, 12 shared relay tests, and one UI navigation journey. Exact test names, durations, source hashes and the local result-bundle path are in `validation-receipt.txt`.

The app tests cover Keychain pairing and sign-out, invalid pairing, home order and a single starred shortcut, optional `starred`, New bot validation, split-byte SSE parsing, relay events updating the open thread and typing, individual task updates, one-post/reply shortcut behavior, timeout fallback without reposting, blank input and cancellation unblocking a relay request.

The UI test navigates home → Tasks/filter → home → Usage → starred thread → Bot settings → home → You → New bot/disabled validation → Hosts/Connect → starred thread → Answer. It verifies Connect is reachable and the answer sheet contains the full question and choices. Actual navigation found and fixed a stale sheet-data bug; the presentation item now owns its question/changes payload.

The unchanged upstream transport tests cannot compile in Swift 6 mode. The exact initial compiler diagnostic was:

```text
Mac-app/Tests/SwarmaRelayTransportTests.swift:409:28: error: sending value of non-Sendable type '() async throws -> ()' risks causing data races [#RegionIsolation::SendingRisksDataRace]
```

They pass unchanged in the separate **iOS** `RelayCompatibilityTests` target in Swift 5 mode. The application and its 11 app tests remain Swift 6 with complete checking. This is a compatibility exception for upstream tests, not an edit to Mac code.

The first macro-enabled build could not nest Swift's compiler-plugin sandbox inside this worker sandbox. `project.yml` therefore supplies `-disable-sandbox` only for simulator compilation. Device builds use the default. No runtime permissions were changed.

The simulator was already booted: **Piano Review iPhone SE**, `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`, iOS 27.0, 375 × 667 pt. No simulator was created or booted; existing devices were left in their original state. Test targets explicitly run without simulator parallelization/cloning.

Nine final PNGs were captured with `-demo -screen …`, saved in `design/launch-kit/screens-ios/`, and visually inspected. They show native views and fixture data; Connect contains empty secure pairing fields. Long lists/forms scroll within the reachable area, and the primary buttons remain visible on this small phone. Usage was recaptured after one transient SpringBoard capture. No screenshot was fabricated from HTML.

Verification corrections: initial hostless Keychain tests failed; hosting the exact app-core tests in the app enabled real simulator Keychain access. Missing image lookup and a below-screen Connect button were corrected after screenshot inspection. One relaunch-based automation attempt failed and stalled; an overlapping follow-up was stopped, then verification ran serially using only in-app navigation. The final run above passed. No failed or interrupted run is counted as successful evidence.

Focused source checks: `git diff --check` and `git diff --cached --check` passed. No repository-wide Node suite, hosted CI, external service test or deployment was run. Small-code review: Lean already. Ship.

## Remaining validation / handoff

Review the pending merge and app diff, then let the bridge commit. Next, use an explicitly authorized test host and physical iPhone to validate real relay pairing/presence/reconnect, bot creation/update and I1 star uniqueness, task approval/artifact access, and Shortcuts/Action Button execution including device lock/background behavior. The implementation supports iOS 18, but the only available iPhone runtime tested here was iOS 27.0. Larger accessibility text, another phone size, and real-device signing/distribution remain unverified; no simulator was created to obtain them.
