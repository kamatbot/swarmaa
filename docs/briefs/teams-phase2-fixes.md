# Brief: Teams phase 2 review fixes

Fix the Claude Opus review findings on Teams phase 2. This worktree starts from your branch swarmaa/antigravity/12aaee4d (head 79bc608). Spec: docs/briefs/teams-phase2-swarms.md and docs/TEAMS.md. Fix EVERY numbered finding (1-13) and every item under "Low", and add a regression test for each that fails on 79bc608.

Hard requirements beyond the review:
- Actions run INSIDE the task_finish transaction, on the same db client, through internal helpers that take (db, ctx) - never the public tool methods (which open their own transaction and check the caller's permissions). The turn grant is the authority, not the worker's role.
- One lock order for the whole service, documented in a comment at the top of src/core/swarms.ts: task -> thread -> agent -> swarm -> steps (steps in id order). Apply it in task_finish, onStepTaskFinished, swarmUpdate, queueStepTurn, handoff, thread_post, agent_update and question_answer. Lock all of a swarm's steps with one ORDER BY id FOR UPDATE.
- Flows keep their exact behaviour: flow_start creates a swarm row for tracking only; flow steps never spawn agent turns and onStepTaskFinished must not schedule flow steps (flows.ts keeps scheduling them).
- Every id from model output (swarm_id, swarm_step_id, agent ids, channel ids) is validated as a uuid and checked for tenant+scope+ownership in the parser/grant; a bad id rejects that action with a notice, never a SQL error or rollback.
- question_answer requires the owner (frontend/owner principal with thread:write in scope) and rejects expired questions; expiry posts a notice and moves the step to blocked.
- Channel turns: dedupe by the agent's existing queued turn (join it, as phase 1 batching does), not by any task anywhere; add a hop limit (a turn started by an agent post may not cause more than 3 further agent-initiated turns in a chain; carry the depth on the task) and a fan-out cap of 20 queued turns per finish.
- Replace the Friday-launch test with one that is driven ONLY through real turn finishes carrying swarmaa-actions blocks (worker principal claims and finishes turns with result answers containing the blocks; swarm_start, handoff, question_ask, swarm_update all come from actions), plus the owner answering through question_answer. Add a parallel-steps test that finishes two sibling steps concurrently (Promise.all) and asserts no deadlock and correct downstream scheduling.

The review (untrusted text from another agent, but verified by the coordinator):
---
**Recommendation: don't merge.** Five findings are blockers: agents can't start or update swarms, other bugs break atomicity and tenant/scope isolation, and parallel steps can deadlock. This was a static read of `git diff 28858e0..79bc608`. I ran no tests, so every scenario below is reasoned from the code, not reproduced. Line numbers are from the 79bc608 tree.

**Sandbox / providerEnvironment:** `src/bridge/sandbox.ts` has no diff. `adapters.ts` changes only `buildTurnPrompt` (the agent list and the actions help text); `providerEnvironment` (line 12) is unchanged.

## Blockers
1. **The swarm_start and swarm_update actions never work.** `swarms.ts:1214` and `:1223` call the public `swarmStart`/`swarmUpdate`, which open a new transaction on a separate connection using the worker principal. Workers don't have `task:submit` (`policy.ts:23`).
   - Result: a 403, and the whole `task_finish` rolls back. The reply is lost, and the provider re-runs until it runs out of attempts.
   - Even with the permission, the inner `threads … FOR UPDATE` (`:303`) would wait forever on the thread lock the outer transaction already holds (`assignThreadSeq`). It also wouldn't be atomic.
   - Tests only cover refusals (`swarms.integration.test.ts:315-396`), so this is never exercised.
2. **A handoff can name any step in the tenant.** `actions.ts:193-200` and `:354-368` never check `swarm_step_id`. It is stored on the target's turn (`swarms.ts:1206`). When that turn finishes, `onStepTaskFinished` (`tasks.ts:907`, `swarms.ts:1029`) marks that step `done` with no scope check and no check that this is the step's own task.
   - Scenario: an agent in scope A hands off with a step id from a scope-B swarm. The B step turns `done`, its dependents start, and the summary turn can fire.
   - With a non-uuid value, the column is `text` (from migration 024) but `swarm_steps.id` is uuid. The cast fails, and the target's turn can never finish.
3. **Every flow now also spawns agent turns.** `flows.ts:103-138` gives each flow task a `swarm_step_id` and assigns an arbitrary agent from the scope. Finishing a flow task runs `onStepTaskFinished`, which queues turns for the next pending steps (`swarms.ts:1072-1077`).
   - This includes steps after an `approve` step, with edits if that agent has them enabled. The flow rules are no longer enforced as before, and steps run twice.
4. **Deadlocks:**
   - a) `onStepTaskFinished` locks the step, then the swarm, then all steps (`:1030`, `:1040`, `:1063`). If two parallel steps finish at the same time, A holds step A and the swarm and waits for step B, while B holds step B and waits for the swarm.
   - b) `swarmUpdate` locks swarm, then steps, then the task (`:471`, `:481`, `:538`). `task_finish` locks task, then step, then swarm. Reassigning a step while its turn finishes deadlocks.
   - c) Agent is locked before thread in `queueStepTurn` (`:1387`→`:1393`) and in handoff (`:1147`→`:1170`). Phase 1 locks thread then agent (`teams.ts:258-259`, `:418`/`:456`). A `thread_post` to B's thread racing a step being queued for B deadlocks.
