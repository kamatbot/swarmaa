# Core API and consistency contract

This is the shared contract used by the REST tools, MCP tools and local stdio proxy. Every call enters `CoreService` in `src/core/index.ts`; permission and tenant/scope checks are performed there and in the database queries. A transport cannot grant itself a wider scope by placing a tenant, worker identity or permission field in a request.

**Validation status:** the implementation and integration-test source were authored and statically reviewed. No dependency installation, build, type check, database migration, server or test was executed during this source-only delivery. Run the validation steps in the handoff guide on a disposable database before connecting real projects.

## Calling tools

For a provisioned service bearer token, send `POST /api/tools/TOOL_NAME` with a JSON object body and `Authorization: Bearer <connection-token>`. Success wraps the tool result as `{"result": ...}`. MCP exposes the same names and arguments through `tools/list` and `tools/call`; use the transport's negotiated protocol version and framing. OAuth access tokens are audience-bound to the MCP resource, so use a provisioned service token for REST workers.

All examples below show **tool arguments and unwrapped tool results**, without the REST `result` wrapper or MCP content envelope. Every tool rejects unknown argument names. Dates are ISO-8601 strings in JSON. UUIDs identify records; tenants and principals come from authentication. An exact scope looks like `project:demo`, with lowercase letters, digits and `: _ / . -`. Only an admin principal with a `*` scope can cross its granted scope list, and it still remains inside its tenant.

### Permissions

| Tool | Required permission | Additional condition |
| --- | --- | --- |
| `context_get`, `memory_search`, `memory_get` | `memory:read` | `context_get` also needs `task:read` when `task_id` is supplied |
| `memory_propose` | `memory:write` and `memory:read` | Exact authorized scope |
| `memory_promote`, `memory_retract` | `memory:moderate` and `memory:read` | Admin role; never a worker or frontend self-approval |
| `task_submit`, `task_continue` | `task:submit` and `task:read` | Exact authorized scope |
| `task_get`, `task_list` | `task:read` | Exact authorized scope |
| `task_claim` | `task:claim` and `task:read` | Worker role; patch claims additionally need `task:patch` |
| `task_heartbeat`, `task_checkpoint`, `task_finish` | `task:work` and `task:read` | Worker role and current owned lease; exact completion replay is the documented exception |
| `task_cancel` | `task:cancel` and `task:read` | Expected current task version |
| `artifact_put` | `artifact:write` | Worker role and current owned lease |
| `artifact_get` | `artifact:read` | Exact authorized scope |
| `events_poll` | `events:read` | Exact authorized scope; each event type also requires its resource's read permission |

The `admin` permission satisfies permission checks, but it does not turn an admin connection into a worker. Owner review and worker execution use separate identities. Default frontend and worker permissions do not include `memory:moderate` or `task:patch`. Capability strings route work; they are never permissions. Mutation tools that return a full memory/task also require that resource's read permission, preventing a custom write-only grant from exposing an existing record through a conflict or replay response.

## Memory

### Memory record

An unretracted `Memory` contains:

```ts
type Memory = {
  id: string;
  scope: string;
  kind: 'note' | 'observation' | 'preference' | 'decision' | 'procedure' | 'hypothesis';
  key: string;
  content: string;
  source: {
    type: 'user' | 'tool' | 'document' | 'agent';
    reference: string;
    observed_at: string | null;
    reported_by: string; // Authenticated principal UUID
    assurance: 'reported';
  };
  status: 'active' | 'proposed';
  version: number;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  authority: 'reported' | 'owner_reviewed';
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};
```

`source.type: "user"` means an agent reports a user source. It does not authenticate that source or convert the content into an execution permission. The server always records the submitting principal and `assurance: "reported"`. Owner review records a separate reviewer. The source and reviewer IDs provide provenance for another agent to cite or inspect.

The canonical identity is `(tenant, scope, key)`. Keys and kinds cannot be changed in place. Notes and observations start active as reports. Preferences, decisions, procedures and hypotheses start proposed; an owner must promote them before normal context retrieval includes them. A promoted directive remains protected: a worker's later change becomes a proposal rather than replacing the head.

### `memory_propose`

