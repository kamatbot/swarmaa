# Trust and execution boundaries

This document describes what the source enforces and where the operator remains responsible. These are design and source-review statements; they are not a claim of a completed runtime security audit.

## Identity and project authorization

Provisioned connection tokens are random and stored in PostgreSQL only as SHA-256 hashes. Each authenticates a stable principal with a tenant, role, exact project scopes and permissions. The core applies these checks regardless of REST, MCP or a direct internal call. An agent cannot choose another tenant or worker identity by passing an argument.

Admin credentials are kept out of model clients. OAuth refuses admin identities, uses an approved grant snapshot, and intersects that snapshot with current permissions on every request. A later privilege increase does not silently enlarge an existing authorization. Event subscriptions retain the OAuth grant that created/refreshed them and stop when that grant, principal or required scope is no longer valid.

The shared principal is a service identity, not proof of a particular human message inside a third-party app. In a multi-person Bot, anyone who can use that connection may have its scoped service authority. Use separate identities and narrower scopes when conversation audiences differ.

## Memory as evidence

Memory content, proposed changes, task objectives, source files, provider output and event metadata are data. No field authorizes a shell command, credential access, publication or broader project scope. The source reference records what the writer claims; it does not independently authenticate an external document or human quote.

Decisions, preferences and procedures are proposed until the owner promotes them. Optimistic version checks preserve competing proposals instead of silently replacing a reviewed head. Notes and observations can be active while explicitly remaining agent-reported. Retraction has defined live-database limits; avoid putting credentials into shared memory at all.

## Tasks and the filesystem

The database serializes task changes, authenticates lease ownership and generation, uses database time, and rejects expired/fenced writes. Task execution is at least once. A completion receipt is idempotent only for the same run/result. Transport acknowledgement and provider exit alone are not acceptance verification.

Resource keys coordinate known shared resources; callers must use a consistent key. They do not prove that different keys refer to different files. The Mac bridge's static project registry prevents task text from selecting a directory or binary. Workers run up to their configured slots, and PostgreSQL serializes claims per stable worker identity across all projects before counting current, unexpired leases. Patch tasks use separate local worktrees and branches. Cancellation and lease-loss logic reduce overlap but cannot physically fence a paused host or undo an external action.

Every autonomous provider invocation requires macOS `sandbox-exec`; startup fails before claiming if it is unavailable, and `sandbox:false` is rejected. The Seatbelt profile starts with `deny default`, grants project reads, private scratch and enumerated provider/runtime access, and permits project writes only in a patch worktree. Shared Git metadata stays read-only to the provider. Explicit service-token paths, `.env` files, `.local` state and common credential/config paths are excluded. The trusted parent prepares worktrees and commits patches. Pinned read snapshots disable Git hooks, fsmonitor and configured checkout filters; they do not fetch dependencies, LFS objects, submodules or remotes.

Claude uses an explicit tool list, `dontAsk`, and an empty strict MCP configuration. Bash remains available within the outer filesystem boundary. Codex uses a private `CODEX_HOME` with provider authentication only, excluding interactive config/MCP state and other conversations. Codex and Antigravity currently retain CLI bypass flags inside the mandatory outer boundary; they are not a fallback to unconfined execution. Filesystem read-only mode is not a general classifier that can prohibit every computation or network side effect. Installed CLI compatibility and actual Seatbelt enforcement still require local macOS validation.

Provider environments contain an explicit runtime/provider-auth allowlist, excluding Swarmaa service credentials and arbitrary shell hooks or API endpoint overrides. Provider login itself is an intentional residual: Claude can read `.claude.json` (which may contain other configuration), provider credential refresh files remain accessible, and allowed macOS Keychain RPC services are not scoped to individual secrets. Antigravity requires shared provider state; native Codex refresh reconciliation is not an atomic credential broker. Use a dedicated OS account with only the intended provider login for stronger isolation. Keep unrelated credentials out of exposed projects and runtime installation directories.

The bridge reports process observations and static capabilities with their source. It cannot observe model reasoning or prove a CLI supports every declared option without installed-version validation. Process-group termination covers descendants that remain in that group; a descendant that creates a new session can outlive the timer while retaining the inherited filesystem sandbox. A missing native transcript is reported as missing, not as a successful resume capability.

## Workflows, messages and handoffs

The fixed `independent_review_v1` workflow atomically creates exactly three read tasks. Both reviewers and synthesis use detached snapshots of the same full commit SHA. Only synthesis receives bounded peer results/artifact excerpts, and cross-task worker messages to independent reviewers are refused. Owner/frontend context remains attributed data. There is no universal planner, majority-vote approval, or automatic promotion of peer findings into memory.

Deferred activation and managed task lease writes recheck the initiating principal, credential version, original authorization snapshot, scope and originating OAuth grant. Claims and renewals are clamped to the workflow/grant deadline. Cancellation fences all pending/running children; managed steps cannot independently continue or cancel. A completion with missing/mismatched commit provenance blocks the workflow. Provenance remains trusted-worker-reported evidence, not cryptographic proof that a model inspected the source.

Messages require task read plus frontend submission authority, or a worker's live same-scope source lease. A bounded batch is frozen per execution generation. Accepted, delivered, deferred and failed describe messaging only. Delivered records process-boundary input evidence; it does not prove model consumption, truth, acceptance or execution success. Later messages wait for another explicitly authorized invocation. A crash/lost receipt can cause redelivery. Message content never replaces task constraints or expands grants.

Handoffs are consistent read-only database snapshots with current memory status/version references, artifact hashes, source identity and transcript coverage. Recorded sessions retain only their latest window, up to 40 turns; missing history is unknown. Workflow execution status and the owner verdict are separate fields, and only an admin-role connection can approve a completed synthesis.

## Network and callbacks

The HTTP service validates public Host and any supplied Origin, bounds bodies and concurrency, and does not trust forwarded headers for identity. Put public deployment behind HTTPS, private database networking and appropriate proxy controls.

Callback allowlists are exact DNS hostnames. Every outbound attempt resolves and rejects non-public addresses, pins a validated IP for the TCP connection, keeps the original hostname for TLS certificate validation and refuses redirects. This prevents a later DNS resolution from redirecting the connection to an internal address. A public allowlisted receiver can still see the metadata you intentionally send it; allowlisting is not end-to-end confidentiality from that receiver.

MCP callbacks require a signed, one-use challenge and Standard Webhooks HMAC over exact body bytes, event ID and signing timestamp. Secrets are encrypted with authenticated encryption and bound to the subscription ID. Generic sinks are owner-configured and use the receiver's supplied authentication headers; they are a distinct mode with no implied MCP challenge support.

The optional Relay notifier is an owner-configured outbound integration, distinct from public webhook callbacks. It requires an explicit self-hosted origin, a pre-provisioned agent token, an exact recipient and exact scopes. It sends identifiers/status only and never accepts inbound task authority. Disabled mode does not import the SDK or read credentials. No hosted default, workspace credential, automatic agent registration or SDK installation is used. An accepted Relay send is not recipient acknowledgement; an uncertain send retains the same event identity and cursor.

## Operational residuals

Provisioned tokens do not expire automatically; rotate/revoke them deliberately. OAuth families have finite lifetimes. HTTP rate limits are process-local and shared by clients behind the same proxy IP. The implementation provides neither user signup/MFA nor a full identity-provider integration. There is no automatic backup, restore, retention or key-ring service.

A compromised worker can write agent-reported content and results within its grants. Owner promotion and review reduce reliance on that content but do not certify it. Inspect artifacts and code before integrating changes. The service cannot undo actions already executed by a provider or another external system.
