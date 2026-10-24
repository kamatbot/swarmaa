# Brief: delivery receipts for the inbox (after agent-notifications lands)

**Repo:** `~/Projects/swarma`.
**Builds on:** the inbox from `docs/briefs/agent-notifications.md`, which must be merged first.
**Borrowed from:** AgentWorkforce Relay (Apache-2.0), `crates/broker/src/native_delivery.rs` and `docs/harnesses/pty-delivery.md` (clone at `~/Projects/research/relay`). Credit it in `THIRD_PARTY_NOTICES.md` if any code is adapted, not just ideas.

**Goal.** A single `delivered_at` hides the difference between "a hook printed it", "the agent's next step consumed it" and "we never got an answer". Make every delivery attempt honest and idempotent.

## Do this

- **Delivery ids.** Each inbox item gets a stable `delivery_id`. Hooks and the waiter send it back when they consume an item.
  - Repeating a call with the same id is a **read-only lookup**.
  - A body is never handed out twice to the same session once it has been accepted.
- **Receipt states** per item and session:
  - `offered`: the service handed it to a hook or waiter.
  - `accepted`: the hook confirmed it printed the injection output and exited 0, or the waiter exited 2 with it.
  - `unconfirmed`: the attempt timed out or the response was lost, so it's in doubt.
  - `read`: the agent called `inbox_get` or acted on it, for example by calling `task_get` for that task.

  Write each receipt **before** responding to the hook, as Relay does before writing to a worker.
- **Redelivery.** `unconfirmed` items are offered again at most twice, with the same `delivery_id`, then surfaced in `swarm_status` as "stuck".
  - `accepted` items are never re-offered to that session.
- **Visibility.** `inbox_get` and `swarm_status` show per-item state. Sinks and the notch see receipt counts, never bodies.
- **Tests:**
  - an exact retry stays read-only;
  - a lost response becomes `unconfirmed` and then is re-offered;
  - an `accepted` item is never re-offered;
  - other tenants are isolated.

## Rules

- Same Rules section as `docs/briefs/agent-notifications.md`.
- Next free migration number (check `db/migrations`).
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