```json
{
  "scope": "project:demo",
  "kind": "decision",
  "key": "runtime-language",
  "content": "Use TypeScript for the shared service.",
  "source": {
    "type": "user",
    "reference": "conversation:planning-2026-10-21",
    "observed_at": "2026-10-21T12:00:00Z"
  }
}
```

Required: `scope`, `kind`, `key`, `content`, `source`. Optional: `expected_version`, `expires_at` (timestamp or `null`). A key is at most 240 characters; content is nonempty, at most 32,768 characters **and** 32 KiB in UTF-8. Source references are at most 2,048 characters. New records omit `expected_version`; updates should provide the version the caller read. Omitting expiry on an accepted update clears the previous expiry, so repeat it when you intend to retain it.

Result is always:

```ts
{ memory: Memory; proposal: Proposal | null; conflict: boolean }
```

A missing or stale expected version on an existing record saves a proposal with `status: "conflict"` and returns `conflict: true`. This is a successful tool response so the competing evidence and audit event commit. **Callers must inspect `conflict`** and must not assume the head changed. A matching update to a promoted directive saves a proposal with `status: "proposed"` and `conflict: false`; the head still does not change. A matching update to an unreviewed record, note or observation appends a revision and advances the head version.

A `Proposal` has `id`, `memory_id`, `expected_version` (possibly `null`), `observed_version`, `status`, `actor_id`, `created_at`, `resolved_at`, `resolved_by`, and, while unretracted, `content`, `source`, `expires_at`. Its status can be `proposed`, `conflict`, `accepted`, `superseded` or `retracted`. The current implementation preserves other pending proposals as conflicts after accepting one; it never silently discards competing text.

### `memory_search`

Arguments: `{scope, query?, kinds?, include_proposed?, limit?}`. `query` is nonempty and at most 512 characters. `kinds` is an array of up to six memory kinds. `limit` defaults to 20, maximum 50. `include_proposed` defaults to `false`.

Result: `{scope, memories: Memory[]}`. Retrieval uses PostgreSQL `simple` full-text token matching and ranks matching records, with recency as a secondary order. Omitting `query` lists recent records. This release has no embedding service or semantic similarity index. Scope and tenant predicates are part of the retrieval query. Expired and retracted records are excluded; proposed records require opt-in.

### `memory_get`

Arguments: `{memory_id, include_history?, proposal_limit?, history_limit?}`. `proposal_limit` defaults to 10 and permits 0–50; `history_limit` defaults to 10 and permits 0–100. History is retrieved only when `include_history: true`.

Result always contains `{memory, proposals, proposal_limit, proposals_has_more}`. With `include_history: true`, it additionally contains `{revisions, history_limit, history_has_more}`. Proposals are the most recent subset by creation time; revisions are the most recent subset by version. Each `has_more` flag reports whether older entries were omitted. A zero limit returns an empty array while still reporting whether entries exist. This release does not provide a history/proposal pagination cursor: increasing the limit expands the latest subset, and older records beyond the maxima require administrative database inspection.

Each revision has `version`, `content`, `source`, `status`, `expires_at`, `actor_id`, `created_at`. Expired records remain available for explicit historical inspection, although context/search omit them. Use smaller history/proposal limits for large records; a transport `response_too_large` error means the serialized result exceeded its response budget. Likewise reduce `task_list.limit` or `memory_search.limit` if a large list exceeds that budget.

Retracted records return a tombstone containing only `id`, `scope`, `status: "retracted"`, `version`, `created_at`, `updated_at`, `content: null` and `source: null`. `proposals` is empty, and requested `revisions` is empty; the corresponding limits remain in the result and both requested `has_more` flags are false. There is no key or old body in the tombstone response.

### `memory_promote`

Arguments: `{memory_id, expected_version, proposal_id?}`. Admin review is required. Omitting `proposal_id` promotes or reaffirms the current head; supplying it adopts that still-pending proposal, including a conflicting one. The owner must inspect the proposal before doing so. The head becomes active at the next version, and review identity/time are recorded. Result: `{memory, accepted_proposal_id: string | null}`. A changed head gives `version_conflict`; an already-resolved proposal gives `proposal_resolved`.

### `memory_retract`

Arguments: `{memory_id, expected_version}`. Admin review is required. Result: `{memory: Tombstone, cleared_task_references: number}` for a new retraction, or `{memory: Tombstone}` when the already-retracted current version is supplied.

