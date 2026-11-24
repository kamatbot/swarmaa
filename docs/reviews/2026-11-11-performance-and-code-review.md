# Performance and code review — 2026-11-11

Review only. No application code was changed.

No live secrets were found in the tree or in a history scan for common key and private-key patterns. The matches are redaction fixtures (`AKIAIOSFODNN7EXAMPLE`, synthetic `ghp_` / `sk-ant-` / `xoxb-` strings, and short PEM samples in `tests/safety.test.ts` and `src/safety/redact.ts`).

## What was measured, and what was not

This VM is Linux x64, 4 vCPU (Intel Xeon), Node **v24.11.0** (the image’s default Node is v22; the review used a Node 24 binary because `package.json` requires `>=24 <25`). PostgreSQL is **16.15**. The repo documents PostgreSQL 17. All **36** migrations applied cleanly to a disposable schema (192 ms). The schema was dropped afterward.

| Check | Result |
|---|---|
| `npm run typecheck` (Node 24.11.0) | Pass, **0.59 s** |
| `npm test` (570 tests) | **556 pass, 3 fail, 11 skip, 12.8 s** |
| `npm audit` | **0** vulnerabilities (95 packages) |
| Migrations on PostgreSQL 16.15 | **36/36** applied |
| Swift / Mac / iOS UI | Not built. Static review only |
| Provider CLIs (Claude, Codex, Antigravity) | Not installed. No live agent runs |
| `scripts/perf-teams.ts` | Not re-run. It calls macOS `sysctl` and **overwrites** `docs/perf/teams-2026-10-28.md` |

The three unit failures are environmental, not regressions in the service logic:

- `tests/bridge-config.test.ts` expects `sandbox-exec` (macOS only). On Linux `wrapCommand` throws, which is what `src/bridge/sandbox.ts:47` is written to do.
- `tests/bridge-patch-recovery.test.ts` expects `cp -cR` to clone `node_modules` into a worktree. That flag is APFS copy-on-write; on this ext4 VM the copy fails and is swallowed (`src/bridge/worktree.ts:73`).
- `tests/bridge-token-usage.test.ts` marks the Antigravity case `sandbox: true`, so the same missing `sandbox-exec` finishes the task as `blocked` instead of `completed`.

CI (`.github/workflows/ci.yml`) runs install, typecheck, build, and `npm test` on `macos-latest`. It does not run `npm run test:integration`.

Numbers below are from this VM unless marked **prior** (the 2026-10-28 Apple M1 Max report in `docs/perf/teams-2026-10-28.md`) or **static** (read from source, not timed).

## Architecture

Swarmaa is one PostgreSQL-backed Node service plus several local clients. The database is the source of truth for memory, tasks, leases, teams, bots, and the event outbox. Optional Reason Network messages are notifications only.

| Process | Role |
|---|---|
| `src/server.ts` | One HTTP process. MCP and REST share `CoreService`. OAuth and signed webhooks start only when configured. Timers: bot schedules and lease sweep every 30 s, source deliveries every 15 s, retention hourly, push sweep every 5 s, webhook dispatch about every 1 s. |
| PostgreSQL | Pool max 12, `statement_timeout` 30 s, `idle_in_transaction_session_timeout` 60 s (`src/db.ts:7`). Scope advisory locks serialize task mutations. A separate tenant-wide `teams:` lock serializes bots, threads, and swarms (`src/core/shared.ts:119-126`). |
| `src/bridge.ts` | One macOS worker process per provider. Claims up to 64 projects per call, keeps an SSE stream for wakeups, and falls back to `poll_seconds` (default 5). Spawns the provider CLI with `shell: false`, a bounded stdout buffer (default 4 MiB, hard cap 8 MiB), and a process-group kill. |
| Mac notch app, iOS app | Mac talks to loopback HTTP. iOS talks through the relay (`relay/`), which forwards a path allowlist to `127.0.0.1`. |
| `site/` | Static landing page. `launch.mp4` is 9.6 MB and plays when the film is on screen. |
| Capture LaunchAgent | Documented as a 2-minute poll of local chat histories. Not running here. |

