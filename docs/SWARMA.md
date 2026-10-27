# Swarmaa

Swarmaa connects your agent CLIs and chat agents to one shared memory and task queue. Claude Code,
Codex and Antigravity read and write the same project memory over MCP. Claude, Codex and Antigravity can also
run as background workers that pick up read-only review/research tasks. Dot and Grok use the same
service over HTTPS. The Swarmaa macOS app shows the agents and swarms in the notch.

## First launch

```bash
npm install
npm run setup
```

`npm run setup` opens a one-page onboarding in your browser (`-- --cli` for terminal prompts). It asks which project folders the swarm may read, which installed CLIs to connect, which
ones to run as background workers, whether to show Swarmaa in the macOS notch app, and whether to start
everything at login. It is safe to re-run; answers are remembered in `.local/setup.json`.
`npm run setup -- --dry-run` prints every action without changing anything.

What it does:

| Step | Result |
|---|---|
| Database | Local PostgreSQL 17 cluster in `.local/pg` on `127.0.0.1:54329` (needs `brew install postgresql@17`) |
| Identities | One scoped identity per client, token in an owner-only `.local/<name>.json` |
| Clients | `swarma` MCP server registered in Claude Code (user scope), Codex and Antigravity (with per-tool allow rules) |
| Workers | `.local/bridge-<agent>.json` per worker (`claude`, `codex`, `agy`), read-only and Seatbelt-sandboxed, Claude on Sonnet; Antigravity serves `antigravity.read` |
| Autostart | LaunchAgents `com.swarma.postgres`, `com.swarma.service`, `com.swarma.bridge.<agent>`; logs in `.local/logs/` |

Tokens never appear in client configs or process arguments: `clients/macos/swarma-mcp.sh` reads
the identity's token file and starts the stdio proxy; bridges read `token_file` directly.

## Captured apps

Besides the hook-based sharing for Claude Code, Codex and Antigravity, Swarmaa can record chats from other AI coding apps
without running a service. Setup asks once ("Capture chats from other apps") and lists the ones it finds.

| How | Apps |
|---|---|
| Polled by `npm run capture -- --once` (LaunchAgent `com.swarma.capture`, every 2 minutes, then exits) | Cursor, OpenCode, GitHub Copilot CLI, Cline, Roo Code, Devin CLI, Hermes, Factory, Pi |
| Hooks installed by setup (own identity per app, one share toggle each) | Kiro (`~/.kiro/hooks/swarmaa-journal.json`), Windsurf / Devin Desktop (`~/.codeium/windsurf/hooks.json`), Qwen Code (`~/.qwen/settings.json`) |

The poller reads each app's local history read-only, keeps only user/assistant text (no tool calls or results, thinking or injected
context), redacts secrets, resolves the project scope from the working directory, and sends the latest 40 turns per changed
session through the `capture` identity (`.local/capture.json`). Cursors live in `.local/capture/<app>.json`; the first run only
looks at the last 14 days; a run stops after 60 seconds. Errors are logged as status words to `.local/logs/capture.log`.
`npm run capture -- --dry-run [--only cursor,opencode]` prints per-app counts and sends nothing. Roo Code's storage layout is inferred
from Cline's; Windsurf hooks carry no working directory, so those chats land in `project:general`. Qwen chats are recorded under the
`other` harness. Not affiliated with Asymptote Labs; the readers adapt MIT-licensed recipes from agent-beacon.

## Projects and scopes

Each project folder becomes a scope `project:<folder-name>`; `project:demo` is a throwaway sandbox.
Identities only see their scopes. To add a project later, re-run `npm run setup`, or change one
identity directly:

```bash
npm run admin -- set-scopes --name claude-interactive --scopes project:demo,project:myapp
```

Removing a scope takes effect on the next request, including for OAuth-connected clients.

## Routing work by remaining quota

