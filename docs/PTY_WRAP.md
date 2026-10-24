# Idle terminal wake

Use Node 24, a real terminal, and a local Swarmaa identity provisioned by setup:

```sh
npm run wrap -- codex
npm run wrap -- agy
# The package's swarmaa executable accepts the same commands:
swarmaa wrap codex --no-alt-screen
swarmaa wrap agy
```

Arguments after the harness go directly to its executable, without a shell. The normal CLI
environment, terminal colours, raw keys, size and exit code pass through. Swarmaa service-token
environment variables are removed from the child. The wrapper reads `.local/codex.json` or
`.local/antigravity.json` and the `.env` port from its installation, exactly as the MCP launcher does.
It never needs an admin identity. For an isolated test installation, set `SWARMAA_WRAP_ROOT` to
that installation's directory before launching; the child never inherits that setting or token.

`node-pty` is necessary because Node has no built-in child PTY API. System `script` cannot provide
the wrapper's direct PTY input, resize and lifecycle control consistently on macOS and Linux.
Install requires the platform's native build tools (Xcode Command Line Tools on macOS; Python/make/C++
on Linux). The root postinstall runs `npm_config_build_from_source=true npm rebuild node-pty` under
the selected Node 24 runtime: the upstream macOS prebuilt helper otherwise fails with
`posix_spawnp failed` because it is not executable. If installing with lifecycle scripts disabled,
run that rebuild manually. The wrapper does not alter dependency permissions or global runtime settings
at startup. Windows installation is outside this wrapper's supported macOS/Linux scope.

The startup banner prints a session such as `wrap:codex:<uuid>`. Long-polling registers its ownership;
once registered, another authorized connection in the shared scope can address it with:

```json
{"to":"session:wrap:codex:<uuid>","scope":"project:demo","body":"A short update"}
```

Use that object with `message_send`. Bodies remain untrusted data; receipt acceptance never grants
permission or proves model comprehension. Installed next-step inbox hooks inherit the wrapper's
session, so they share its receipts instead of duplicating principal-wide notices in a second stream.
The model can explicitly read with `inbox_get {session: "wrap:codex:<uuid>"}`.

The wrapper waits up to 15 seconds for a quiet terminal, a recognized empty composer and its live
cursor. Login, trust, busy, draft, unknown terminal state and unsupported layouts fail closed with
`prompt_unproven`; no body or Enter is written. A resize requires a full repaint before another
automatic delivery. New harness UI versions may require updated fixtures/readiness recognition.

The full notice, including its untrusted-data heading and session, is capped at 1,500 UTF-8 bytes.
An oversized batch becomes `N new Swarmaa updates; call inbox_get`, never a partial body. Controls
are stripped; tab and LF survive sanitization. When DECSET 2004 has been observed, the body is one
bracketed paste. Otherwise it is typed at 5 ms per code point, with tab/LF flattened into spaces so
they cannot act as editor keys. Both wires send a distinct CR at least 250 ms after the body.

A summary wake is logged as `summary_accepted`, while the original item receipts stay `unconfirmed`:
their bodies were not delivered, and accepting them would hide that full content from `inbox_get`.
The awakened agent can read the complete bodies with the printed session ID.

Echo is still a draft. Only subsequent harness activity, or an observed draft followed by an empty
composer, permits `inbox_ack` acceptance. A body proven parked at the cursor gets at most one extra
delayed CR, with another check immediately before that key. The body is never typed again in the
same wrapper session, including after a lost acknowledgment. User input cancels readiness, typing,
the delayed CR and recovery immediately; partially typed drafts are left for the human to edit.
Uncertain or cancelled attempts are acknowledged as `unconfirmed` and remain available through the
inbox. The service's existing bounded re-offers may still occur, but the wrapper suppresses their bodies.

The startup banner also prints a private receipt-log path under `~/.swarma/wrap/`. Logs contain
session/delivery IDs and verdict codes, never tokens or bodies. They distinguish session registration,
delivery verdict, acknowledgment completion and process exit. Network errors back off up to 30 seconds
while the user's CLI keeps working. Replay protection stops automatic input after 4,096 deliveries in
one session, and the metadata log stops growing at 2 MiB; start another wrap session for longer use.

To print optional defaults, use `npm run wrap -- --aliases`:

```sh
alias codex='swarmaa wrap codex'
alias agy='swarmaa wrap agy'
```

Setup offers this display as an unchecked choice. Add the aliases yourself only after making the
package's `swarmaa` executable available on PATH. No alias or shell profile is installed automatically.

Focused validation: `node --import tsx --test tests/wrap*.test.ts tests/inbox-hooks.test.ts tests/setup.test.ts`.
Use a disposable `TEST_DATABASE_URL` for inbox integration tests. Real-harness proofs must use temporary
homes/config directories and an isolated tmux socket; authenticated idle wake remains unproven when the
CLI cannot log in there. See [the implementation evidence](briefs/pty-wake-results.md).
