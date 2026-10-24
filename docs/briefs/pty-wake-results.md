# PTY wake implementation evidence

Date: 2026-10-24. Baseline/local main: `660c42b24db4a3f9d7f101959405dc730e96ecfb` (flows 021), branch `swarmaa/codex/38dbb871`. Node `v24.21.0`, selected with `/opt/homebrew/opt/node@24/bin` first in PATH. Source edits only; the bridge owns the commit. No push, merge, deployment, service restart, shell alias installation or real harness configuration change was performed.

## Implemented

- `swarmaa wrap codex|agy [args…]`, plus `npm run wrap -- codex|agy`, with raw terminal input/output, colours, backpressure, resize, termination signals, Ctrl-Z/resume and child exit codes.
- Owned `wrap:<harness>:<uuid>` inbox sessions, local MCP identity token-file/port lookup, long-polling and bounded reconnect backoff. No service token enters the child environment or receipt log. Existing inbox hooks share the wrapper's session to avoid a second principal-wide receipt stream.
- Live cursor/empty composer readiness with a 250 ms quiet window and a 15 s deadline; unsupported state fails closed with `prompt_unproven`. Complete solicited CPR, DA, OSC colour, terminal-version and DEC-mode replies are distinguished from human keys. Fragmented/unknown replies conservatively cancel.
- Control sanitization, a 1,500-byte UTF-8 whole-notice limit and whole-body summary fallback. A summary wake keeps original bodies unconfirmed/readable: acknowledging those bodies as accepted would otherwise hide them from `inbox_get`. Bracketed paste when enabled, otherwise 5 ms paced typing with LF/tab flattened to spaces. Both use a separate CR at least 250 ms later.
- Acceptance requires fresh activity or a visible draft followed by composer clearing. A proven parked body gets one extra delayed CR. Stable delivery IDs are retained before writing, including across acknowledgment retries; bodies are never retyped by that wrapper session. Human input cancels pending typing/submit/recovery immediately.
- Backward-compatible `inbox_ack` optional `state: unconfirmed`; repeated state is read-only, and accepted/read cannot be downgraded. Existing schema 020 supports this; **no migration 022 is needed**.
- An unchecked setup choice that prints aliases only; wrapper/API docs and Relay Apache-2.0 attribution/license.

## Dependency and native build

`node-pty@1.1.0` is the sole new direct dependency (`node-addon-api` is its transitive dependency). Node has no built-in child PTY API; the system `script` command does not provide the same direct input, resize and child-lifecycle control consistently across macOS/Linux. No terminal-emulator or other dependency was added.

The published macOS prebuilt `spawn-helper` had mode 0644 and failed with `posix_spawnp failed`. Rebuilt the installed dependency from source under Node 24:

```sh
npm_config_build_from_source=true npm rebuild node-pty --foreground-scripts
```

This succeeded (`gyp info ok`, `rebuilt dependencies successfully`); a real native PTY printed `native PTY ready` and exited with the requested code 7. The root postinstall now performs that source rebuild automatically. A fresh `npm ci` under Node 24 succeeded (`rebuilt dependencies successfully`, `added 51 packages`, audit: 0 vulnerabilities), followed by a successful build and focused native-PTY verification. The source does not chmod installed helpers or change global permissions/settings. Native build prerequisites and the manual fallback for installs with scripts disabled are documented. npm 11 warned that the build-from-source environment setting may stop being recognized by npm 12; the selected Node 24/npm 11 clean install was verified.

## Validation

`npm run build`: exit 0.

Focused wrapper unit/client tests (sanitizer/cap, replay frames and recorded login screens, readiness, both wires, delayed CR, acceptance vs echo, bounded retry, 15 s timeout, human cancellation including an in-flight poll, token isolation, receipt retry/no replay, summary-body readability and wrapped hooks):

```text
ℹ pass 22
ℹ fail 0
```

Both real native PTY tests also passed in the final full run: colours/resize, human keys and exit code 23, Ctrl-Z/resume, and SIGTERM with child exit code 41. These use a local contract fixture, not an authenticated provider.

Full unit command, with a temporary HOME, exactly the requested 600-second timeout:

```sh
timeout 600 npm test
```

```text
ℹ tests 361
ℹ suites 8
ℹ pass 353
ℹ fail 1
ℹ cancelled 0
ℹ skipped 7
```

The sole failure is the expected nested Seatbelt test, unchanged:

```text
✖ light profile: allow by default, deny only credential folders, enforced on a real process
AssertionError: everything else readable and writable
71 !== 0
```

It invokes `/usr/bin/sandbox-exec` inside the worker sandbox. The seven skipped suites are database-dependent suites without `TEST_DATABASE_URL` in this unit invocation; they were exercised by the separate integration run.

Copied `/Users/mk/Projects/swarma/.env.test` into this worktree before integration tests, without printing it. Integration tests used only its explicit disposable `TEST_DATABASE_URL` and generated temporary schemas.

The initial concurrent all-integration run reported `112 pass, 1 fail`: unchanged `tests/core.integration.test.ts:553`, “upgrades an empty legacy page without skipping an uncommitted event”, expected one event but received `[]`. That test passed alone (`1 pass, 0 fail`). The query's database-wide `pg_snapshot_xmin` boundary makes cross-suite transaction interference a plausible explanation; this is an inference, not a proven fix. No event code or existing test was changed.

