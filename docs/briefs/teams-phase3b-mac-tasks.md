# Brief: Teams phase 3b, Needs you, Tasks, setup checklist and notch items (Mac app)

**Repo:** `~/Documents/Claude/Projects/NotchTrader`, on current `main` (build 27). The Swarmaa main window (`Sources/Teams/`, `Sources/Providers/SwarmaTeamsClient.swift`) is merged and installed.
**Service:** Teams phases 1 and 2 are **live** on `http://127.0.0.1:8787`. Spec: `/Users/mk/Projects/swarma/docs/TEAMS.md` and `/Users/mk/Projects/swarma/docs/API.md`.
**Real response shapes:** `/Users/mk/Projects/swarma/docs/briefs/teams-shapes/*.json` are copied from the live service. Build your decoders and test fixtures from these files, not from the spec. The window's first version guessed the shapes and got `unread_count` wrong.
**UX reference:** OpenDuet's phone app. Use the ideas only, never its code. They are described below.

## What the service gives you (verified live)

- **`attention_list {limit?, after?}` → `{items:[{kind, id, title, state, next_step, at, thread_id?}], has_more, next_cursor}`.** `kind` is `question`, `task` or `swarm`.
  - `title` is already one line.
  - `next_step` is a ready-made line such as "Ready for review · branch swarmaa/claude/aa96efb9 · 12 files", "Needs input · …" or "Failed · quota_exhausted · …".
- **`task_resolve {task_id, resolved, expected_version}`** folds a task into Resolved, or unfolds it. Get `version` from `task_get`.
- **`task_list`** accepts `resolved` and `initiator_kind` filters.
- **`swarm_list` and `swarm_get`** return the swarm with `steps[]` and `progress`; see the shape files.
- **Swarm card messages carry no snapshot.** `thread_read` returns `kind:"swarm"` with `ref.swarm_id` and an empty body. Fetch the swarm with `swarm_get`, cache it by id, and refresh it on `swarm.updated` and `message.updated` stream events.
- **`question_list {status?}` and `question_answer {question_id, choices, text?, idempotency_key}`.**
  - Answering needs the `answer_questions` permission, which the owner grants to the app's identity.
  - Without it the service returns 403 `owner_required`. Show "Ask the owner to allow answering questions from this Mac", with the grant command `npm run admin -- grant --name notchtrader --permission answer_questions`. Never crash.
- **The stream:** `GET /api/stream?after=now`.
  - The first event is `event: cursor`.
  - The types are `message.created`, `message.updated`, `swarm.updated`, `agent.updated`, `question.created`, `question.answered`, `thread.read` and `task.updated`.

## Do this

1. **"Needs you" home.** This is the new default pane of the main window, at the top of the rail. It shows:
   - a header line with the date and "N things need you";
   - a **Needs you** section from `attention_list`, newest first. Each row has its title, `next_step`, a relative time and one action button:
     - **Answer** for a question; it opens its thread at the question card;
     - **Review** for a task with a branch: copy `git log -p <branch>` to the clipboard, and show a **Mark resolved** button;
     - **Retry** for a failed task, via `task_continue`;
     - **Open** for a swarm; it opens its thread at the card.
   - A **Running** section with the open swarms from `swarm_list`, showing title, `done/total` and the agents on running steps.
   - With nothing to show: "Nothing needs you" and a short line. That's the real empty state, not demo data.
2. **Tasks tab** (rail icon). The sections are **Needs input**, **Ready for review**, **Working**, **Failed** and **Resolved** (collapsed). Build it from `attention_list`, plus `task_list` for the running tasks and for `resolved:true`.
   - Each row has a checkbox that calls `task_resolve` and moves the row to Resolved. Unchecking moves it back.
   - A coloured state word, then " · " and the `next_step` remainder: green for review, orange for input, blue for working, red for failed.
   - A search field and a sort by newest or by state.
   - Live: `task.updated` and `question.*` events refresh it.
3. **Setup checklist** (Settings → Setup, and the first time the window opens when anything is wrong). Each row reads **Ready**, **Not checked** or **Needs setup**, with a one-line fix, and the list has a **Check again** button. The rows:
   - the service is reachable;
   - the token is valid;
   - Teams tools exist, so `agent_list` doesn't answer 404 or `unknown_tool`;
   - each provider has a live worker, read from `swarm_status` workers;
   - the stream connects;
   - answering questions is allowed, from a cheap probe: `question_answer` with an invalid id gives 404 when allowed and 403 `owner_required` when not.
4. **Notch items.**
   - Open questions show as one notch cell, with a badge for the count and id `swarm:thread:<thread_id>` of the newest question. Clicking it opens the window on that thread; the hook from phase 3 already routes that id format.
   - An open swarm that is `waiting_on_you` or `blocked` shows as a cell with `done/total`.
   - Don't change any other notch layout or behaviour.
5. **Composer and cards.** Keep what's there. Also:
   - the question card's chips send via `question_answer`, and show the 403 state above;
   - the swarm card decodes `swarm_get` exactly as in the shape file.
6. **Thumb-reach rule:** primary actions sit at the bottom of a pane or sheet, and sheets are sized to their content.
7. **Tests** (`Tests/`):
   - decode every shape file in `teams-shapes/` as a fixture: copy them into `Tests/Fixtures/`, and keep it small;
   - the Tasks section grouping and colour mapping from `attention_list` items;
   - the resolve toggle building the right request;
   - the setup probe mapping (404 → Ready, 403 `owner_required` → Needs setup);
   - the notch cell ids.

## Rules

- No new dependencies; SwiftUI and AppKit only. No demo or placeholder data in real views.
- **Write no build output inside the repo.** Use `-derivedDataPath "$TMPDIR/teams-dd"`.
- Package resolution hangs in the worker sandbox. Copy an existing `~/Library/Developer/Xcode/DerivedData/Codenotch-*/SourcePackages` into `$TMPDIR/teams-sp`, and pass `-clonedSourcePackagesDirPath "$TMPDIR/teams-sp" -disableAutomaticPackageResolution -skipPackageUpdates`.
- Put `timeout 900` on every `xcodebuild`, and pass the sandbox flags from the phase 3 brief.
- Don't install, launch or kill apps, and don't touch keychains or signing. Don't call write tools on the live service. Read-only calls (`attention_list`, `swarm_list`, `question_list`) are fine if you want to check a shape.
- Run `xcodegen` if you add files and `project.yml` needs it. Commit nothing; the bridge commits.
- Conventional commit message suggestion ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

- `BUILD SUCCEEDED` for the Debug build, unsigned is fine; say so.
- The new tests pass, and the existing Teams suites and `AntigravityHeadlineTests` still pass. Report the exact result lines.
- List every new file and every changed notch file, with a one-line reason each.