Hot path for a chat turn: the app posts a message, the service queues a `turn` under the scope lock (and the tenant teams lock when a bot is involved), a bridge claims it, spawns Claude/Codex/Antigravity, and checkpoints partial text about every 1.5 s. The app hears `task.updated` / `message.created` on `GET /api/stream` (LISTEN/NOTIFY, plus a 2 s safety poll) and then calls `thread_read` / `task_list` / `task_get` to fill in bodies. Bodies do not ride the stream.

That design is sound. The costs below are where it stops scaling with agents, tasks, and projects, and where the implementation is weaker than `docs/SECURITY.md`.

## Measured hot paths

**Worker stdout tail is quadratic.** `runBoundedProcess` keeps every chunk, then on each chunk does `Buffer.concat` of the whole buffer to keep an 8 KiB tail (`src/bridge/process.ts:57-62`). Same function serves stderr.

| Payload | Chunk size | Current concat | Tail-only buffer |
|---|---:|---:|---:|
| 4 MiB | 4 KiB | 0.71–0.91 s | ~4 ms |
| 8 MiB | 4 KiB | 1.87 s | 3.5 ms |
| 1 MiB | 128 B | 1.29 s | 17 ms |

The default cap is 4 MiB (`src/bridge/config.ts:106`). Claude `stream-json` writes small chunks, which is the expensive shape: cost grows with the square of the chunk count. This runs on the bridge’s single JavaScript thread, so it delays heartbeats and the next claim. A ring buffer of the last 8 KiB removes it. Memory of the retained transcript is already capped; the bug is the repeated copy.

**`task_list` reads columns it discards.** The handler selects every column, including `checkpoint` and `result`, then `taskListView` drops `partial_output` / `partial_text` and clips the answer (`src/core/tasks.ts:108-117`, `360-367`).

On 80 completed tasks whose checkpoints are ~32 KiB of incompressible data (table 3.6 MB, warm cache):

| Query | Client p50 | Client max | Planner execution |
|---|---:|---:|---:|
| `SELECT * … LIMIT 51` | **4.34 ms** | 6.79 ms | 0.10 ms (index scan, shared hits only) |
| `id, left(objective,300), status, kind, required_capability, created_at` | **0.21 ms** | 0.55 ms | 0.05 ms |

The planner is cheap. The 20× gap is detoasting checkpoint JSON and copying it into Node, after which the list view throws the bulk away. A separate run with highly compressible checkpoints understated this (wire response after the view: **83,017 bytes** for 50 tasks, service p50 **4.5 ms**). **Prior**, before that view existed, one 50-row page was 463 KB and a full Mac refresh was 5.36 s through the Cloudflare tunnel (`docs/briefs/perf-2026-10-28.md`).

**Other timings on this VM** (disposable schema, warm cache, no TLS):

| Operation | Result |
|---|---|
| `agent_list`, 40 agents × 30 messages | p50 **1.1 ms**, p95 3.4 ms, ~680/s |
| Checkpoint throttle `SELECT` over 2,000 events | p50 **0.09 ms** (index on `(tenant_id, scope, created_at)` makes the 3-second window cheap) |
| `redactSecrets` on a 200 KB blob | **8.6 ms** per call |
| `spawn('/bin/true')` | **3.0 ms** each |
| Applying 36 migrations | **192 ms** |

`agent_list` is no longer the N+1 the October report described (78 selects, p50 6 ms for 50 agents). It is one unread-count query plus two set queries (`src/core/teams.ts:450-490`). The 8.6 ms redact and the 3 ms spawn are not the bottleneck. A real Claude or Codex process is. **Prior:** a bot turn waited 0.7–3.2 s for a worker, then 10–14 s in the CLI including startup.

**Prior lock numbers, not re-measured here** (`docs/perf/teams-2026-10-28.md`, Apple M1 Max, pool max 8): during a 20-step swarm, `scope:tasks` advisory-lock acquisition was p50 **20 ms** / p95 **41 ms**; the tenant teams lock during that swarm was ~0.002 ms, but the same teams lock under 20-way posts in one tenant was p50 **11 ms**. Twenty tenants posted about 3× faster than one tenant (1,523/s vs 511/s). SSE commit-to-delivery was p50 **103 ms** when the stream polled every 200 ms. The stream now wakes on `LISTEN swarmaa_events` and polls every 2 s only as a backstop (`src/http.ts:692`, `src/event-wakeup.ts`). That part of the October plan landed.

