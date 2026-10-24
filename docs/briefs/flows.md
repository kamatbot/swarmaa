# Brief: flows, enforced multi-step workflows with gates

**Repo:** `~/Projects/swarma`.
**Borrowed from:** AgentWorkforce Relay's flows (Apache-2.0), cloned at `~/Projects/research/relay`. See `flows/verify`, `flows/ci`, `flows/audit` and `flows/diagnose`, and its README "Flows" section. Ideas only unless attributed.

**Prior attempt:** branch `feat/relay-inspired-coordination` (commit `c4b2809`) tried a fixed two-reviews-plus-synthesis workflow. **Do not merge that branch.** It doesn't compile, its sandbox breaks every worker, and it strips the workers' config. You may read its `src/core/workflows.ts` and `tests/workflows.integration.test.ts` for ideas such as pinned commits, dependency activation and cancellation fencing. Rewrite on current `main`.

## Goal

Some rules matter too much to leave to a prompt: "two independent reviews before merging", "a patch only counts when the tests pass", "a human approves before X". A flow is a small declarative definition the **service** enforces, not the agents.

## Do this

1. **The flow definition.** JSON, validated, stored per tenant. Built-in flows ship in `flows/` in the repo. Shape:
   - `id`, `title`;
   - `steps[]`, each with:
     - `id`;
     - `kind`: `research` | `review` | `patch` | `check` | `approve`;
     - `capability`: for example `auto.read`, or "a different provider than step X";
     - `objective` template;
     - `needs[]`: dependency step ids;
     - `pin`: run against the same commit as the step named here;
     - `check`, for `check` steps only: one of the allowed checks.
2. **Checks are deterministic and run by a worker inside the patch worktree, never by the model:**
   - `tests_pass`: runs the project's configured test command, for example `npm test`, with a timeout;
   - `build_passes`;
   - `diff_nonempty`;
   - `files_within` (glob list).

   A check result is a fact recorded by the bridge (exit code, tail of output), not model text.
3. **`approve` steps** create a pending item in the owner's inbox and the notch: "Flow X needs your approval: …". Approve or reject through a `flow_approve` tool restricted to the owner's identity.
4. **Built-in flows:**
   - `independent-review`: two `review` steps on different providers, pinned to the same commit, then a `review` synthesis that needs both.
   - `verified-patch`: a `patch` step, then `check: tests_pass` on its branch. The flow completes only if the check passes; otherwise it is `blocked` with the check output.
   - `patch-then-review`: `verified-patch`, then `independent-review` of the resulting branch.
5. **Tools:** `flow_list`, `flow_start {flow, scope, inputs}`, `flow_get`, `flow_cancel`, `flow_approve`.
   - Each step becomes a normal task, so routing, slots, quota, notifications and the notch all keep working.
   - The flow's status is derived from its tasks.
6. **Tests:**
   - dependency activation, so a step can't be claimed before its `needs` complete;
   - different-provider enforcement;
   - same-commit pinning;
   - a failing check blocks the flow;
   - cancellation stops pending steps;
   - only the owner can approve;
   - tenant isolation.

## Rules

- Same Rules section as `docs/briefs/agent-notifications.md`.
- Keep workers' current configuration and environment exactly as they are. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`. The owner decided to keep workers on their own config.
- Next free migration number.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
