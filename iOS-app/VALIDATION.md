# Round 2 checkpoint — dd765573

Objective: repair scroll-area layout and New bot controls, attribute live replies, add QR/paste/URL pairing, and recapture all nine native screens. Baseline: `e0cc45c26ffd94066ba75fd7ff3ab9207dad793d`, initially clean, writable task worktree. Owned scope: `iOS-app/**`, the nine `design/launch-kit/screens-ios/*.png`, `scripts/relay-pair.ts`, `tests/relay-agent.test.ts`. No Mac/core/relay/database source edits. Non-goals: production pairing, service writes, messages, publication, deployment, commits and pushes. The worker-level prohibition on committing overrides the contradictory JSON constraint; the bridge owns the commit. Risk: client pairing entry points, camera permissions, and private local QR lifecycle.

Implementation: removed midpoint spacers and fractional scroll-height caps; thread retains `.defaultScrollAnchor(.bottom)`, history scrolls above and controls stay pinned. Settings/Tasks begin directly after their headers. New bot uses a large scrolling sheet, explicit menu-style Project/Lead controls, five Chat replies choices (Haiku 5.5 default), and pinned Make bot. Live replies resolve the actual `typing.agent_id` against agents and show its character/name with a dashed outline. Pairing links are strictly parsed, rejecting unknown/duplicate query parameters, invalid host/code, wrong scheme/authority/path, credentials, ports and fragments. QR, paste, and `.onOpenURL` share the same pairing handler. Manual fields are collapsed by default. The URL scheme and camera purpose string are in generated `Info.plist` via XcodeGen.

Host command: derives the existing host identity through the existing helper; emits words plus link in one owner write; invokes Swift/CoreImage with the link on stdin, never argv; atomically writes `.local/relay-pairing-qr.png` with mode 0600 and a QR quiet zone; opens it unless `--no-open`; remains running to remove the QR after consumption/expiry. SIGINT/SIGTERM also remove its QR. Renderer and viewer subprocesses have timeouts. No dependencies added. Tests use fresh temporary identities and fake relay peers only; no existing credentials were read and no production connection was attempted.

Validation: `xcodegen` succeeded. Initial full iOS run passed 27 tests (14 app, 12 unchanged compatibility, 1 expanded UI journey), with `TEST SUCCEEDED` in `test-round2.log`. After a live-text wrapping correction, link error-copy update, optional font change and addition of the OS URL-entry test, all 26 unit/compatibility tests passed on the final AppCore revision, but the UI process crashed in `swift::AsyncTask::completeFuture` (`EXC_BAD_ACCESS/SIGBUS`) during menu selection and URL launch. That run (`test-round2-final.log`) is failed/interrupted, never counted as green. Its automatic retry was stopped after the crash/timeout. The optional font change was reverted and a fresh focused UI build used `-derivedDataPath iOS-app/DerivedData/Recovery -only-testing:SwarmaaUITests`. Both final UI tests passed with `TEST SUCCEEDED` (`ui-round2-recovery.log`, result bundle `DerivedData/Recovery/Logs/Test/Test-Swarmaa-2026.10.28_18-46-26-+0700.xcresult`). A final acceptance run regenerated the Xcode project and ran the entire iOS test scheme on the frozen final source using the fresh build directory. It finished exit 0 / `TEST SUCCEEDED`: **28 tests passed (14 app + 12 compatibility + 2 UI), zero failures**, in `acceptance-round2.log`; result bundle `DerivedData/Recovery/Logs/Test/Test-Swarmaa-2026.10.28_18-49-38-+0700.xcresult`. Xcode reported 57.751 seconds for testing. This supersedes the earlier split evidence for final acceptance. No cause is claimed for the intermediate runtime crash; it did not recur in the fresh UI build. The UI journey checks every New bot field, project agents, all five reply choices, manual fallback, history scrolling and navigation. The separate OS URL test invokes the registered scheme with a malformed fixture and verifies the pairing error; the successful handler test uses a fake relay and test-only Keychain service. Node 24.21.0 relay-agent suite passed 13 tests, including CoreImage QR round-trip decoding, 0600 permissions, expiry/consumption cleanup, exact link format and actual `--no-open` command one-time output/cleanup. `.env.test` is absent, so the literal requested Node command could not start; the equivalent focused run used `--env-file=/dev/null`. No database or production environment was loaded. Logs are local ignored `*-round2*.log` files.

Only existing iPhone: Piano Review iPhone SE (`B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`), iOS 27.0, 375×667 pt. It was already booted. No simulator was created or booted; none therefore needs shutdown. There is no larger existing iPhone. Camera unavailable on simulator: actual camera capture, permission denial/recovery, real host pairing and paste-to-real-relay need an authorized physical-device smoke test. CoreImage QR decoding is tested locally. Existing native condensed typography remains an approximation of the canvas web font. On SE the newest thread viewport intentionally omits earlier messages, which are verified reachable by scrolling; long Settings/Tasks/Usage/Answer content also scrolls. Final screenshot review: all nine PNGs recaptured serially from the final installed native app with `-demo -screen …`; each inspected individually. All are 750×1334 pixels (375×667 pt). 02 shows the complete question card and Scout character/name/dashed live reply; earlier messages remain above the newest viewport and were reached by UI scrolling. 03 starts cards below header/counts. 08 starts fields below header/job. 07 shows Name, What it does, Project, Lead, and Haiku 5.5 with Make bot pinned; menu contents are exercised by the UI test. 01/04/05/06/09 also inspected. No requested layout defect remains visible. Still different from the canvas: native display/menu fonts approximate its web fonts; on this compact screen Usage, Answer and Settings need scrolling to reveal their remaining content. Demo disables actual pairing/mutations and displays the simulator camera-unavailable state. Local simplification review: Lean already. Ship.

---

Historical first-round evidence follows; it describes the previous source and screenshots, not the current round.

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