## Findings

### P1

**1. Streaming a provider is O(n²) on the bridge thread.**  
`src/bridge/process.ts:57-62`. Measured above: about 0.7–0.9 s of CPU for 4 MiB in 4 KiB chunks, and 1.3 s for only 1 MiB in 128-byte chunks. A turn that streams for a long time stalls lease renewal on that process.  
Fix: keep an 8 KiB tail incrementally. Do not `Buffer.concat` the full history on each `data` event.

**2. Unattended workers get a full tool bypass, a deny-list sandbox, and almost the entire parent environment.**  
`src/bridge/adapters.ts:297-321` always passes Claude `--permission-mode bypassPermissions` (and `--max-turns 200`) and Codex `--dangerously-bypass-approvals-and-sandbox`, including for review and research. `src/bridge/sandbox.ts:38-40` is `(allow default)` plus a deny-list of credential folders. `SandboxOptions.projectRoot`, `gitDir`, `patch`, and `ownHistoryDir` are never used in the profile. The deny-list does not cover `.env`, `.local`, `.swarma`, `.codex`, or `.claude`.  
`providerEnvironment` (`src/bridge/adapters.ts:13-16`) copies every parent variable except `COLLECTIVE_*` and `SWARMAA_*`. A bridge started with `--env-file=.env` therefore hands `DATABASE_URL` and any cloud tokens in that environment to the model process.  
`docs/SECURITY.md:25-27` still says Claude’s tool set excludes shells, Codex stays in its read-only sandbox, and the parent removes unrelated environment entries. The code comments say the bypass is intentional because nobody is present to approve a prompt. Those two descriptions cannot both be what an operator relies on.  
Fix: use the provider’s read-only flags for non-patch tasks. For patch tasks, generate the allowlist the `SandboxOptions` fields already describe, and pass an explicit env allowlist. Update `docs/SECURITY.md` to match whatever remains.

**3. `task_list` still loads the checkpoint JSON the response throws away, and both clients page whole queues.**  
Server: `src/core/tasks.ts:360-367`. Measured 4.34 ms vs 0.21 ms per page once checkpoints are real sized.  
Mac: `TeamsModel.loadTasks` (`Mac-app/Sources/Teams/TeamsModel.swift:628-650`) issues running, queued, and one resolved page **per scope**, 8 at a time. Running and queued go through `allPages`, which walks up to 100 pages (`Mac-app/Sources/Providers/SwarmaTeamsClient.swift:917-921` and `1031-1041`). The open-task cap is 1,000 per scope (`src/core/tasks.ts:307`), so one busy project can be ~20 pages of fat rows.  
iOS `loadTasks` (`iOS-app/Sources/AppCore.swift:768-786`) calls `allPages` on `task_list` with **no status filter**, so it pulls history, not just the queue.  
Fix: select the columns `taskListView` actually returns. Have the clients request one page of active work unless the user asks for history.

**4. A streaming turn holds the project lock every couple of seconds, and a claim holds it across the thread window.**  
`task_checkpoint` (`src/core/tasks.ts:702-722`) takes the scope advisory lock, increments `version`, writes the full checkpoint, queries `events` for the 3-second throttle, and returns `taskWithInstructions` (two more queries). The bridge sends that about every 1.5 s while text changes (`src/bridge/worker.ts:453-485`) and again on the heartbeat (`519-530`). The throttle query itself is cheap (0.09 ms). The lock and the row rewrite are the cost, and they sit on the same key as submit, claim, and finish (`src/core/shared.ts:119-122`).  
`claimScope` (`src/core/tasks.ts:471-607`) holds that lock, and the tenant teams lock when any bot task is queued or running (`508`), while it loads up to 40 messages and their images (`getTurnWindow`, `src/core/teams.ts:53-102`, 24 KiB plus image bytes).  
**Prior:** scope-lock acquisition p50 20 ms under a 20-step swarm; one-tenant teams lock p50 11 ms. Not re-measured on this VM.  
Fix: checkpoint partial text in a short update that does not bump the task version or return instructions. Load the turn window after the claim commits. The comment at `src/core/tasks.ts:137-139` already says a per-thread teams key needs every holder to change together; that is still the right direction, and it is not sufficient on its own while claim and checkpoint hold the scope lock.

