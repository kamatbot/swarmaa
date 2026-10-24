# Enforced flows

Flows are tenant-owned, validated JSON definitions. Every step is a normal durable task with the existing routing, leases, slots, artifacts, task events and inbox notifications. Dependencies, provider separation and commit pins are enforced by the service. Model output cannot release a check or approval gate.

The built-ins in `flows/` are:

- `independent-review`: an independent review, a second review on a different provider of the same commit, then synthesis of both results. The second reviewer waits for the first to bind provider and commit, but receives no first-review findings in its objective. Synthesis receives bounded excerpts of both results.
- `verified-patch`: an isolated patch followed by the configured `tests_pass` command on its exact output commit.
- `patch-then-review`: a verified patch followed by the two independent reviews and synthesis, all pinned to the resulting commit.

Apply migration **021_flows.sql** through the existing migration procedure before running the updated service. Migration 020 is reserved by another task. This implementation does not incorporate `feat/relay-inspired-coordination`.

## Tools

`flow_list {}` lists built-ins and definitions saved in the caller's tenant (`task:read`). `flow_start` requires `task:submit` and `task:read`:

```json
{
  "flow": "patch-then-review",
  "scope": "project:demo",
  "inputs": {"objective": "Fix the bounded issue", "commit": "0123456789012345678901234567890123456789"},
  "idempotency_key": "demo-fix-1"
}
```

Use the real full 40- or 64-character Git commit hash. Moving names such as `main` are rejected for `inputs.commit`. A root patch may omit it and use the worker repository's HEAD; later steps bind to the bridge's observed patch commit. An unpinned read/research step requires `inputs.commit`.

Always supply the same `idempotency_key` when retrying a start. Changed inputs with the same key are rejected. Without a key, each call creates a new flow and returns its generated key. Return values include `flow.id` and tasks in definition order.

- `flow_get {"flow_id":"<uuid>"}` requires `task:read` and the exact scope. It returns the immutable definition/inputs and each step's normal task record. Status is derived from tasks: `queued`, `running`, `awaiting_approval`, `blocked`, `completed`, or explicitly `cancelled`. Blocked check tasks contain exit code, stop reason, duration and a bounded redacted output tail.
- `flow_cancel {"flow_id":"<uuid>"}` requires `task:cancel` and `task:read`. It cancels pending/running steps, fences leases, closes approval notices and preserves completed evidence. Repetition is safe.
- `flow_approve {"flow_id":"<uuid>","step_id":"approve","approve":true}` requires the bound owner identity, admin role, `task:cancel` and `task:read`. `false` rejects and blocks the flow. Decisions are immutable; exact retries return the original decision. Ordinary frontends, workers and other admins cannot approve on the owner's behalf.

Flow steps cannot be reopened with `task_continue`: changing a completed prerequisite would invalidate downstream evidence. Diagnose the blocked step and start a new flow. Task cancellation and lease exhaustion also block downstream activation. A failed check cannot be converted to completion by an answer claiming tests passed.

## Definitions and approvals

An owner can supply a JSON definition as `flow` in `flow_start`. It is validated and stored under `(tenant, id)` in the same transaction as the run. Authorized frontends can subsequently start it by ID. Saved definitions and built-ins are immutable; use another ID for a revision. There are 1–20 distinct steps and no dependency cycles.

```json
{
  "id": "approved-patch",
  "title": "Owner-approved patch",
  "steps": [
    {"id":"approval","kind":"approve","objective":"Approve this proposed local patch: {{objective}}","needs":[]},
    {"id":"patch","kind":"patch","capability":"auto.patch","objective":"{{objective}}","needs":["approval"]},
    {"id":"tests","kind":"check","objective":"Run configured tests.","needs":["patch"],"pin":"patch","check":{"type":"tests_pass"}},
    {"id":"files","kind":"check","objective":"Check changed paths.","needs":["tests"],"pin":"patch","check":{"type":"files_within","globs":["src/**","tests/**"]}}
  ]
}
```

