# Connect your agents and run the Mac bridge

This guide connects installed agent clients to the Swarmaa service. Start with the repository
README and [docs/SWARMA.md](SWARMA.md), then use this guide after the service is reachable.

## 1. Give each client its own identity

If you followed the README setup, the identities below already exist: reuse their private
credential files and **do not run `create` again for those names**. The CLI requires unique
principal names and does not rotate a credential when `create` is repeated.

For an installation where these connections have not been provisioned, create only the missing
principals after configuring the service and database:

```sh
npm run admin -- create --name dot --role frontend --scopes project:demo --out .local/dot.json
npm run admin -- create --name grok --role frontend --scopes project:demo --out .local/grok.json
npm run admin -- create --name claude-interactive --role frontend --scopes project:demo --out .local/claude.json
npm run admin -- create --name codex-interactive --role frontend --scopes project:demo --out .local/codex.json
npm run admin -- create --name antigravity-interactive --role frontend --scopes project:demo --out .local/antigravity.json
npm run admin -- create --name worker-1 --role worker --scopes project:demo --out .local/worker-1.json
```

These commands write each new token to its named private file; the output path must not already
exist. Store the token in a password manager or macOS Keychain. Use a different worker principal
on any additional worker machine. Tokens identify the authenticated
principal; caller-supplied names cannot impersonate another worker. Start interactive clients
with the frontend role for memory, dispatch and result access. Give a distinct worker identity
only to an interactive client that must manually claim/checkpoint/finish tasks.

The example scope `project:demo` is an exact access grant. Replace it consistently in service
principals, bridge configuration and task requests. Dot and Grok Bot can see the same task when
both have that scope. They cannot discover other project contents through a guessed UUID.

Use provisioned bearer tokens for the REST bridge and bot client. OAuth-issued `cn_access_...`
tokens are for the `/mcp` protected resource only. Never use an admin token in a model client.

## 2. Connect Claude, Codex and Antigravity

The package provides a small stdio-to-HTTP MCP proxy at `dist/src/stdio-proxy.js` after a local
build. Its stdout contains only JSON-RPC messages; startup errors go to stderr. It accepts:

```sh
node dist/src/stdio-proxy.js --url https://swarmaa.example.com --token-env COLLECTIVE_CLAUDE_TOKEN
```

The named environment variable holds the token. The URL is an origin without `/mcp`; the proxy
adds the path. HTTPS is required except for `http://localhost`, `http://127.0.0.1` or loopback
IPv6 during local setup. Redirects are rejected. The proxy handles stateless JSON MCP, including
legacy initialization and the service's modern per-request routing headers. It does not handle
SSE streams or server-initiated tool requests; use the service event mechanism for updates.
The proxy limits one input line to 1 MiB and one HTTP response to 8 MiB. The bridge REST client
and optional Grok REST client also cap responses at 8 MiB. These client caps are protective
limits, not a promise that every maximum-sized collection fits. Start list calls with small
pages (for example `limit: 10`), follow returned cursors, and request memory history only when
needed. For `memory_get`, `proposal_limit` and `history_limit` default to 10; reduce them when
you need less detail, and use zero to omit those bodies. History still requires `include_history:
true`. The `proposals_has_more` and `history_has_more` flags describe a latest-record subset;
this release has no older-history cursor. Do not treat that subset as a complete history.

| Client | Template | Action |
|---|---|---|
| Claude Desktop | `clients/claude/claude_desktop_config.example.json` | Merge its `mcpServers` entry into the app's MCP configuration. |
| Claude Code | `clients/claude/mcp.example.json` | Merge the server into your approved MCP configuration or use the CLI's `--mcp-config` option. |
| Codex | `clients/codex/config.example.toml` | Merge the table into Codex config; `env_vars` forwards only the named client token to the proxy. |
| Antigravity | `clients/antigravity/mcp_config.example.json` | Open the product's MCP manager and merge the server into the configuration it displays. |
| Dot | `clients/dot/README.md` | Add the deployed remote `/mcp` endpoint through its connection flow. |
| Grok Bot | `clients/grok/README.md` | Connect its native Remote HTTPS MCP server to the deployed `/mcp` endpoint; `rest-client.mjs` is an optional custom-backend integration. |

