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
| `message_send` | `memory:write` | Shared exact scope; `task:read` also required for task references |
| `inbox_get`, `inbox_poll`, `inbox_ack` | `events:read` | Own principal/session; task items additionally require `task:read` |
| `task_watch` | `task:read` and `events:read` | Scoped task and own session |
| `events_poll` | `events:read` | Exact authorized scope; each event type also requires its resource's read permission |
| `agent_create`, `agent_update`, `agent_archive` | `agent:manage` and `agent:read` | Exact authorized scope |
| `agent_get`, `agent_list` | `agent:read` | Exact authorized scope |
| `bot_create`, `bot_update`, `bot_archive` | `agent:manage` and `agent:read` | Exact authorized scope |
| `bot_get`, `bot_list` | `agent:read` | Exact authorized scope |
| `thread_post` | `thread:write` and `thread:read` | Exact authorized scope |
| `thread_read`, `thread_attachment_get`, `thread_mark_read`, `thread_list` | `thread:read` | Exact authorized scope |

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

`task_list` omits instructions and run arrays, drops `checkpoint.partial_output` and `checkpoint.partial_text`, clips `objective` to 300 characters, and retains only `answer` (clipped to 500 characters), `branch`, `changed_files`, `served`, `failure`, `check`, `summary` and `review_required` from `result`. `task_get` and other detail responses retain full objectives, checkpoints and results, plus instructions and run arrays. Previous finished-run result bodies are retained in PostgreSQL for administrative inspection, while the tool view returns the latest task result and per-run artifact IDs. `checkpoint` is the latest saved progress, and persists through expiry/continuation. A continuation leaves previous result/artifact references visible until the next finish so agents can inspect prior evidence; the queued/running status identifies that the new run is not complete.

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

`task_get({task_id, session?})` returns `{task}`, including appended instructions and run metadata. It marks related inbox items read for the caller in that session (the principal stream when omitted), if the caller also has `events:read`. Other sessions remain independent. IDs outside the principal's tenant/scopes return `not_found` rather than leaking a body before checking permission.

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

Result: `{task, replayed: boolean}`. A completed `turn` with a non-empty string `result.delegate.objective` posts its reply as usual and queues one follow-up turn for the same agent/thread through the existing pending-message path, in the same transaction. The objective is redacted and clipped to 500 characters. The follow-up envelope carries `runner.model` (the agent runner model, otherwise `DELEGATE_MODEL = "claude-opus-5-5"`) and `runner.delegated: true`. Delegated turns ignore further delegation requests. Pending human messages batch into this one follow-up; the service posts a system notice: "<agent> handed this to <model> for a fuller answer". Completion retries do not duplicate either the turn or notice.

A valid finish stores the outcome/result, closes the run, clears the task lease, releases its resource and emits `task.updated`. Repeating the same outcome/result/artifact set with the same run credentials returns `replayed: true`. Changing any of them gives `completion_conflict`. A late replay after a continuation returns the task's **current** state without completing or overwriting the new run. A previously uncommitted finish from an expired/reassigned run always gives `lease_lost`.

This provides idempotent delivery to the coordinator, not exactly-once external execution. A worker can crash after local side effects but before recording them. External systems do not honor these database fences automatically; workers must stop on lease loss, isolate workspaces, and verify previous partial effects before resuming. The service never claims that cancellation undoes an effect already issued.

### `task_continue`

Arguments: `{task_id, expected_version, instruction, idempotency_key}`. Instruction is nonempty, at most 16,000 characters and 32 KiB UTF-8. Result: `{task, replayed: boolean}`.

A continuation appends an attributed instruction, requeues work, clears expired execution ownership, advances generation/version, and resets the configured bounded attempt budget. It preserves scope, kind, objective, required capability, resource key, constraints, acceptance criteria and permission envelope. To change those, submit a new bounded task. At most 20 continuations are allowed on one task.

An unexpired running task gives `task_running`; wait or explicitly cancel before continuing. A non-running or expired task can be continued, including a cancelled task. Repeating the same `(task, principal, idempotency_key)` with the same expected version and instruction returns the current task without appending again. Retain the original arguments when retrying an ambiguous request.

### `task_cancel`

Arguments: `{task_id, expected_version}`. Result: `{task}`. Cancellation advances the task version and lease generation and clears lease ownership immediately. A running patch retains its old resource reservation until the later of its original expiry or cancellation time, plus a 30-second stop grace. New or continued patch tasks on that resource wait for this cooldown. Other resources are released. This reduces overlap while a cooperative worker observes cancellation; it cannot physically fence a suspended or uncooperative process on another machine.