Workers report each provider's quota windows (`5h`, `weekly`) and reset times (`usage_report`, from `src/usage`).
Submit read work with `required_capability: "auto.read"` (edits with `"auto.patch"`) and the owner's **routing policy** decides, per task kind
(`review`, `research`, `patch`), who takes it: providers are walked in priority order and the first that is enabled, allows
the kind, has a live worker for the scope, has a fresh reading (under 15 minutes) and is under both its
`max_five_hour_pct` and `max_weekly_pct` wins. If none qualifies, `fallback: "most_headroom"` picks the allowed
live provider with the most headroom, and `"none"` leaves auto.read tasks of that kind waiting. With no fresh
readings at all, any enabled worker that allows the kind may claim, so work never stalls.

Default policy (no saved row): claude, codex (review + research + patch, 90% / 95% ceilings) then antigravity (review + patch, 95%).
Antigravity cannot reach outside the project, so it takes reviews and in-project edits, never research. Saved policies from before patch routing gain `patch` where the default allows it (migration 011). `routing_get` returns
`{policy, is_default, default_policy, updated_at}`; `routing_set {policy}` replaces it and needs `routing:manage`:
`npm run admin -- grant --name <frontend identity> --permission routing:manage` (`revoke-grant` removes it).
Changes are audit-logged. Explicit capabilities obey the policy too: `<provider>.read` / `<provider>.patch` for a kind the provider
does not take is rejected with `kind_not_allowed`, and a disabled provider with `provider_disabled`; queued
work already pinned to such a provider is skipped by its worker.

Rule for agents and front ends: prefer `auto.read` / `auto.patch`; use `antigravity.read` only for review tasks that need just
the project's own files; anything needing commands, builds, cloning/fetching external repos or reading outside the
project goes to `codex.read`/`claude.read`/`auto.read`. Check `swarm_status.routing.by_kind` before naming a provider.

### Fan out

Name a provider (`codex.patch`, `claude.read`, ...) when the user asks for one; otherwise `auto.read` (review/research)
or `auto.patch` (edits) and the service routes by the Routing rules and quota. `auto.read` rejects patch tasks and
`auto.patch` rejects review/research. Patch tasks need only `task:submit`; `resource_key` is optional (set it to
serialize work on one resource) and `base_ref` (patch only, a git ref) picks the starting commit. Each patch runs in an
isolated git worktree and returns a local branch `swarmaa/<provider>/<task id>` plus a diff artifact; the result carries
`branch`, `base_ref`, `base_commit`, `head_commit`, `changed_files`, `diffstat`, `commands_allowed`. Review, then merge;
nothing is pushed.

`swarm_status` returns live workers, provider headroom with reset times, `routing` (`recommended`/`reason` for review, plus `policy`, `is_default`, `by_kind`), task counts per scope and
recent tasks. `npm run usage` prints the local readings.

**Coming next:** persistent agents with their own threads, channels and tracked swarms; see [TEAMS.md](TEAMS.md).

## /swarm

`/swarm` shows swarm runs from inside Claude Code, Codex and Antigravity through the `swarma` MCP tools (worker chats are
recorded as `swarm:<task id>` chats, so `session_list {swarm_only:true}` finds them; `session_get {task_id}` reads one).

| Input | Does |
|---|---|
| `/swarm` | live workers, queued/running, and a table of the last 15 runs here (when, service, project, title, status, branch) |
| `/swarm <task id or prefix>` | request, answers, branch, diff summary, how to continue and review (`git log`/`git diff` on the branch) |
| `/swarm continue <id> <instruction>` | `task_continue` on the latest version with a fresh idempotency key |
| `/swarm run <instruction>` | `task_submit` here (`auto.read` for review/research, `auto.patch` for edits; asks if unclear) |

Installed by `npx tsx scripts/hooks-install.ts` (`--dry-run`, `--remove`): `~/.claude/commands/swarm.md`,
`~/.codex/skills/swarm/SKILL.md` (type `$swarm`), `~/.gemini/config/skills/swarm/SKILL.md`. Files without the
`swarma:swarm-command` marker are never overwritten. Source: `clients/commands/swarm.md`.