Replace absolute Node and repository paths. Apple Silicon Homebrew commonly uses
`/opt/homebrew/bin/node`; select the actual installed binary on your machine. Do not paste token
values into JSON/TOML files or commit them. Each template expects its own token variable:
`COLLECTIVE_CLAUDE_TOKEN`, `COLLECTIVE_CODEX_TOKEN` or `COLLECTIVE_ANTIGRAVITY_TOKEN` (or `SWARMAA_*` aliases).

GUI apps may not inherit the environment of your terminal. For those, add the token in macOS
Keychain Access as a generic password, for example service name `swarmaa-claude`. Edit the
absolute paths in `clients/macos/mcp-keychain-launcher.sh`, then set the MCP configuration to:

```json
{
  "command": "/bin/sh",
  "args": [
    "/ABSOLUTE/PATH/swarmaa/clients/macos/mcp-keychain-launcher.sh",
    "swarmaa-claude",
    "https://swarmaa.example.com",
    "COLLECTIVE_CLAUDE_TOKEN"
  ]
}
```

The wrapper reads the secret from Keychain and exports it internally. It never prints the
secret or puts it in the Node command's arguments. macOS can ask you to authorize the Keychain
read. Use a distinct service name and token variable for each app.

Once connected, list tools and call `context_get({"scope":"project:demo"})`. An empty memory
list is a valid new installation. Only describe a connection as active after those requests
succeed. Copy relevant rules from `clients/NETWORK_RULES.md` into each client's project
instructions. These instructions guide behavior; service permissions enforce access.

Claude's remote connector can use the service OAuth flow instead of the local proxy when the
client supports it. Follow the transport/OAuth guide for redirect allowlists and hosting.

## 3. Configure the local Mac worker

Copy `config/bridge.example.json` to a private local configuration file. Set the service origin,
actual executable paths, and one static project root per scope. Remove uninstalled agents.
Binary paths and project roots must be absolute; the bridge resolves them at startup and checks
executability. Remote task messages cannot choose the executable, arguments or working directory.

Sign in to the provider CLIs on the worker machine using their normal login flows first.
The bridge inherits a small environment allowlist for provider authentication; its Swarmaa
token is omitted from provider subprocess environments. It does not pass arbitrary API base URL
overrides, shell startup hooks or `NODE_OPTIONS`. This is a trusted local runner, not isolation
from a malicious executable running as the same operating-system user. Prefer a dedicated
macOS user and project workspaces that do not contain unrelated credentials.

Supply `COLLECTIVE_WORKER_TOKEN` (or `SWARMAA_WORKER_TOKEN`) through a private environment or configure
`clients/macos/bridge-keychain-launcher.sh` to read `swarmaa-worker` from Keychain. The
bridge startup command, after building locally, is:

```sh
node dist/src/bridge.js --config /ABSOLUTE/PATH/bridge.local.json
```

For one polling pass, add `--once`; it executes at most one claimed task. With the source
dependencies installed, `npm run bridge -- --config /ABSOLUTE/PATH/bridge.local.json` uses the
TypeScript source entrypoint. Follow the repository's local validation instructions before
starting a persistent worker.

The default capabilities are `claude.read` and `codex.read`. A task must name one of those exact
strings. `research` and `review` tasks are eligible by default. A single bridge process executes
one task at a time, then polls the next configured project. Multiple machines can compete for
the same queue using different worker identities.

