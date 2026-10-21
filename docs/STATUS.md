# Release status — 0.1.0 source handoff

Prepared 2026-10-21. This is an authored implementation, with source inspection and cross-component review. No dependency installation, typecheck, test, build, migration, service, provider CLI or real account connection was executed during authoring. There is no generated package lockfile and no compiled distribution in the ZIP.

## Delivered behavior

| Area | Present in source | Still requires local verification/setup |
|---|---|---|
| Memory | PostgreSQL records/revisions/proposals, source provenance, explicit conflict responses, expiration, owner promotion and live retraction | Migrations and concurrency/authorization suite |
| Tasks | Scoped submission, continuation, idempotency, attempts, leases, heartbeat/checkpoint, resource coordination and completion receipts | PostgreSQL races and worker interruption scenarios |
| Artifacts | Bounded UTF-8 text, hashes, task/run provenance, scoped retrieval | Storage limits and client display |
| MCP | Legacy and modern request framing, tool discovery/calls, stdio proxy | Actual installed client interoperability |
| OAuth | Public clients, dynamic registration, S256 PKCE, browser consent, token hashes, refresh replay revocation, grant narrowing | Actual Dot/Grok/Claude callback registration and browser flow |
| Events | Persistent subscriptions/deliveries, callback challenge, HMAC signatures, retries, expiry, OAuth grant binding and polling | Public HTTPS receiver lifecycle and vendor event delivery |
| Workers | Claude/Codex read-only adapters, restricted Claude file-patch mode, bounded processes, static project mapping | Installed CLI versions, account login, permission enforcement and actual tasks |
| Antigravity | MCP config and manual task workflow | User-supervised execution in the app; no autonomous adapter |
| Reason | Optional targeted notifications and vendored upstream source | Local upstream install, pairing and live peer sessions |

## Deliberate scope of this release

- **Explicit shared memory:** the server stores records agents publish through tools. It does not import hidden vendor memories or entire chat histories automatically.
- **Small private network:** one service/database is the intended starting deployment. Multi-process task claims use database locks, but the source has not been load-tested. HTTP rate limits are per process. Event polling uses a brief global table read barrier to avoid sequence cursors skipping transactions that commit out of order.
- **Text artifacts:** up to 256 KiB per artifact, stored in PostgreSQL. The earlier design's object-storage adapter and semantic/vector retrieval are not included. Memory search uses PostgreSQL text search.
- **At-least-once work:** leases fence service writes. They do not guarantee exactly-once external effects or stop an already-issued action. Keep unattended work read-only initially.
- **Provider result vs acceptance:** a successful provider terminal response is recorded as task completion, with acceptance criteria explicitly unverified. Human or subsequent agent review remains necessary before integration.
- **No automatic task decomposition/consensus:** entrypoints choose work, can submit multiple bounded tasks and can compare their results. The service is not a universal autonomous planner, voting engine or all-to-all agent conversation loop.
- **No unattended Antigravity:** the supplied configuration shares memory and tasks interactively. The bridge rejects an autonomous Antigravity provider entry.
- **No general shell patch runner:** the opt-in Claude patch adapter exposes file tools. The other worker adapters remain read-only. Builds, installs, tests, Git writes and deployments are not task capabilities in this MVP.
- **Hosted entrypoints need HTTPS:** local loopback works for local clients. Dot and a cloud Grok connection require an accessible HTTPS endpoint and account-specific connection setup.
- **Grok callbacks are generic:** an owner can configure a receiver and its documented auth headers. The bundle does not assume the exact webhook authentication schema or claim a tested Grok routine connection.
- **Reason is optional:** its peer channel improves notifications; the companion service owns durable memory/tasks. The vendored public source does not include Reason's hosted account/relay backend.
- **Operations remain owner work:** choose deployment hosting, monitor usage, manage backups/retention, perform dependency/security review and test restores. There is no signup system, MFA, billing, dashboard or automatic fleet administration.

## Source provenance

Reason Network snapshot: `https://github.com/reason-machines/reason-network`, commit `3e08ce1d4e538a5576f52cc06b62ca36c2360998`, upstream package `0.12.3`. The snapshot includes the original licenses and NOTICE. Git metadata and upstream GitHub automation files are omitted from the source bundle. No remote fork, branch, commit, PR or deployment was created by this work.

The original HTML architecture report is included for context. The current implementation replaces the planned object store with bounded PostgreSQL text artifacts and defers provider modes that could not be restricted reliably. Treat the source and this status file as the release description.

Tests and builds were not run. Local Codex should validate the changes before integration. Claude Code can perform the same documented local validation once the user authorizes it.