Checkpoints/results remain as historical evidence. A stale expected version gives `version_conflict`; read the new task before deciding again. Workers with the old lease cannot renew, save a checkpoint, create artifacts or finish. A repeat using the current cancelled version is a no-op.

## Flows

`flow_list`, `flow_start`, `flow_get`, `flow_cancel`, and owner-only `flow_approve` enforce declarative task dependencies, provider separation, exact commit pins and deterministic/approval gates. Definitions are stored per tenant and each step remains a normal task. See [Flows](FLOWS.md) for schemas, built-ins, permissions, retry behavior and bridge check configuration.

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

`after` defaults to `'0.0'`. Each event's `cursor` and `next_cursor` are opaque `'<xid>.<seq>'` decimal strings (up to 40 characters: unsigned 64-bit XID, dot, nonnegative signed bigint sequence). Pass them unchanged; never convert them to a JavaScript `number` or compare them lexicographically. Limit defaults to 50, maximum 100. Persist a cursor **per tenant/principal/scope stream** after processing the returned events. An empty page retains a pair cursor. `memory.changed` additionally requires `memory:read`; `task.updated` requires `task:read`. Its payload always includes `kind` and includes `thread_id` when present. Submissions use `task.updated` with `action: "submitted"`; the corresponding `task.submitted` audit details also include these fields. There is no separate `task.submitted` event name in the current event schema. A principal with only `events:read` receives an empty page. If permissions expand and historical catch-up is needed, restart at `'0.0'` and deduplicate already-seen event IDs.

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

## Agent inbox (migrations 019–020)

`message_send({to, scope, body, task_id?})` sends up to 2,000 characters of untrusted data, redacted before storage.
`to` is a principal name in the same tenant and scope, `task:<uuid>` (the currently leased worker, otherwise
its submitter), `session:<claude|codex|agy>:<id>`, or `session:wrap:<codex|agy>:<uuid>`. A session must first register through `inbox_get`, `inbox_poll` or
`task_watch`; another principal cannot claim it. The recipient must have `events:read`, plus `task:read`
for task-related messages. A database-backed limit allows 30 messages per sender per minute, across
scopes and processes. Result: `{id, sent:true}`. Messages are not idempotent; do not blindly retry after an
uncertain response. Message content never grants permission to execute tools or expand task scope.

`task_watch({task_id, session})` registers a session, idempotently (at most 128 session watchers per task).
Session keys are `claude:<id>`, `codex:<id>`, or `agy:<id>`; IDs contain letters, digits, underscores or hyphens
(up to 200 characters). Terminal wrappers use `wrap:codex:<uuid>` or `wrap:agy:<uuid>` instead; ownership and permissions are identical.
Task submitters always have a principal-level watch. Completed, failed, blocked,
cancelled and exhausted-lease transitions write one `task_finished` item per watcher in the task transaction.
Completion replays do not duplicate items. Late watches receive the current terminal version; a continued
execution produces a new item on its next terminal transition. Summaries are redacted and bounded, with
`task_get <uuid>` pointing to the full result. Revoked recipient scopes/permissions are checked again.

`inbox_get({after?, limit?, session?, delivery_id?})` returns `{items, guidance}`. Without a delivery ID,
this is an explicit agent read: unread items become `read` before the response. Accepted items return metadata
only, since their body has already been injected. `limit` defaults to 4, maximum 50. Items include the original
item `id`, stable `delivery_id`, kind, scope, task ID, source principal, timestamps, receipt `state`, `offers`,
and `stuck`. No session selects the principal stream; a session includes principal-wide items and that session's
items. Each session has independent receipts. `after` is a previously returned item UUID for chronological
filtering, not a durable change cursor; omit it to drain pending items, including late commits.

`inbox_poll({after?, limit?, session?, delivery_id?})` is the hook transport. It reserves `offered` receipts
in the database transaction **before** returning bodies. An offer has a 30-second confirmation deadline.
Expired offers are visible as `unconfirmed` even without another poll; a new poll materializes expiry and
may offer them again, with the same delivery ID. There are at most three offers total (initial plus two retries).
An exhausted unconfirmed receipt is `stuck`. Accepted/read items are never re-offered to that stream.
Migration 020 backfills old `delivered_at` records as unconfirmed, not accepted; the old delivery did not prove
output success or identify which session consumed a principal-wide item.

