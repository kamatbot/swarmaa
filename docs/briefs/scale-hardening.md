# Brief: let one Swarmaa service run hundreds of swarms

**Repo:** `~/Projects/swarma` (Node 24 + TypeScript + PostgreSQL 17; service `src/`, worker bridge `src/bridge/`, migrations `db/migrations/`).
**Goal:** hundreds of tasks queued or running across many projects, with many notches and agents polling, on one Mac Studio without 429s, 503s or lock waits.
**Out of scope:** how many agents can run at once. That's bounded by the Mac (32 GB, 10 cores, about 150 MB per idle agent CLI) and by provider quotas. More running at once means adding worker Macs, which already works.

## Measured (2026-10-23)

`scripts/load.ts` drives the real `CoreService` on a throwaway schema in `TEST_DATABASE_URL`:
- Workers behave like the bridge: one pass over every project, claiming while a slot is free, then heartbeat and finish.
- Frontends poll `swarm_status` and `events_poll`.

| Run | Result |
|---|---|
| 60 projects, 500 tasks, 6×16 slots, 30 pollers | 14.8 s, no errors; p99 ≤ 266 ms for every tool |
| 60 projects, 2000 tasks, 12×16 slots, 100 pollers | 29.5 s, no errors; **events_poll p99 879 ms**, task_claim max 939 ms, task_submit p95 922 ms (burst) |
| 100 projects | **fails at setup**: `principals_scopes_check` (max 64 scopes) |

The core and database are not the bottleneck. These three things are.

## Fix 1: one claim call per pass, not one per project (the main wall)

- **What happens:** `src/bridge/worker.ts` `run()` loops over `config.projects` and calls `task_claim` once per project per pass (`claimAndRun`), with `poll_seconds` = 3 in the live configs.
- **Why it breaks:** the HTTP layer allows 600 requests a minute per identity (`src/http.ts`, `limiter.accept(\`principal:${principal.id}\`, 600)`). A worker serving about 30 projects therefore 429s itself just polling idle projects, and work stalls.

**Do this:**
- `task_claim` (`src/core/tasks.ts`, claim around lines 300–380; schema in `src/core/tools.ts`) accepts either today's `scope` or `projects: [{scope, capabilities, kinds?}]` with 1–64 entries. Exactly one of the two must be given.
  - Validate each entry exactly like the single-scope form: scope grant, capabilities, patch opt-in and permissions.
  - Try the entries in order using the existing per-scope claim code. Refactor it into one helper; don't copy the SQL.
  - Return the first successful claim in the current response shape (task, lease_token, lease_generation, route, …), or the current "no task" response.
  - Each entry's expired-lease sweep still runs.
  - Keep each entry's transaction semantics as they are today.
- The bridge makes one `task_claim` call per slot attempt, with `projects` built from all its projects. Each entry gets its own `projectCapabilities(...)` and kinds, as `claimAndRun` does now. Split lists longer than 64 into chunks of 64.
  - Map the claimed `task.scope` back to its `ProjectConfig`.
  - Keep the slot loop: claim while a slot is free and the last claim returned a task; sleep `poll_seconds` when a pass claimed nothing.
  - Keep `validateClaim`, the `route_unavailable` handling, logging and `execute()` unchanged.
- The single-scope form must keep working unchanged, since older bridges use it.

## Fix 2: `events_poll` without a table lock

- **What happens:** `src/core/index.ts` `eventsPoll` runs `LOCK TABLE events IN SHARE MODE` with a 3 s lock_timeout. That blocks every event insert (`src/core/shared.ts` ~line 87 runs on every task and memory change), and polls return 503 `events_busy` under load. The Postgres log shows `canceling statement due to lock timeout` on this statement.
- **Why the lock exists:** `seq` can be allocated by a transaction that commits after a later `seq` is already visible, so a reader could skip an event.

**Do this, using the snapshot-xmin technique:**
- New migration `db/migrations/014_events_xid.sql` adds `xid xid8 NOT NULL DEFAULT pg_current_xact_id()` to `events`. Check `004_events.sql` first.
- In `eventsPoll`, remove the LOCK, the lock_timeout and the `55P03 → events_busy` branch. Add `AND xid < pg_snapshot_xmin(pg_current_snapshot())` to the SELECT. Newer events come back on the next poll, and the response shape stays the same.
- Run `grep -rn "LOCK TABLE" src` and apply the same fix to any other reader with the same problem.

## Fix 3: raise the 64-project cap

- `db/migrations/001_identity.sql` has `CHECK (cardinality(scopes) BETWEEN 1 AND 64)` on `principals`.
- In migration 014, drop `principals_scopes_check` and allow 1–512.
- Grep `src/` and `scripts/` (admin, setup, oauth, policy, tool schemas) for other limits on how many projects an identity or grant can hold (maxItems, slice(0,64), …) and raise them to 512. Leave unrelated 64s alone, such as hash lengths.
- List every place you changed or deliberately left.

## Tests

- Integration tests build their schema from the migration files. Some list the files explicitly, for example `tests/swarm.integration.test.ts`; add `014` there.
- **Claim:**
  - With `projects`, returns a task from the second project when the first has none.
  - Returns "no task" when no project has work.
  - Respects per-entry capabilities: a `claude.patch` task in project B isn't claimed when B's entry lists only `claude.read`.
  - Rejects a scope the identity isn't granted.
  - Rejects `scope` and `projects` given together.
- **Bridge** (`tests/bridge-worker.test.ts`, in its fake-client style): sends one `projects` call per slot attempt, not one per project.
- **Events:**
  - A poll doesn't wait on a concurrent uncommitted event insert. It returns promptly without that event, and after the commit the next poll returns it with nothing skipped.
- **Projects cap:** an identity with 100 scopes can be inserted.

## Rules

- Match the surrounding code style: terse and dense, with the same naming and comment density. No new dependencies or abstractions beyond the one claim helper.
- Fix the root cause with the smallest correct diff, and don't change unrelated behaviour.
- One conventional commit per fix. Never print secrets, and put a `timeout` on long commands.
- Don't restart launchd services or run migrations against the live database (`.env` `DATABASE_URL`). Only the test schemas the tests create.

## Acceptance

```bash
npm run build
timeout 300 npm test 2>&1 | grep -E "^ℹ (pass|fail)"                       # 0 fail
timeout 400 npx tsx --env-file=.env.test --test tests/*.integration.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^✖"   # 0 fail
grep -rn "LOCK TABLE events" src                                               # no hits
timeout 600 node --env-file=.env.test --import tsx scripts/load.ts --scopes 100 --tasks 2000 --workers 12 --pollers 100
```

The load run must:
- finish 2000/2000 with `errors: none`
- complete 100 projects (the cap is lifted)
- show events_poll p99 well under the 879 ms baseline

Update `scripts/load.ts` so its simulated workers use the new `projects` claim, so the load test matches the real bridge. Report the before and after table.
