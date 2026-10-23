# Setup and operations

These commands are provided for your local environment and were not executed while authoring the archive. Complete the validation guide before relying on this service for unattended work.

## One authoritative service

Run one PostgreSQL-backed service as the initial authority. Both entrypoints connect to its `/mcp` URL; desktop agents and the Mac bridge connect to the same origin. Do not run separate databases on the Mac mini and Mac Studio and try to merge their memory tables. A second Mac is another worker with its own credential and local project registry.

For local development use the README flow: install dependencies, generate `.env`, start the database, apply migrations and run the service. `HOST=127.0.0.1` is the default. The database Compose port is also bound to loopback. Stopping containers without deleting their volume preserves state:

```bash
docker compose stop
docker compose start db
```

Never use `docker compose down -v` on a database whose contents you want to keep.

## Public HTTPS for Dot and Grok

Choose a private deployment host or an authenticated network arrangement that your actual clients can reach. The application itself speaks HTTP; a reverse proxy terminates public HTTPS. Configure:

```dotenv
PUBLIC_URL=https://collective.example.com
ALLOW_INSECURE_LOCALHOST=false
ALLOWED_ORIGINS=https://collective.example.com
OAUTH_ENABLED=true
OAUTH_REDIRECT_HOSTS=EXACT_CLIENT_REDIRECT_HOSTNAMES
EVENT_CALLBACK_HOSTS=EXACT_INTENDED_RECEIVER_HOSTNAMES
```

Replace the example domain and placeholder allowlists. Hostnames are comma-separated, without schemes, ports or wildcards. OAuth's registered redirect URIs are subsequently matched in full. Webhook callbacks require public DNS hostnames and HTTPS port 443. Do not paste callback URLs, credentials or query-string secrets into access logs.

Preserve the public `Host` header when proxying. Forward `/mcp`, `/oauth/*` and the well-known metadata paths. A bearer-authenticated REST endpoint is available at `/api/tools/*` for the bridge. The proxy should bound request size/time and rate-limit clients; the application deliberately ignores forwarded IP/host headers and therefore sees a shared proxy IP for its process-level rate limit. Its own body limit is 512 KiB, with 16 KiB for OAuth.

Keep PostgreSQL off the public network. Keep the application listener on loopback or a private container network. Set database credentials and the event encryption key through the deployment's secret mechanism. A browser page, server health check or TLS certificate does not establish working agent interoperability; perform the actual client checks in `VALIDATION.md`.

## Optional application container

After generating and reviewing `package-lock.json` and completing local verification, the supplied Dockerfile builds the service from source. It deliberately requires that lockfile. It runs as the image's non-root `node` user. Container commands inherit environment values supplied by Compose and do not require an `.env` file inside the image.

```bash
docker compose --profile app build service
docker compose up -d db
docker compose --profile app run --rm service node dist/scripts/migrate.js
docker compose --profile app up -d service
```

The app container is optional; the default Compose command starts only the database. The example publishes the app on host loopback port 8787 for a reverse proxy on that host. Migrations are an explicit separate step and are not automatically run on every service startup. Review and pin exact base-image digests for a deployment you intend to maintain.

## Connections and roles

Provision one identity per client or independently revocable worker. The CLI requires direct database access and is an owner operation; no HTTP account-signup endpoint exists.

```bash
npm run admin -- list
npm run admin -- create --name macstudio --role worker --scopes project:demo --out .local/macstudio.json
npm run admin -- rotate --name grok --out .local/grok-rotated.json
npm run admin -- revoke --name macstudio
```

Output files must be new paths; the CLI reserves them before changing credentials. After rotation update the client's private secret and reconnect OAuth. Rotation revokes derived grants and stops that identity's subscriptions. Revocation disables the identity; provision a new named connection to restore access. In-flight operations already authorized before revocation may finish, and a process already running on a worker stops when it observes lease loss.

The roles are:

| Role | Intended holder | Default authority |
|---|---|---|
| `frontend` | Dot or Grok connection | Read/write sourced memory; submit, continue, read and cancel tasks; read artifacts/events |
| `worker` | A bridge or interactive agent | Read/write sourced memory; claim and work tasks; read/write leased artifacts; read events |
| `admin` | Local human-owner tooling | Owner review, promotion/retraction and other administrative access; never delegated through OAuth |

Only an admin can use wildcard project scopes. Other scopes must match exactly. Model-produced source claims remain reported evidence even when a caller labels a source as `user` or `document`.

For an interactive agent that must submit its own tasks, provision it with explicit `--grant task:submit`; normal entrypoint submission does not need this addition. For a patch worker, use a separate credential with `--grant task:patch` and configure both adapter/project opt-ins. Read the patch restrictions and local lock recovery in `AGENT_SETUP.md` before doing this. Capability names route jobs; they are not a substitute for grants.

## OAuth connection

When a client initiates OAuth, inspect the redirect hostname it actually supplies and add that exact intended hostname to `OAUTH_REDIRECT_HOSTS`. The implementation supports dynamic registration of public clients and requires PKCE S256. If an app requires a different OAuth contract, treat that as an interoperability issue to resolve; do not loosen redirects or accept arbitrary tokens as a workaround.

On the service consent page enter the dedicated **non-admin** token for that client. The next page shows its projects and permissions. OAuth access tokens only authenticate `/mcp`; use provisioned worker tokens for REST. Tokens contain no model-provider API credentials. Reconnecting a client does not automatically connect its own model account or local CLI.

## Dot events

Normal MCP tools work independently of events. To expose event methods, configure both `EVENT_ENCRYPTION_KEY` and at least one allowed callback hostname, then restart the service. Dot supplies its callback URL and signing secret when it subscribes. The application verifies the signed challenge before activating a subscription.

Supported names are `task.updated` and `memory.changed`, filtered by a required exact `scope`. Events contain IDs and state metadata; they are not instructions to execute more work. Ask Dot to read the current task/memory after an event, and avoid a rule that creates a new task on every task update.

MCP subscriptions default to 24 hours and grant at most seven days. A request for no expiration receives a finite default. Refresh preserves identity and rotates signing secrets with a five-minute overlap. Verification caching is bounded to five minutes. There is no protocol replay; use read tools to reconcile current state after interruptions.

Each event ID remains stable across up to eight delivery attempts. Retryable failures use bounded exponential backoff; HTTP 410 disables the subscription and HTTP 413 ends that delivery. Authentication, scope, permission, OAuth grant status and expiry are rechecked before each delivery. A request already in flight cannot be recalled. A 2xx callback means receipt, not task completion.

Inspect subscription metadata without printing callback URLs or keys:

```bash
npm run admin -- subscriptions
npm run admin -- remove-sink --id sub_REPLACE_WITH_ID
```

## Grok or another generic receiver

Grok's remote MCP connection provides normal shared access. For an optional webhook/routine wake-up, first obtain the real receiver URL, documented authentication header and expected payload behavior from your own Grok setup. Do not assume a particular header convention. The adapter posts this JSON shape:

```json
{
  "eventId": "uuid",
  "name": "task.updated",
  "timestamp": "ISO-8601 time",
  "data": { "scope": "project:demo", "subject_id": "task-uuid", "change": { "status": "completed" } },
  "cursor": null
}
```

Supply `CALLBACK_URL` and `CALLBACK_HEADERS_JSON` through a private environment file or secret manager. `CALLBACK_HEADERS_JSON` is a JSON object containing at most four actual receiver headers; use `Authorization` or a custom `X-...` header as documented by the receiver. Values are encrypted at rest. Then register the sink under the scoped Grok connection:

```bash
npm run admin -- add-sink --name grok --scope project:demo --event task.updated --days 7
```

The generic owner-configured mode does not send the MCP verification challenge or assume Standard Webhooks authentication. It still validates destinations, rechecks the identity, retries with stable IDs and bounds the response. Register a receiver only when you intend it to receive that scope's metadata. It expires after the requested 1–30 days. If Grok requires another body format, add an explicit small adapter and verify it against your real receiver. Normal MCP access remains usable while that work is pending.

