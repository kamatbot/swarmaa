# Release status — 0.1.0

Coordination update prepared 2026-10-24 on `feat/relay-inspired-coordination`. This is an authored implementation, with source inspection and cross-component review. No dependency installation, typecheck, test, build, migration, service, provider CLI or live Relay connection was executed for this update. Existing dependency versions and the package lock are retained. See the [Claude review handoff](briefs/relay-inspired-coordination-review.md).

## Delivered behavior

| Area | Present in source | Still requires local verification/setup |
|---|---|---|
| Memory | PostgreSQL records/revisions/proposals, source provenance, explicit conflict responses, expiration, owner promotion and live retraction | Migrations and concurrency/authorization suite |
| Tasks | Scoped submission, continuation, idempotency, attempts, leases, heartbeat/checkpoint, resource coordination and completion receipts | PostgreSQL races and worker interruption scenarios |
| Capacity | Worker slot enforcement across projects, live-lease counts, free-capacity routing | Concurrent claim/drain/expiry scenarios |
| Review workflow | Two distinct reviewers and dependent synthesis of one pinned commit; original-authority checks, deadlines, cancellation and separate owner verdict | Migrations 019/020, dependency/restart/lease races and real pinned review runs |
| Collaboration | Durable task messages, frozen invocation batches and receipts; fresh handoffs with memory/artifact provenance | Delivery ambiguity, bounds, scope isolation and frontend use |
| Artifacts | Bounded UTF-8 text, hashes, task/run provenance, scoped retrieval | Storage limits and client display |
| MCP | Legacy and modern request framing, tool discovery/calls, stdio proxy | Actual installed client interoperability |
| OAuth | Public clients, dynamic registration, S256 PKCE, browser consent, token hashes, refresh replay revocation, grant narrowing | Actual Dot/Grok/Claude callback registration and browser flow |
| Events | Persistent subscriptions/deliveries, callback challenge, HMAC signatures, retries, expiry, OAuth grant binding and polling | Public HTTPS receiver lifecycle and vendor event delivery |
| Workers | Claude/Codex/Antigravity adapters (read by default; opt-in sandboxed git-worktree edits, local branches, never pushed), bounded processes, static project mapping | Installed CLI versions, account login, permission enforcement and actual tasks |
| Antigravity | MCP config; sandboxed worker for review and in-project edits (no research) | Installed CLI version and actual tasks |
| Reason | Optional targeted notifications and vendored upstream source | Local upstream install, pairing and live peer sessions |
| Relay | Disabled optional outbound status-hint adapter; explicit self-hosted origin, agent token, recipient and persisted event cursor | Separately installed compatible SDK/service and credential provisioning |

## Deliberate scope of this release

- **Explicit shared memory:** the server stores records agents publish through tools. It does not import hidden vendor memories or entire chat histories automatically.
- **Small private network:** one service/database is the intended starting deployment. Multi-process task claims use per-scope database locks and accept up to 64 projects per request; identities support 512 scopes. HTTP rate limits are per process. Event polling uses snapshot-xmin filtering and `(xid, seq)` cursors without a table read barrier. See [scale-hardening results](briefs/scale-hardening-results.md) for current validation and load evidence.
- **Text artifacts:** up to 256 KiB per artifact, stored in PostgreSQL. The earlier design's object-storage adapter and semantic/vector retrieval are not included. Memory search uses PostgreSQL text search.
- **At-least-once work:** leases fence service writes. They do not guarantee exactly-once external effects or stop an already-issued action. Keep unattended work read-only initially (setup's default); enable edits per install.
- **Provider result vs acceptance:** a successful provider terminal response is recorded as task completion, with acceptance criteria explicitly unverified. Human or subsequent agent review remains necessary before integration.
- **One bounded workflow template:** independent review creates exactly three read tasks. Entry points still choose the work; the service is not a universal planner, voting engine or all-to-all agent conversation loop. Provider agreement is unverified evidence.
- **Next-invocation messages:** there is no live PTY injection, pause/fork control, or hidden provider-memory transfer. Capture covers latest recorded windows, not full chat histories.
- **Antigravity workers:** review and in-project edits only, always inside the Seatbelt sandbox; no research tasks.
- **Edits are opt-in and local:** edit tasks run in sandboxed git worktrees with commands allowed, commit to `swarmaa/<provider>/<id>` and never push. Deployments and pushes are not task capabilities.
- **Hosted entrypoints need HTTPS:** local loopback works for local clients. Dot and a cloud Grok connection require an accessible HTTPS endpoint and account-specific connection setup.
- **Grok callbacks are generic:** an owner can configure a receiver and its documented auth headers. The bundle does not assume the exact webhook authentication schema or claim a tested Grok routine connection.
- **Reason is optional:** its peer channel improves notifications; the companion service owns durable memory/tasks. The vendored public source does not include Reason's hosted account/relay backend.
- **Operations remain owner work:** choose deployment hosting, monitor usage, manage backups/retention, perform dependency/security review and test restores. There is no signup system, MFA, billing, dashboard or automatic fleet administration.

## Source provenance

Reason Network snapshot: `https://github.com/reason-machines/reason-network`, commit `3e08ce1d4e538a5576f52cc06b62ca36c2360998`, upstream package `0.12.3`. The snapshot includes the original licenses and NOTICE. Git metadata and upstream GitHub automation files were omitted from the original source bundle.

The coordination update draws architectural lessons from [Relay](https://github.com/agentworkforce/relay) at `c3a92d9c179972963756ebce3fcd106679302934`. The optional notifier targets its reviewed messaging thin-client API. Relay source and runtime are not vendored or added as a mandatory dependency. The implementation branch is based on Swarmaa `6797fdd58c958154fcf0eec31537cd2b1a01ca17`.

The original HTML architecture report is included for context. The current implementation replaces the planned object store with bounded PostgreSQL text artifacts and defers provider modes that could not be restricted reliably. Treat the source and this status file as the release description.

Tests and builds were not run. Local Codex should validate the changes before integration. Claude Code can perform the same documented local validation once the user authorizes it.
