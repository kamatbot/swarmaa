# Teams: persistent agents, channels and tracked swarms

**Status:** design, not implemented. **Date:** 2026-10-27.
**Inspired by:** OpenBot (openbot.run, `nightly-labs/openbot`, source-available under its own licence). Ideas only: no OpenBot code or text is copied.

Today a Swarmaa swarm is a set of one-shot tasks. You submit, a worker runs, a result comes back, and the work is gone from view once you have read it. This design adds the layer people actually work in:

- **agents** with a name, a role and a memory of their own work;
- **threads** you return to;
- **channels** where agents see each other's work;
- **swarms** that persist, show their progress and can be changed while they run.

Tasks, routing, quota, workers, the inbox and flows stay as they are. They become the engine under this layer.

## 1. The UX we are building

The reference screens are OpenBot's main window and its channel view.

| Screen element | What it is in Swarmaa |
|---|---|
| Left rail | Agents, Flows, Usage, and a quota ring per provider (Claude, Codex, Antigravity, Grok; already in `swarm_status.usage`). |
| Sidebar sections ("Launch", "Research") | User-named **sections** that group agents and channels. |
| Sidebar row (avatar, **Atlas**, `Team lead`, preview, time, unread badge) | An **agent** or **channel**: its role, the last message of its thread, and the unread count for the viewer. |
| Header model picker ("Claude Opus 5.5 · High") | The agent's **runner**: `auto`, or a provider, model and effort. Changing it keeps the thread. |
| Chat with an agent | The agent's **main thread**: human and agent messages, plus cards. |
| Card "Friday's launch, split across the team. **5/5** ›" | A **swarm card**: a live view of a persistent swarm, updated in place. |
| Row "Ran 2 subagents · 2 done · 2s ›" | A **run card**: the tasks one turn started, collapsed. |
| Row "4 messages with 3 agents" | A **handoff summary**: agent-to-agent messages this turn caused, folded into one row. |
| Card "Answers sent: Which channels should the launch use?" | A **question card**: a structured question to the human, with their answer. |
| Channel `# launch` with three avatars | A **channel**: one thread that several agents and people read and write. |
| Line "Ada gave the task to Linus" | A **handoff** message, posted by the service and not by a model. |
| "Stored on your computer" | Unchanged: everything lives in the local Postgres, and projects stay on disk. |

### Where it lives

- **Mac app: a new main window** in Swarmaa.app (the Codenotch base), opened from the menu bar and the notch. It holds the sidebar, threads and channels described above, and it is the primary UI.
- **Notch:** stays glanceable. It shows the quota rings, open swarms with their progress (`3/5`), and a badge when an agent is waiting on your answer. Clicking one opens it in the main window.
- **Harnesses** (Claude Code, Codex, Antigravity): use the same objects through MCP, so `/swarm` can list swarms and post to a thread.
- **Grok, through the gateway:** can post to threads and answer questions. Webhook sinks get the new event types.

## 2. Concepts

**Agent.** A persistent teammate scoped to one project. It has:
- an `id` (`agt_…`) and a `name` ("Atlas");
- a `role` label ("Team lead") and an `avatar` seed;
- `instructions`, a system prompt of up to 8 KB;
- a `scope` (`project:…`), which is its workspace;
- a `runner`: `{mode:'auto'}` or `{provider, model?, effort?}`;
- `edits`: whether its turns may patch files (patch tasks need `task:patch` on the worker);
- `main_thread_id`.

An agent is not tied to one provider. Like OpenBot, we keep **the thread** (ours, and durable) separate from **the provider session** (private resume state of one CLI). Switching the runner keeps the thread. The new provider gets the thread window as context, and the old provider's session is kept in case the agent switches back.

**Thread.** A durable, ordered log of messages. Kinds:
- `agent_main`: one per agent;
- `agent_side`: a second conversation with the same agent, which closes and archives;
- `channel`.

**Channel.** A thread with members: several agents plus the owner (and later, invited humans). A message in a channel is seen by every member. Members are addressed with `@Name`; an unaddressed message goes to the channel's `lead` agent, if it has one.

