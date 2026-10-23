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

Resource keys coordinate known shared resources; callers must use a consistent key. They do not prove that different keys refer to different files. The Mac bridge's static project registry prevents task text from selecting a directory or binary. It runs one process at a time per bridge and uses a per-project patch lock for local file mutation. Cancellation and lease-loss logic reduce overlap, but cannot provide absolute filesystem fencing across a paused host, a sleeping machine or an uncooperative runner.

Read-only defaults use provider restrictions. Claude's allowed tool set excludes shells and external MCP; Codex runs under its read-only sandbox configuration. The bridge rejects unsupported provider modes. These settings must be verified against the installed CLIs and managed policy. A read-only sandbox can still read sensitive files accessible to its OS account. The service does not isolate the user's home directory or create a separate OS account.

Use a dedicated worker account or isolated worktree with the least filesystem access it needs. Keep `.env`, connection tokens, Keychain privileges and provider credentials outside the project directory exposed to a worker. The parent process removes the Swarmaa service token and unrelated environment entries from model subprocesses, but an agent that can read arbitrary files available to its OS account may still find secrets stored there.

## Network and callbacks

The HTTP service validates public Host and any supplied Origin, bounds bodies and concurrency, and does not trust forwarded headers for identity. Put public deployment behind HTTPS, private database networking and appropriate proxy controls.

Callback allowlists are exact DNS hostnames. Every outbound attempt resolves and rejects non-public addresses, pins a validated IP for the TCP connection, keeps the original hostname for TLS certificate validation and refuses redirects. This prevents a later DNS resolution from redirecting the connection to an internal address. A public allowlisted receiver can still see the metadata you intentionally send it; allowlisting is not end-to-end confidentiality from that receiver.

MCP callbacks require a signed, one-use challenge and Standard Webhooks HMAC over exact body bytes, event ID and signing timestamp. Secrets are encrypted with authenticated encryption and bound to the subscription ID. Generic sinks are owner-configured and use the receiver's supplied authentication headers; they are a distinct mode with no implied MCP challenge support.

## Operational residuals

Provisioned tokens do not expire automatically; rotate/revoke them deliberately. OAuth families have finite lifetimes. HTTP rate limits are process-local and shared by clients behind the same proxy IP. The implementation provides neither user signup/MFA nor a full identity-provider integration. There is no automatic backup, restore, retention or key-ring service.

A compromised worker can write agent-reported content and results within its grants. Owner promotion and review reduce reliance on that content but do not certify it. Inspect artifacts and code before integrating changes. The service cannot undo actions already executed by a provider or another external system.
