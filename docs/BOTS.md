# Bots: persistent, configured swarms

A **bot** is the unit people work with in Swarmaa. It does one job ("Launch", "Pricing watch", "Inbox triage") for as long as it exists. A bot is a **swarm with settings**:
- **a crew of agents:** one lead plus members;
- **one thread**, where everything it does shows up;
- **its own routing and rules,** which apply to every task it starts and override the global Swarmaa defaults.

This builds on Teams ([TEAMS.md](TEAMS.md)). Agents, threads, turns, swarms, questions and the turn grant are unchanged. A bot ties them together, and the Mac app's home is the list of bots.

Design: the "Swarmaa main window" canvas (Bots home, Bot settings, Tasks, Usage).

## 1. The model

| Thing | What it is |
|---|---|
| **Bot** | `bots` row (migration 027): `name`, `job` (≤ 8 KB, the lead's standing brief), `scope`, `avatar`, `thread_id`, `lead_agent_id`, `routing`, `rules`, `schedule`, `starred` (migration 028, default false), `version`. |
| **Crew** | The bot thread's `thread_members` (migration 025), with `threads.lead_agent_id` = the bot's lead. Members are ordinary agents, and one agent may serve several bots. |
| **Bot thread** | A `threads` row with `kind = 'bot'`. It routes like a channel: a human post goes to the `@`mentioned member, or else to the lead. Everything the bot does lands here as messages. |
| **Bot task** | Any task with `tasks.bot_id`: the lead's turns, swarm steps started from the bot thread, handoffs, reviews, checks and scheduled runs. |
| **Task card** | A message of `kind = 'task'`, with `ref.task_id`, that the service posts into the bot thread when a bot task needs the owner: ready for review, failed, or check failed. |

**`bot_id` propagation.** A task gets `bot_id` when it is created:
- from a turn in a bot thread;
- from a swarm whose `thread_id` is a bot thread;
- as a handoff, review or check of a bot task.

It is set once, at insert, and never changed.

## 2. Routing per bot

```jsonc
"routing": {
  "research": {"mode": "auto"},                                     // read-only work: reading, web, code search
  "patch":    {"provider": "claude", "model": "claude-opus-5-5", "effort": "high"},
  "review":   {"mode": "different_from_author"},                    // or a runner
  "summary":  {"provider": "antigravity", "model": "gemini-3.8-flash-high"}   // the lead's chat turns
}
```

**What each key covers:**
- A turn is `summary` when the agent has no `edits`, and `patch` when it does.
- A swarm step is `patch` when its assignee has `edits`, otherwise `research`.
- `review` tasks are `review`, and the research kind is `research`.

**Resolution, when a bot task is created.** A missing kind means `{"mode":"auto"}`.
- **A provider runner** sets `required_capability = <provider>.<read|patch>`. A model or effort the runner names is passed to the bridge as today's agent runner is.
- **`auto`** maps to `auto.read` or `auto.patch`. The existing quota-aware router chooses the provider, under the bot's rules.
- **`different_from_author`** applies to reviews only. The provider that served the reviewed task goes into `excluded_providers`, then auto routing runs; this is the flows rule `different_provider_than`. With no other provider left, the review waits with a notice instead of reviewing itself.

**`rules.quota_floor_pct`** (0–50, default 0):
- **Auto routing:** auto never picks a provider whose most-used window has less than this much left. `0` means a service may be run to empty, the owner's choice for Codex.
- **Named runners:** a named runner still runs when it is below the floor, and the task card says so.
- **Global policy:** the global policy's `max_*_pct` still applies, and the bot floor only tightens it.

## 3. Rules

| Rule | Default | Effect |
|---|---|---|
| `quota_floor_pct` | 0 | See above. |
| `approve_public` | true | The turn prompt tells the crew that anything public (posts, emails, releases, pushes) needs a `question_ask` first. Worker envelopes already forbid `publish` and `deploy`, so this is guidance plus the envelope, not a new hard gate. |
| `review_edits` | true | When a bot `patch` task finishes with a commit, the service queues a `review` task of that branch, routed by `routing.review` (default `different_from_author`). Its verdict posts as a `task` card, and the edit's card shows *Ready for review* only after the review passes. |
| `require_tests` | false | When a bot `patch` task finishes with a commit, the service queues a `check` task with `initiator_kind = 'bot_check'`. It runs the project's tests on that branch, reusing the flows `tests_pass` check. A failing check posts a `task` card with **Send back**, which queues a follow-up turn for the author with the failure. |
| `schedule` | null | A 5-field cron in the owner's time zone (`CRON_TZ=…` prefix allowed). The service's tick posts a notice "Scheduled run" into the bot thread and queues the lead's turn with `initiator_kind = 'schedule'`, then sets `next_run_at`. It skips a run while the lead already has a queued or running turn. |

A bot's `starred` boolean is returned by create, update, get and list. At most one live bot per tenant can be starred, across all scopes (migration 028). Setting `starred: true` on create or update atomically clears the previous star and emits `bot.updated` for both bots; clearing the previous star also increments its version. The caller must have access to both scopes or the entire write fails. Setting `starred: false` clears the star; archiving also clears it. Create retries with the same idempotency key do not move the star again.

## 4. Tools (`POST /api/tools/<name>` and MCP)

All follow the Teams conventions: closed schemas, `idempotency_key` on writes, `expected_version`, `teamsLock` first on every write, tenant and scope checks.

| Tool | Permission | Input → output |
|---|---|---|
| `bot_create` | `agent:manage` | `name, job, scope, lead_agent_id, member_agent_ids[], routing?, rules?, schedule?, avatar?, starred?, idempotency_key` → `{bot, thread}`. Creates the `bot` thread with lead and members. |
| `bot_update` | `agent:manage` | `bot_id, expected_version`, plus any of `name, job, avatar, lead_agent_id, member_agent_ids, routing, rules, schedule, starred` → `{bot}`. A routing or crew change posts a `notice` such as "Edits now run on Claude Opus 5.5 · High". |
| `bot_get` | `agent:read` | `bot_id` → `{bot}` with `crew` (agents, lead first), `routing_now` and `badges`. |
| `bot_list` | `agent:read` | `scope?, include_archived?, after?, limit?` → `{bots, has_more, next_cursor}`. Ordered with **updates first**: bots with `badges.needs_you > 0`, then `starred = true`, then `badges.unread > 0`, then by last activity. |
| `bot_archive` | `agent:manage` | `bot_id` → `{bot}`. Clears its star. Its thread stays readable, and its queued tasks are cancelled. |
| `bot_routing_preview` | `agent:read` | `bot_id` → `routing_now`. |

**`routing_now`:** for each kind, `{runner, provider_now, reason}`, where `provider_now` is the provider the router would choose right now under current quota and the bot's rules. It feeds the header line "Auto · Antigravity researches, Claude edits".

**`badges`:**
- `unread`: messages in the bot thread past the viewer's read cursor;
- `needs_you`: open questions, plus unresolved review-ready or failed bot tasks;
- `latest`: `{kind, line, at}`, the newest thing worth a row preview, which is the newest needs-you item if there is one.

**Bot shape (JSON):**

```jsonc
{"id","scope","name","job","avatar","thread_id","lead_agent_id","member_agent_ids":[...],
 "routing":{...},"rules":{"quota_floor_pct":0,"approve_public":true,"review_edits":true,"require_tests":false},
 "schedule":null,"next_run_at":null,"archived":false,"starred":false,"version":1,"created_at","updated_at",
 "badges":{"unread":2,"needs_you":1,"latest":{"kind":"question","line":"Which channels should the launch use?","at":"..."}}}
```

**`thread_read` on a bot thread** also embeds a `task` object on `kind: 'task'` messages: `{id, title, kind, status, resolved, branch, changed_files, served:{provider,model}, failure:{code,detail}|null, check:{status}|null}`. It is batched like the question and swarm embeds.

**Live stream:** `bot.updated` (`{bot_id, reason}`), emitted when a bot's settings, crew or badges change. Badge changes ride on the existing `message.created`, `question.*` and `task.updated` events. Ids only, never bodies.

## 5. What stays the same

- Agents, turns, the turn grant, swarm actions, questions and `teamsLock` are unchanged.
- Channels still work; a bot thread is a channel with settings attached.
- The global routing policy (`routing_set`) stays the default for work outside a bot.
- Workers keep their own configuration and environment. `src/bridge/sandbox.ts` and `providerEnvironment` are unchanged.

## 6. Build plan

| Part | Owner | Scope |
|---|---|---|
| Architecture and migration 027 | coordinator | This file and `db/migrations/027_bots.sql`. |
| **B1: bots core** | Antigravity | `src/core/bots.ts`: the tools, the crew, bot thread routing, `bot_id` propagation, task cards and their `thread_read` embed, badges and ordering, and `bot.updated`. |
| **B2: bot routing and rules** | Codex (GPT-6.1 Sol) | `src/core/bot-routing.ts`: runner resolution per kind, the quota floor, `different_from_author`, `routing_now` / `bot_routing_preview`, `require_tests` checks, and the schedule tick. |
| **Mac app** | coordinator | The design's Bots home, bot thread with task cards, Bot settings, rail usage hover cards, Tasks and Usage, in `Mac-app/`. |

B1 and B2 touch different files, apart from small hooks in `src/core/tasks.ts` and `src/core/tools.ts`. The coordinator merges them.
