# Brief: Mac app fixes from the UX review

**Repo:** `~/Projects/swarma`, on current `main`. Touch `Mac-app/` only; never `src/`, `tests/` or `db/` at the repo root, which a parallel service task owns. The app is Swarmaa.app (scheme `Codenotch`, XcodeGen `Mac-app/project.yml`).
**The review to fix:** `docs/reviews/mac-app-ux-2026-10-28.md`, 16 ranked findings with file:line. Paths there are relative to `Mac-app/Sources`.
**Service shapes:** `docs/briefs/teams-shapes/*.json` (live). The parallel service task changes two things the app must use:
- `thread_read` with no cursor now returns the **newest** page, ascending, and `has_more` means older messages exist;
- `thread_read` messages now embed card data:
  - `question` on `kind:'question'`: `{id, prompt, options, multi, free_text, status, swarm_step_id, created_at, answer: {choices, text} | null}`;
  - `answer` on `kind:'answer'`: `{question_id, choices, text}`;
  - `swarm` on `kind:'swarm'`: the `swarm_get` object, with `steps` and `progress`.

  Decode these. When they're absent, as on an older service, fall back to `swarm_get` for swarms, and show the question's plain-text body with no chips.

## Fix every finding, in this order

- **P1-2: questions.** Render question cards from the embedded `question`, and answers from the embedded `answer` or plain text. The owner_required state must be reachable through a real message. Add fixtures for both shapes.
- **P1-3: thread history.** Treat the default page as the newest. Page back with `before_seq` on scroll-up, and page forward with `after_seq` on `message.created` for the open thread.
- **P1-4: composer.** Keep drafts per thread (a dictionary keyed by `thread_id`); a send goes to the thread it was typed in. Allow typing while a send runs, without overwriting it on failure. Keep the idempotency key across a retry of the same draft. Return focus to the editor after Send.
- **P1-5: resolve.** The service now allows `task_resolve` with `answer_questions` and returns 409 `task_active` for running or queued tasks. Hide or disable Resolve on active tasks. Show task-specific errors, and drop the "can't review lessons" message for this case.
- **P1-6: first use.** Clicking the app in the Dock opens the main window, not Settings. Add a persistent "Create agent" button pinned at the bottom of Agents, and to the empty Home.
- **P1-7: offline.** Keep the last data on failure, with a stale banner such as "Offline · last updated 2 min ago" and Retry. Show the stream's reconnecting and auth state. Make Home Refresh reload everything.
- **P1-1: accessibility.** The window doesn't appear in the accessibility tree. Find out why, for example by checking `NSApp.windows` against `accessibilityChildren`, with an `NSApplication.activationPolicy` of accessory and `LSUIElement`. Fix it so that `AXUIElementCopyAttributeValue(app, kAXWindowsAttribute)` lists the main window. If no cause can be found statically, add a small test that builds `TeamsWindowController`, shows it, and asserts that `window.isAccessibilityElement`, `accessibilityRole` (`.window`) and a non-empty `accessibilityChildren()` hold. Write up what you found.
- **All P2 items** in the review: unread handling, accessibility labels, keyboard paths, loading, empty and error states, the Tasks sort, pagination, the setup probe, keeping the runner's model, thumb reach, sizing and large text, coalescing refreshes, and copy.
  - **Thumb reach** is the owner's rule: interactive controls go in the lower half; sheets are sized to their content; the primary action is pinned at the bottom.
  - **The setup probe** must use structured error codes: `not_found` (the question) means allowed; `owner_required` means not allowed; `unknown_tool` means the service is too old.

## Tests (`Mac-app/Tests/`)

Add tests for:
- decoding the embedded question, answer and swarm shapes, and the fallback;
- the newest-page and paging logic;
- per-thread drafts and send targeting;
- hiding Resolve on active tasks;
- the setup probe code mapping;
- the stale state;
- the unread gating, which must not clear when the thread isn't visible;
- keeping the runner's model.

## Rules

- No new dependencies. No demo data in real views.
- **Write no build output inside the repo.** Use `-derivedDataPath "$TMPDIR/mac-dd"`.
- Package resolution hangs in the sandbox. Copy an existing `~/Library/Developer/Xcode/DerivedData/Codenotch-*/SourcePackages` to `$TMPDIR/mac-sp`, and pass `-clonedSourcePackagesDirPath "$TMPDIR/mac-sp" -disableAutomaticPackageResolution -skipPackageUpdates`.
- Run `cd Mac-app && xcodegen`; the generated `.xcodeproj` is gitignored.
- Put `timeout 900` on every `xcodebuild`, and pass `-IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'` if needed. A test run hosted in the app may hang in the sandbox; if it does, use a throwaway test project in `$TMPDIR`.
- Don't install, launch or kill apps, and don't touch signing or keychains. Don't push.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

- `BUILD SUCCEEDED` for the Debug build; say whether it is unsigned.
- The new tests and all existing Teams suites pass. Report the exact lines.
- A table mapping every review finding (P1-1 … P2-16) to the change and the test, or to why it was not done.