With `delivery_id`, both get and poll perform an exact **read-only, metadata-only lookup**, including after
expiry or acceptance. Only `delivery_id` and `session` are allowed in this form. They do not bind sessions,
expire stored rows, update timestamps/counters, or send a body. A fresh poll without an ID is the explicit
request to drain/re-offer; an exact retry is never that request.

`inbox_ack({delivery_id, session?, state?})` confirms that the hook printed injection output and its output process
exited 0, or that the waiter printed its wake output and exited 2. It changes an existing offered/unconfirmed
receipt to `accepted`. Repeated acknowledgments of an accepted/read receipt are read-only lookups. The caller
cannot acknowledge an unknown delivery, another principal/tenant's receipt, or a different session's receipt.
`state` defaults to `accepted`. A PTY wrapper sends `accepted` only after harness activity or an observed
draft followed by a cleared composer. It sends `state: "unconfirmed"` after uncertain delivery, a write failure,
an unproven prompt or human cancellation. This clears the offer deadline without marking acceptance or read.
Repeating the same state is read-only; accepted/read receipts cannot be downgraded. No schema migration is needed.
Acceptance proves transport output, not that a model read it. `inbox_get` or `task_get` with the session is the
separate `read` signal. A lost explicit agent-read response stays read; automatic retries belong to the hook
transport, where uncertain delivery is represented honestly.

`swarm_status` includes `inbox: {counts, items}` for the caller's permitted receipts. Counts are `offered`,
`accepted`, `unconfirmed`, `read`, and `stuck`; items are at most 50 metadata records, stuck first. No inbox
body appears in dashboard/notch status. Generic terminal-task sinks include only `inbox_receipts` counts for
the subscriber's receipts for that task, never bodies, session IDs, or per-item details. Neither surface grants
access to another principal's inbox. Existing MCP event callbacks remain metadata-only invalidation hints.

`GET /api/inbox/wait?session=claude:<id>&timeout=25` uses the same service bearer token as REST tools,
returns `{result:{items,guidance}}`, and reserves offers using `inbox_poll`. Timeout is an integer 0–25 seconds;
an empty timeout response is 200. A shared PostgreSQL `LISTEN/NOTIFY` connection wakes outstanding requests
on committed inserts, without a polling sleep loop. Each read reauthenticates the token and checks current
grants. Disconnects cancel the wait; limits are four waiters per principal and 32 per HTTP handler. Expired
offers become eligible on the next read (including at the long-poll deadline).

The design uses the write-ahead reservation and exact-retry ideas described in AgentWorkforce Relay's
`crates/broker/src/native_delivery.rs` and `docs/harnesses/pty-delivery.md`; no Relay code was adapted.

## Teams phase 1: Agents, threads, turns and stream (migration 024)

Persistent agents, conversation threads, turn execution, read cursors and real-time SSE streaming provide the collaborative service foundation specified in [TEAMS.md](TEAMS.md).

### Permissions

- `agent:manage`: Create, update and archive agents. Granted to `owner` and `frontend` roles.
- `agent:read`: Read agent profiles, statuses and lists. Granted to `owner`, `frontend`, and default roles.
- `thread:write`: Post messages to threads (queuing turns for agent threads). Granted to `owner` and `frontend` roles.
- `thread:read`: Read thread messages, message history, thread listings, and update read cursors. Granted to `owner`, `frontend`, and default roles.

### Tools

#### `agent_create`
- **Permissions:** `agent:manage` and `agent:read`
- **Input:**
  - `name` (string, 1-80 chars)
  - `role` (string, 1-80 chars)
  - `instructions` (string, 1-8,192 chars)
  - `scope` (valid scope string, e.g. `project:demo`)
  - `runner` (object: `{mode: 'auto'}` or `{provider: 'claude'|'codex'|'antigravity'|'grok', model?: string, effort?: string}`)
  - `edits` (boolean): whether turn tasks allow patch execution
  - `avatar` (optional string, 1-64 chars)
  - `idempotency_key` (string, 1-128 chars)
- **Output:** `{ agent, thread }`. Creates the agent record and its primary `agent_main` thread. Emits an `agent.updated` event.

#### `agent_update`
- **Permissions:** `agent:manage` and `agent:read`
- **Input:**
  - `agent_id` (UUID)
  - `expected_version` (integer)
  - `name`?, `role`?, `instructions`?, `runner`?, `edits`?, `avatar`?