## Backups, keys and retention

Back up PostgreSQL and retain the event encryption key separately in a secure owner-controlled location. Restore both into a private environment and verify reads before switching clients. Losing `EVENT_ENCRYPTION_KEY` makes stored callback signing secrets unrecoverable; it does not lose memory/tasks, but affected subscriptions must be recreated. This version does not implement encryption-key rotation with a key ring.

There is no automatic memory/task/event retention deletion job. Choose a retention policy before accumulating large volumes. Retraction scrubs memory bodies from live memory/revision/proposal records and clears structured task context references; it does not remove backups, previously copied artifacts, provider transcripts or notes a client already downloaded.

OAuth cleanup must preserve refresh replay records while a grant lives. Event deliveries and subscriptions reference grants: archive the required operational evidence, remove expired deliveries/subscriptions that are no longer needed, then remove expired grants and their token records. Review the schema before any maintenance SQL. Do not run broad deletion against an active service just to resolve a foreign-key error.

## Stop and recover

Stop a foreground bridge with Ctrl-C; it requests subprocess termination and reports incomplete work. Stop the server with Ctrl-C/SIGTERM; it stops accepting new work, waits for bounded in-flight activity and closes the pool. Restart the service against the same database to retain state. Expired tasks become claimable through the bounded retry policy; a new worker resumes from durable context/checkpoints, not from a hidden provider conversation state.

Inspect a task's current status and artifacts before continuing an ambiguous completion. Use its expected version and a stable continuation idempotency key. For patch work, inspect local files and any surviving workspace lock before starting another writer; a crashed-process lock is intentionally an operator recovery step.

## Owner passkey sign-in

The OAuth approval page signs the owner in with a passkey (WebAuthn), then lets them pick the non-admin connection identity the agent receives. Passkeys need the public HTTPS `PUBLIC_URL`; over plain loopback the approval page keeps the connection-token method. Apply migration `007_passkeys.sql`, then run `npm run admin -- passkey-invite [--minutes 30]` (or `npm run setup`) and open the one-time `/account?code=...` link it prints. The link is a secret; it is stored only as a hash and expires after use. The owner session cookie (`swarmaa_owner`, 12 h) is never accepted on `/mcp` or `/api/tools/*`.

For hosted invitations, apply `015_gateway_tenants.sql` after the existing migrations and run `npm run admin -- gateway-invite [--minutes 30] [--out /private/new-file.json]`. This creates a fresh `t_…` tenant and returns its one-time code and `/account?code=…` signup URL. `passkey-invite` still adds an owner passkey to `personal`. Codes expire after 1–1440 minutes (default 30); only their hashes are stored. Treat the code and URL as secrets, and use `--out` to avoid terminal output.

Visitors to `/oauth/authorize` without an owner session see the invite-only message, existing-passkey sign-in, and “Have an invite?”. That link opens `/account` with a local OAuth return path; entering the invite code and completing passkey signup returns to approval. Opening the invite URL directly lands on the account page; start the app's OAuth connection to approve it. First approval in the new tenant creates one `frontend` identity with `project:general` and the standard frontend permissions. Existing identities retain the selection/review flow. Dynamic client registration does not create a tenant or identity and keeps its existing caps.

On `/account`, “Add a worker Mac” posts to `/account/workers` using the owner session. It creates a worker in that tenant with standard worker permissions and the union of its enabled non-admin frontend projects (or `project:general` before first approval). The token appears once alongside a bridge configuration snippet. Set `COLLECTIVE_WORKER_TOKEN` privately on that Mac, adjust the snippet's binary and project paths, and run the existing bridge setup. No worker is connected automatically. The bridge supports at most 50 projects; patch execution is off by default. Reloading the page cannot recover the token. Owner actions require same-origin JSON; OAuth approval retains its browser cookie and single-use CSRF checks.
