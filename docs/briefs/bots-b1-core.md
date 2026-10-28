# Brief B1: bots core (Antigravity)

**Repo:** `~/Projects/swarma`, current `main`.
**Spec:** [docs/BOTS.md](../BOTS.md). Read it whole, plus [docs/TEAMS.md](../TEAMS.md) and the Teams code (`src/core/teams.ts`, `src/core/swarms.ts`, `src/core/actions.ts`, the turn paths in `src/core/tasks.ts`).
**Schema:** `db/migrations/027_bots.sql` is already written and is the contract. Do not edit it. If you find a real problem in it, say so in your report.

A parallel task (**B2**, Codex) builds `src/core/bot-routing.ts`: the quota floor, reviews and checks after edits, `routing_now` and the schedule tick. **Do not create or edit `src/core/bot-routing.ts`**, and keep your hooks in `tasks.ts` small and clearly marked, so the coordinator can merge the two.

## Do this

1. **Tools**, in a new `src/core/bots.ts`, wired into `src/core/index.ts` and `src/core/tools.ts`: `bot_create`, `bot_update`, `bot_get`, `bot_list` and `bot_archive`, exactly as in BOTS.md §4, under its conventions (closed schemas, idempotency, `expected_version`, `teamsLock` first, tenant and scope checks, live-name uniqueness as a clear 409 `name_taken`).
   - Validate `routing` and `rules` strictly:
     - routing kinds: only `research`, `patch`, `review`, `summary`;
     - runners: `{mode:'auto'}`, `{provider, model?, effort?}` with a known provider, or for `review` also `{mode:'different_from_author'}`;
     - rules: `quota_floor_pct` an integer from 0 to 50, plus booleans `approve_public`, `review_edits` and `require_tests`;
     - `schedule`: a 5-field cron, optionally `CRON_TZ=<zone> ` first. Validate the shape only; B2 computes `next_run_at`, so leave it null.
   - `bot_create` creates the `kind:'bot'` thread, with `lead_agent_id` set and `thread_members` for the lead and every member. All the agents must exist, be live and be in the bot's scope.
   - A routing or crew change in `bot_update` posts a `notice` into the bot thread.
   - `bot_archive` cancels the bot's queued tasks through the existing cancellation path.
2. **Bot thread routing.** A human `thread_post` to a `kind:'bot'` thread routes like a channel: the `@`mentioned member, else the lead. Reuse the channel code and don't fork it. `thread_list` includes bot threads only with `kind:'bot'`.
3. **`bot_id` propagation**, per BOTS.md §1. Set `tasks.bot_id` at insert on:
   - turns queued from a bot thread;
   - swarm steps of swarms whose `thread_id` is a bot thread;
   - handoffs made by a bot task;
   - summary turns.

   Set `required_capability` from the bot's `routing` by the kind mapping in §2:
   - a provider runner gives `<provider>.read` or `.patch`;
   - auto, or a missing kind, gives `auto.read` or `auto.patch`.

   Put this static mapping in one exported function, `botCapability(bot, kind, edits)`, in `bots.ts`. B2 will layer the quota floor onto the claim path, not onto this function.
4. **Task cards.** When a task with `bot_id` finishes `completed` with `result.head_commit`, or finishes `failed`, post one `kind:'task'` message (`ref: {task_id}`, a one-line body) into the bot thread. The body reads like "Forge finished the launch banner · swarmaa/claude/4f1e · 7 files" or "Failed · quota_exhausted on Codex".
   - Do it inside `task_finish`, under the same transaction and turn-grant rules as replies.
   - Never post two cards for one task and one outcome.
   - Emit `message.created`.
5. **Embed `task`** on `kind:'task'` messages in `thread_read`, batched, with the shape in BOTS.md §4. Leave `check` null; B2 fills it in later.
6. **Badges and order** on `bot_get` and `bot_list`, per BOTS.md §4: `unread` from the read cursor; `needs_you` = open questions in the bot thread plus unresolved review-ready or failed bot tasks; `latest`. Use a constant number of queries per page, never one per bot; add a query-count test like the agent_list one. Order updates first, as in §4.
7. **`bot.updated`** on create, update, archive and badge-relevant changes; ids only.
8. **Docs:** a Bots section in `docs/API.md` for every tool and for the `task` message kind.
9. **Tests:** add `027_bots.sql` to every integration test's migration list. Then:
   - **integration tests:**
     - create, update and archive, with versions, idempotency and `name_taken`;
     - crew validation, including another scope's agent;
     - a post to a bot thread reaches the lead, and an `@`mention reaches that member;
     - `bot_id` propagates through turn, swarm step, handoff and summary;
     - `required_capability` follows the routing;
     - a task card for review-ready and for failed, never twice;
     - `thread_read` embeds `task`;
     - badges and updates-first ordering;
     - the `bot_list` query count stays constant;
     - tenant and scope isolation for every tool;
   - **unit tests:** routing, rules and schedule validation, and `botCapability`.

## Rules

- No new dependencies. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`. Keep `teamsLock`.
- Copy `.env.test` from `/Users/mk/Projects/swarma/.env.test` into the worktree, and never print it. Use `timeout 600` for `npm test` and `--test-concurrency=1` for integration tests.
- Never write to the live database. Don't restart services, and don't push. Write no build output, scratch or notes files inside the repo.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

`npm run build`; `npm test` with 0 failures, apart from the known nested `sandbox-exec` test; the serial integration suite with 0 failures. Report the summary lines and map each item above to its test.