- **Output:** `{ agent }`. Updates the agent record and increments its version. If `runner` changes, keeps the existing thread and automatically posts a `notice` message to the agent's main thread (e.g. `Atlas now runs on Codex`), and emits an `agent.updated` event.

#### `agent_get`
- **Permissions:** `agent:read`
- **Input:** `{ agent_id }`
- **Output:** `{ agent }` including computed `status` (`'idle'`, `'working'`, `'waiting_on_you'`, or `'offline'`) and `unread_count` for the calling principal.

#### `agent_list`
- **Permissions:** `agent:read`
- **Input:** `{ scope?, include_archived?, after?, limit? }`
- **Output:** `{ agents: AgentView[], guidance }`. Lists agents ordered by creation time, with each agent's current runtime status and unread message count based on `thread_reads`.

#### `agent_archive`
- **Permissions:** `agent:manage` and `agent:read`
- **Input:** `{ agent_id }`
- **Output:** `{ agent }`. Sets `archived_at`. Archived agents retain their existing threads as read-only history.

#### `thread_post`
- **Permissions:** `thread:write` and `thread:read`
- **Input:**
  - `thread_id` (UUID)
  - `body` (string, up to 16,384 UTF-8 bytes, run through secret redaction; may be empty with photos)
  - `idempotency_key` (string, 1-200 chars)
  - `reply_to?` (message UUID)
  - `attachments?` (up to two `{name, media_type: "image/jpeg", data_base64}` objects). Each JPEG must be canonical base64, at most 160 KiB decoded and at most 2048 pixels per side. Native apps normalize orientation, strip source metadata and resize to at most 1600 pixels before sending. The existing 512 KiB HTTP request limit still applies.
- **Output:** `{ message }`. Inserts the message with the next sequential `seq` in the thread under an advisory lock. Emits a `message.created` event.
  - When posted by a human caller to an `agent_main` thread, automatically queues a `turn` task for the agent.
  - The turn task's `scope` is the agent's scope, `required_capability` is derived from runner configuration (`auto.read`, `auto.patch`, `<provider>.read`, or `<provider>.patch`), and `resource_key` is `agent:<id>`.
  - If a turn task is already queued or currently running for the agent, additional messages batch into a follow-up turn upon task completion.
  - Retrying an identical caption, ordered photo content/names and reply reference with the same key returns the original message. Changed content returns `idempotency_conflict`.
  - Message views include `attachments: [{id, name, media_type, byte_length, sha256}]`; image bytes are excluded from message views and events. Photos live with their message in PostgreSQL. Authorized task claims include the newest two photo payloads in the bounded thread context; older photos remain metadata only.

#### `thread_attachment_get`
- **Permissions:** `thread:read`, exact thread tenant and scope.
- **Input:** `thread_id`, `message_id`, `attachment_id` (UUIDs).
- **Output:** `{attachment: {id, name, media_type, byte_length, sha256, data_base64}}` for that message's photo. Mismatched or inaccessible references return `not_found`. There are no public image URLs or arbitrary filesystem paths.

#### `thread_read`
- **Permissions:** `thread:read`
- **Input:**
  - `thread_id` (UUID)
  - `after_seq`? (integer): fetch messages with `seq > after_seq` (oldest first)
  - `before_seq`? (integer): fetch messages with `seq < before_seq` (newest first, reversed to chronological order)
  - `limit`? (integer 1-100, default 50)
- With neither cursor, returns the newest `limit` messages in ascending sequence order; `has_more` indicates older messages. `before_seq` takes precedence when both cursors are supplied.
- **Output:** `{ thread_id, messages: MessageView[], has_more, typing: [{task_id, agent_id, text, updated_at}] }`. `typing` contains only running `turn` tasks in this thread with non-empty string `checkpoint.partial_text`; `text` passes through `redactSecrets` before retaining its last 4000 characters, and `updated_at` is an ISO timestamp. It is independent of message pagination and is empty when no task is typing. Raw `partial_output` is never included. Bodies and non-photo references are unchanged; photos expose only attachment metadata. Question messages embed `question: {id, prompt, options, multi, free_text, status, swarm_step_id, created_at, answer: {choices, text} | null}`; answer messages embed `answer: {question_id, choices, text}`. Swarm messages embed the `swarm_get` swarm object, including steps and progress, when the caller has `task:read`. Card references are restricted to the thread's tenant and scope; unavailable references are omitted. Cards are fetched in batches.

#### `thread_mark_read`
- **Permissions:** `thread:read`
- **Input:**
  - `thread_id` (UUID)
  - `seq` (integer): read cursor position
