# Brief: Teams phase 3, the Swarmaa main window (Mac app)

**Repo:** `~/Documents/Claude/Projects/NotchTrader`, on current `main`. This is the Swarmaa.app Mac app, built on Codenotch (SwiftUI and AppKit, XcodeGen `project.yml`, scheme `Codenotch`, product `Swarmaa.app`).
**Spec:** Swarmaa's `docs/TEAMS.md`, at `/Users/mk/Projects/swarma/docs/TEAMS.md`. Read §1–§4 first. The service side is being built in parallel, so build against the protocol in §4 exactly.
**Reference UX:** OpenBot's main window, described in TEAMS.md §1. Ideas only: copy no OpenBot code or assets.

## Goal

A main window, opened from the menu bar ("Open Swarmaa") and from a click on the notch. Its layout:
- **Left rail:**
  - Agents, Flows and Usage icons;
  - the per-provider quota rings, using the existing usage data from `SwarmaClient.status()`;
  - Settings at the bottom.
- **Sidebar:**
  - a search field;
  - user sections ("Launch", "Research"), each listing agents and channels;
  - per row: avatar, name, role badge, last-message preview, relative time, and an unread badge.
- **Thread pane:**
  - a header with the agent's name and its runner picker ("Claude Opus 5.5 · High"; choices from `swarm_status.routing` providers);
  - messages: human messages right-aligned, agent messages left;
  - cards for the `swarm`, `run`, `question`/`answer`, `handoff` and `notice` kinds, as in TEAMS.md §1 and §2;
  - a composer pinned at the bottom.

## Do this

1. **Client:** `Sources/Providers/SwarmaTeamsClient.swift`.
   - Typed `Decodable` models for Agent, Thread, Message (all kinds), Swarm (with steps and progress), Question and Section.
   - Calls for the TEAMS.md §4 tools: `agent_list`, `agent_get`, `agent_update`, `thread_read`, `thread_post`, `thread_mark_read`, `thread_list`, `section_set`, `swarm_get`, `swarm_list`, `question_list` and `question_answer`. Use the same `POST /api/tools/<name>` transport and token handling as `SwarmaClient`.
   - A `stream(after:)` that reads the SSE stream `GET /api/stream` and yields events. It reconnects with the last cursor, with backoff.
   - An unknown tool or a 404 means the service isn't updated yet. Surface it as a typed `.serviceTooOld` error, never a crash.
2. **Views:** under `Sources/Teams/`. Use the existing `Sources/DesignSystem` tokens, fonts and colours; follow its dark style, and support light mode if the design system does.
   - `TeamsWindowController` (an AppKit window hosting SwiftUI, like the existing windows) and `TeamsRootView`, with the rail, sidebar and thread.
   - `ThreadView`: lazy, newest at the bottom, scrolls to the latest message, and loads older pages on scroll-up through `thread_read before_seq`. It marks the thread read when visible.
   - Cards:
     - `SwarmCard`: the title, `done/total`, a step list on expand, and a chevron that opens the swarm detail;
     - `RunCard`: "Ran N subagents · K done · 2s";
     - `QuestionCard`: an option chip for each choice (multi-select if `multi`), an optional text field, and Send, which calls `question_answer`. Once answered it reads "Answers sent" with the choices;
     - `HandoffLine` and `NoticeLine`.
   - Composer: a multi-line field, Return to send (Shift-Return for a new line), and send calls `thread_post` with a fresh idempotency key.
   - Empty states:
     - no agents: "Create your first agent", which opens a small create sheet calling `agent_create`;
     - service too old: "Update the Swarmaa service to use teams".
   - **No demo or placeholder data in real views.** Fixtures live only in tests and SwiftUI previews.
3. **Live updates.** One shared stream subscription refreshes the affected thread, sidebar row, unread badge and card. A `message.created` for the open thread appends the message; for other threads it bumps that row's badge and preview.
4. **Entry points.**
   - Add "Open Swarmaa" to the menu-bar menu (`StatusItemController`).
   - A click on a swarm or question item in the notch opens the window on that thread. Leave the existing notch layout unchanged otherwise.
5. **Tests** (`Tests/`):
   - decoding every message kind and swarm/question payload from JSON fixtures, written to match TEAMS.md §4;
   - the SSE parser, including split chunks, heartbeat comments and reconnecting with the cursor;
   - unread-count derivation;
   - question answer validation (`multi` and single choice);
   - `.serviceTooOld` mapping.

## Rules

- Change no notch behaviour or layout beyond the two entry points above.
- No new dependencies (SPM or otherwise). Use SwiftUI and AppKit only.
- **Write no build output inside the repo.** Use the default DerivedData, or `-derivedDataPath "$TMPDIR/teams-dd"`. The Swarmaa bridge commits everything in the worktree, and gigabytes of build output broke an earlier task.
- Put `timeout 900` on every `xcodebuild`. If the sandbox blocks package or macro plugin sandboxes, pass `-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'`. A test run hosted in the app hangs in this sandbox: use `build-for-testing` plus `test-without-building` with `TEST_HOST="" BUNDLE_LOADER=""`, or `xcrun xctest`.
- Run `xcodegen` if you add files and `project.yml` needs it; check whether `Sources` is globbed first.
- Don't install, launch or kill any app; the coordinator does that. Don't touch keychains or signing.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

- `timeout 900 xcodebuild -project Codenotch.xcodeproj -scheme Codenotch -configuration Debug -destination 'platform=macOS' build` gives `BUILD SUCCEEDED`. Sign it, or build with `CODE_SIGNING_ALLOWED=NO` if signing is blocked, and say which.
- The new test classes pass, and the existing `AntigravityHeadlineTests` still passes. Report the exact result lines.
- List every new file, and say which TEAMS.md §4 calls the client implements.
