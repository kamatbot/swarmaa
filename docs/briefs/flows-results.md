# Flows implementation checkpoint and handoff

Task `da61938a-014b-42b6-921c-ea8bd19df063`. Baseline/rollback point `32bf1de24bc52c6320fec281e123dd5b540e587e`; branch `swarmaa/codex/da61938a`. Initially clean; all current tracked/untracked source changes belong to this task. HEAD and branch remain unchanged. Classification: critical local implementation (task authorization, lease fencing, deterministic command execution); no release authority.

Implemented: validated immutable per-tenant definitions, three built-in JSON flows, service-enforced dependency/provider/commit gates, task-derived status, owner-only approvals through the merged inbox, five `flow_*` tools, migration **021_flows.sql**, pinned review/check worktrees, four deterministic checks with static owner-configured commands, tests and setup/API documentation. Existing task leases, routing/quota, slots, artifacts and events are reused. Approval task objectives and metadata-only events feed existing notch/task consumers.

Owned surfaces: `flows/`, `src/core/{flow-definition,flows,tasks,index,tools,inbox}.ts`, `src/bridge/{checks,config,types,worker,worktree}.ts`, migration 021, `tsconfig.json` (copy built-in JSON into dist), new flow/bridge tests, migration lists in five existing integration fixtures, `docs/FLOWS.md`, API/setup links and this record. No new dependencies. `src/bridge/sandbox.ts`, all of `src/bridge/adapters.ts` (including `providerEnvironment`), and the rejected coordination branch remain untouched.

## Validation

Runtime: `/opt/homebrew/opt/node@24/bin` first in PATH; `node --version` = `v24.21.0`. The authorized `.env.test` was copied into this worktree without displaying it; integration tests used only `TEST_DATABASE_URL` and random temporary schemas. Git/provider fixtures use temporary homes/repositories.

- `timeout 120 npm run build`: exit 0, including the final source. Built `dist/src/core/flow-definition.js` successfully loads all three built-in JSON definitions from `dist/flows/`.
- `timeout 600 npm test`: `ℹ tests 332`, `ℹ pass 324`, `ℹ fail 1`, `ℹ skipped 7`. Sole failure: `tests/sandbox.test.ts:32`, “light profile: allow by default, deny only credential folders, enforced on a real process”; nested `sandbox-exec` returned 71 in the worker sandbox. The sandbox implementation and test were not changed. The seven integration suites require the explicitly loaded test environment and are exercised separately below.
- `timeout 400 node --env-file=.env.test --import tsx --test --test-concurrency=1 tests/*.integration.test.ts`: `ℹ tests 106`, `ℹ pass 106`, `ℹ fail 0`, `ℹ skipped 0`.
- Earlier default-parallel integration run: `ℹ pass 102`, `ℹ fail 3` (105 tests before the final approval regression was added). The three existing event cursor tests failed with empty pages during other suites' transactions. All three passed alone (`ℹ pass 3`, `ℹ fail 0`) and the complete suite passed serially. This is consistent with the database-wide PostgreSQL snapshot-xmin fence, which spans temporary schemas. No event implementation or event-test assertions were changed.
- Final affected check after refining deterministic-check attribution/summary: `timeout 120 node --env-file=.env.test --import tsx --test tests/flows.test.ts tests/bridge-flow.test.ts tests/flows.integration.test.ts tests/bridge-worker.test.ts`: `ℹ tests 42`, `ℹ pass 42`, `ℹ fail 0`, `ℹ skipped 0`. Full suites above precede only that reporting refinement; this focused run and final build cover it.
- `git diff --check`: clean. Protected-file diff check: exit 0 (unchanged).

Logs are under ignored `.local/flows-validation/`: `build-final.log`, `npm-test-final.log`, `integration-final.log`, `final-focused.log`, `integration.log` (initial parallel failure) and `event-focused.log`.

Acceptance evidence includes real Git worktrees and an actual failing Node command on the patch output commit, which blocks the flow without invoking a model. Tests cover all four checks, rename deletions, source/HEAD integrity, timeout/cancellation, bounded/redacted output, provider exclusion even with quota preference, same-commit rejection, pending dependency claims, owner identity and early approval rejection, exact-scope/tenant isolation, idempotent starts/completions, lease expiry and cancellation fencing. No actual provider connection or native app UI success is claimed.

## Limits and next step

No requested service/bridge feature is deliberately omitted. Actual notch rendering and a live two-provider flow need a manual smoke check after integration; native app source lives in another repository. Existing local configuration was deliberately not edited. The owner must apply migration 021 and opt into `projects[].checks` with absolute commands, in addition to existing patch grants/configuration. Check/review workers must have the pinned local commit in their configured repository; no cross-host commit transport is introduced. `task_continue` cannot reopen flow steps; a corrected attempt starts a new flow so downstream evidence cannot become stale.

No production DB, credentials (beyond the explicitly authorized test-env copy), real harness configs, services, accounts or external operations were touched. No commit, push, merge, publication or deployment was performed. The coordinator/bridge owns review and commit; suggested subject: `feat(flows): enforce task workflows and bridge gates`, with the requested trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Local simplification review: Lean already. Ship.
