# Relay-inspired coordination: handoff for Claude

## Review target

Branch: `feat/relay-inspired-coordination`.

Base: Swarmaa `6797fdd58c958154fcf0eec31537cd2b1a01ca17`.

Reference: [AgentWorkforce Relay](https://github.com/agentworkforce/relay/tree/c3a92d9c179972963756ebce3fcd106679302934), especially explicit agent capabilities, messaging receipts, workflow dependencies and observable lifecycle events. This branch implements those ideas within Swarmaa's existing PostgreSQL/CoreService model. It does not vendor Relay runtime code or replace durable task authority with a transport.

The user requested this implementation branch for Claude to review. Source and authored tests are provided; this work did not run installs, typechecks, tests, builds, migrations, services, provider CLIs, CI or a live Relay connection. No PR, merge or deployment is part of the change.

## What changed and why

| Area | Main files | Review intent |
|---|---|---|
| Worker filesystem and credentials | `src/bridge/{sandbox,adapters,config,native-session,capabilities,types}.ts`, `src/bridge.ts` | Replace the old permissive filesystem profile with mandatory confinement, provider-specific environment allowlists, private invocation scratch and a private Codex profile. Preserve truthful capability and native-artifact metadata. |
| Capacity and deadlines | `src/core/{tasks,routing,swarm}.ts`, `src/bridge/worker.ts` | Serialize claims per worker across scopes, count unexpired occupied slots, avoid routing to a full reporter, and make managed leases/local stop timers honor workflow/grant deadlines. |
| Fixed review workflow | `db/migrations/019_workflows.sql`, `src/core/{workflows,workflow-authorization,workflow-context}.ts`, `src/bridge/review-worktree.ts` | Create two independent pinned reviews and one dependent synthesis atomically. Recheck original authority, bound attempts/time, fence cancellation, and separate completion from owner verification. |
| Messages and handoffs | `db/migrations/020_collaboration.sql`, `src/core/{messages,handoffs,sessions}.ts`, `src/bridge/{worker,process}.ts` | Freeze next-invocation message batches, record observed delivery separately, and supply fresh handoffs with canonical provenance and honest capture coverage. |
| Transport/service integration | `src/core/{index,tools}.ts`, `src/server.ts` | Expose the same scoped tools through existing transports; add a bounded, restart-safe coordinator with graceful shutdown. |
| Optional Relay pilot | `src/relay/{transport,runner}.ts`, `config/relay.example.json`, `package.json` | Forward identifier/status hints through a separately installed, explicitly configured SDK. Keep it disabled by default and outside model execution. |

## Invariants to inspect first

1. **Authority stays in CoreService/PostgreSQL.** Every new tool checks tenant/scope/role/permission. The workflow's stored initiating snapshot is a ceiling, and current principal, credential version and original OAuth grant can revoke continued execution. No provider text chooses a binary, filesystem root, tenant or new permission envelope.
2. **Claim capacity is global to the worker identity.** The worker-capacity advisory lock precedes the task-scope lock. Occupancy counts live running leases across all scopes. A principal row share lock serializes capacity/disable updates with claim. Zero slots drains while current work can finish.
3. **One source snapshot per workflow.** Each read attempt gets a fresh detached worktree for a full SHA. Worktree creation disables hooks, fsmonitor and configured checkout filters; the owner's repository/configuration remains trusted. All three recorded `base_commit` values must match. No fetch, dependency seeding or mutation of the user's checkout occurs in read preparation.
4. **Dependencies cannot be bypassed.** Synthesis is queued but unactivated and filtered before the claim limit. Only synthesis gets upstream answers/artifact excerpts. Workers cannot send cross-task messages into independent reviewers. Managed children cannot independently continue/cancel, and cancellation fences the run's pending/running children.
5. **Lease time is database time.** Managed claim/renewal expiry is the minimum of requested lease, workflow deadline and original grant expiry. The worker uses the returned remaining window with its monotonic request-start clock. All existing stale-generation write checks remain in force.
6. **Receipts are precise.** Input delivery requires observed spawn plus stdin flush, or argv supply. Provider success is not used to infer delivery. Exact receipt retries cannot change delivered to deferred after an ambiguous response. Message acceptance/delivery never finishes, resumes or approves work.
7. **Completion remains unverified.** The fixed workflow requires an explicit admin-role owner verdict. Peer agreement does not promote memory, merge a branch or satisfy acceptance by itself. Pin provenance is still reported by a trusted worker, not a cryptographic proof of model inspection.
8. **Bounded views remain honest.** Synthesis excerpts, timeline metadata, messages and handoff arrays have explicit bounds/truncation signals. Session storage is the latest recorded window, not a complete archive. Cursor comparisons retain PostgreSQL timestamp precision.

## Deliberate limits and compatibility changes

- Every autonomous provider now requires macOS `sandbox-exec` and `sandbox:true`. Configurations that previously disabled it fail closed before claims. Read workers can use Bash within the filesystem boundary; read-only filesystem policy does not prohibit every computation or outbound network effect.
- Claude uses explicit built-ins, `dontAsk` and strict empty MCP settings. Codex and Antigravity still use CLI bypass flags inside the mandatory outer Seatbelt profile. Exact installed flag support and provider state writes have not been exercised here.
- Provider login remains accessible. Claude's readable `.claude.json` can contain other config/secrets, allowed Keychain services are not restricted to individual secrets, and Antigravity needs shared provider state. A dedicated worker OS account is the stronger isolation boundary. Outbound networking remains allowed.
- Codex receives authentication-only private state. Keychain-only/custom-provider configurations and token formats without stable account identity may require explicit operator setup. Native artifact/auth export rejects links/FIFOs and bounds actual reads/traversal, but refresh reconciliation is not an atomic credential broker. A bridge crash can leave owner-only temporary state.
- Process-group termination covers descendants that remain in the group. A process creating another session may evade the timer while retaining the filesystem sandbox. Capabilities report process exit as observed or unavailable rather than always exact.
- Quota storage remains one last reporter per provider/tenant. Capacity is enforced per stable worker identity, not per provider account or a new fleet scheduler. Explicit reviewer selection follows routing-policy order; it does not dynamically switch provider for quota headroom.
- Workflows have exactly three read tasks. There is no arbitrary DAG, live PTY injection, pause/fork runtime, automatic decomposition or consensus vote. Lease-expired work may retry within budget; explicit failed/blocked child results stop the run. A new review uses a new workflow.
- Relay is an outgoing notification pilot only. It requires a separately installed compatible `@agent-relay/sdk/messaging`, explicit self-hosted origin, pre-provisioned agent token, one recipient and exact scopes. It has no hosted fallback or inbound execution authority. Unknown send outcomes retain cursor/idempotency, with unresolved SDK work bounded.

## Authored test coverage

| Test source | Scenarios to evaluate locally |
|---|---|
| `tests/workflows.integration.test.ts` | Atomic/idempotent submit; budgets; original grant/credential narrowing; workflow/task cancellation races; deadline clamps; restart after valid completion; dependency gates; starvation behind waiting synthesis; pin mismatch; owner verdict; scoped/bounded synthesis evidence; precise pagination/timeline. |
| `tests/collaboration.integration.test.ts` | Scoped provenance, message idempotency, frozen boundaries, late/deferred messages, stale leases, batch bounds, independent review guard, handoff freshness/identity and capture coverage. |
| `tests/worker-capacity.integration.test.ts` | Concurrent claims across projects, separate identities, multi-slot release, zero-slot drain/renewal and expired leases in another scope. |
| `tests/bridge-worker.test.ts`, `tests/bridge-process.test.ts` | Receipt evidence vs provider result, ambiguous exact retry, spawn/pipe/abort paths, workflow lease windows and cleanup ordering. |
| `tests/sandbox.test.ts`, `tests/bridge-capabilities.test.ts`, `tests/bridge-config.test.ts` | Mandatory confinement, provider environment, private scratch, static capability limits and macOS read/patch/credential enforcement. |
| `tests/native-session.test.ts` | Private Codex auth, bounded native artifacts, link/path protection, changed account rejection and intervening-login preservation. |
| `tests/review-worktree.test.ts` | Immutable snapshot despite a moved/dirty checkout, suppressed hooks/filters, absent commit failure and cleanup. |
| `tests/relay-transport.test.ts` | Disabled mode, explicit origins/credentials, identifier-only payloads, bounded uncertain sends, stable retry IDs and durable cursor behavior. |

Existing core, routing, swarm, passkey and bridge fixtures were updated where the new migrations, slot enforcement or confinement contracts change their setup. No test outcome is claimed.

## Local review and rollout sequence

Begin with source review of the authorization/lock order, dependency activation and worker filesystem policy. Then, once authorized under the repository's code-only workflow, perform TypeScript and unit validation and the integration suites against an explicitly disposable `TEST_DATABASE_URL` with isolated schemas. Never fall back to production `DATABASE_URL`.

On a supported Mac, verify installed Claude/Codex/Antigravity flags and authentication, denied project writes for read work, allowed patch writes only in its worktree, blocked service credentials and unrelated home files, private scratch cleanup, truthful delivery receipts, and interruption before managed deadlines. Inspect any CLI compatibility failure instead of adding a permissive fallback.

Apply additive migrations 019 and 020 before starting the upgraded server and worker fleet. Older workers cannot supply the new pinned-source provenance and do not consume message batches. Exercise a disposable two-reviewer run, cancellation, server restart and the owner's unverified/approved distinction before using the workflow for real work. Enable the Relay notifier only after reviewing its local configuration and compatible SDK; it is not a prerequisite for the core features.

Tests and builds were not run. Local Codex should validate the changes before integration. Claude can review this branch and perform the documented validation once authorized.