- **Output:** `{ read_cursor: { thread_id, principal_id, last_read_seq, updated_at } }`.
  - Updates the caller's read cursor (advancing forward only). Emits a `thread.read` event.

#### `thread_list`
- **Permissions:** `thread:read`
- **Input:** `{ agent_id?, kind?, include_archived?, after?, limit? }`
- **Output:** `{ threads: ThreadView[] }`.

#### `channel_create`
- **Permissions:** `agent:manage`
- **Input:**
  - `name` (string, 1-64 characters)
  - `scope` (valid project scope)
  - `members` (array of agent UUIDs)
  - `lead_agent_id`? (agent UUID)
- **Output:** `{ channel: ThreadView }`. Creates a shared channel thread with specified agent members and optional lead agent.

#### `channel_update`
- **Permissions:** `agent:manage`
- **Input:**
  - `channel_id` (UUID)
  - `expected_version` (integer)
  - `name`? (string, 1-64 characters)
  - `members`? (array of agent UUIDs)
  - `lead_agent_id`? (agent UUID or null)
- **Output:** `{ channel: ThreadView }`. Optimistically updates channel settings and members.

#### `section_set`
- **Permissions:** `thread:read`
- **Input:**
  - `sections` (array of `{ id?, name, order_index?, items, collapsed? }`)
- **Output:** `{ sections: SectionView[] }`. Replaces caller's custom sidebar sections.

#### `section_list`
- **Permissions:** `thread:read`
- **Input:** `{}`
- **Output:** `{ sections: SectionView[] }`. Returns caller's custom sidebar sections in display order.

### Swarms and Steps

#### `swarm_start`
- **Permissions:** `task:submit`
- **Input:**
  - `title` (string, 1-200 characters)
  - `goal` (string, up to 16,384 characters)
  - `scope` (valid project scope)
  - `thread_id` (UUID)
  - `steps` (array of `{ key, title, assignee_agent_id, needs?, instructions?, check? }`)
  - `owner_agent_id`? (agent UUID)
  - `idempotency_key`? (string)
- **Output:** `{ swarm: SwarmView, replayed: boolean }`. Validates step graph (DAG, no cycles, assignees in scope), creates persistent swarm, starts unblocked steps as turns, posts swarm card message, and logs handoffs.

#### `swarm_update`
- **Permissions:** `task:submit`
- **Input:**
  - `swarm_id` (UUID)
  - `expected_version`? (integer)
  - `ops` (array of atomic update operations):
    - `add_step`: `{ op: 'add_step', step: { key, title, assignee_agent_id, needs?, instructions?, check? } }`
    - `reassign`: `{ op: 'reassign', step_id, assignee_agent_id }`
    - `retry`: `{ op: 'retry', step_id }`
    - `cancel_step`: `{ op: 'cancel_step', step_id }`
    - `edit`: `{ op: 'edit', title?, goal? }`
    - `close`: `{ op: 'close' }`
- **Output:** `{ swarm: SwarmView }`. Applies operations atomically under transaction, adjusts derived status, updates version, and emits `swarm.updated`.

#### `swarm_get`
- **Permissions:** `task:read`
- **Input:** `{ swarm_id: UUID }`
- **Output:** `{ swarm: SwarmView }`. Returns swarm status, steps, assignee agents, task states, and progress `{ done, total }`.

#### `swarm_list`
- **Permissions:** `task:read`
- **Input:**
  - `scope`? (string)
  - `status`? (`all`, `open` [default: planning, running, waiting_on_you, blocked], or specific status)
  - `after`? (UUID)
  - `limit`? (integer 1-100, default 50)
- **Output:** `{ swarms: SwarmView[], has_more: boolean, next_cursor: string | null }`.

#### `swarm_cancel`
- **Permissions:** `task:submit`
- **Input:**
  - `swarm_id` (UUID)
  - `expected_version`? (integer)
- **Output:** `{ swarm: SwarmView }`. Cancels all active and pending step tasks with cancellation fencing, marks steps and swarm cancelled.

### Questions

#### `question_answer`
- **Permissions:** `thread:write` and `answer_questions` (owner only). Admin identities have it; grant it to the owner's own frontend with `npm run admin -- grant --name <identity> --permission answer_questions`. Identities named `grok` or `dot` are always refused (`403 owner_required`).
- **Input:**
  - `question_id` (UUID)
  - `choices`? (array of strings matching question options)
  - `text`? (string, up to 16,384 characters)
  - `idempotency_key`? (string)