**Resume from the CLI.** Claude patch runs and all Codex runs keep a native transcript, so a swarm run can be continued in
the CLI: the result's `native_session` is `{harness, id, resume}` and the swarm chat ends with `Resume: <command>`
(`cd <project root> && claude --resume <id>` or `codex resume <id>`). The bridge copies the transcript into
`~/.claude/projects/<project slug>/` or `~/.codex/sessions/` after the run, changing only the worktree path to the project
root. Workers stay confined: a Claude patch worker may read/write only its own `~/.claude/projects/<worktree slug>/`
(removed after the copy), a Codex worker runs with a temporary `CODEX_HOME` whose only link into `~/.codex` is `auth.json`.
Claude read runs are not persisted (their cwd is your real project). Antigravity is unchanged. The desktop apps still list
only chats they started. A failed copy logs `native_session_failed` and never changes the task outcome.

## Lessons

Finished chats become reviewed, reusable guidance: distill, review, reuse.

- **Distill.** `npm run distill -- [--once] [--dry-run]` (a daily LaunchAgent runs it) acts as the `distiller` identity
  (created on first run, frontend role, never admin). It queues read-only `review` tasks (`auto.read`) holding the redacted,
  fenced transcripts of up to five ended or idle (30 min) chats per scope (at least 4 turns), then collects finished tasks
  and files each valid lesson with `lesson_propose` (`source: "distill"`). Scopes no worker serves, and `project:general`,
  are marked skipped. A task prompt is capped at 16000 characters by `task_submit`, so long chats are shortened (first and
  last turns kept).
- **Propose.** Any agent with `memory:write` can call `lesson_propose`. Secrets are redacted, safety findings are stored as
  `flags` (prompt-injection, risky-command and credential-access patterns), invisible/bidi characters are rejected. Lessons
  start as `candidate` and are data, never instructions.
- **Review.** `lesson_review` needs `lesson:review`, which nobody has by default:
  `npm run admin -- grant --name <frontend identity> --permission lesson:review` (`revoke-grant` removes it). Approve (with
  optional edits; the original is kept in the audit log), reject, or supersede an approved lesson. `swarm_status` shows
  `lessons_pending`.
- **Reuse.** Approved lessons appear in `context_get` (`lessons`, at most five) and `lesson_search`, always as guidance that
  yields to the user's instructions and the project's docs.

Run `npm run migrate` (migration `008_lessons.sql`) before restarting the service.

## macOS notch view

With the Swarmaa view enabled, the macOS notch app shows one cell per worker (quota ring, current task or
idle/offline) and one per swarm (running, queued, done today). It uses its dedicated local frontend
identity and `http://127.0.0.1:8787`.

## Reaching Swarmaa from other devices and hosted agents

No custom server module is needed. The service stays on this Mac (fast local path, data stays local)
and is published through an existing tunnel:

| Who | How |
|---|---|
| Your own devices (MacBook, phone) | Tailscale: `tailscale up`, then `tailscale serve --bg 8787` gives `https://<mac>.<tailnet>.ts.net` inside your tailnet only |
| Hosted agents (Dot, Grok, claude.ai connectors) | Cloudflare Tunnel: `cloudflared tunnel login`, `cloudflared tunnel create swarma`, route `swarma.<your-domain>` to `http://127.0.0.1:8787`, run it as a service |

Then set `PUBLIC_URL=https://<that host>` in `.env` and restart the service. Local clients keep using
`http://127.0.0.1:8787`: the service accepts a literal loopback Host from a loopback connection in
addition to the public host. Hosted clients use `https://<host>/mcp` with OAuth; set
`OAUTH_REDIRECT_HOSTS` to the hosts their connection screens show (see `docs/TRANSPORT.md`).

A Cloudflare Worker would only be worth it to accept tasks while this Mac is asleep; that means
moving the PostgreSQL-backed service, which is not needed for a personal swarm.

## Deploying changes

