Objective: implement teams-fixes-codex-service.md on 725cd85. Clean writable worktree; Node v24.21.0. Scope: service, integration regressions, benchmark/docs; no Mac-app, bridge sandbox, dependencies, lock redesign, commit/push/restart/deploy. Risk: scoped card disclosure and stream lifecycle/cursor races. Work units: reads/status, resolution authorization, stream notification, validation/performance. Disposable TEST_DATABASE_URL only, copied without printing. Build output goes to temporary directory. Acceptance: focused regressions including baseline failures, build, timeout 600 npm test, serial integration, scenarios 3/6 report. No external actions authorized.

Implemented: newest-first selection/ascending response, batched question+answer and swarm snapshots (tenant/scope constrained; swarm details retain task:read), constant agent status queries, unchanged single-query thread_list, answer_questions task resolution including CoreService/tool gate, active-task 409, shared reconnecting LISTEN client and transactional NOTIFY with immediate draining/2 s safety poll. No indexes/dependencies added; teamsLock unchanged.

Evidence (Node v24.21.0):
- Five new behavioral regressions all FAIL against git-archived 725cd85 (temporary source copy; branches untouched), all PASS with patch. Baseline failures are newest page, missing card data, owner gate, variable query count, and notification latency. Log: /tmp/teams-baseline.log.
- npm run build -- --outDir <temporary directory>: PASS, including final build /var/folders/kp/zm5z_hd54210n5yvtnrswmrc0000gp/T/teams-build-final.Zoydqo.
- timeout 600 npm test: 415 tests, 407 pass, 7 skipped, only known nested sandbox-exec failure (exit 71). /tmp/teams-unit.log.
- Serial integration: 185/185 PASS, zero skips/failures. /tmp/teams-integration.log.
- Final startup correction starts durable polling while LISTEN connects. Focused final Teams integration: 23/23 PASS; listener unit test PASS for shared connection, fan-out, reconnect and last-subscriber cleanup. /tmp/teams-final-focused.log. Full suite evidence above precedes this small stream startup correction; affected checks and final build were rerun.
- Benchmark --after-fixes runs all seven scenarios and appends scenarios 3/6 without replacing baseline; disposable random schema cleanup verified. Final receipt: /tmp/teams-perf-final.log, numbers in docs/perf/teams-2026-10-28.md.
- git diff --check and allowed-path audit PASS. No Mac-app, sandbox or providerEnvironment changes. No commit, push, merge, service restart or deployment. Bridge owns commit and required trailer.

Review: Lean already. Ship.
Remaining validation: coordinator diff review before integration; no production or Mac UI validation authorized/performed. Real database listener outage is covered by mocked lifecycle reconnection, not a production outage experiment. Benchmark is local/warm-cache and does not prove production latency.

Final benchmark: agent_list 5 SELECTs including auth; p50 15.912 ms (baseline 6.100 ms, no measured latency win). Stream delivery p50 3.939 ms and 1,000-event catch-up p50 31.596 ms: both brief targets met. Replay checks and schema cleanup passed. Full report preserves baseline and states the slower sidebar results explicitly.
