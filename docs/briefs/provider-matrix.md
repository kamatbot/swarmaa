# Brief: provider support matrix, a live smoke test against the real CLIs

**Repo:** `~/Projects/swarma`.
**Borrowed from:** HarnessRouter (Apache-2.0), cloned at `~/Projects/research/harnessrouter`. Read `docs/harness-verification.md` and `scripts/support-matrix/` (`README.md`, `run.mjs`, `render.py`). Ideas only. Credit it in `THIRD_PARTY_NOTICES.md` if any code is adapted.

## Problem

Swarmaa breaks when a CLI updates. Codex reconnect notices once marked good tasks as failed; worktrees once had no `node_modules`. Unit tests use stubs, so they can't catch that. `npm run smoke` (`scripts/smoke.ts`) only proves that *some* worker completes *one* task.

## Goal

`npm run smoke:providers [-- --providers claude,codex,antigravity] [--scope project:general] [--patch-scope <scope>]` drives the **real running swarm on this Mac**, through each provider explicitly, and prints a pass/fail table. Exit 1 on any FAIL.

## Do this

1. **The script** `scripts/smoke-providers.ts`, plus a `package.json` entry next to `smoke`. Reuse `smoke.ts`'s `call()` and token pattern. Per provider, using explicit capabilities (`<provider>.read` / `<provider>.patch`) so routing can't substitute:

   | Scenario | What it proves | Verdict |
   |---|---|---|
   | `answer` | A research or review task returns an exact nonce: "Reply with exactly: swarmaa-ok-`<nonce>`". | `completed`, and the answer contains the nonce. |
   | `served` | It ran where we said. | `result.provider` (and `result.served.provider` once failure-codes lands) equals the provider asked for. Anything else is a FAIL, never a pass (HarnessRouter rule 1). |
   | `continue` | `task_continue` on that task: "What was the nonce?" | The answer contains the nonce. |
   | `patch` | Only with `--patch-scope` (a scope whose bridge project has `allow_patch`): create a file `smoke/<nonce>.txt` with that content. | `completed`, `changed_files ≥ 1`, and the branch's diff contains exactly that file. Without `--patch-scope`: `SKIP` with a one-line setup hint. |
   | `cancel` | Submit a long task ("count slowly to 500, one number per line"), cancel it once it's running. | Status `cancelled` within 30 s, and that worker's slot frees up within 60 s. |
   | `notify` | The submitter's inbox gets a `task_finished` item for the `answer` task. | Found by `inbox_get`. |

   - Run providers in parallel; scenarios inside a provider run in order.
   - Each scenario has a timeout (default 5 minutes, flag to change) and records its duration.
2. **Output:**
   - A table: provider × scenario, with PASS / FAIL / SKIP, the duration, and a short reason on FAIL.
   - A JSON copy in `.local/smoke-providers/<timestamp>.json` (gitignored), so runs can be compared.
   - Print the CLI version of each provider (`claude --version`, `codex --version`, `agy --version`) at the top, so a regression can be tied to an upgrade.
3. **Cost guard.** Prompts are tiny. Print the number of tasks it will submit before starting. Skip a provider whose usage reading shows less than 5% headroom: SKIP with a reason, not FAIL.
4. **Clean up.** Cancel anything the script started that is still running when it exits, including on Ctrl+C. Tag every task's objective with `[smoke]` so it is easy to spot.
5. **Tests.** Factor the verdict logic (scenario result → PASS/FAIL/SKIP and reason; the table renderer) into pure functions. Unit-test them with fixtures: a substituted provider is a FAIL; a missing nonce is a FAIL; the 5% headroom skip; a timeout. Don't run the live script in tests.

## Rules

- Same Rules section as `docs/briefs/agent-notifications.md`. No new dependencies.
- Don't change `src/bridge/sandbox.ts`, `providerEnvironment`, or any worker or bridge config.
- **Do not run the live script yourself.** It submits real tasks to the user's swarm, and the coordinator runs it after merging. Do run `npm run smoke:providers -- --help` and show that it parses.
- Never touch the user's real harness configs or `.local` tokens, don't restart services, don't push.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

```bash
npm run build
timeout 600 npm test 2>&1 | grep -E "^ℹ (pass|fail)"
npm run smoke:providers -- --help
```

0 test failures, apart from the known nested `sandbox-exec` test, which you report separately.
