# Brief: see who handed what to whom (server, Mac, iOS)

UX ideas taken from BroCrew (Apache-2.0, a TypeScript/Electron app): ideas only, no code copied.

Flow: a bot starts a swarm → each step is a handover with a "Done when" line → the swarm card shows who owns which step, who is waiting on whom, and each step comes back with a four-part report → anything that needs your approval shows the exact action and pauses the thread's composer until you answer.

Four tasks on four branches. They touch different files except where noted; the shared contract below is fixed, so build to it without waiting for each other.

## Shared contract (all tasks build to this exactly)

**1. Every swarm step has a check ("Done when").**
- `swarm_start` steps and `swarm_update` `add_step` require `check`: a non-blank string, at most 512 characters, meaning "this step is done when …". Missing or blank → 400 `invalid_steps` with a message that says `check is required: say what done means and how to check it.`
- JSON shape is unchanged (`steps[].check` is a string in the swarm view). Old swarms may still have `check: null`; clients must handle null (show nothing).

**2. Handover message.** The `handoff` message the service posts into the assignee's thread reads:
```
{owner} gave you: {step title}
Done when: {check}
```
(second line omitted when check is null).

**3. Four-part report.** Every swarm-step turn is told to end its reply (before any `swarmaa-actions` block) with exactly these four labelled parts, each starting on its own line:
```
**Result:** …
**Checks:** …
**Not checked:** …
**Files:** …
```
Clients detect a report when a message body has a line starting with `Result:` (optionally wrapped as `**Result:**` or prefixed `#`–`###` with the label as a heading) AND at least one of `Checks:`, `Not checked:`, `Files:` the same way. Labels match case-insensitively. Text before the first label renders as normal text above the report. Each part's text runs until the next label. A part may be "None". Render a report as one card with four labelled rows; "Not checked" is never hidden (if missing, show "Not stated").

**4. Approvals show the exact action.** `question_ask` gains an optional `action` object:
```json
"action": { "kind": "command" | "publish" | "send" | "deploy" | "purchase" | "other",
            "summary": "≤200 chars, what will happen",
            "detail": "≤2000 chars, the exact command / text / URL",
            "where": "≤300 chars, optional: folder, channel, recipient or site" }
```
- Stored in a new nullable `questions.action jsonb` column (new migration file; never edit applied migrations). Returned as `action` (object or null) in every question view, including the `question` embedded in thread messages and `attention_list`.
- A question with an action is an **approval**. If its `options` are empty the service fills `["Approve", "Deny"]`.
- Secrets are redacted in all three strings with the existing `redactSecrets`.

**5. Who is waiting on whom (clients compute it, no server change).** From a swarm's steps:
- step `waiting_on_you` → "{assignee} is waiting on you"
- step `pending` whose `needs` include a step that is not `done` → "{assignee} is waiting on {that step's assignee} · {that step's title}" (the first unfinished need in order)
- a need that is `failed`/`cancelled` → "{assignee} is blocked: {need title} failed"
- assignee names come from the agents list; fall back to "A crew member".

## Shared rules (every task)
- Read the code you touch end to end first; match the surrounding style (terse TS in `src/`, terse SwiftUI with `KS.*` tokens in the apps). Keep comment density similar.
- Don't modify `src/bridge/sandbox.ts` or `providerEnvironment` in `src/bridge/adapters.ts`. Prompt text in `adapters.ts` may change.
- Don't deploy, migrate the live database, restart bridges, push, merge, or open PRs. Commit on your branch only, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never create a simulator. iOS uses the existing "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`; shut it down if you booted it.
- Don't redesign anything not named here. Mobile: controls in the lower half, read-only info up top.
- No new dependencies.
