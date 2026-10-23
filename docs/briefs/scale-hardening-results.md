# Scale hardening result — local acceptance complete with sandbox exception

2026-10-23. Worktree branch `swarmaa/codex/52d139e0`, clean baseline `045c8d3cf4518a5f6595fcd46075eb7553267bd1`. Reused `c5c2885` with `git cherry-pick --no-commit`; resolved conflicts without changing branches or creating a commit. Node `v24.21.0`, with `/opt/homebrew/opt/node@24/bin` first in PATH. No dependency changes, production access, service restart, push, publication or deployment. The bridge owns committing the patch.

## Implemented

- `task_claim` accepts either the original single scope or 1–64 per-project entries. Every entry is authorized/validated before leasing; the original per-scope transaction, routing, expired-lease sweep and response remain in `claimScope`.
- Bridge slot attempts claim project chunks of 64, retain each project's capabilities/patch opt-in, and map the returned scope to its configured root. Main's graceful drain, zero-slot reporting, once mode, transient heartbeat retries and execution code remain intact. Worktree dependency seeding is unchanged in `worktree.ts`.
- Migration **018** adds `events.xid`, index `(tenant_id, scope, xid, seq)`, and the 512-scope identity constraint. Existing migrations, including applied 015–017, are unchanged. Every explicit integration migration list includes 018.
- `events_poll` filters below snapshot xmin, orders and resumes by **(xid, seq)**, and returns `xid.seq` cursors. Bounds are unsigned 64-bit XID, nonnegative signed bigint sequence, at most 40 characters. No event table lock, lock timeout or `events_busy` branch remains.
- Numeric legacy cursors filter `seq > N` for that call and upgrade. Empty legacy pages capture xmin before reading and resume at `xmin.0`, so pending transactions cannot be skipped. Subsequent pair polls can replay historical events with a greater XID and sequence at/below N; clients should deduplicate IDs. Default/new consumers start at `0.0`.
- Tool schema, task message, load driver, Grok REST guidance, Grok/Dot/network instructions and API/status/operations/brief documentation describe the new contract. Setup has no cursor guidance to change.

## Scope-limit inventory

| Location | Change |
|---|---|
| `db/migrations/018_events_xid.sql` | Principals: 64 → 512 scopes; historical 001 remains unchanged |
| `scripts/admin.ts` | 64 → 512 scopes; argument bound 4096 → 512 × 129 characters |
| `scripts/distill.ts` | Scope selection slice 64 → 512 |
| `scripts/setup-lib.ts` | 64 → 510 folders, plus reserved demo/general scopes |
| `src/bridge/config.ts` | 50 → 512 projects |
| `src/passkeys.ts` | Newer owner worker provisioning limit 50 → 512; union overflow is rejected before insertion |

Retained: 64 entries per claim request/chunk; OAuth/policy grant intersection has no separate project-count cap. Unrelated 64-character hashes/keys, validation fields, secret/search candidate limits, HTTP concurrency, request/token/config byte bounds and git buffer sizes remain unchanged. Large configurations can still hit their independent 64 KiB file bound.

## Evidence

Only the explicitly authorized `.env.test` copy and `TEST_DATABASE_URL` were used for database tests, in randomly named disposable schemas. No `.env` or live database migrations were used. The load command exited normally after its schema-cleanup code. Logs are in ignored `.local/scale-*.log` files in this worktree.

| Check | Observed result |
|---|---|
| Reversed-XID reproduction on the reused implementation | Failed as expected: after returning the later-sequence/lower-XID event, the next poll missed the held lower-sequence/higher-XID event after commit (`scale-reproduction-before.log`) |
| Focused core + worker tests, timeout 180 | **43 passed, 0 failed, 0 skipped**, 3.0 s; includes exact-once regression, prompt nonblocking poll, legacy upgrade, same-XID pagination, project claims/chunks, drain and heartbeat retry |
| `timeout 180 npm run build` | **Passed**. Initial run caught a duplicate test insertion in the wrong fixture; removed it and reran the build successfully |
| `timeout 600 npm test` (database variables unset) | **302 passed, 1 expected sandbox failure, 7 skipped, 0 cancelled**, 3.0 s; no other failures |
| `timeout 400 node --env-file=.env.test --import tsx --test tests/*.integration.test.ts` | **85 passed, 0 failed, 0 skipped, 0 cancelled**, 5.4 s; includes schema bounds and owner worker 512/513-scope tests |
| `grep -rn "LOCK TABLE events" src` | No hits |
| `git diff HEAD --check` | Passed |

The only npm failure is `tests/sandbox.test.ts`, “light profile: allow by default, deny only credential folders, enforced on a real process”: nested `sandbox-exec` exits **71**, as expected in the worker sandbox. `tests/bridge-config.test.ts` passed. No sandbox test or threshold was changed. Integration suites skipped in plain npm test were separately executed successfully with `.env.test`. After the npm run, only the misplaced duplicate integration-test block was removed; the corrected file passed build and the complete integration run.

## Load comparison

Required command (timeout 600): `node --env-file=.env.test --import tsx scripts/load.ts --scopes 100 --tasks 2000 --workers 12 --pollers 100`.

Before values are the brief's measurements, not a new baseline run. Both larger runs use 2000 tasks, 12×16 worker slots and 100 pollers; the new run serves **100 projects versus 60** in the timed baseline.

| Metric | Before (brief) | After (this worktree) |
|---|---|---|
| 100-project setup | Failed `principals_scopes_check` | Passed |
| Completion | 2000 tasks / 60 projects in 29.5 s | **2000/2000 / 100 projects in 36.0 s** |
| Errors | None at 60 projects | **None at 100 projects** |
| `events_poll` p99 | **879 ms** | **660 ms**, 24.9% lower |
| `task_claim` max | 939 ms | 808 ms |
| `task_submit` p95 | 922 ms | 697 ms |

After: submit-all 0.8 s; pool 12; simulated work ≈1500 ms. Event polling made 5100 calls (p50 16 ms, p95 100 ms, p99 660 ms, max 695 ms). Claims: 2118; finishes: 2000; heartbeats: 3783; swarm status: 1700. The smaller 60-project/500-task baseline was not repeated. This measures direct CoreService/database load, not HTTP rate limits or real provider CLI throughput.

## Handoff

No unresolved implementation or integration failure was observed. Native sandbox enforcement still needs a run outside the nested worker sandbox. Migration 018 must be applied before running the updated service; production migration/deployment was not performed or authorized. Review the uncommitted patch and let the bridge commit it, preserving the required `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer. No commit, push, merge, upload or deployment was performed here.

Lean review: Lean already. Ship.