Step kinds are `research`, `review`, `patch`, `check`, `approve`. Model capabilities are `auto.read`, `auto.patch` or explicit `claude`/`codex`/`antigravity` read/patch capabilities matching the kind. `{"different_provider_than":"<step>"}` excludes that dependency's service-bound provider while retaining the owner's routing policy and quota rules. Only a provider advertised by the claiming worker can be selected.

`needs` lists prerequisite step IDs. `pin` names a dependency ancestor: use its output commit (patch) or observed commit (review/check/research). Checks must trace their pin to an upstream patch. `check` is accepted only for check steps; allowed types are `tests_pass`, `build_passes`, `diff_nonempty`, and `files_within` with relative, non-negated `globs`. Commands, paths, environment overrides and arbitrary check code are not definition fields.

Objectives accept `{{objective}}`, `{{inputs.name}}` (or `{{name}}`) and `{{steps.<dependency-id>.result}}`. Inputs are bounded strings; rendering never executes expressions. Dependency results remain untrusted excerpts and cannot expand authority.

A ready approval produces one `flow_approval` item in `src/core/inbox.ts` for the tenant's scoped admin named `owner`, or its sole scoped admin when no `owner` exists. Ambiguous or missing owners prevent start. The owner's inbox uses the existing durable notification trigger. The approval task's objective carries “Flow X needs your approval: …” for task/notch consumers; its `task.updated` event includes `approval_required: true` and flow/step IDs, keeping callbacks metadata-only. No native Mac application code is in this repository; actual notch rendering still needs a manual smoke check in that app.

## Owner-configured bridge checks

Checks require the worker's `task:patch` grant, project `allow_patch`, a patch-enabled agent and an explicit `projects[].checks` object in the bridge's local owner configuration. Existing configuration is unchanged unless the owner opts in. Example project entry:

```json
{
  "scope": "project:demo",
  "root": "/absolute/path/to/demo",
  "agents": ["codex"],
  "allow_patch": true,
  "checks": {
    "tests_pass": {"command":"/opt/homebrew/opt/node@24/bin/npm","args":["test"],"timeout_seconds":600},
    "build_passes": {"command":"/opt/homebrew/opt/node@24/bin/npm","args":["run","build"],"timeout_seconds":600}
  }
}
```

`checks: {}` enables the two Git-only checks. Missing test/build commands block the check with `check_not_configured`; there is no shell-command fallback. Executables must be absolute paths. Arguments are a bounded string array. Timeouts default to 600 seconds, are bounded to 1–7200 seconds, and are capped by the bridge task timeout. Output is bounded by the bridge process limit; overflow, nonzero exit, timeout, lease loss or source mutation cannot pass. Node commands use the owner's absolute Node 24 tooling and PATH starts with its versioned Homebrew directory.

The bridge dispatches `bridge.check` itself, without invoking a model. It reconstructs the patch commit in a separate isolated worktree in the same configured repository. Reviews likewise get isolated snapshots, never the user's moving working copy. Checks verify HEAD and tracked source before and after execution; generated untracked build files are allowed. Check snapshots are removed without committing their output. Existing provider environment and sandbox implementations remain unchanged; commands use the existing sandbox wrapper when the selected configured agent enables it. Check subprocesses get a small environment without service/provider tokens or shell startup overrides.

`diff_nonempty` compares committed patch output against its original base. `files_within` examines every changed path, including both sides of renames, with Node's native glob matcher. Checks cannot pick a new repository path from remote task input. Local patch commits must exist in the repository configured on the claiming bridge; no fetch, push or cross-host artifact transfer is introduced. A missing commit blocks instead of checking another revision.

The result includes `observed_commit`, `tests_run_by_bridge`, and a structured `check` fact (`type`, `commit`, `base_commit`, `passed`, `exit_code`, `stop_reason`, `duration_ms`, `output_tail`). The server validates successful evidence against its pin. The bridge is the trusted reporter; this is not cryptographic proof against a compromised worker. General model acceptance criteria remain unverified even when deterministic gates pass.
