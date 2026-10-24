# Brief: failure codes with retry rules, rerouting on exhausted quota, and served-provider stamps

**Repo:** `~/Projects/swarma`.
**Borrowed from:** HarnessRouter's Unified Harness Protocol (Apache-2.0), cloned at `~/Projects/research/harnessrouter`. Read these first:
- `protocol/versions/2026-10-19/errors.md`: the closed code list, the retry table, and "task failure is not request failure";
- `docs/harness-verification.md` rules 1–2: a served model or connection other than the one asked for is a finding.

Ideas only. Credit it in `THIRD_PARTY_NOTICES.md` if any text or code is adapted.

## Problem

1. **No reason.** A failed task today carries `outcome: 'failed'`, an exit code, a stop reason and free text. Nothing machine-readable says *why*, so nothing can act on it.
2. **No rerouting.** A Codex task that dies because the weekly quota ran out fails outright, even though Antigravity and Claude have headroom. Routing around spent quota is Swarmaa's core promise.
3. **No stamp.** Nothing records which provider and model actually served a task. Flows' "different provider than step X" rule, and the notch, trust the worker's configured provider. Antigravity in particular can fall back to another model silently.

## Do this

1. **A closed failure-code list**, in one module (for example `src/core/failures.ts`), shared by the bridge and the service. Each code has a retry rule.

   | Code | Meaning | Rule |
   |---|---|---|
   | `quota_exhausted` | The provider's plan or window is spent. | Reroute (step 3). Never retry on the same provider until its usage reading shows headroom. |
   | `rate_limited` | Short-term throttling, 429. | Retry the same provider after a backoff (respect any retry-after the CLI prints). |
   | `auth_required` | Signed out, or the token expired or was rejected. | Don't retry. Surface "sign in to X". |
   | `provider_error` | Upstream 5xx, overloaded, network. | Retry once with backoff, then reroute. |
   | `harness_error` | The CLI ran and failed: crash, bad output, no completed turn. | Don't auto-retry. |
   | `timeout` | The task's wall-clock budget was exceeded. | Don't auto-retry. |
   | `sandbox_denied` | Existing `denied_actions`. | Keep today's `blocked` behaviour; attach the code. |
   | `cancelled` | Cancelled. | — |

   Vendor-specific extras get a `swarmaa_` prefix.
2. **Classification in the bridge.** Each provider adapter in `src/bridge/adapters.ts` gets a pure `classifyFailure(provider, result)` beside `providerSucceeded`. It reads the CLI's real output: Claude's result JSON, Codex's event stream (`turn.failed` and error messages), Antigravity's status JSON. It also uses the stop reason and exit code.
   - Collect real failure samples from the transcripts of past failed tasks in the live DB, **read-only** (`artifacts` linked to failed tasks), and turn them into test fixtures. Redact them first.
   - Unknown output falls back to `harness_error`, never to a retryable code.
   - `task_finish` carries `result.failure = {code, retry, detail}`. `detail` is a short, redacted line, safe to show a user.
3. **Rerouting in the service** (`src/core/tasks.ts` finish path, plus routing).
   - For `auto.*` tasks: a `quota_exhausted` failure, or a `provider_error` after its one retry, requeues the task. That provider is excluded from the next claim (store the exclusions on the task) and `attempt_count` counts it as usual.
   - When every enabled provider is excluded or out of headroom, the task fails with `quota_exhausted` and the message names each provider's reset time from the usage readings.
   - Tasks with an explicit capability (`codex.patch`, …) are **never** rerouted; they fail with the code.
   - `rate_limited` requeues on the same provider no sooner than the backoff.
   - Mark the provider's usage reading stale on `quota_exhausted`, so routing stops picking it before the next probe.
4. **Served stamp.** Each run records `result.served = {provider, model}`, taken from the CLI's own output (Claude's result JSON model fields, Codex's events, Antigravity's response metadata), not from config.
   - The model is `null` when the CLI doesn't report it.
   - The flows "different provider" check (`src/core/tasks.ts` claim and `src/core/flows.ts`) uses `served.provider`.
   - A served model that differs from a model the task or policy asked for is recorded as `served.substituted = true`. Treat a vendor prefix or a date suffix as the same model, as HarnessRouter's `samemodel.py` does.
5. **Visibility.**
   - `task_get` and `swarm_status` recent items show `failure.code` and `served`.
   - The inbox `task_finished` body says the reason: "failed (quota_exhausted on codex, rerouted to antigravity)" or "failed: auth_required, sign in to Claude Code".
   - Generic sinks get the code, never the detail text.
6. **Tests:**
   - unit tests: `classifyFailure` for every code, per provider, from the recorded fixtures;
   - integration tests:
     - `quota_exhausted` on an auto task requeues it and excludes that provider;
     - when every provider is exhausted, the task fails with reset times;
     - an explicit-capability task never reroutes;
     - `rate_limited` waits its backoff;
     - the flows different-provider rule uses `served.provider`;
     - tenant isolation.

## Rules

- Same Rules section as `docs/briefs/agent-notifications.md`. Terse code that matches the style around it. No new dependencies.
- Keep workers' configuration and environment exactly as they are. Do **not** change `src/bridge/sandbox.ts` or `providerEnvironment`.
- Use migration **023** if you need one (022 is reserved for the terminal-wake work).
- Read the live DB only for failure samples; never write to it. Never touch the user's real harness configs, don't restart services, don't push.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

```bash
npm run build
timeout 600 npm test 2>&1 | grep -E "^ℹ (pass|fail)"
timeout 400 npx tsx --env-file=.env.test --test tests/*.integration.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^✖"
```

0 failures, apart from the known nested `sandbox-exec` test inside the worker sandbox, which you report separately.