**Message.** `{id, thread_id, seq, author:{kind:'human'|'agent'|'system', id}, kind, body, ref?, created_at, edited_at?}`. The kinds:

| `kind` | Body | Written by |
|---|---|---|
| `text` | Markdown, ≤ 16 KB, redacted | a human or an agent |
| `handoff` | "Ada gave the task to Linus" | the service, when an agent hands work on |
| `swarm` | none; `ref.swarm_id` | the service; rendered as a live card |
| `run` | none; `ref.task_ids[]` | the service; rendered as a live card |
| `question` | prompt, options, `multi`, `free_text` | an agent, through a tool |
| `answer` | the chosen options and text; `ref.question_id` | a human |
| `notice` | a short service line (a failure, quota rerouting, a provider switch) | the service |

Agent-written bodies are untrusted data. They render as text, never as instructions to another agent's tools, and every prompt built from a thread says so. This follows the inbox rule.

**Turn.** One exchange: a new message reaches an agent, and the agent answers. A turn runs as a normal **task** of the new kind `turn`, so routing, quota, slots, leases, failure codes, rerouting, the notch and the inbox all apply unchanged. The worker builds the turn prompt from:
- the agent's instructions;
- the thread window: the last 40 messages, or up to 24 KB, plus a rolling thread summary;
- the new message.

The agent's final answer is posted to the thread as a `text` message. Turns of one agent are serialized: one running turn per agent, enforced with `resource_key = agent:<id>`. Messages that arrive while a turn runs are batched into the next turn.

**Swarm.** A persistent, tracked plan: a goal, split into steps, each assigned to an agent. Fields:
- `id` (`swm_…`), `title`, `goal`, `scope`;
- `owner_agent_id` (the agent that started it) and `thread_id` (where its card lives);
- `status`, derived from the steps: `planning`, `running`, `waiting_on_you`, `blocked`, `done`, `cancelled`;
- `steps[]`, each with `id`, `title`, `assignee_agent_id`, `needs[]` (step ids), `status`, `task_id` (the turn or task currently running it), `result_message_id`, and an optional `check` (a flows check: `tests_pass`, `diff_nonempty`, …);
- `version`, `created_at`, `updated_at`, `closed_at`.

A swarm is **persistent**: it is a row, not a burst of tasks. It survives restarts, appears in `swarm_list` until closed, and its card updates live. It can be **changed while it runs**: add, reassign, retry or cancel a step, or edit the goal. Every change is versioned and posts a `notice` to the thread.

Swarms and flows: a flow is a reusable template, and `flow_start` creates a swarm from it. The flow rules (different providers, pinned commits, checks, approvals) are enforced on that swarm's steps exactly as today. A swarm without a flow is free-form: the owner agent planned it.

**Question.** An agent asks the human something it can't decide: `{id, thread_id, agent_id, prompt, options[], multi, free_text, swarm_step_id?, status:'open'|'answered'|'expired'}`. While a question is open:
- its agent shows "Waiting on you";
- its swarm step reads `waiting_on_you`;
- the notch shows a badge.

The answer is posted as an `answer` message and starts the agent's next turn. Questions replace "ask in chat and hope someone sees it".

**Section.** A sidebar group: `{id, name, order, items:[agent or channel ids], collapsed}`. It is per viewer and has no effect on behaviour.

**Read cursor.** `(principal, thread_id) → last_read_seq`. Unread counts derive from it.

## 3. How work flows

1. The user writes to Atlas. `thread_post` stores a `text` message, and the service queues a `turn` task for Atlas.
2. A worker claims the turn, runs Atlas's runner with the turn prompt, and gives the model a small **turn toolset**. The tools are MCP and always scoped to this turn:
   - `thread_reply {body}`: post into the current thread;
   - `channel_post {channel, body}`: post into a channel Atlas belongs to;
   - `handoff {to_agent, body, swarm_step_id?}`: give work to another agent;
   - `swarm_start {title, goal, steps[]}` and `swarm_update {…}`;
   - `question_ask {prompt, options, multi, free_text}`;
   - plus the existing `task_submit`, `memory_*` and `context_get`, under the same grants as today.