Use Node.js 24 and `npm run deploy:local` to build, drain running bridges with SIGUSR2,
wait for their replacement PIDs, then restart the service and check its discovery endpoint.
Never `kickstart -k` a busy bridge: SIGTERM/SIGINT abort its running tasks. A repeated SIGUSR2 is harmless.
Drain waits indefinitely by default; set `BRIDGE_DRAIN_MAX_SECONDS` in the bridge environment to
abort remaining tasks after a deadline. Draining bridges keep heartbeating and report zero slots.
Use `-- --dry-run` to print the plan without building or signaling, `--only claude|codex|agy` for one
bridge, or `--no-service` to leave the service running. Set `PORT` for a non-default service port
(default 8787); an optional `COLLECTIVE_TOKEN` adds scoped running-task counts to PID progress.
The first rollout requires bridges that already handle SIGUSR2; install this version while idle.
Before rollout, the database's worker-slots constraint must accept 0 (the original migration accepts 1–16).

## Day to day

```bash
launchctl kickstart -k gui/$(id -u)/com.swarma.service   # restart the service
tail -f .local/logs/service.log .local/logs/bridge.claude.log
npm run admin -- list                                    # identities
npm run usage                                            # provider quota and resets
```

Stopping autostart: `launchctl bootout gui/$(id -u)/com.swarma.<job>` and delete its plist from
`~/Library/LaunchAgents`.

Removing a client: `claude mcp remove -s user swarma`, `codex mcp remove swarma`, `agy mcp remove swarma`.

## Inbox notifications between agents

After applying migrations `019_inbox.sql` and `020_inbox_receipts.sql`, setup installs inbox hooks for each connected Claude Code, Codex
and Antigravity CLI, independently of optional chat sharing. `npx tsx scripts/hooks-install.ts` installs the
journal, inbox and `/swarm` files; `--remove` removes only these owned entries, and `--dry-run` previews them.
Codex requires one-time review and trust through `/hooks`; the installer never bypasses it.

`clients/hooks/swarmaa-inbox.mjs <claude|codex|agy> <event>` reads the same `.local/<identity>.json` and `.env`
port as the stdio launcher. Fast hooks have a two-second network budget and stay silent on errors. Bodies
are labeled as untrusted data and context is capped below 10,000 characters (four items per fetch).

- Claude's SessionStart, UserPromptSubmit and PostToolUse hooks inject context; its matched `task_submit`
  hook registers the submitting session. Stop runs an async + asyncRewake waiter for up to 30 minutes in
  25-second chunks. An item goes to stderr with exit 2. One PID lock per session lives under
  `~/.swarma/inbox/<session hash>`; another Stop leaves a live waiter alone, and normal cancellation releases it.
- Codex's step hooks inject context. Stop only displays an informational message and saves that batch
  privately for the next step: the current Stop contract does not support model-visible additionalContext.
  It never blocks or creates a continuation. No `codex queue` idle-wake path is enabled without live proof.
- Antigravity PreInvocation returns an ephemeral injected step; Stop continues only when pending data exists.

For explicit routing use `message_send`; to watch a task from Codex or Antigravity, call `task_watch` with
the harness-prefixed session ID. A principal-wide notification is tracked independently for each session of that identity;
explicit session watchers receive their own item.

Hooks reserve an `offered` receipt before output. The wrapper waits for its output-only child to exit 0 (step)
or 2 (Claude wake), then sends `inbox_ack` with the stable delivery ID. A small private acceptance journal retains
IDs when the acknowledgment response is lost; later hooks reconcile those IDs before fetching or printing more.
Codex Stop's informational output is not accepted until the next model-visible step prints its cached batch.
Before using that cache, the hook rechecks access and receipt state with a read-only lookup; accepted/read or
stuck items are discarded without printing.
A crash before local confirmation remains unconfirmed; after 30 seconds the server permits at most two re-offers,
then shows the receipt as stuck in `swarm_status`. Acceptance means successful output, not model comprehension.
Use `inbox_get` or `task_get` with `session` to record an agent read in that session. Exact `delivery_id` lookups
return receipt metadata without redelivery. Dashboard and sink receipt summaries never include message bodies.
