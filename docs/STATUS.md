# Release status — 0.1.0

Swarmaa is an active local-first implementation covering the PostgreSQL core service, MCP/REST/OAuth/passkey transports, macOS worker bridges, local chat capture and lesson distillation, PTY idle-wake wrapper, native macOS and iOS companion apps, and an optional end-to-end relay. Schema migrations span `001` through `046` (`db/migrations/`), with unit tests (`npm test`), TypeScript typechecking (`npm run typecheck`), production build (`npm run build`), and disposable-database PostgreSQL integration tests (`npm run test:integration`).

## Delivered behavior

| Area | Status in repository | Notes |
|---|---|---|
| Memory | Implemented & tested | Scoped PostgreSQL records, revisions, competing proposals, source provenance, expiration, owner promotion (`memory_promote`) and live retraction (`memory_retract`) |
| Tasks & Routing | Implemented & tested | Scoped submission, continuations, idempotency, attempts, DB-clock lease fencing, heartbeats/checkpoints, resource locks, quota-aware `auto.read`/`auto.patch` routing, and usage cost accounting |
| Flows | Implemented & tested | Declarative step DAGs, provider separation (`different_provider_than`), commit pinning, owner-configured bridge checks (`tests_pass`, `build_passes`), and owner approval gates |
| Teams & Bots | Implemented & tested | Persistent agents, threads, channels, tracked swarms (`swarm_*`), structured questions/approvals, persistent bots (`bot_*` including archive/unarchive/delete, scheduling, routing floors, task cards, avatars/colors), and SSE live stream (`/api/stream`) |
| Inbox & Hooks | Implemented & tested | Scoped cross-session notifications (`message_send`, `inbox_get`, `inbox_poll`, `inbox_ack`, `task_watch`), POSIX dirty-flag `PostToolUse` fast-path guard, Claude/Codex/Antigravity inbox/memory/journal hooks, and `/swarm` command |
| Sessions & Lessons | Implemented & tested | Cross-harness chat journal (`session_record`, `session_list`, `session_get`), read-only local capture (`src/capture/` for Cursor, OpenCode, Copilot CLI, Cline, Roo Code, Devin CLI, Hermes, Factory, Pi), and lesson distillation/review (`lesson_*`) |
| MCP, OAuth & Passkeys | Implemented & tested | Stateless HTTP MCP and local single-process stdio proxy (`src/stdio-proxy.ts`), OAuth 2.1 S256 PKCE with dynamic registration and grant narrowing, and WebAuthn owner passkeys |
| Events & Webhooks | Implemented & tested | Transactional event outbox (`(xid, seq)` cursors), subscriptions, SSRF IP-pinned HMAC webhook delivery, and GitHub repo source intake (`POST /hooks/github/<id>`, `source_*`, `task_subscribe`) |
| Workers & Bridge | Implemented & tested | Claude Code, Codex CLI, and Antigravity (`agy` headless + ACP `src/bridge/acp.ts`) adapters; read-only by default, opt-in sandboxed git-worktree patches (`swarmaa/<provider>/<id>`, never pushed), Seatbelt credential isolation, and native transcript resume |
| PTY Wrapper | Implemented & tested | `swarmaa wrap codex|agy` (`src/wrap/`) preserves interactive terminals and delivers idle-composer inbox wakes |
| Native Apps & Relay | Implemented & tested | Native Swift macOS app (`Mac-app/`), iOS/iPadOS/watchOS companion (`iOS-app/`), shared Swift package (`Shared/`), voice/local actions (`src/local/`), APNs push registration (`push_*`), and Cloudflare Durable Object relay (`relay/`, `src/relay-agent.ts`) |
| Reason Network | Optional vendored snapshot | Pinned upstream source in `vendor/reason-network` for optional targeted notifications; never auto-installed |

## Architectural boundaries and deliberate scope

- **Local-first single-host default:** One local PostgreSQL 17 cluster and Node 24 service on your Mac is the default deployment (`npm run setup`). Multi-process task claims use per-scope database locks and accept up to 64 projects per claim; identities support up to 512 scopes. HTTP rate limits are per process.
- **Role and permission separation:** Default `frontend` identities (coding CLIs, Dot, Grok) receive core memory/task/event permissions (`memory:read`, `memory:write`, `task:read`, `task:submit`, `task:cancel`, `artifact:read`, `events:read`). Native Mac/iOS app capabilities (`agent:read`, `agent:manage`, `thread:read`, `thread:write`, `app:device`, `answer_questions`, `routing:manage`) are explicit grantable permissions provisioned for `swarmaa-mac` and paired phone connections.
- **Text artifacts:** Up to 256 KiB per artifact, stored in PostgreSQL. Memory search uses PostgreSQL full-text search (no external vector store required).
- **At-least-once work & unverified acceptance:** Leases fence service writes; they do not guarantee exactly-once external side effects. A `completed` task means the provider returned terminal success (`acceptance_criteria_verified: false`). Patch tasks run owner-configured `checks` before committing, commit locally to `swarmaa/<provider>/<id>`, and never push or merge automatically.
- **Antigravity workers:** Review and in-project edits only (no research tasks), always Seatbelt-sandboxed, with ACP (`agy acp --stdio`) support in `src/bridge/acp.ts`.
- **Hosted entrypoints need HTTPS:** Local loopback serves desktop CLIs and the Mac app. Dot, cloud Grok, and remote connectors require an HTTPS endpoint (e.g., `npm run tunnel` or Tailscale) with OAuth PKCE.
- **External account & hardware verification:** Live provider CLIs, OAuth redirects with third-party hosts, APNs push delivery, Apple EventKit/Speech permissions, and RetireOdds ledger calls still require local credentials and hardware validation on the target Mac/iPhone (see [VALIDATION.md](VALIDATION.md)).

## Source provenance

Reason Network snapshot: `https://github.com/reason-machines/reason-network`, commit `3e08ce1d4e538a5576f52cc06b62ca36c2360998`, upstream package `0.12.3` (MIT OR Apache-2.0). See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for all third-party attributions and licenses.
