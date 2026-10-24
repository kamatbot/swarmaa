# PTY fixtures

`composers.json` contains minimal replay frames for readiness and submission regressions. Codex
prompt/working shapes and terminal wire expectations are adapted from AgentWorkforce Relay's
`readiness.rs`, `detection.rs`, `pty_worker.rs` and delivery documentation (Apache-2.0; see
`THIRD_PARTY_NOTICES.md`). The bare Antigravity composer is a conservative test layout, not an
authenticated live capture. It must not be cited as a successful real-harness wake proof.

`codex-login.json` and `agy-login.json` are recorded local startup captures with the real tmux cursor
and size, used as negative readiness fixtures. Their exact commands/limitations are documented in
`docs/briefs/pty-wake-results.md`. No fixture contains account credentials or the user's harness config.