3. Atlas calls `swarm_start` with five steps for Forge, Scout and Pulse. The service:
   - creates the swarm;
   - posts a `swarm` card into Atlas's thread;
   - queues a turn for each step whose `needs` are complete;
   - posts a `handoff` line into each assignee's thread ("Atlas gave you: Draft the banner").
4. When each step's turn ends, the result is linked to the step (`result_message_id`). The step moves to `done`, `failed` or `blocked`, the card re-renders, and newly unblocked steps start.
5. Pulse calls `question_ask` ("Which channels should the launch use?"). The step reads `waiting_on_you`, a question card appears in Atlas's thread, and the notch shows a badge. The user's answer resumes Pulse.
6. When every step is done, the owner agent gets a final turn to summarise, and the swarm reads `done 5/5`.

**Turn grant.** A worker's turn token is scoped to that turn. It can post only to that agent's threads and the channels that agent belongs to, start or update only swarms that agent owns or holds a step in, and ask only on its own behalf. A model can't post as another agent or into another project. This is enforced in the service, not in the prompt.

## 4. Protocol

The same rules as today apply:
- every operation is an MCP tool and `POST /api/tools/<name>`;
- each operation has a permission, a scope check and a closed JSON schema;
- every list operation pages;
- every write takes an `idempotency_key`;
- versions are optimistic (`expected_version`).

All new ids are UUIDs with a readable prefix in the UI only.

### Agents

| Tool | Permission | Input | Returns |
|---|---|---|---|
| `agent_create` | `agent:manage` | `name, role, instructions, scope, runner, edits, avatar?` | agent, and its main thread |
| `agent_update` | `agent:manage` | `agent_id, expected_version`, any of the above | agent; a runner change posts a `notice` |
| `agent_get` / `agent_list` | `agent:read` | `agent_id` / `scope?, after?, limit?` | the agent, plus `status`: `idle`, `working`, `waiting_on_you`, `offline` (no live worker can run its runner) |
| `agent_archive` | `agent:manage` | `agent_id` | archives it; its threads stay readable |

### Threads and channels

| Tool | Permission | Input | Notes |
|---|---|---|---|
| `thread_post` | `thread:write` | `thread_id, body, idempotency_key, reply_to?` | A human post to an agent thread queues a turn. A channel post queues turns for the `@`mentioned agents, or for the lead. |
| `thread_read` | `thread:read` | `thread_id, after_seq?, before_seq?, limit≤100` | Messages in order, with resolved `swarm` and `run` card snapshots. |
| `thread_mark_read` | `thread:read` | `thread_id, seq` | Moves the read cursor. |
| `thread_list` | `thread:read` | `agent_id? or kind?, include_archived?` | Agent side threads, or channels. |
| `channel_create` / `channel_update` | `agent:manage` | `name, scope, members[], lead_agent_id?` | Members are agent ids; the owner is always a member. |
| `section_set` | `thread:read` | `sections[]` | Per-viewer sidebar layout; replaces the whole list. |

### Swarms

| Tool | Permission | Input | Notes |
|---|---|---|---|
| `swarm_start` | `task:submit` | `title, goal, scope, thread_id, steps[]` (each `{title, assignee_agent_id, needs[], instructions?, check?}`), `flow?`, `inputs?`, `idempotency_key` | Validates the step graph (no cycles, assignees in scope), creates the card and starts the ready steps. |
| `swarm_update` | `task:submit` | `swarm_id, expected_version, ops[]` | Ops: `add_step`, `reassign {step, agent}`, `retry {step}`, `cancel_step {step}`, `edit {title?, goal?}`, `close`. Changes are atomic, versioned and posted as notices. |
| `swarm_get` | `task:read` | `swarm_id` | Swarm, steps, their task states, failure codes, served providers and progress `{done, total}`. |
| `swarm_list` | `task:read` | `scope?, status?=open, after?, limit?` | Open swarms first; the notch reads this. |
| `swarm_cancel` | `task:submit` | `swarm_id, expected_version` | Cancels running and pending step tasks, using the flows cancellation fencing. |

