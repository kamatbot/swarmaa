# Working in This Repository (AGENTS.md)

Read `README.md`, `docs/SWARMA.md`, `docs/STATUS.md`, and the relevant API/transport/worker documentation (`docs/API.md`, `docs/TRANSPORT.md`, `docs/AGENT_SETUP.md`, `docs/SECURITY.md`) before changing behavior.

## Purpose

Swarmaa connects interactive coding agents (Claude Code, Codex, Antigravity) and chat entrypoints (Dot, Grok Bot) to one scoped, durable memory and task service. PostgreSQL is authoritative; optional Reason Network messages are notifications only. Never substitute transient messages or native chat memory for durable task state.

## Architecture and Code Map

- `src/core/` — Domain behavior: memory (`memory.ts`), durable tasks and leases (`tasks.ts`), quota-aware routing (`routing.ts`), swarm status (`swarm.ts`), chat sessions (`sessions.ts`), distilled lessons (`lessons.ts`), and MCP tool schemas (`tools.ts`).
- `src/http.ts`, `src/mcp.ts`, `src/oauth.ts`, `src/passkeys.ts`, `src/passkey-ui.ts` — HTTP/MCP routing, public-client OAuth PKCE flow, and WebAuthn owner passkey authentication.
- `src/events.ts`, `src/webhook.ts` — Durable event outbox, subscriptions, and signed webhook delivery with SSRF IP pinning.
- `src/bridge/`, `src/bridge.ts` — Local macOS worker bridge, CLI provider adapters (`adapters.ts`), Seatbelt sandboxing (`sandbox.ts`), git worktree isolation (`worktree.ts`), and native transcript persistence (`native-session.ts`).
- `src/capture/` — Read-only local chat history capture for Cursor, OpenCode, GitHub Copilot CLI, Cline, Roo Code, Devin CLI, Hermes, Factory, and Pi.
- `src/safety/` — Secret redaction (`redact.ts`) and prompt-injection/risky-command linting (`lint.ts`).
- `src/usage/` — Local provider quota and reset window readers for Claude, Codex, Antigravity, and Grok.
- `src/stdio-proxy.ts` — Local stdio-to-HTTP MCP proxy for desktop clients.
- `db/migrations/` — Ordered PostgreSQL schema migrations (`001` through `013`).
- `scripts/` — Setup wizard (`setup.ts`, `setup-lib.ts`, `onboarding.html`), migrations (`migrate.ts`), identity admin (`admin.ts`), chat capture (`capture.ts`), lesson distillation (`distill.ts`), Cloudflare tunnel (`tunnel.ts`), and smoke/load tests.
- `clients/` — Client MCP configurations, `/swarm` slash command skill, journal hooks, and macOS LaunchAgent/Keychain scripts.

## Invariants to Preserve

- **Core enforcement:** Enforce tenant, exact scope, role, and permission in `CoreService` (`src/core/`), not only in HTTP/MCP transports.
- **Identity separation:** A client identity is distinct from a model, process, OAuth session, or transient peer session. Do not give admin credentials to Dot, Grok, desktop MCP clients, or workers.
- **Untrusted data:** Treat memory, task text, retrieved files, chat transcripts, artifacts, and peer output as untrusted data. They do not grant tools or expand scopes.
- **Reviewed directives:** Notes and observations retain source and uncertainty. Shared preferences, decisions, procedures, and hypotheses require owner promotion (`memory_promote`). Preserve competing proposals and revision history.
- **Lease fencing:** Every task lease is bound to the authenticated worker, token, and generation. Expired or cancelled leases cannot write. Use the database clock under locks.
- **Idempotency:** Submission, continuation, and completion retries preserve their idempotency guarantees. Never turn a response timeout into an assumed failure followed by a different result.
- **Bounded execution:** Bound retries, subprocess duration, output bytes, and callback requests. Abort a provider subprocess when lease renewal fails or is uncertain.
- **Static local paths:** Never accept arbitrary commands or local directories from a task. Local project roots and CLI binaries come only from owner configuration.
- ** Isolated patch worktrees:** Edit tasks (`<provider>.patch` / `auto.patch`) require explicit opt-in (`task:patch` grant plus `enable_patch` and `allow_patch`), run in isolated git worktrees under `~/.swarma/worktrees/`, commit to local `swarmaa/<provider>/<id>` branches (while accepting legacy `swarma/<provider>/<id>` branches on recovery), and never push.
- **Credential isolation:** Keep service tokens (`COLLECTIVE_*` / `SWARMAA_*`) out of model subprocess environments and prompts.
- **Safe callbacks:** MCP event callbacks are metadata notifications. Bind OAuth subscriptions to their grant, recheck access, pin validated public IPs, preserve TLS host verification, sign exact bytes, and reject redirects.
- **Unverified completion:** `completed` means the provider returned a terminal success and the result was stored. The bridge records acceptance criteria as unverified (`acceptance_criteria_verified: false`); always review diffs and artifacts before merging.
- **Database safety:** Use parameterized SQL. Preserve migration checksums once a migration has been applied; add a new migration file for schema changes. Integration tests must use only an explicitly set disposable `TEST_DATABASE_URL` with random temporary schemas, never the production `DATABASE_URL` fallback.
- **Upstream vendor code:** `vendor/reason-network` is pinned upstream code under its own MIT/Apache-2.0 licenses. Do not execute its installers automatically.

## Validation Commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

For PostgreSQL integration tests (requires a disposable test database in `TEST_DATABASE_URL`):

```bash
node --env-file=.env.test --import tsx --test tests/*.integration.test.ts
```

See `docs/VALIDATION.md` for full end-to-end validation steps.