**5. The Mac and iOS live updates do the heavy work on the main actor.** Static. Neither app was built.  
Mac `TeamsModel` is `@MainActor`. On `message.created` it may call `thread_read` in a loop of up to 100 pages (`Mac-app/Sources/Teams/TeamsModel.swift:1103-1124`), merge and sort the transcript, and then schedule a task refresh. `botActiveTaskCount` (`358-374`) walks the thread’s messages and every swarm on each SwiftUI pass.  
The SSE parser appends one byte at a time (`SwarmaTeamsClient.swift:1071-1076`).  
The swarm map, while open, calls `task_get` for up to 30 jobs on each status publish and `refreshUsage` every 3 s (`Mac-app/Sources/Teams/SwarmMapView.swift:17-44`).  
iOS `AppModel.handle` (`iOS-app/Sources/AppCore.swift:707-734`) re-reads the open thread and, on `message.created`, reloads **every bot page**. `AskStarredBot` polls `thread_read` every 500 ms (`918-937`).  
Fix: handle the stream off the main actor, fetch one message (or one tail page) per event, and keep per-thread counts instead of recomputing them in `body`. Drive the shortcut off the stream the app already holds.

### P2

**6. Push delivery drops anything older than 10 minutes and ignores which principal registered the device.**  
`src/push.ts:186-201`. The sweep advances `push_cursor` even when `fresh` is false, so a restart or a backlog permanently skips those notifications. Devices are loaded with `WHERE tenant_id=$1` even though `push_devices.principal_id` is stored. On a single-owner install that is “every phone and watch,” which may be what you want. A second principal in the same tenant (a gateway identity, another frontend) receives the same alert text.  
Fix: do not advance the cursor past an unsent row. Select devices for the bot owner’s principal.

**7. After a lost lease the bridge still commits the worktree.**  
`src/bridge/worker.ts:601-617` runs `finishWorktree` in `finally` before `if (leaseLost) return`. The comment says that is so an abort does not lose the edit. The service may already have requeued the task (`src/core/tasks.ts:627-649`). Inside one process, `serialized()` in `src/bridge/worktree.ts:22-28` keeps the git commands ordered. Two bridge processes on the same repo do not share that map, and the branch name is only the first 8 hex characters of the task id (`src/bridge/worktree.ts:87`: `swarmaa/${provider}/${task.id.slice(0, 8)}`). The docs and `AGENTS.md` say `swarmaa/<provider>/<id>`. Eight hex digits is 32 bits; a second task can attach to another task’s branch and treat it as a continuation (`createWorktree`, lines 98-111).  
Fix: skip the commit when the lease was lost and let the next attempt recover the worktree. Put the full task id in the branch name.

**8. The relay treats `host_id` as a capability URL.**  
`computeHostId` is 26 base32 characters of SHA-256 (`relay/src/room.ts:77-79`), so guessing it is not practical. `hello` sets `authed` (`435-438`) but `req` never reads that flag (`455-497`). Anyone who can open `/h/{hostId}` can ask the host agent to call the path allowlist on the owner’s loopback service, using whatever `Authorization` header they send. Without a bearer token the local API still returns 401. With a leaked token, the host id is enough to reach the Mac from the relay.  
Fix: require the paired client credential on `req`, not only on `pair_redeem`.

**9. The landing film is a 9.6 MB autoplay.**  
`site/public/film/launch.mp4` (9,589,428 bytes). `site/public/index.html:968` and `1063-1069` call `play()` when 30% of the film is visible, unless the user prefers reduced motion. `preload="metadata"` avoids fetching it before then. Fonts are self-hosted and modest (the two preloaded variable fonts are 57 KB and 90 KB).  
Fix: keep the poster until a click, or ship a shorter clip.

**10. Integration tests never run in CI, and the teams benchmark cannot run on Linux.**  
`.github/workflows/ci.yml:36` stops at `npm test`. Lease fencing, webhook delivery, and routing live in `tests/*.integration.test.ts` (24 files) and only run when `TEST_DATABASE_URL` is set. `scripts/perf-teams.ts:387-391` shells out to `/usr/sbin/sysctl`, which does not exist here, and on success it overwrites `docs/perf/teams-2026-10-28.md`.  
Fix: run the integration suite against a disposable Postgres service in CI. Point the benchmark at `/tmp` and skip the sysctl call off Darwin.

