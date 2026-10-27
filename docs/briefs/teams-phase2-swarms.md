# Brief: Teams phase 2, swarms, handoffs, questions and channels

**Repo:** `~/Projects/swarma`, on current `main`. Phase 1 (agents, threads, turns, stream) is merged and live.
**Spec:** [docs/TEAMS.md](../TEAMS.md) §2–§4 and §6 phase 2. Read it, and read how phase 1 did turns first: `src/core/teams.ts`, the `turn` paths in `src/core/tasks.ts`, and `buildTurnPrompt` in `src/bridge/adapters.ts`.

## Design decision: turn actions, not a turn MCP server

TEAMS.md §3 describes a turn toolset over MCP. **Don't build that.** It would mean changing each worker CLI's MCP config, and workers keep their own config. Instead:
- the turn prompt tells the agent it may end its answer with **one** fenced block, ` ```swarmaa-actions `, holding a JSON array of actions;
- the bridge passes the final answer through unchanged;
- in `task_finish`, the service parses the block, strips it from the posted `text` message, and validates each action against the **turn grant**;
- it applies all actions atomically with the reply, or none. On a bad block, it posts the reply plus a `notice` naming the rejected action and why;
- update TEAMS.md §3 to say so.

The actions, with a closed schema each:
- `{type:'handoff', to_agent, body, swarm_step_id?}`
- `{type:'swarm_start', title, goal, steps:[{key, title, assignee_agent_id, needs:[key], instructions?, check?}]}`
- `{type:'swarm_update', swarm_id, ops:[…]}`, with the same ops as the tool below
- `{type:'question_ask', prompt, options, multi, free_text, swarm_step_id?}`
- `{type:'channel_post', channel_id, body}`

The **turn grant** is enforced in the service. A turn may:
- post only to its own agent's threads and the channels that agent is a member of;
- hand off only to agents in the same tenant and scope;
- start swarms only in its own scope, owned by itself;
- update only swarms it owns or holds a step in;
- ask questions only as itself.

There are at most 10 actions per turn, and every body is redacted and byte-capped as in phase 1.

## Do this

1. **Migration `025_teams_swarms.sql`:**
   - `thread_members` and `lead_agent_id` for channels;
   - `sections` (per principal);
   - `swarms` and `swarm_steps`, with `needs` as a uuid array;
   - `questions`;
   - on `tasks`: `initiator_kind` (`person` | `handoff` | `swarm` | `answer` | `flow`, default `person`), `initiator_id`, and `resolved_at`;
   - new event types `swarm.updated`, `question.created` and `question.answered`.

   Add the file to every integration test's migration list.
2. **Swarms** (`src/core/swarms.ts`): the tools `swarm_start`, `swarm_update`, `swarm_get`, `swarm_list` and `swarm_cancel`, as in TEAMS.md §4.
   - Validate the step graph: no cycles, assignees active and in scope.
   - Starting a swarm posts a `swarm` card message (`ref.swarm_id`) to its thread. It queues a turn for each ready step, with `swarm_step_id` set and initiator `swarm`, and posts a `handoff` line into each assignee's main thread.
   - When a step's turn finishes:
     - the step is `done` with `result_message_id`, or `failed` with the failure code;
     - newly ready steps start;
     - the card emits `message.updated` and `swarm.updated`.
   - When every step is done, the owner agent gets one final summarising turn, and the swarm reads `done`.
   - Status derivation: a step is `waiting_on_you` while it has an open question, and the swarm takes the most urgent step status.
   - `swarm_update` ops: `add_step`, `reassign` (cancels the running turn with the flows cancellation fencing, then requeues for the new agent), `retry`, `cancel_step`, `edit` and `close`. They are atomic and versioned, and each posts a `notice`.
   - `flow_start` keeps its signature, also returns `swarm_id`, and creates a swarm whose steps are the flow's tasks. Flow rules stay enforced exactly as today.
3. **Handoffs.** A handoff action posts a `handoff` line in both threads. It queues a turn for the target agent with initiator `handoff`, and with the body as an untrusted message from the sending agent.
4. **Questions:**
   - `question_ask` is an action only.
   - `question_answer` (owner, `thread:write`) validates the choices against `options` and `multi`, posts the `answer` message, closes the question, and queues the agent's next turn with initiator `answer`.
   - `question_list` lists questions, filtered by `status`, open by default.
   - Expiry: `expires_in` seconds; an expired question posts a `notice`.
5. **Channels and sections:**
   - `channel_create` and `channel_update`: members are agent ids, plus an optional lead.
   - A channel `thread_post` queues turns for the `@Name`-mentioned members, or for the lead if no one is mentioned; with no lead and no mention it queues nothing.
   - `thread_list {kind:'channel'}`.
   - `section_set` and a `section_list`; `agent_list` returns the viewer's sections.
6. **Attention and resolution.** These are for the Mac app's "Needs you" home page and Tasks tab:
   - `attention_list` (`task:read` and `thread:read`, paged) returns what needs the owner, newest first:
     - open questions;
     - completed `patch` and `turn` tasks with `review_required`, not yet resolved, with their branch and diffstat;
     - failed tasks not resolved, with their failure code and detail;
     - swarms that are `waiting_on_you` or `blocked`.

     Each item has `{kind, id, title, state, next_step, at, thread_id?}`. `next_step` is a one-line, service-written text such as "Ready for review · branch swarmaa/antigravity/1a2b · 9 files", "Needs input · answer the question", or "Failed · quota_exhausted · retry".
   - `task_resolve {task_id, resolved, expected_version}` (owner) sets or clears `resolved_at`.
   - `task_list` gains `resolved?` and `initiator_kind?` filters.
7. **Stream:**
   - accept `after=now`, which starts at the current cursor and sends it in the first event, `event: cursor`;
   - emit the new event types;
   - still ids only, never bodies.
8. **Turn prompt.** Document the actions block in the turn prompt with a short example, and give the list of agents in scope (name and id) so handoffs and swarms can name them. All thread content stays wrapped as untrusted, as in phase 1.
9. **Docs:** a section in `docs/API.md` for every new tool and action; TEAMS.md marks phase 2 implemented and records the actions decision.
10. **Tests:**
    - unit tests:
      - parsing and validating the actions block (including malformed blocks, too many actions, a forged block inside a quoted message, and a block that isn't last);
      - step-graph validation;
      - swarm status derivation;
    - integration tests:
      - **the Friday-launch scenario end to end:** Atlas starts a 5-step swarm for 3 agents. Steps run in dependency order. Pulse asks a question; the step and the swarm read `waiting_on_you`; answering resumes Pulse. One step is reassigned while running and its old turn is cancelled. A restart in the middle is simulated by recreating the core and expiring leases. The final summary turn runs, and the swarm ends `done 5/5`;
      - the turn grant refuses: a handoff into another scope; updating someone else's swarm; posting to a channel the agent isn't in;
      - channel mentions route to the right agents, and no mention goes to the lead;
      - `attention_list` and `task_resolve`;
      - `flow_start` returns a swarm;
      - `after=now` on the stream;
      - tenant and scope isolation for every new tool.

## Rules

- No new dependencies. Write terse code that matches the style around it, and reuse phase 1 helpers (`assignThreadSeq`, `clipUtf8`, the agent and thread locks in the same order: thread, then agent).
- Keep workers' configuration and environment exactly as they are. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`, and don't add MCP servers to worker CLIs.
- Copy `.env.test` from `/Users/mk/Projects/swarma/.env.test` into the worktree before integration tests, and never print it. Use `timeout 600` for `npm test`, and run integration tests with `--test-concurrency=1`.
- Never write to the live database or the user's harness configs. Don't restart services, and don't push.
- Write no build output or other large files inside the repo; the bridge commits everything in the worktree.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

```bash
npm run build
timeout 600 npm test 2>&1 | grep -E "^ℹ (pass|fail)"
timeout 500 npx tsx --env-file=.env.test --test --test-concurrency=1 tests/*.integration.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^✖"
```

0 failures, apart from the known nested `sandbox-exec` test. Report the summary lines, the Friday-launch test's name, and anything left out.
