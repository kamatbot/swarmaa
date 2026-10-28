# Brief B2: bot routing and rules (Codex)

**Repo:** `~/Projects/swarma`, current `main`.
**Spec:** [docs/BOTS.md](../BOTS.md), §2 and §3 above all. Also read [docs/TEAMS.md](../TEAMS.md), `src/core/routing.ts`, the claim and route code in `src/core/tasks.ts`, the flows check code (`src/core/flows.ts`, `flow-definition.ts`, the `tests_pass` check) and `src/usage/`.
**Schema:** `db/migrations/027_bots.sql` is already written and is the contract. Do not edit it.

A parallel task (**B1**, Antigravity) builds `src/core/bots.ts`:
- the bot tools;
- `bot_id` propagation, with an exported `botCapability(bot, kind, edits)`;
- task cards in the bot thread;
- badges.

**Do not create or edit `src/core/bots.ts`.** Read bot rows straight from the `bots` table in your own module. Keep your hooks in `tasks.ts` small and clearly marked, so the coordinator can merge the two.

## Do this, in a new `src/core/bot-routing.ts`

1. **Quota floor at claim.** When an `auto.*` task has a `bot_id`, the route the claim picks must skip any provider whose most-used window has less than `rules.quota_floor_pct` percent left (default 0). That window is the larger of its 5-hour and weekly used percentages.
   - This is on top of the global policy's `max_*_pct`, never instead of it.
   - A floor of 0 means a service may be run to empty.
   - With no eligible provider, the task stays queued, and the claim moves on to the next task. Don't fail it.
   - Use the same usage snapshots the router already uses.
2. **Reviews after edits** (`rules.review_edits`, default true). When a bot `patch` task finishes `completed` with `result.head_commit`, queue one `review` task:
   - `bot_id` set, `initiator_kind = 'bot_check'`;
   - `base_ref` = the branch;
   - an objective naming the branch and the original objective;
   - routed by `routing.review`. Under `different_from_author`, put the provider that served the edit (`result.served.provider`) in `excluded_providers` and use `auto.read`. If no other provider is enabled for reviews, post a `notice` and queue nothing.
   - Idempotent per edit task.
3. **Tests after edits** (`rules.require_tests`, default false). In the same place, queue one `check` task that runs the project's tests on the branch, reusing the flows `tests_pass` check mechanism, with `initiator_kind = 'bot_check'`. Its outcome goes on the edit task as `result.check = {status: 'passed'|'failed', task_id}`; B1's `task` embed reads `check` from there.
4. **`routing_now` and `bot_routing_preview {bot_id}`** (`agent:read`; tenant and scope checks). For each kind, return `{runner, provider_now, reason}`:
   - `provider_now` is what the router would pick right now, under current usage, the global policy and the bot floor;
   - `reason` is a short phrase: "most quota left", "named runner", "Codex below the 15% floor" or "different from the author".

   Export `routingNow(db, tenantId, botRow)` so B1's `bot_get` can include it. The coordinator wires the call when merging.
5. **Schedule tick.** Bots with a `schedule` get a `next_run_at`, computed from the 5-field cron with the `CRON_TZ=` prefix honoured. Write a small cron evaluator: minute, hour, day-of-month, month and day-of-week, each with `*`, lists, ranges and `/step`. No new dependency. The service's periodic loop (find the existing tick or sweep) then, at most once per due bot:
   - posts a `notice` "Scheduled run" into the bot thread;
   - queues the lead's turn with `bot_id` and `initiator_kind = 'schedule'`;
   - advances `next_run_at`;
   - skips the run, still advancing, while the lead already has a queued or running turn;
   - all under `teamsLock` for that tenant.

   `bot_update` (B1's) sets `schedule`; your tick must also compute `next_run_at` when it finds a scheduled bot with `next_run_at IS NULL`.
6. **Docs:** a section in `docs/API.md` for `bot_routing_preview`, and a short "how bot routing decides" subsection there.

## Tests

- **Unit tests:**
  - the cron evaluator, covering steps, ranges, lists, day-of-week with day-of-month, time zones and a DST boundary;
  - the floor arithmetic;
  - `routingNow` reasons.
- **Integration tests.** Add `027_bots.sql` to every integration test's migration list. Insert bot rows and threads directly with SQL, since B1's tools aren't on your branch:
  - the floor skips a low provider for a bot task and not for a non-bot task;
  - a floor of 0 still uses a provider at 99% used;
  - a review is queued after a bot edit and excludes the author's provider;
  - `review_edits: false` queues none;
  - `require_tests` queues a check, and its pass or fail lands on `result.check`;
  - the review and check are idempotent;
  - `bot_routing_preview` shape and isolation;
  - the schedule tick posts, queues once, skips while the lead is busy, and advances.

## Rules

- No new dependencies. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`. Keep `teamsLock`.
- Copy `.env.test` from `/Users/mk/Projects/swarma/.env.test` into the worktree, and never print it. Use `timeout 600` for `npm test` and `--test-concurrency=1` for integration tests.
- Never write to the live database. Don't restart services, and don't push. Write no build output, scratch or notes files inside the repo.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

`npm run build`; `npm test` with 0 failures, apart from the known nested `sandbox-exec` test; the serial integration suite with 0 failures. Report the summary lines and map each item above to its test.