Full serial integration command (same tests, no skips):

```sh
timeout 400 node --env-file=.env.test --import tsx --test --test-concurrency=1 tests/*.integration.test.ts
```

```text
ℹ tests 114
ℹ suites 10
ℹ pass 114
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

The earlier focused inbox integration run passed `16 pass, 0 fail`, covering wrapper session ownership/routing, unconfirmed idempotency, tenant/principal isolation and acceptance never being downgraded. The added summary-wake/full-body-read integration test passed alone (`1 pass, 0 fail`) and in the final 114-test run. No existing event/sandbox test or event implementation was changed.

Setup was exercised in fresh-profile headless Chrome with `--no-sandbox`, waiting for process exit. The real checkbox click and form payload were verified:

```json
{"width":500,"defaultOff":true,"clickSelectsPrintOnly":true,"returnedOff":true}
```

Screenshot output was blank in two attempts (including software rendering); visual layout QA is therefore unproven. The DOM interaction/default/payload checks passed. Neither attempt executed setup or changed any user settings.

## Real tmux attempts

Installed versions: `codex-cli 0.160.1`, `agy 1.4.7`. Each final attempt used a fresh HOME/config directory, a dedicated tmux socket, a freshly migrated disposable test schema and synthetic frontend identities. `message_send` targeted only the fixture wrapper session through that isolated test service. The proof driver did not read existing service tokens or harness configuration; it supplied only synthetic tokens, the explicitly authorized disposable database configuration and isolated HOME variables. No authentication choice was submitted.

Codex's daemon mode initially failed under the worker sandbox because `ps` was denied; the final attempt used its suggested `--no-daemon`. Earlier startup attempts exposed terminal responses being counted as human input; captured CPR/version/DEC replies became regression tests and the final attempts below reached the honest 15-second prompt verdict. One earlier Antigravity startup briefly displayed `Signing in...` without a submitted authentication choice; that process was stopped. No authenticated session or successful real-harness connection was observed.

Exact final Codex output:

```text
HARNESS codex; temp HOME; isolated tmux; Node v24.21.0
COMMAND swarmaa wrap codex --no-daemon --no-alt-screen
DISPOSABLE message_send sent=true; target=wrap:codex:ba0874b7-a735-4124-9895-164a759d85b8
VERDICT prompt_unproven
RECEIPT {"state":"unconfirmed","offers":1,"accepted_at":null}
TMUX OUTPUT BEGIN
  Welcome to Codex, OpenAI's command-line coding agent

  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Provide your own API key
     Pay for what you use

  Press enter to continue
TMUX OUTPUT END
AUTHENTICATED IDLE WAKE: NOT PROVEN (no real credentials accessed).
```

Exact final Antigravity output:

```text
HARNESS agy; temp HOME; isolated tmux; Node v24.21.0
COMMAND swarmaa wrap agy
DISPOSABLE message_send sent=true; target=wrap:agy:50fb4252-0694-4d8d-b825-66e9a56bbb50
VERDICT prompt_unproven
RECEIPT {"state":"unconfirmed","offers":1,"accepted_at":null}
TMUX OUTPUT BEGIN

     ▄▀▀▄
    ▀▀▀▀▀▀
   ▀▀▀▀▀▀▀▀
  ▄▀▀    ▀▀▄
 ▄▀▀      ▀▀▄

 Welcome to the Antigravity CLI. You are currently not signed in.

 Select login method:
 > 1. Google OAuth
   2. Use a Google Cloud project

   ↑/↓ Navigate · enter Select
TMUX OUTPUT END
AUTHENTICATED IDLE WAKE: NOT PROVEN (no real credentials accessed).
```

Neither harness was authenticated in the temporary home. **Authenticated idle wake and a real model answer remain unproven.** Both final attempts left the login UI intact, wrote no notice body, and recorded `unconfirmed` with `accepted_at: null`. Recorded screen/cursor fixtures are in `tests/fixtures/pty/{codex,agy}-login.json`. Positive composer replay fixtures are documented reconstructions, not authenticated live captures.

## Remaining validation and handoff

- Owner-controlled authenticated tmux proof for both real harnesses, using isolated test homes and a disposable service. Verify the actual Antigravity composer layout/activity markers and refresh fixtures if necessary. Login-screen rejection and the local native PTY contract fixture do not establish real model acceptance.
- Run the unchanged Seatbelt test outside a nested sandbox. Investigate the unchanged event-cursor test's concurrent-suite timing separately; the all-serial integration suite is green.
- Linux was not available for verification. Unsupported/multiline or resized-without-full-repaint composer layouts deliberately fail closed; fragmented terminal replies can conservatively cancel. Replay protection is capped at 4,096 delivery IDs/session; metadata logs at 2 MiB.
- Independent review and merge remain owner/bridge work. Implementation economy review: Lean already. Ship. This is a code-size review, not authorization to release or a claim of authenticated wake acceptance.

Suggested bridge commit:

```text
feat(wrap): wake idle Codex and Antigravity terminal sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
