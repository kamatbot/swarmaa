# Brief: wake idle Codex and Antigravity sessions through a terminal wrapper

**Repo:** `~/Projects/swarma`.
**Builds on:** the inbox and `message_send` from `docs/briefs/agent-notifications.md`, plus `docs/briefs/delivery-receipts.md`.
**Borrowed from:** AgentWorkforce Relay (Apache-2.0), cloned at `~/Projects/research/relay`. Read these first:
- `docs/harnesses/pty-delivery.md`
- `docs/harnesses/injection.md`
- `crates/relay-pty/`
- `crates/broker/src/{wrap.rs,pty_worker.rs,terminal_control.rs,injection_wire.rs}`

Port the ideas and the hard-won rules; adapt code only with attribution in `THIRD_PARTY_NOTICES.md`.

## Problem

Hooks get Swarmaa notices into Codex and Antigravity at their **next step**. Nothing wakes a session that is sitting idle at its prompt, because neither harness accepts outside input into a live session. Claude Code is already covered by the `asyncRewake` waiter.

## Goal

`swarmaa wrap codex [args…]` and `swarmaa wrap agy [args…]` start the user's normal CLI inside a pseudo-terminal that Swarmaa controls.

- The user sees and uses it exactly as if run directly: same terminal, same keys, resize, colours, exit code.
- When an inbox item arrives for that session **and the agent is idle**, the wrapper types a short notice into the composer and submits it, so the agent wakes and acts.

## Do this

1. **The wrapper** (`src/wrap/` plus a `bin` entry or `npm run wrap`).
   - Use `node-pty` only if no smaller option exists. It is the one new dependency allowed; justify it in the report.
   - Pass through stdin, stdout, resize and signals.
   - Register the session with the service under a session id like `wrap:<harness>:<uuid>`, using the same token-file path as the MCP launcher.
   - Long-poll `/api/inbox/wait` for it.
2. **Delivery rules (from Relay's `pty-delivery.md`):**
   - **Idle only.** Wait until the composer is provably idle. If that can't be proven within 15 s, the delivery fails with `prompt_unproven` and the body is never written.
   - **Paste or type.**
     - If the harness enabled bracketed paste (DECSET 2004), send one bracketed paste, then a *separate, delayed* Enter.
     - Otherwise type at a paced rate. Codex 0.160 needs a distinct `CR` about 250 ms after the body; Relay reproduced a body and `CR` in one write staying parked.
   - **Sanitise.** Strip control characters except tab and newline, so a body can't submit early or close a paste.
   - **Size cap.** Cap the notice at about 1,500 bytes. Longer content becomes "N new Swarmaa updates; call inbox_get", never a partial body.
   - **Confirm acceptance.** Echoed text is only a draft. Confirm by the composer clearing or activity appearing.
     - If the body stays parked, allow one bounded extra Enter.
     - Otherwise record `unconfirmed` (per `delivery-receipts.md`) and never retype the body.
   - **The human wins.** Any keystroke from the user cancels a pending delivery and leaves it in the inbox.
3. **Setup.** Print how to make it the default, for example `alias codex='swarmaa wrap codex'`. Never install that alias without asking; offer it as a setup choice that defaults to off.
4. **Tests:**
   - unit tests on the sanitiser, size cap, composer-idle detection and submit sequencing, using recorded terminal fixtures;
   - one manual proof per harness in tmux against the real installed `codex` and `agy`:
     - leave the agent idle;
     - send `message_send` to its session;
     - show it wake and answer.

   Report the exact output.

## Rules

- Same Rules section as `docs/briefs/agent-notifications.md`. Never touch the user's real configs in tests.
- macOS first; Linux if free.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