The bridge claims a 120-second database lease and renews it every 20 seconds by default. It
saves an initial checkpoint and bounded partial output on renewals. Completion stores a
transcript artifact and a task result. If renewal or checkpointing fails, the running provider
is aborted. POSIX process groups are terminated, with forced termination after a grace period.
Each provider run also has a wall-clock timeout and a combined stdout/stderr byte cap.
A separate conservative monotonic deadline stops the provider before the last known lease
window ends, even when a renewal request hangs. Cancelling a running patch can impose a resource
cooldown through the old lease expiry plus a stop grace before a successor can claim it.

The result explicitly marks acceptance criteria **unverified** and review required. A
`completed` task means the provider returned a successful terminal result. Read the artifact
and verify the original criteria before integrating its work. Provider output and diagnostics
are untrusted; the bridge does not treat them as permissions or SQL/file paths.

When a machine sleeps or loses network access, the lease can expire and another worker may
retry. Execution is at least once. Database lease fencing prevents stale service updates, but
cannot reverse already-written local files or external effects. Use dedicated working copies,
keep patch work on one assigned machine, and inspect interrupted work before continuation.
Use one consistent `resource_key` for tasks touching the same logical resource. Keys supplied
by different callers do not establish that their filesystem targets are distinct.

Patch execution also takes an atomic local `.collective-patch.lock` directory in the configured
project root, so two bridge processes cannot mutate the same root even when callers use
different resource keys. It is released after the provider process group stops. A crashed
bridge deliberately leaves the lock in place: inspect its `owner.json`, verify the old provider
and its descendants have stopped, and then remove the lock before requeuing. There is no
automatic stale-lock deletion that could overlap a still-active local process.

## 4. Provider support and patch mode

| Provider | Autonomous support | Enforced mode |
|---|---|---|
| Claude Code | Research/review; opt-in edits in sandboxed git worktrees (commands allowed) | `--restricted`, explicit built-in tool list, MCP tools denied, empty strict MCP config, permission prompts denied. |
| Codex CLI | Research/review; opt-in edits in sandboxed git worktrees | `exec --sandbox read-only`, never approvals, user config ignored, apps/plugins disabled. |
| Antigravity (`agy`) | Review and in-project edits (no research) | `--mode plan --output-format json --print-timeout`, prompt as one argv element (`-p=<text>`), no `--dangerously-skip-permissions`. Requires `sandbox:true`: the Seatbelt profile is the file boundary. |

Claude requires a release supporting `--restricted` and `--permission-prompts none` (at least
v2.1.259 for the latter). Read-only mode exposes `Read`, `Glob` and `Grep`. File-only patch mode
adds `Edit` and `Write` with `acceptEdits`; command execution, subagents, browser and MCP tools
are absent from that tool list. Managed organization policy remains authoritative. The bridge
never falls back to a permission-bypass flag if a CLI version rejects an option.

Codex must support the flags shown in `src/bridge/adapters.ts`. Its read-only filesystem sandbox
does not mean that every readable file is limited to the project directory. Keep the worker's
account and project data appropriate for the tasks it is authorized to analyze. Codex patch
mode is rejected in this release; use an interactive reviewed workflow for Codex edits.

Antigravity workers run `agy` in plan mode: headless, it auto-denies shell commands and reads outside the
workspace (reported as `denied_actions`; the bridge treats an empty answer as failure), and the outer
Seatbelt profile independently blocks project writes, credential directories and other chats. Its MCP
servers are defined in `~/.gemini/config/mcp_config.json` (which can hold tokens); the profile hides that
file, so the worker has no MCP tools and cannot call Swarmaa. `agy` still needs its own state writable
(`~/.gemini/antigravity-cli`, `~/.gemini/antigravity`, `~/.gemini/config/projects`), and other
conversations' `brain/` and `conversations/` are unreadable. Not confined: network access, and the
read-only guarantee for patch work (Antigravity has no patch mode here). Interactive MCP use of Antigravity is unchanged.