The transaction blanks the live memory content and source, all revision content/source and all proposal content/source, clears expiry fields, and removes this UUID from structured task `context_refs` and `context_versions`. Affected tasks advance their semantic version. Subsequent memory/context reads cannot retrieve the removed memory body. The record's internal key remains as a deduplication tombstone, preventing accidental resurrection under the same key; the API hides that key after retraction.

This is a defined live-storage deletion boundary. It does **not** erase manually copied text in task objectives, instructions, checkpoints, run results, artifacts, external agent conversations, database WAL or backups. Those objects have independent retention and require a separate deletion process. Do not use this API as a claim of forensic or global erasure.

### `context_get`

Arguments: `{scope, task_id?, query?, limit?, include_proposed?}`. `limit` defaults to 12, maximum 20; `query` has the same 512-character limit as search. The task, if supplied, must be in the requested scope and requires `task:read` permission.

```ts
{
  scope: string;
  task: Task | null;                // Includes appended instructions and run metadata
  memories: ContextMemory[];
  conflicts: ProposalMetadata[];    // No proposal bodies in this packet
  generated_at: string;
  memory_content_limit: 20000;
  guidance: string;
}
```

Explicit task memory references are prioritized; other records match the query or recency. The same active/proposed and expiry rules apply to referenced records, so a reference never bypasses review or retraction. Each memory body is clipped to 2,000 JavaScript string characters and aggregate memory bodies to 20,000. Metadata and the bounded task object are additional to this body budget. `ContextMemory` adds `content_truncated`, `input_version` (the version captured at task submission, or `null`) and `changed_since_task`. Use `memory_get` when full text or proposed competing bodies are needed.

`conflicts` contains at most 50 pending proposal metadata records for the included memories. Retrieved text, instructions and peer results are evidence; they do not grant credentials, tools, scopes or external permissions. An original task's immutable constraints and permission envelope continue to apply.

## Durable tasks

### Task representation

All task results exclude lease-token hashes and submission idempotency hashes. Task views contain:

```ts
type Task = {
  id: string; scope: string;
  kind: 'research' | 'review' | 'patch';
  objective: string;
  constraints: string[];
  acceptance_criteria: string[];
  permission_envelope: {
    read_project: true;
    local_patch: boolean;
    external_side_effects: false;
    deploy: false; publish: false; send_messages: false;
    purchase: false; permission_changes: false;
  };
  required_capability: string;
  resource_key: string | null;
  context_refs: string[];
  context_versions: Record<string, number>;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  version: number;
  created_by: string;
  attempt_count: number;
  max_attempts: number;
  continuation_count: number;
  lease_generation: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  checkpoint: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  artifact_ids: string[];
  created_at: string; updated_at: string; completed_at: string | null;
  instructions?: Array<{id: string; instruction: string; actor_id: string; created_at: string}>;
  runs?: Array<{
    generation: number; worker_id: string;
    status: 'running' | 'completed' | 'failed' | 'blocked' | 'abandoned' | 'cancelled';
    artifact_ids: string[]; started_at: string; ended_at: string | null;
  }>;
};
```

`task_list` omits instructions and run arrays; the other task responses include them. Previous finished-run result bodies are retained in PostgreSQL for administrative inspection, while the tool view returns the latest task result and per-run artifact IDs. `checkpoint` is the latest saved progress, and persists through expiry/continuation. A continuation leaves previous result/artifact references visible until the next finish so agents can inspect prior evidence; the queued/running status identifies that the new run is not complete.

Task completion means a worker submitted an outcome. The core does not independently verify acceptance criteria, code quality or provider truthfulness. The included bridge reports `acceptance_criteria_verified: false` and `review_required: true` in its result.

### `task_submit`

```json
{
  "scope": "project:demo",
  "kind": "research",
  "objective": "Explain the repository's authentication flow and cite source files.",
  "constraints": ["Read only. Do not install dependencies or contact external services."],
  "acceptance_criteria": ["Identify trust boundaries and unresolved questions."],
  "required_capability": "claude.read",
  "idempotency_key": "dot-auth-review-2026-10-21-01"
}
```

