# Brief: Teams phase 1, service foundation (agents, threads, turns, stream)

**Repo:** `~/Projects/swarma`, on current `main`.
**Spec:** [docs/TEAMS.md](../TEAMS.md). Read all of it first. This brief covers **phase 1 only**: §2 Agent, Thread, Message (`text` and `notice` kinds), Turn and read cursors; the §4 Agents and Threads tables (minus channels); the live stream; and migration 024.

**Not in this phase:** swarms, questions, handoffs, channels, sections, and the `swarm`, `run`, `question` and `answer` message kinds. Create their tables only if that keeps the migration simple. Don't build their tools.

## Do this

1. **Migration `db/migrations/024_teams.sql`:**
   - `agents`;
   - `threads`, with kinds `agent_main` and `agent_side`;
   - `messages`, with a unique `(thread_id, seq)` and a per-thread `seq` assigned in the insert transaction;
   - `thread_reads`;
   - `agent_provider_sessions`;
   - on `tasks`: nullable `agent_id`, `thread_id` and `swarm_step_id`, plus the new task kind `turn`.
   - Per-tenant columns and indexes are as in the existing tables. Add `024_teams.sql` to every integration test's migration list.
2. **Service** (`src/core/teams.ts`, wired into `src/core/index.ts` and `src/core/tools.ts`):
   - the tools `agent_create`, `agent_update`, `agent_get`, `agent_list`, `agent_archive`, `thread_post`, `thread_read`, `thread_mark_read` and `thread_list`, with the permissions in TEAMS.md §4. Add the new permissions `agent:manage`, `agent:read`, `thread:read` and `thread:write` the way existing permissions are defined, and give them to the owner and frontend roles;
   - closed schemas, idempotency keys, `expected_version` and paging, all as in the existing tools;
   - bodies run through `redactSecrets` and are capped at 16 KB.
3. **Turns.**
   - A human `thread_post` to an agent thread queues a `turn` task:
     - its scope is the agent's scope;
     - `required_capability` comes from the agent's runner: `auto.read` or `auto.patch` (when `edits`) for `mode:auto`, otherwise `<provider>.read` or `<provider>.patch`;
     - `resource_key` is `agent:<id>`, so one agent has one turn at a time;
     - messages that arrive while a turn is queued or running join the next turn, not a new task each.
   - **Bridge** (`src/bridge/worker.ts` and `adapters.ts`): a `turn` claim builds its prompt from the agent's instructions, the thread window (last 40 messages or up to 24 KB, oldest first) and the new messages. Every message is wrapped as untrusted data, in the same wording the inbox uses. Then the agent's runner runs, like a read or patch task. On finish, the agent's final answer is posted to the thread as a `text` message by the service, inside `task_finish`, with the author being the agent.
   - Failures post a `notice` message, using the failure code and short detail from `failure-codes`.
   - Record the provider's native session per (agent, provider) in `agent_provider_sessions`, reusing `native-session.ts`, so a later turn on the same provider can resume it. Resuming is optional in this phase: the thread window must be enough on its own.
4. **Turn grant.**
   - The worker's lease for a `turn` task may post only to that agent's threads, through the result path. No new MCP tools are given to the model in this phase.
   - A turn task can never post as another agent or into another tenant or scope. Enforce this in the service.
5. **Runner switch.** `agent_update {runner}` posts a `notice` ("Atlas now runs on Codex"). The next turn uses the new runner with the same thread.
6. **Live stream.** `GET /api/stream?after=<cursor>`:
   - Server-Sent Events over the existing events table and `'<xid>.<seq>'` cursor, with the same no-skip guarantee and scope filtering as `events_poll`.
   - Emit `message.created`, `agent.updated` and `thread.read` events carrying ids and metadata only, never bodies.
   - Send a heartbeat comment every 15 s. Authenticate like the other `/api` routes.
   - Reconnecting with the last cursor resumes without loss.
7. **Docs:** a section in `docs/API.md` for each new tool and the stream, and an update to `docs/TEAMS.md` marking phase 1 implemented.
8. **Tests:**
   - unit tests: the turn prompt builder (window cap, untrusted wrapping, ordering) and the capability mapping from the runner;
   - integration tests:
     - create an agent, post, and see a turn task queued;
     - finishing the turn posts the agent's reply with the next `seq`;
     - two posts during a running turn produce one follow-up turn, not two;
     - a runner switch keeps the thread and posts a notice;
     - the turn grant refuses posting to another agent's thread;
     - `thread_read` pages both ways, and `thread_mark_read` drives unread counts in `agent_list`;
     - the stream delivers `message.created` within 1 s and resumes from a cursor without gaps;
     - tenant and scope isolation for every tool.

## Rules

- Same Rules section as `docs/briefs/agent-notifications.md`: terse code that matches the style around it, no new dependencies.
- Keep workers' configuration and environment exactly as they are. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`.
- Copy `.env.test` from `/Users/mk/Projects/swarma/.env.test` into the worktree before integration tests, and never print it. Use `timeout 600` for `npm test`.
- Nested `sandbox-exec` tests fail inside the worker sandbox: report them separately and don't change them. Integration tests may be run with `--test-concurrency=1`, because the event-cursor tests are known to flake in parallel.
- Never write to the live database or the user's harness configs. Don't restart services and don't push.
- Write no build output or other large files inside the repo; the bridge commits everything in the worktree.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

```bash
npm run build
timeout 600 npm test 2>&1 | grep -E "^ℹ (pass|fail)"
timeout 500 npx tsx --env-file=.env.test --test --test-concurrency=1 tests/*.integration.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^✖"
```

0 failures, apart from the known nested `sandbox-exec` test. Report the summary lines and anything left out.