- **Output:** `{ question: QuestionView, replayed: boolean }`. Closes open question, resumes waiting swarm step if linked, posts `answer` message, and queues agent's follow-up turn. A question whose step is not `waiting_on_you` (for example a cancelled step) returns `409 step_not_waiting`; a question past `expires_at` (database clock) returns `400 question_expired`.

#### `question_list`
- **Permissions:** `thread:read`
- **Input:**
  - `status`? (`open` [default], `answered`, `expired`, or `all`)
  - `after`? (UUID)
  - `limit`? (integer 1-100, default 50)
- **Output:** `{ questions: QuestionView[], has_more: boolean, next_cursor: string | null }`. A read: due questions are expired by the lease sweep and by `question_answer`.

### Attention and Resolution

#### `attention_list`
- **Permissions:** `task:read` and `thread:read`
- **Input:**
  - `scope`? (string)
  - `after`? (string)
  - `limit`? (integer 1-100, default 50)
- **Output:** `{ items: AttentionItem[], has_more: boolean, next_cursor: string | null }`.
  - Aggregates actionable items needing owner review (sorted newest first):
    - Open questions (`Needs input · answer the question`).
    - Completed review-required patch/turn tasks not yet resolved (`Ready for review · branch ...`).
    - Failed tasks not yet resolved (`Failed · <code> · retry`).
    - Blocked or waiting swarms.

#### `task_resolve`
- **Permissions:** `answer_questions` (admins included), in the task scope; Grok and Dot are refused by name.
- **Input:**
  - `task_id` (UUID)
  - `resolved` (boolean)
  - `expected_version` (integer)
- **Output:** `{ task: TaskView }`. Sets or clears `resolved_at` timestamp on task, removing or restoring it in `attention_list`. Running or queued tasks return 409 `task_active`.

### Updated Task Filters

#### `task_list`
Supports additional query filters:
- `resolved`? (boolean): filter by whether `resolved_at` is set or null.
- `initiator_kind`? (`person` | `handoff` | `swarm` | `answer` | `flow`).

### Turn Execution and Turn Actions Block

Agent turns do not use a separate MCP server in worker CLIs. Instead:
- At the end of its response, the agent may include **one** fenced block:
  ````
  ```swarmaa-actions
  [
    { "type": "handoff", "to_agent": "<agent_id>", "body": "...", "swarm_step_id": "<uuid>" }
  ]
  ```
  ````
- The actions array supports up to 10 actions:
  - `handoff`: `{ type: 'handoff', to_agent: UUID, body: string, swarm_step_id?: UUID }`
  - `swarm_start`: `{ type: 'swarm_start', title: string, goal: string, steps: StepInput[] }`
  - `swarm_update`: `{ type: 'swarm_update', swarm_id: UUID, ops: SwarmOp[] }`
  - `question_ask`: `{ type: 'question_ask', prompt: string, options: string[], multi?: boolean, free_text?: boolean, swarm_step_id?: UUID, expires_in?: number }`
  - `channel_post`: `{ type: 'channel_post', channel_id: UUID, body: string }`
- **Turn grant enforcement:** In `task_finish`, the block is parsed, stripped from the message text, and validated against the agent's turn grant (only member channels, only same scope, only owned swarms or assigned steps). Valid actions apply atomically; invalid actions post a explanatory `notice` message.

### Live SSE stream: `GET /api/stream`

- **Endpoint:** `GET /api/stream?after=<cursor>&scopes=<scope1>,<scope2>`
- **Protocol:** Server-Sent Events (`text/event-stream`).
- **Authentication:** Standard service bearer token (`Authorization: Bearer <token>`).
- **Cursor ordering:** Uses durable `events` table ordering by `(xid, seq)`. The cursor format is `"<xid>.<seq>"`.
- **`after=now` support:** Passing `after=now` starts reading from the latest event in the database and immediately sends `event: cursor` with `{"cursor":"<current_cursor>"}`.
- **Event types:** `message.created`, `message.updated`, `thread.read`, `agent.updated`, `bot.updated`, `swarm.updated`, `question.created`, `question.answered`.
- **Payloads:** Metadata and IDs only (no message bodies or task results). Reconnecting with `after=<cursor>` resumes without event loss.
- **Heartbeat:** Sends `:keepalive` comment frames every 15 seconds. Uses TCP nodelay for low latency (< 1 s delivery).