Required: `scope`, `kind`, `objective`, `required_capability`, `idempotency_key`. Optional: `resource_key`, `constraints`, `acceptance_criteria`, `context_refs`, `max_attempts`. Objective is at most 16,000 characters and 32 KiB UTF-8. Constraints/criteria each allow 30 strings of 1,000 characters. Context refs allow 32 UUIDs, all in the same tenant/scope and unretracted; their current versions are captured. Capability is at most 128 characters; idempotency key 200; resource key 240. Attempts default to 3, permitted range 1–10. New submissions and terminal-task continuations cannot exceed 1,000 queued/running/blocked tasks in one scope.

Patch work must include a stable resource key, for example `repo:demo-main-worktree`. It requests only local patch work. This API does not accept caller-defined permission envelopes or deploy/publish/payment/message task types. Worker configuration must still authorize the local project and adapter mode.

Result: `{task, replayed: boolean}`. The key is unique per tenant and submitting principal, across scopes. Identical normalized inputs return the original task; different inputs return `idempotency_conflict`. Use a shared task ID to continue work across Dot and Grok: their separate identities have separate submission key namespaces. The service cannot infer that two differently worded requests to different frontends are the same intention.

### `task_get` and `task_list`

`task_get({task_id})` returns `{task}`, including appended instructions and run metadata. IDs outside the principal's tenant/scopes return `not_found` rather than leaking a body before checking permission.

`task_list({scope, status?, limit?, before_id?})` returns `{tasks, next_before_id: string | null}`. Default limit 20, maximum 100. Sort is newest creation time then UUID. Pass the returned cursor as `before_id` for the next page; cursors must identify a task in that same scope. Listing is not a transactional snapshot across pages. Status filters can change as workers act, so clients should reconcile displayed tasks by ID.

### `task_claim`

Arguments: either `{scope, capabilities: string[], kinds?, lease_seconds?}` or `{projects: [{scope, capabilities: string[], kinds?}], lease_seconds?}`. Give exactly one form; `projects` contains 1–64 entries, tried in order until one task is claimed. All entries are validated before any claim; each visited scope keeps its own transaction and expired-lease sweep. Capabilities and patch opt-in apply only to their entry. Bridges split longer project lists into chunks of 64 and make one claim call per slot attempt per chunk. Identities can hold up to 512 scopes. At least one and at most 30 capability strings; kinds default to `['research','review']`. Patch requires both `kinds` opt-in and the provisioned `task:patch` permission. Leases default to 120 seconds, bounded 30–300 seconds.

If no eligible task exists: `{task: null}`. Otherwise:

```ts
{ task: Task; lease_token: string; lease_generation: number }
```

The token is random, returned only at claim, and stored only as a hash. Every mutation must use the authenticated claiming principal, token and generation. Never include lease tokens in memory, artifacts, event payloads or model prompts. Claiming another worker identity in arguments is not supported.

Claims serialize through a per-tenant/scope advisory lock and task row locks. Eligible work must match an advertised capability and allowed kind. Patch leases also reserve `(tenant, scope, resource_key)`, preventing two current patch leases on one resource. Configure the same canonical resource key everywhere that reaches the same workspace; different keys or scopes cannot protect an accidentally shared external directory.

Each claim sweep requeues expired running tasks and marks their runs abandoned. Attempts exhausted after expiry become failed with `result.error: 'attempts_exhausted'`; otherwise the next claim increments the attempt count and generation. A patch resource retains an old-generation tombstone for 30 seconds after the later of expiry or reclamation, allowing a cooperative local process time to stop. The task is queued during that cooldown; a later poll can claim it. Reclamation is driven by calls to `task_claim`, so a stopped fleet leaves expired work visible as running until a worker resumes polling. Results explicitly reported as failed/blocked are not automatically retried; an authorized continuation is needed.

### `task_heartbeat`

Arguments: `{task_id, lease_token, lease_generation, lease_seconds?}`. Result: `{task}`. Renewal uses the database clock after waiting for locks and must occur before expiry. It updates both task and resource expiry without changing the semantic task version or emitting a timer event. A renewal never revives an expired or cancelled lease.

### `task_checkpoint`

Arguments: `{task_id, lease_token, lease_generation, checkpoint: object}`. Checkpoint JSON is limited to 32 KiB and nesting depth 16. Result: `{task}`. Successful progress advances the task version and emits metadata. Save concrete evidence, phase and next steps; do not copy credentials or claim new authority in checkpoints.

