# Agent notifications — implementation and validation

2026-10-24. Baseline `64365de7fd5af3023cbb6b77f1846089528e4a89`, worktree branch `swarmaa/codex/c4148e6f`.
Node `v24.21.0`. Local patch only; no commit, push, deployment, launchd restart, real harness-config changes,
or live service/database writes. `.env.test` was copied as instructed without printing it. Integration suites
and the proof used only `TEST_DATABASE_URL` and random disposable schemas, removed on exit.

## Delivered

Migration 019 adds durable inbox items, owned session bindings, task watchers, a deduplication index and
transactional PostgreSQL notifications. Terminal task updates (including blocked/cancelled/exhausted leases)
notify submitters and session watchers exactly once per terminal version. New core/MCP tools enforce tenant,
exact scope, permissions, session ownership, body redaction and a database-backed sender rate limit.
The HTTP waiter shares one LISTEN connection and rechecks authentication before claiming pending items.

All three harnesses have bounded, silent-on-error step hooks, installed alongside the existing journal and
removed through the existing CLI path. Setup installs inbox hooks independently of chat sharing. Claude's
matched task-submit hook registers its session, and its Stop waiter uses async + asyncRewake with a single
PID lock. Antigravity Stop continues only with pending items. Codex Stop preserves items for the next
model-visible step and emits only informational UI output; it does not block or start a new turn.

## Commands and exact summary lines

`timeout 90 npm run build` — exit 0, final source including the proof script.

`timeout 600 npm test` — exit 1 solely for the known nested sandbox test:

```text
ℹ pass 313
ℹ fail 1
ℹ skipped 7
```

Failure: `tests/sandbox.test.ts:32`, “light profile: allow by default, deny only credential folders,
enforced on a real process”, actual sandbox subprocess status `71`, expected `0`. This test was not changed.
Integration suites skip in the unit command without TEST_DATABASE_URL; the explicit integration run below
executed all of them.

`timeout 400 npx tsx --env-file=.env.test --test tests/*.integration.test.ts` — exit 0:

```text
ℹ pass 94
ℹ fail 0
ℹ skipped 0
```

Coverage includes replay/continuation/late-watch races, terminal failures/cancellation/lease expiry,
principal/task/session routing, scope/tenant/permission isolation, redaction, rate limiting, atomic delivery,
HTTP authorization, revocation, clean timeout, and delivery in less than one second.

After the full run, final focused validation covered the bounded waiter, one added timeout test, and the
compiled installer-root fix (no duplicate full-suite run):
`timeout 60 node --import tsx --test tests/inbox-hooks.test.ts tests/journal.test.ts tests/setup.test.ts`

```text
ℹ pass 57
ℹ fail 0
ℹ skipped 0
```

The hook checks include executable exit-2/stderr behavior, JSON shapes for each harness/event, no-output
error handling, two-second network timeout, redacted/limited output, live/dead PID lock behavior,
Codex Stop buffering, and temporary-home install/remove/idempotency/foreign-config preservation.
The compiled installer was also run with a fresh temporary HOME: install/reinstall/remove passed, and the
second install made no changes. `git diff --check` also passed. Local simplification review: Lean already. Ship.

## Manual tmux wake proof

Command: `timeout 270 node --env-file=.env.test --import tsx scripts/inbox-wake-proof.ts` — exit 0.
The script is checked in so the same bounded proof can be repeated. Requires installed `claude`, `tmux`,
a build, and a disposable TEST_DATABASE_URL; it never needs real provider credentials.

This ran **the real interactive Claude Code 2.1.304 TUI**, real stdio MCP proxy, CoreService/HTTP service,
PostgreSQL task transitions, installed task-watch hook and installed asyncRewake Stop waiter. The session
sat idle for two seconds before the fixture worker finished the task. No user input was sent after that.
The returned system reminder caused a new model request and the displayed awake response.

**Model responses were deterministic local Anthropic-protocol fixtures**, using a dummy key and a loopback
base URL in a clean environment. This establishes harness wake behavior without spending provider usage or
copying real credentials; it does not establish real-provider reasoning, authentication, remote-gateway,
or every Claude version's behavior. The API billing label below is the TUI's mode label, not a paid call.