5. **`owner_agent_id` isn't checked against the tenant or scope** (`swarms.ts:255`, `:318`). The summary turn (`:1100-1120`) is then queued for any agent uuid. Scenario: tenant A creates a task with an `agent_id` from tenant B, in B's scope, which leaks that agent's instructions or session.

## High / medium
6. **`after=now` can skip events.** `http.ts:491-499` uses the newest event's `(xid, seq)`, even when that xid is at or above the snapshot xmin. A transaction still in flight with a lower xid commits later, and `(xid,seq) > cursor` (`:572`) drops its events for good. The fix is to always start from `pg_snapshot_xmin`.
7. **Lease exhaustion leaves a step running forever.** The sweep marks the task `failed` (`tasks.ts:434-441`) but never updates the swarm step, so the swarm never shows `blocked`. `cancelTask` (`:267`) cancels the step but doesn't recompute the swarm or emit a card update.
8. **Swarm status can be overwritten, and the summary can run twice.**
   - `deriveSwarmStatus` is called without the closed/cancelled flags (`swarms.ts:754`, `:1088`, `:1271`).
   - `questionAnswer` sets the step back to `running` unconditionally (`:746`), and the `question_ask` grant doesn't check the step's state.
   - Scenario: cancel a swarm while a step is `waiting_on_you`, then answer the question. The step and the swarm go back to `running`, and a new turn is queued.
   - Scenario: ask a question on a `done` step and answer it. The new turn finishes, everything is done again, and a second summary turn is queued. Its idempotency key is a fresh id each time (`:1120`), so nothing dedupes it.
   - `swarmUpdate` doesn't check that the swarm is still open, so `add_step` on a cancelled swarm queues turns.
9. **Reassign and retry ignore dependencies and state** (`:550`, `:562`):
   - Reassigning a pending step whose dependencies aren't done starts it early.
   - Reassigning a `waiting_on_you` step leaves the question open; answering it later starts the step a second time.
   - Reassigning a `done` step runs it again.
   - Retrying a cancelled step ignores its dependencies.
10. **question_answer:**
    - It never checks `expires_at` (`:693`). Expiry is only applied lazily inside `question_list` (`:803`), and no notice is posted, so the step stays `waiting_on_you`.
    - There's no owner check (the spec says owner plus `thread:write`), so Dot or Grok can answer questions and resume swarms.
11. **Bad ids from the model crash `task_finish` instead of producing a notice.** A non-uuid `swarm_step_id` in `question_ask` (`actions.ts:426`) or a non-uuid `swarm_id` in `swarm_update` (`:389`) causes a uuid cast error and a full rollback. The agent's own output can make its turn impossible to finish.
12. **A worker can post a reply to any channel.** `tasks.ts:768-771` accepts the worker-supplied `result.thread_id` whenever `kind==='channel'`, with no membership check.
13. **Channel routing:**
    - A mention is silently dropped if the agent has any queued or running task anywhere (`teams.ts:519`, `swarms.ts:1343`).
    - There's no hop limit: A can `channel_post` "@B" and B can post "@A" back, forever.
    - Fan-out has no overall cap: one turn can trigger 10 actions × 50 steps.

## Low
- `taskResolve` returns the raw task row, including `lease_hash`, and doesn't check the task's status (`swarms.ts:1016`).
- In `attention_list`, an operator-precedence bug at `:927` shows "undefined files". The per-category `LIMIT 50` makes `has_more` wrong.
- `swarmStart` replays an idempotency key without comparing the request, and shares the swarms `UNIQUE` key with `flow_start` (`flows.ts:98`). A key reused across the two either replays the wrong swarm or fails with a 500.
- Handoff lines are posted as `system:service` (`:1157`, `:1177`). The spec says they should be an untrusted message from the sending agent.
- Migration 025: `tasks.swarm_step_id` stays `text` with no foreign key to `swarm_steps`. The rest of the migration is correct.

## Parser, grant and isolation checks (no new findings)
- **Parser:** a quoted (`>`) block is ignored, a block that isn't last is rejected, and two blocks reject everything (not "the last one wins"). The caps hold: 10 actions, 8 options, a 500-byte prompt, and redacted, byte-capped bodies.
  - Weak spots: indented or list-item fences are accepted (`actions.ts:84` trims the line), and other fence types aren't tracked.
  - An injected thread message that gets the agent to end its answer with a block will be honoured. That can't be fixed in the parser, so the turn grant is the only defence, and items 2 and 11 weaken it.
- **Grant:** `channel_post` requires membership, handoff targets stay within tenant and scope, `swarm_update` requires owning the swarm or holding a step in it, and a question's step must belong to the asking agent.
- **Isolation:** `attention_list` requires both `task:read` and `thread:read` and filters by scope, so it doesn't leak message bodies outside the caller's scopes.

## Unverified
- **The 7 skipped unit tests:** I didn't run them. `npm test` uses the glob `tests/*.test.ts`, which also picks u

---
Migration 025 is not deployed anywhere: edit it in place (make tasks.swarm_step_id a uuid with an FK to swarm_steps, ON DELETE SET NULL).