### `task_finish`

Arguments: `{task_id, lease_token, lease_generation, outcome, result: object, artifact_ids?}`. Outcome is `completed`, `failed` or `blocked`. Result JSON is at most 64 KiB, nesting depth 16; artifact IDs are at most 32 and must belong to this same task **and execution generation**.

Result: `{task, replayed: boolean}`. A valid finish stores the outcome/result, closes the run, clears the task lease, releases its resource and emits `task.updated`. Repeating the same outcome/result/artifact set with the same run credentials returns `replayed: true`. Changing any of them gives `completion_conflict`. A late replay after a continuation returns the task's **current** state without completing or overwriting the new run. A previously uncommitted finish from an expired/reassigned run always gives `lease_lost`.

This provides idempotent delivery to the coordinator, not exactly-once external execution. A worker can crash after local side effects but before recording them. External systems do not honor these database fences automatically; workers must stop on lease loss, isolate workspaces, and verify previous partial effects before resuming. The service never claims that cancellation undoes an effect already issued.

### `task_continue`

Arguments: `{task_id, expected_version, instruction, idempotency_key}`. Instruction is nonempty, at most 16,000 characters and 32 KiB UTF-8. Result: `{task, replayed: boolean}`.

A continuation appends an attributed instruction, requeues work, clears expired execution ownership, advances generation/version, and resets the configured bounded attempt budget. It preserves scope, kind, objective, required capability, resource key, constraints, acceptance criteria and permission envelope. To change those, submit a new bounded task. At most 20 continuations are allowed on one task.

An unexpired running task gives `task_running`; wait or explicitly cancel before continuing. A non-running or expired task can be continued, including a cancelled task. Repeating the same `(task, principal, idempotency_key)` with the same expected version and instruction returns the current task without appending again. Retain the original arguments when retrying an ambiguous request.

### `task_cancel`

Arguments: `{task_id, expected_version}`. Result: `{task}`. Cancellation advances the task version and lease generation and clears lease ownership immediately. A running patch retains its old resource reservation until the later of its original expiry or cancellation time, plus a 30-second stop grace. New or continued patch tasks on that resource wait for this cooldown. Other resources are released. This reduces overlap while a cooperative worker observes cancellation; it cannot physically fence a suspended or uncooperative process on another machine.

Checkpoints/results remain as historical evidence. A stale expected version gives `version_conflict`; read the new task before deciding again. Workers with the old lease cannot renew, save a checkpoint, create artifacts or finish. A repeat using the current cancelled version is a no-op.

## Artifacts

`artifact_put({task_id, lease_token, lease_generation, name, content, media_type?})` requires a live worker lease. `name` is a plain filename of at most 120 characters, beginning with an ASCII letter or digit and then letters, digits, spaces, `.`, `_`, `-`. Path separators and `..` are rejected. Content is UTF-8 text without NUL, at most 256 KiB. Allowed media types are `text/plain` (default), `text/markdown`, `application/json`, `text/x-diff` and `application/x-patch`; the server records the label without claiming to validate its syntax. A task may store at most 128 artifacts across all attempts.

Result: `{artifact: ArtifactMetadata, replayed: boolean}`. Reusing a name within the same execution with identical content and media type returns the existing object. Different content gives `artifact_conflict`. Retry before the lease expires; artifact creation is not permitted after finish. Names can be reused in a later execution generation, producing a distinct artifact.

`artifact_get({artifact_id})` returns `{artifact: ArtifactMetadata & {content: string}}` after scope authorization. Metadata fields are `id`, `task_id`, `scope`, `run_generation`, `created_by`, `name`, `media_type`, `byte_length`, `sha256`, `created_at`. SHA-256 covers the stored UTF-8 text bytes. The server accepts no filesystem path, executable artifact or arbitrary object-store URL. Larger/binary storage requires a separate adapter.

## Events and reconciliation

`events_poll({scope, after?, limit?})` returns:

```ts
{
  scope: string;
  events: Array<{
    id: string;
    cursor: string;
    scope: string;
    name: 'task.updated' | 'memory.changed';
    subject_id: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
  next_cursor: string;
  has_more: boolean;
}
```