**11. One Node process caps itself at 64 in-flight requests, and the rate limiter only sweeps at 10,000 keys.**  
`src/http.ts:726-732` returns 503 above 64 concurrent requests. Inbox waits hold a slot for up to 25 s (`500-515`). The limiter (`142-158`) deletes expired keys only once the map reaches 10,000, and then answers 429 for everyone if it is still full. Limits are per process (`docs/SECURITY.md` already says this).  
Fix: do not count long-polls against the same 64 as tool calls. Sweep the limiter on a timer.

**12. `swarm_status` still runs per-worker subqueries.**  
`src/core/swarm.ts:97-110` aggregates running tasks and provider usage inside the worker query, and counts tasks for every scope. Migration `037_task_indexes.sql` added `tasks_running_lease_owner_idx`, which helps the count, but each status call is still one correlated aggregate per worker plus a scan of task counts grouped by scope. Static, from the SQL. The October report’s dashboard pain was this shape plus fat `task_list` pages.  
Fix: one `GROUP BY lease_owner` for running tasks, joined to workers.

### P3

**13. SSE poll failures are silent.** `src/http.ts:686-688` swallows database errors. The 2 s timer retries, and the client is not told. Log the failure and end the stream so the client reconnects with a cursor.

**14. Heartbeats return the full task.** `src/core/tasks.ts:682-698` builds instructions and runs on every renewal (default 20 s) even though the bridge only needs the lease to still be valid. Return `{ok: true}` from heartbeat.

**15. Webhook `last_seq` moves when the delivery row is inserted, not when the HTTP call succeeds.** `src/events.ts:233-254`. This is fine: retries live in `event_deliveries` until `MAX_ATTEMPTS`, then the row is `failed` and is not re-read from `events`. Worth knowing so a “missed webhook” is looked up in `event_deliveries`, not by rewinding `last_seq`. A terminal `failed` row is a dropped event by design.

**16. `computeAgentStatus` is an extra pair of queries on the single-agent write path.** `src/core/teams.ts:1012-1031`. The list path already batched this. Low volume.

## What is in good shape

- SQL is parameterized. Auth looks up a SHA-256 of the bearer token (`src/auth.ts:25-28`).
- Claim uses `FOR UPDATE SKIP LOCKED`, database time, and a lease hash. Finish replays a matching idempotency hash before it requires the lease (`src/core/tasks.ts:517-532`).
- The bridge does not use a shell. Output is capped, the process group is killed, and provider stdout is redacted before it is stored.
- Webhook delivery is HTTPS-only, checks every resolved address, pins one public IP, and refuses redirects (`src/webhook.ts`).
- `LISTEN` plus a safety poll replaced the old 200 ms SSE spin. `agent_list` is a handful of queries and was 1.1 ms for 40 agents here.
- `npm audit` is clean. Runtime dependencies are four packages, pinned.
- Worktrees are created from the bridge’s configured project root, not from task text. `base_ref` is rejected when it looks like an option (`src/bridge/worktree.ts:81-86`). Nothing in the bridge pushes.

## Suggested order of work

1. Replace the stdout `Buffer.concat` in `src/bridge/process.ts`. It is local, measured, and it sits on the heartbeat path.
2. Make `task_list` a narrow query, and stop the Mac and iOS clients from walking every page of every scope on refresh.
3. Shorten checkpoint and claim transactions so streaming turns do not hold the scope lock.
4. Decide the worker threat model in one place: either restore read-only provider flags and an allowlist seatbelt, or rewrite `docs/SECURITY.md` and strip the environment for real.
5. Fix push so a backlog is not skipped, and stop committing a worktree after the lease is gone.
6. Put the integration suite in CI.

October’s list-view trimming, parallel Mac refresh, and SSE wakeups are in the tree. The remaining scale limit is lock scope plus clients that still treat `task_list` and `thread_read` as full copies, and a bridge that copies provider output on every chunk.