Streams share one LISTEN connection per service pool. Transactional `swarmaa_events` notifications wake all streams; full batches drain immediately, with a 2 s safety poll and listener reconnection backoff. The durable xmin/cursor visibility rules are unchanged.

## Bot routing preview

`bot_routing_preview {bot_id}` requires `agent:read` and access to the bot's exact tenant and
scope. It returns `research`, `patch`, `review` and `summary`, each with
`{runner, provider_now, reason}`. `provider_now` is null when no provider can currently be
selected. `routingNow(db, tenantId, botRow)` supplies the same shape for `bot_get` integration.
A `different_from_author` preview has no edit author yet; the actual review excludes the
provider recorded on that edit's `result.served.provider`.

### How bot routing decides

Named runners retain their named provider and bypass the bot quota floor. Auto tasks use the
same live, fresh usage snapshots and priority ordering as the global router, with the bot's
`quota_floor_pct` applied to the most-used window. The bot floor only tightens the global
5-hour and weekly limits; bot tasks wait when no eligible provider remains, while other queued
tasks can still be claimed. A floor of zero allows 99% usage when the global limits are 100%.
Missing quota readings follow the existing router fallback only with a zero floor.

Completed bot edits with commit and branch provenance queue an idempotent review by default.
A different-author review uses `auto.read` and excludes the edit provider. If no different
provider is enabled, the thread receives a notice. `review_edits: false` disables this.
`require_tests: true` also queues a pinned `bridge.check` flow task using the owner's configured
`tests_pass` command, with the edit head and base commits. Bridge evidence is required for a
passing completion; the edit receives `result.check = {status: 'passed'|'failed', task_id}`.
Missing commit provenance produces a notice rather than an unpinned check. These follow-ups
carry `bot_id` and `initiator_kind: 'bot_check'`.

The service sweeps schedules every 30 seconds. Five-field cron supports `*`, lists, ranges and
steps; Sunday is 0 or 7. Restricted day-of-month and weekday fields use POSIX OR semantics.
`CRON_TZ=Area/City` selects an IANA time zone; the default is UTC. Evaluation follows real
minutes through DST (missing local minutes are skipped; repeated minutes can run twice).
A newly configured schedule first initializes `next_run_at`; a due schedule advances from
current database time, posts “Scheduled run” and queues one lead turn. Missed intervals are
coalesced. A busy lead skips the run and still advances. Scope and tenant Teams locks serialize
concurrent sweeps and task claims. No service restart is needed when changing a schedule.

B2 acceptance coverage (test names in `tests/bot-routing.integration.test.ts` unless noted):

| Brief item | Named tests |
|---|---|
| 1. Claim floor | `floor skips a low provider only for bot tasks and claim proceeds to next queued task`; `zero floor permits 99 percent use under global 100 limits and global limits still block`; `named runners bypass the bot floor while preserving enabled-kind policy` |
| 2. Reviews | `bot edit queues one review excluding author; completion replay is idempotent`; `review_edits false queues none and no different enabled reviewer posts a notice` |
| 3. Tests | `require_tests queues an idempotent pinned tests_pass check; pass lands on edit result.check`; corresponding `failure lands on edit result.check` case (also rejects invented passing evidence) |
| 4. Preview | `bot_routing_preview returns all kinds and enforces permission tenant and exact scope isolation`; unit `routingNow reasons cover named runner, floor, quota and different author` |
| 5. Schedule | `schedule tick initializes, posts and queues once under concurrent ticks, skips busy lead and advances`; unit `cron steps, ranges, lists and Sunday alias`, `cron day-of-month and weekday use POSIX OR for restricted fields`, `cron CRON_TZ honours local offsets and DST missing and repeated hours`, `cron rejects invalid fields, steps, ranges and time zones` |
| 6. API documentation | Preview shape and reason tests above match the documented response. |

Unit cases live in `tests/bot-routing.test.ts`, including `bot floor uses most-used window,
accepts exact floor and zero at 99, preserves global maxima`. Integration service fixtures
include migration 027 alongside its prerequisites. The isolated migration-020 backfill test
intentionally reconstructs its historical schema before applying migration 020.

## Bots: persistent, configured swarms (migrations 027–028)

A **bot** is a persistent, configured swarm that performs a designated job. A bot ties together:
- **a crew of agents:** one lead agent plus member agents;
- **one dedicated bot thread (`kind: 'bot'`),** which routes like a channel (addressed `@Member`, else lead) and records everything the bot executes;
- **its own routing and standing rules,** governing research, patch, review, and summary work across tasks created by the bot.