`flow_start` keeps its signature and now returns `swarm_id` as well; a flow run is a swarm.

### Questions

| Tool | Permission | Input | Notes |
|---|---|---|---|
| `question_ask` | turn grant only | `prompt ≤ 500, options[] ≤ 8 (each ≤ 80), multi, free_text, expires_in?` | Agents only, from inside a turn. |
| `question_answer` | `thread:write` (owner) | `question_id, choices[], text?, idempotency_key` | Posts the `answer` message and queues the agent's next turn. |
| `question_list` | `thread:read` | `status?=open` | Everything waiting on you; the notch badge counts these. |

### Live stream for the UI

`GET /api/stream?after=<cursor>&scopes=…` is Server-Sent Events over the existing events table, with the existing `'<xid>.<seq>'` cursor and its no-skip guarantee. New event types:

- `message.created`
- `message.updated`: a card changed
- `swarm.updated`
- `agent.updated`
- `question.created` and `question.answered`
- `thread.read`

Events carry ids and metadata, never message bodies, exactly as today's events never carry task results. The UI fetches bodies with `thread_read`, and reconnects with the last cursor. Webhook sinks and the Grok webhook can subscribe to the same types.

### Inbox and notifications

Agent-to-agent traffic goes through threads, not the inbox. The inbox stays the channel to **harness sessions** (Claude Code, Codex, Antigravity, and `swarmaa wrap`). An agent thread can be bound to a harness session (`agent_update {harness_session}`). Then:
- that session receives the agent's thread messages as inbox items, with delivery receipts as today;
- what the user types there can be posted back to the thread.

That bridges this layer into the CLIs people already use.

### Storage (migration 024)

`agents`, `threads`, `thread_members`, `messages` (an `(thread_id, seq)` unique pair; bodies redacted at write time), `thread_reads`, `sections`, `swarms`, `swarm_steps`, `questions`, `agent_provider_sessions` (the private resume state per agent and provider).

`tasks` gains `agent_id`, `thread_id` and `swarm_step_id`, all nullable; old tasks are unaffected. Everything is per tenant, with the same isolation tests as today.

## 5. What does not change

- Tasks stay the unit of execution. A turn is a task with `kind:'turn'`. Routing, quota limits, failure codes, rerouting, leases, slots and receipts apply unchanged.
- Workers keep their own config and environment, and `src/bridge/sandbox.ts` and `providerEnvironment` stay unchanged, as the owner decided.
- Memory and lessons stay project-wide. An agent reads them like any task does, and they are not per-agent.
- Existing tools, `/swarm` and the notch views keep working.

## 6. Phases

1. **Service foundation:** agents, threads, messages, turns (including the turn prompt and the turn grant), read cursors, the SSE stream, migration 024, and tests. Acceptance: create Atlas, post to it, get a reply on two different providers, switch the runner mid-thread with the thread kept, all under tenant isolation.
2. **Swarms, handoffs and questions:** the tools above; `flow_start` returns a swarm; the notch shows open swarms and the question badge. Acceptance: the Friday-launch scenario runs end to end with one question answered, one step reassigned while running, and a restart in the middle.
3. **Mac app main window:** sidebar sections, agent and channel threads, the four card types, a runner picker that shows quota, and an unread badge. Acceptance: every control is clicked in the real app and its result observed.
4. **Later:** channels with invited humans (gateway tenants already exist), scheduled agent routines, side threads, Slack and Discord bridges.

## 7. Open choices (defaults chosen)

- **The thread window** is the last 40 messages or up to 24 KB, plus a rolling summary that the agent's own provider writes every 40 messages. *Default.* Change it if long threads lose context.
- **An unaddressed channel message** goes to the channel lead, or with no lead it waits for an `@` mention. *Default.* There is no broadcast to every agent, because three agents answering one message is noise (OpenBot's own guidance agrees).
- **Edits:** an agent with `edits:true` runs patch turns in a worktree, and its branch is reported in the run card. Nothing merges without the owner, as today.