Exact output (including the tmux capture):

```text
TMUX start exit=0 
MODEL available tools: 
MODEL fixture phase=1 wake=false stream=true
MODEL fixture phase=2 wake=false stream=true
PROOF: task_submit watched; Stop waiter armed; waiting 2 seconds while idle
PROOF: committed task_finished fixture
MODEL fixture phase=3 wake=true stream=true
PROOF: idle Claude woke via asyncRewake
[Screen Reader Mode: on via flag]
Claude Code v2.1.304
Sonnet 4.6 · API Usage Billing
/private/var/folders/kp/zm5z_hd54210n5yvtnrswmrc0000gp/T/inbox-manual-tezoPw/project
Auto mode is now Claude Code's default permission mode.
Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and prompt
 injection before executing, runs the ones it assesses as lower-risk, and blocks the rest.
https://code.claude.com/docs/en/permission-modes
you: Submit the local notification fixture with swarma task_submit, then stop and wait.
Called swarma (ctrl+o to expand)
claude: INBOX_PROOF_IDLE: waiting for completion.
Cogitated for 0s · done 10:45 PM
 Stop hook feedback
claude: INBOX_PROOF_AWAKE: task_finished received while idle.
Worked for 0s · done 10:45 PM
auto mode on (shift+tab to cycle)
effort: high · /effort
$



















FINAL TMUX CAPTURE:
[Screen Reader Mode: on via flag]
Claude Code v2.1.304
Sonnet 4.6 · API Usage Billing
/private/var/folders/kp/zm5z_hd54210n5yvtnrswmrc0000gp/T/inbox-manual-tezoPw/project
Auto mode is now Claude Code's default permission mode.
Auto mode lets Claude handle permission prompts automatically. Claude checks each tool call for risky actions and prompt
 injection before executing, runs the ones it assesses as lower-risk, and blocks the rest.
https://code.claude.com/docs/en/permission-modes
you: Submit the local notification fixture with swarma task_submit, then stop and wait.
Called swarma (ctrl+o to expand)
claude: INBOX_PROOF_IDLE: waiting for completion.
Cogitated for 0s · done 10:45 PM
 Stop hook feedback
claude: INBOX_PROOF_AWAKE: task_finished received while idle.
Worked for 0s · done 10:45 PM
auto mode on (shift+tab to cycle)
effort: high · /effort
$
```

## What did not work / remaining validation

- The initial proof fixture used a token-environment variable outside the stdio proxy's accepted
  `COLLECTIVE_`/`SWARMAA_` prefixes, so MCP connection failed. Correcting only the fixture fixed this.
  The first bounded attempt expired during setup; the final checked-in proof completed successfully.
- The first executable hook test found macOS `/var` versus `/private/var` path resolution prevented the
  entry point from running. Comparing real paths fixed it; executable and live harness tests now pass.
- Codex `0.160.1` has a `queue --thread --message` command, verified with isolated `--help`, but delivery
  to a live authenticated Codex TUI was **not established**. No queue/idle-wake path is shipped. Review and
  trust Codex hooks through `/hooks` on the real installation before using them; this was not bypassed.
- Antigravity `1.4.7` was detected. PreInvocation and Stop formats are fixture-tested against the brief and
  existing installer conventions; actual authenticated Antigravity injection remains unverified.
- Delivery marks an item claimed, not model acceptance. A lost HTTP response after claiming is not replayed.
  `read_at` is reserved; no read acknowledgment API is introduced. A crash inside the tiny lock-acquisition
  guard can require manual guard cleanup after confirming its owner has stopped; live waiters are never stolen.

Verified reference contracts: [Claude hooks](https://code.claude.com/docs/en/hooks) documents asyncRewake
exit 2 and idle wake; [Codex hooks](https://learn.chatgpt.com/docs/hooks) documents hookSpecificOutput context
for step events and Stop continuation behavior. The Codex Stop buffer accounts for that event's lack of a
model-context output contract. The Antigravity docs endpoint could not be fetched, so live support is not claimed.

Next: review the bridge's commit, apply migration 019 and install hooks in the intended environment under
separate operator authorization, then smoke-test real Codex/Antigravity sessions. The bridge owns committing;
the requested trailer remains `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