Tasks started by a bot propagate `tasks.bot_id`. When bot tasks finish review-ready (`completed` with `result.head_commit`) or `failed`, the service automatically posts a task card message (`kind: 'task'`) into the bot thread.

A bot's `starred` boolean is returned by create, update, get and list. At most one live bot per tenant can be starred, across all scopes (migration 028). Setting `starred: true` on create or update atomically clears the previous star and emits `bot.updated` for both bots; clearing the previous star also increments its version. The caller must have access to both scopes or the entire write fails. Setting `starred: false` clears the star; archiving also clears it. Create retries with the same idempotency key do not move the star again.

### Tools

#### `bot_create`
- **Permission:** `agent:manage` (response read requires `agent:read`)
- **Arguments:**
  - `name`: string (1..64)
  - `job`: string (<= 8192 UTF-8 bytes, standing brief)
  - `scope`: exact scope (e.g. `project:alpha`)
  - `lead_agent_id`: UUID
  - `member_agent_ids`: array of UUIDs
  - `routing` (optional): object mapping kinds (`research`, `patch`, `review`, `summary`) to runner configurations (`{mode:'auto'}` or `{provider, model?, effort?}`, with `review` also allowing `{mode:'different_from_author'}`)
  - `rules` (optional): object with `quota_floor_pct` (0..50, default 0), `approve_public` (boolean, default true), `review_edits` (boolean, default true), `require_tests` (boolean, default false)
  - `schedule` (optional): 5-field cron string, optionally prefixed with `CRON_TZ=<zone> `
  - `starred` (optional): boolean, default false
  - `avatar` (optional): string (<= 200)
  - `idempotency_key` (optional): string (<= 200)
- **Returns:** `{ bot, thread, replayed?: boolean }`. Creates the `kind: 'bot'` thread with members for lead and members. All crew agents must be live and in the bot's scope. Live bot names must be unique within a scope (returns 409 `name_taken`).

#### `bot_update`
- **Permission:** `agent:manage` (response read requires `agent:read`)
- **Arguments:**
  - `bot_id`: UUID
  - `expected_version`: integer (>= 1)
  - Any of: `name`, `job`, `avatar`, `lead_agent_id`, `member_agent_ids`, `routing`, `rules`, `schedule`, `starred`
- **Returns:** `{ bot }`. Optimistically versioned. A routing or crew change posts an explanatory `notice` message into the bot thread and emits `bot.updated`.

#### `bot_get`
- **Permission:** `agent:read`
- **Arguments:** `bot_id: UUID`
- **Returns:** `{ bot, crew, routing_now }`. `crew` lists agents with the lead agent first. Includes `badges` (`unread`, `needs_you`, `latest`).

#### `bot_list`
- **Permission:** `agent:read`
- **Arguments:** `scope?`, `include_archived?` (boolean), `after?` (UUID), `limit?` (1..100, default 50)
- **Returns:** `{ bots, has_more, next_cursor }`. Ordered with **updates first**: bots with `badges.needs_you > 0`, then `starred = true`, then `badges.unread > 0`, then by last activity. Uses a constant number of queries per page.

#### `bot_archive`
- **Permission:** `agent:manage` (response read requires `agent:read`)
- **Arguments:** `bot_id: UUID`
- **Returns:** `{ bot }`. Marks the bot archived, clears its star and cancels its queued tasks. The thread remains readable.

### Task cards: message kind `task`

When a bot task with `tasks.bot_id` completes with a `head_commit` (review-ready) or fails, the service atomically posts a message with `kind = 'task'` into the bot thread:
- **`ref`:** `{ "task_id": "<uuid>" }`
- **`author`:** `{ "kind": "system", "id": "service" }`
- **`body`:** A concise one-line summary, e.g. `"Forge finished the launch banner · swarmaa/claude/4f1e · 7 files"` or `"Failed · quota_exhausted on Codex"`.
- Never posts duplicate cards for the same task and outcome.

### Thread read embed: `task`

Calling `thread_read` on a bot thread automatically batches and embeds a `task` object on `kind: 'task'` messages:

```jsonc
{
  "id": "uuid",
  "title": "the launch banner",
  "kind": "patch",
  "status": "completed",
  "resolved": false,
  "branch": "swarmaa/claude/4f1e",
  "changed_files": 7,
  "served": { "provider": "claude", "model": "claude-opus-5-5" },
  "failure": null,
  "check": null
}
```

