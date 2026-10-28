# Brief: Teams phase 2, second fix round

**Branch:** start from `swarmaa/antigravity/4b624e83` (e215068). It holds phase 2 plus the first fix round. The original review is in `docs/briefs/teams-phase2-fixes.md`. The re-review's findings are summarised below; this brief is the authority.

## 1. Replace hand-ordered locking with one lock per tenant

Two rounds of hand-ordered row locks still deadlock in at least six paths: `queueStepTurn` after the swarm lock, the swarm_update action, question_ask, `cancelTask` and the lease sweep, handoff thread pairs, and `routeChannelPost`. Stop ordering row locks by hand.

- Add one helper, `teamsLock(db, tenantId)`: `SELECT pg_advisory_xact_lock(hashtextextended('teams:' || $1, 0))`. Mark it with `// ponytail: one Teams writer per tenant; per-swarm or per-agent keys if one tenant's throughput ever matters.`
- Call it **first**, before any row lock or write, in every transaction that writes agents, threads, messages, swarms, steps or questions, or queues or changes a `turn` task. That includes:
  - `thread_post`, `thread_mark_read`, `agent_create`, `agent_update`, `agent_archive`;
  - `task_finish`, whenever the task has an `agent_id` or `swarm_step_id`;
  - `task_cancel` and the lease sweep, for those same tasks. In the sweep, take it per task, not once for the batch;
  - every swarm, question, channel and section tool;
  - `flow_start`, and flow steps finishing.
- Keep the existing row locks. They become harmless once the advisory lock serialises the writers. Delete the long lock-order comment at the top of `swarms.ts` and write one line instead: Teams writes take `teamsLock` first.
- Reads take no lock.

## 2. Bad model output never rolls back `task_finish`

- In `applyTurnActions`, run each action inside `SAVEPOINT act_n`. On an `AppError` (any 4xx) or a Postgres data error (class 22, or 23 for constraint violations), roll back to the savepoint and post one `notice` naming the action index, its type and the error message. Then go on to the next action.
- The agent's reply is always posted.
- 5xx and other errors still throw.
- Also validate the following in the grant, before running anything:
  - add_step `needs` (uuids or keys of existing steps);
  - the assignee, given as id or name and resolved like `assignee_agent_id`;
  - unknown ops and bad op fields;
  - swarm_start step graphs (cycles, unknown `needs` keys).

## 3. State rules

- `cancel_step`, and cancelling a swarm, expire that step's open questions and post a notice.
- `question_answer` on a question whose step is not `waiting_on_you` returns 409 `step_not_waiting`.
- Expiry uses the database clock (`clock_timestamp()`), never `Date.now()`.
- The handoff grant refuses a `swarm_step_id` whose step is `done`, `cancelled` or `failed`, or whose swarm is closed.
- **Summary turns:** at most one per swarm. Add a nullable column `swarms.summary_task_id` in 025 and set it with `UPDATE … WHERE summary_task_id IS NULL RETURNING`; queue the turn only when the update returns a row.
- **Hop depth:** step turns and summary turns inherit `hop_depth + 1` from the finishing turn. Every turn queued by one finish counts toward the cap of 20, including those from swarm_start and add_step, and turns over the cap are refused with a notice.
- **`questionList`** must not write. Do expiry in one transaction under `teamsLock`, using the expiry path above. Run it from the lease sweep and from `question_answer`, not from a read.
- **Flows:** don't create a channel thread for a flow swarm; flow swarms have `thread_id` null. Mark approve steps done when their approval resolves, so a flow's swarm can close. Flows' task behaviour stays exactly as on 28858e0.
- **`question_answer` ownership:** require the principal whose role is `owner`, or the frontend identity the owner signs in with. To be precise, refuse principals named `grok` or `dot`, and any principal without `thread:write` in that scope. If the codebase can't tell the owner's frontend from other frontends, add an `answer_questions` permission, give it to the owner role only, and require it.

## 4. Tests that must fail on e215068

- **Parallel deadlock:** steps X (agent A) and Y (agent B) both depend on nothing. Z needs X only and is assigned to B. Finish X and Y concurrently 20 times in a loop (`Promise.all` on separate pool clients). Assert no error and correct scheduling every time.
- **A question during a sibling's finish, concurrently:** 20 iterations.
- **`task_cancel` of a step task during a sibling's finish:** 20 iterations.
- **Mutual handoffs, A→B and B→A finishing concurrently:** 20 iterations.
- **Bad actions keep the reply:**
  - a swarm_start with a cycle;
  - an add_step with a non-uuid `needs`;
  - an unknown op;
  - an assignee given by name.

  Each gets a reply plus a notice, and the task completes.
- **Cancelled steps stay cancelled:** cancel a `waiting_on_you` step, then answer its question: 409, and the step stays cancelled.
- **One summary:** a step rerun by a different worker queues no second summary.
- **No unbounded chains:** hop depth carries through step turns, and the cap counts swarm_start turns.
- **Flows:** a flow with an approve step ends with its swarm `done`, and no channel thread is created.
- **Owner-only answers:** a frontend that is not the owner can't answer.

## Rules

- No new dependencies. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`, and don't edit `024_teams.sql`; `025` may be edited.
- Copy `.env.test` from `/Users/mk/Projects/swarma/.env.test` into the worktree before integration tests, and never print it. Use `timeout 600` for `npm test` and `--test-concurrency=1` for integration tests.
- Never write to the live database or harness configs. Don't restart services, and don't push. Write no build output inside the repo.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

`npm run build`; `npm test` with 0 failures, apart from the known nested `sandbox-exec` test; serial integration tests with 0 failures. Run `tests/swarms.integration.test.ts` three times in a row, green each time. Report the summary lines, and map each item above to its test.
