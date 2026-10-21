# Swarmaa

Swarmaa connects your agent CLIs and chat agents to one shared memory and task queue. Claude Code,
Codex and Antigravity read and write the same project memory over MCP. Claude and Codex can also
run as background workers that pick up read-only review/research tasks. Dot and Grok use the same
service over HTTPS. NotchTrader shows the agents and swarms in the notch.

## First launch

```bash
npm install
npm run setup
```

The wizard asks which project folders the swarm may read, which installed CLIs to connect, which
ones to run as background workers, whether to show Swarmaa in NotchTrader, and whether to start
everything at login. It is safe to re-run; answers are remembered in `.local/setup.json`.
`npm run setup -- --dry-run` prints every action without changing anything.

What it does:

| Step | Result |
|---|---|
| Database | Local PostgreSQL 17 cluster in `.local/pg` on `127.0.0.1:54329` (needs `brew install postgresql@17`) |
| Identities | One scoped identity per client, token in an owner-only `.local/<name>.json` |
| Clients | `swarma` MCP server registered in Claude Code (user scope), Codex and Antigravity (with per-tool allow rules) |
| Workers | `.local/bridge-<agent>.json` per worker, read-only, Claude on Sonnet |
| Autostart | LaunchAgents `com.swarma.postgres`, `com.swarma.service`, `com.swarma.bridge.<agent>`; logs in `.local/logs/` |

Tokens never appear in client configs or process arguments: `clients/macos/swarma-mcp.sh` reads
the identity's token file and starts the stdio proxy; bridges read `token_file` directly.

## Projects and scopes

Each project folder becomes a scope `project:<folder-name>`; `project:demo` is a throwaway sandbox.
Identities only see their scopes. To add a project later, re-run `npm run setup`, or change one
identity directly:

```bash
npm run admin -- set-scopes --name claude-interactive --scopes project:demo,project:myapp
```

Removing a scope takes effect on the next request, including for OAuth-connected clients.

## Routing work by remaining quota

Workers report each provider's quota windows and reset times (`usage_report`, from `src/usage`,
ported from NotchTrader). Submit read work with `required_capability: "auto.read"` and the service
gives it to the live worker whose provider has the most headroom. Without fresh readings (older than
15 minutes, or no live worker for the best provider) any auto-capable worker may take it, so work
never stalls. Name an explicit capability (`claude.read`, `codex.read`) to pin a provider.
Patch tasks always name an explicit capability.

`swarm_status` returns live workers, provider headroom with reset times, task counts per scope and
recent tasks. `npm run usage` prints the local readings.

## NotchTrader

With the Swarmaa view enabled, NotchTrader shows one cell per worker (quota ring, current task or
idle/offline) and one per swarm (running, queued, done today) in place of the stock tickers. It uses
the `notchtrader` identity from `.local/notchtrader.json` and `http://127.0.0.1:8787`.

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