`after` defaults to `'0.0'`. Each event's `cursor` and `next_cursor` are opaque `'<xid>.<seq>'` decimal strings (up to 40 characters: unsigned 64-bit XID, dot, nonnegative signed bigint sequence). Pass them unchanged; never convert them to a JavaScript `number` or compare them lexicographically. Limit defaults to 50, maximum 100. Persist a cursor **per tenant/principal/scope stream** after processing the returned events. An empty page retains a pair cursor. `memory.changed` additionally requires `memory:read`; `task.updated` requires `task:read`. A principal with only `events:read` receives an empty page. If permissions expand and historical catch-up is needed, restart at `'0.0'` and deduplicate already-seen event IDs.

Read task/memory state after a notification; an event is an invalidation hint and provenance trail, never an authority grant. Payloads contain identifiers, status/version and action metadata, without memory bodies, objective text, artifacts or lease secrets.

Event writes commit in the same transaction as the state change. Polls only return rows with `xid < pg_snapshot_xmin(pg_current_snapshot())`, ordered by `(xid, seq)` and resumed with `(xid, seq) > (cursor_xid, cursor_seq)`. Transactions below that snapshot boundary have finished, and future transactions cannot acquire an XID below it. XID and sequence allocation order can differ, so a sequence-only resume is unsafe even with this filter. Polls do not wait for uncommitted inserts or take a table read barrier; a long-running transaction can delay visibility until a later poll. Producers must use the database defaults for XID and sequence.

Legacy numeric `after: 'N'` remains accepted (up to 19 digits, at most 9223372036854775807). It filters `seq > N` for that call, still ordered by `(xid, seq)`, then upgrades `next_cursor` to the pair format. If that page is empty, polling captures xmin before reading and returns `'<xmin>.0'`, immediately before any event in the oldest pending transaction; a principal without resource read permissions receives `'0.0'`. On subsequent pair polls, historical events with `seq <= N` but a greater XID may reappear: deduplicate event IDs during migration. Use `'0.0'` for a complete catch-up if an old cursor may already have skipped data.

Callback delivery uses stable event IDs separately; callbacks can be duplicated, so consumers should deduplicate IDs and reconcile authoritative records.

## Errors, limits and operational boundaries

| Code | Meaning / response |
| --- | --- |
| `forbidden`, `worker_required`, `owner_required` | The provisioned principal lacks the required permission or role; task text cannot override it |
| `scope_forbidden`, `not_found` | Unauthorized explicit scope or no visible object in the permitted tenant/scopes |
| `invalid_arguments`, `invalid_context_refs`, `invalid_artifacts` | Correct the typed/bounded input or referenced object provenance |
| `version_conflict` | Read the current object and reconsider the requested change |
| `idempotency_conflict`, `completion_conflict`, `artifact_conflict` | A retry identifier was reused with different inputs |
| `lease_lost` | Stop execution; do not replay writes under an expired/cancelled/reassigned lease |
| `task_running` | A continuation cannot replace currently leased work |
| `memory_retracted`, `kind_immutable`, `proposal_resolved` | The requested memory transition is not allowed |
| `queue_full`, `continuation_limit`, `artifact_limit`, `artifact_too_large` | The configured fixed bound has been reached |

The supplied schema and runtime are application-level authorization, not a database RLS security boundary. A PostgreSQL superuser or someone holding the service database credential can bypass the API. Keep that credential with the coordinator, never with agent clients. Use separate provisioned connection tokens and exact project scopes.

Queues/resources serialize per scope; memory uses optimistic versions and row/advisory locks. These choices prioritize inspectable correctness for a small network over very high throughput. There are no embeddings, automatic semantic deduplication, arbitrary DAG workflows, billing/quotas per model, automatic deployments, cross-instance local filesystem fencing, or global backup erasure in this release.

The written integration suite covers authorization before retrieval, concurrent memory conflicts, review/retraction, bounded context, concurrent idempotent submissions, lease races/expiry/retry exhaustion, resource exclusion, artifact integrity, continuation/completion replay, cancellation and out-of-order event commits. It is in `tests/core.integration.test.ts`, skips without an explicit `TEST_DATABASE_URL`, creates a unique test schema, and removes only that generated schema. It has not been executed as part of this handoff.