Contract: Read tasks run as `<provider>.read` or `auto.read`; edit tasks as `<provider>.patch` or `auto.patch`. Edits are an explicit per-install opt-in (setup's "Allow edits", default read-only): the worker gets the `task:patch` grant and `enable_patch`/`allow_patch` together. Edit tasks run in sandboxed git worktrees with commands allowed, commit to the local branch `swarmaa/<provider>/<id>` and never push. Antigravity does review and in-project edits, not research. The routing policy picks the provider by order and quota.

Edits are opt-in. `npm run setup` ("Allow edits") provisions all of the following together and reconciles them on re-run (switching back to read-only revokes the grant). By hand, do all three:

1. Grant `task:patch` to the worker principal: `--grant task:patch` on `admin create`, or
   `admin grant --name <n> --permission task:patch` for an existing worker.
2. Set the agent's `enable_patch` and the intended project's `allow_patch` to `true` in
   local bridge configuration. Use a dedicated reviewable working copy.
3. Submit a `patch` task with `required_capability: "claude.patch"`, a stable `resource_key`,
   clear constraints, and acceptance criteria.

The adapter produces local source edits and a provider transcript. It does not commit, push,
merge, deploy or run tests/builds. Review the working copy's diff locally. No automated rollback
is performed, because it could discard a user's concurrent edits. Other task kinds cannot gain
patch authority through task prose or a memory entry.

## 5. Optional Reason Network integration

The upstream snapshot is included under `vendor/reason-network`; it is not executed by this
companion service. Install and join Reason Network separately using its reviewed official
instructions. Point `reason.binary` to an already-installed **`reason-network`** executable,
not the `reason` umbrella CLI. Its argument layout is `reason-network who --json` and
`reason-network send person/session message`.

To send a completion notification to one explicit local-team session, replace `reason: null`
in the bridge config with:

```json
{
  "binary": "/ABSOLUTE/PATH/reason-network",
  "recipient": "owner/terminal",
  "cwd": "/Users/YOUR_USER/Projects/demo"
}
```

Notifications contain a task ID and status only. Broadcast recipients are rejected. The module
also exposes bounded `reasonWho` for tools that need the current directory of sessions. The
bridge neither depends on undocumented relay APIs nor assumes that network presence means a
task succeeded. Failure to notify Reason does not erase the durable task result.

## 6. Keep a worker running after validation

`clients/macos/com.collective.bridge.example.plist` is a launch-agent template. Replace every
absolute path, configure the Keychain launcher, choose log locations, and then install it through
your normal macOS launch-agent workflow. Do the same on any additional worker Mac with a different Keychain
item and principal token. Start with read-only capabilities on each machine.

The sample log files contain task IDs and operational event codes, not task bodies or tokens.
Arrange log rotation if you leave the worker running. Stop the bridge cleanly with SIGTERM;
it aborts its active subprocess and attempts a final blocked result when its lease is still valid.

## Validation status and references

Tests in `tests/bridge*.test.ts` cover mode restrictions, prompt/argv separation, environment
filtering, heartbeat loss, wrong-scope claims, output/time bounds, and proxy framing. They are
provided for local validation and were **not run** while this source package was authored.
Provider CLIs, service connections and cross-device failover also require a local smoke test.

Official references reviewed while implementing this package:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): restricted mode,
  tool lists, denied permission prompts and JSON output.
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference): noninteractive execution,
  stdin prompts, configuration isolation and sandbox flags.
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp): stdio environment forwarding
  and native HTTP token configuration.
- [Antigravity headless mode](https://antigravity.google/docs/cli/headless/): headless permissions
  and the workspace-write default.
- [Antigravity MCP](https://antigravity.google/docs/mcp): its `mcpServers` configuration format.
- [Reason Network](https://github.com/reason-machines/reason-network): the pinned upstream source,
  CLI discovery/messaging interface, and separate network installation.

## Flow check execution

The bridge can execute service-owned flow checks without invoking a model. Enable `projects[].checks` in the owner's local bridge configuration and supply absolute Node 24 test/build commands. This requires the existing patch opt-ins and worker permission. See [Flows](FLOWS.md#owner-configured-bridge-checks); this setting does not change provider configuration or environment.
