# Brief: Teams service fixes from the UX and performance review

**Repo:** `~/Projects/swarma`, on current `main`. Touch `src/`, `tests/`, `db/migrations/` and `docs/` only; never `Mac-app/`, which a parallel task owns.
**Inputs:**
- the performance report, `docs/perf/teams-2026-10-28.md`, with its benchmark `scripts/perf-teams.ts`;
- the API docs, `docs/API.md` and `docs/TEAMS.md`.

## Do this

1. **`thread_read` defaults to the newest page.** With neither `after_seq` nor `before_seq`, return the **latest** `limit` messages, still in ascending seq order, with `has_more: true` when older messages exist. Paging back with `before_seq` and forward with `after_seq` keep working as now. Update `docs/API.md`.
2. **`thread_read` embeds card data,** as TEAMS.md §4 always said: "messages with resolved swarm and run card snapshots". For each message in the page:
   - `kind: 'question'`: add `question: {id, prompt, options, multi, free_text, status, swarm_step_id, created_at, answer: {choices, text} | null}`, read from the `questions` row named by `ref.question_id`;
   - `kind: 'answer'`: add `answer: {question_id, choices, text}`;
   - `kind: 'swarm'`: add `swarm`, the same object `swarm_get` returns, including `steps` and `progress`.

   Do it with one batched query per kind per page, never one per message. Keep `body` and `ref` exactly as now. The Mac app task decodes exactly these field names.
3. **Who may resolve a task.** `task_resolve` currently requires `role === 'admin'`. Allow it for any principal with the `answer_questions` permission in the task's scope (admins pass `hasPermission` anyway), and keep refusing `grok` and `dot` by name, as `question_answer` does. Resolving a `running` or `queued` task returns 409 `task_active`, with a clear message.
4. **Live stream wake-up.** Today the stream polls every 200 ms when idle and every 10 ms between batches.
   - Add `LISTEN swarmaa_events` on one dedicated client per service process (not one per stream), and `pg_notify('swarmaa_events', '')` in the same transaction that inserts an event. Put it inside the existing `event()` helper, so it fires on commit.
   - A notification wakes every open stream's poll at once. Drain full batches back to back with no sleep. Keep a 2 s safety poll, in case the listener connection drops; reconnect the listener with backoff.
   - Keep the durable events table and the xmin/cursor no-skip query exactly as they are.
   - Target: commit → `message.created` p50 under 20 ms in `scripts/perf-teams.ts` scenario 6, and 1,000-event catch-up p50 under 150 ms.
5. **`agent_list` N+1.** Today it costs 78 SELECTs for 50 agents.
   - Compute status for the whole page in batches: one query for running tasks by `agent_id = ANY(...)`, and one for live workers by scope.
   - Target: a constant number of queries per page, at most 6, whatever the agent count. Add a test that counts queries (wrap the pool's `query`).
   - Apply the same treatment to `thread_list` if it does per-row queries.
6. **Optional indexes:** don't add the report's two attention indexes. They are unproven.
7. **Re-run `scripts/perf-teams.ts`** and append an "After fixes" section to `docs/perf/teams-2026-10-28.md` with the new numbers for scenarios 3 and 6.

## Tests

Each fix gets a test that fails on the current `main`:
- `thread_read` default returns the newest page;
- `thread_read` embeds `question` (open and answered), `answer` and `swarm`, with one query per kind;
- `task_resolve`: allowed with `answer_questions`; 403 without it and for grok/dot; 409 for active tasks;
- the stream delivers within 50 ms of commit with the safety poll set to 2 s, which proves NOTIFY is used;
- the `agent_list` query count stays constant for 5 vs 50 agents.

## Rules

- No new dependencies. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`. Keep the `teamsLock` design.
- Copy `.env.test` from `/Users/mk/Projects/swarma/.env.test` into the worktree, and never print it. Use `timeout 600` for `npm test` and `--test-concurrency=1` for integration tests.
- Never write to the live database. Don't restart services, and don't push. Write no build output inside the repo.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

`npm run build`; `npm test` with 0 failures, apart from the known nested `sandbox-exec` test; the serial integration suite with 0 failures; and `scripts/perf-teams.ts` run, with the new numbers in the report.
