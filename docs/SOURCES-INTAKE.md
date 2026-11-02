# GitHub Sources and Event Intake

Swarmaa connects GitHub repositories to scoped agents and bots using HMAC-verified webhooks and a pure, code-first event filter.

## Setup

1. **Enable sources in config / environment:**
   Set `SOURCES_ENABLED=true` and ensure `EVENT_ENCRYPTION_KEY` is set to 64 hexadecimal characters (32 random bytes).

2. **Add a source via the admin CLI:**
   ```bash
   npm run admin -- source-add --scope project:demo --repo owner/repo [--name <name>] [--bot <bot_id>]
   ```
   This generates an unshared 32-byte secret, stores it encrypted via AES-256-GCM context-bound to `source:<id>`, and prints the webhook URL:
   `${PUBLIC_URL}/hooks/github/<source_id>`

3. **Configure the GitHub repository webhook:**
   - **Payload URL:** `${PUBLIC_URL}/hooks/github/<source_id>`
   - **Content type:** `application/json`
   - **Secret:** The generated 32-byte secret (shown once on create)
   - **Events:** Select `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `issues`, `check_suite`, `check_run`, `workflow_run`.

4. **Accept modes:**
   - `observe` (default): Verified events are recorded with `would_do` indicating what action would be taken, but no tasks, messages, or turns are created.
   - `auto`: Triggers autonomous actions (posting to bot thread, continuing subscribed tasks). Setting `auto` mode requires the owner CLI (`npm run admin -- source-mode --id <id> --mode auto --yes`).
   - `off`: Events are stored as `ignored/source_off`.

MCP and REST tools may inspect sources and lower accept_mode (`auto` -> `observe` -> `off`). Raising to `auto` returns `403 owner_cli_required`.

## Canonical External Thread References

Canonical thread references identify discussion threads across systems:
- Pull Request: `github:<owner>/<repo>#pr/<number>`
- Issue: `github:<owner>/<repo>#issue/<number>`
- Commit: `github:<owner>/<repo>@<40-hex sha>`

Rules:
- Repositories are strictly lowercase.
- Issue and PR numbers are positive integers from 1 to 10^9.
- Invalid references return `400 invalid_thread_ref`.
- CI events map to each associated pull request (up to 5), or to the commit reference if no pull requests exist.

## Patch Task Continuation Behavior

Continuing a completed patch task reuses the existing local branch `swarmaa/<provider>/<id.slice(0, 8)>`. When a patch task is completed, its temporary worktree directory is pruned but the branch is retained. When continued, `createWorktree` detects the existing branch and re-adds a worktree pointing to it with `continued: true`, rather than branching afresh from `base_ref`.

## Limits and Invariants

- Webhook payload cap: 512 KiB (returns 413 if exceeded).
- Webhook rate limit: 120 requests/minute per source, 600 requests/minute per IP.
- Sweep batches: Up to 50 deliveries claimed per sweep (`FOR UPDATE SKIP LOCKED`).
- Sweep retry backoff: Exponential backoff (30s to 1 hour), failing after 8 attempts.
- Retention: Deliveries older than 30 days are automatically pruned.
- Zero GitHub API calls: Swarmaa does not store GitHub tokens, does not call `api.github.com`, and never pushes git branches.
