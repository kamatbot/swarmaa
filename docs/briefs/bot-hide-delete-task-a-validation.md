# Task A validation

- Scope: server only; unarchive/delete tools and crew-change notices. No app edits, dependency changes, migration, commit, push, merge or deployment.
- Baseline: `2c9b6c8c36621f2bf610ce6eb6ffe46ef9616bd7`; initially clean writable task worktree. Source edits: `src/core/bots.ts`, `src/core/index.ts`, `src/core/tools.ts`; tests: `tests/bots.integration.test.ts`.
- Runtime: Node `v24.21.0`, selected with `/opt/homebrew/opt/node@24/bin` first in PATH.
- New tests cover hide/list/unhide, paused/unpaused schedule restoration, no star/task resurrection, reused-name conflict, exact delete confirmation, archive prerequisite, bot/thread/message/question/member deletion, retained tasks/agents, audit/event emission, crew-set comparison and permission/tenant/scope isolation.
- Regression proof: all four new tests fail against baseline server files (unknown tools and unwanted `Crew updated.` notice); modified server files restored afterward.
- `npx tsc --noEmit`: passed, including final source.
- `npm test`: 475 passed, 9 skipped, 1 failed. `tests/sandbox.test.ts:32` expects a nested `sandbox-exec` process to exit 0; observed 71. Sandbox code was not changed. Requires validation outside this worker sandbox.
- Serial `TEST_DATABASE_URL=… npm run test:integration`: 240 passed; runner reported 2 failures for the gateway-invite test and containing suite. A child process strips implicit username environment, so the throwaway URL without a username failed with `no PostgreSQL user name specified in startup packet`.
- Corrected explicit-username throwaway URL: `node --import tsx --test --test-concurrency=1 tests/bots.integration.test.ts tests/passkeys.integration.test.ts`: 27 passed, 0 failed/skipped. No unchanged full-suite rerun.
- Database: fresh isolated PostgreSQL 17 cluster on loopback port 55479, random schemas from test harnesses, never production DATABASE_URL. Cluster stopped and temporary data removed after testing.
- `git diff --check`: passed. Lean review: Lean already. Ship.
- Remaining acceptance: sandbox test in a compatible environment; Mac/iOS validation belongs to Tasks B/C and was not run. Coordinator should review/integrate the server branch with those tasks. Bridge owns committing; explicit worker no-commit instruction takes precedence over the brief/JSON commit request.
