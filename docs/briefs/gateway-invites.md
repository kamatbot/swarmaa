# Brief: an invite-only swarmaa.com gateway, with a private space per invite

**Repo:** `~/Projects/swarma` (Node 24 + TypeScript + PostgreSQL 17).
**Gateway:** this service as published at `https://api.swarmaa.com`.
**Goal:** the hosted gateway becomes invite-only, and each invite creates a new, fully separate private space (tenant) for the person invited. Local installs from GitHub never need the gateway; that's a separate brief.

## Intended flow

1. **Owner mints an invite.** The gateway owner runs `npm run admin -- gateway-invite [--minutes N]` and gets a one-time code plus a signup URL (reuse the existing passkey signup URL shape with the code).
2. **Stranger connects an app over OAuth.** This covers Swarmaa for Mac, Claude Code, Codex and so on. The stranger arrives with no owner session.
   - With a valid unused invite code they create a passkey, and it belongs to a **new tenant** created for that invite. Reuse the existing invite-based signup page.
   - Without a code they see: "Swarmaa's hosted gateway is invite-only. Run Swarmaa locally from github.com/kamatbot/swarmaa, or ask for an invite." They can't register a passkey or approve anything.
3. **First approval.** After signup they land on the OAuth approval page for **their** tenant. A new tenant has no identities, so the page offers to create the first app identity and approve the connection in one step.
   - The identity is a `frontend` principal in their tenant, scope `project:general`, with the frontend permissions from `ROLE_PERMISSIONS`.
   - The existing owner (tenant `personal`) sees exactly today's page.
4. **Their tasks run only on worker Macs they connect themselves.** From their owner session they can mint a worker token for their tenant.
   - This is an "Add a worker Mac" action on the owner page. It creates a `worker` principal in their tenant with their scopes.
   - It shows the token **once**, with the bridge config snippet.
   - Workers are already tenant-scoped. Verify it, and add a test that a worker never claims another tenant's task.

## What exists (read these first)

- **`src/passkeys.ts`**
  - `PASSKEY_TENANT = 'personal'` is hard-coded for passkeys, invites, sessions and challenges.
  - `createInvite`, `inviteUsable` and `authorizeRegistration` (invite or owner session) live here.
  - Registration spends the invite. Sessions carry `tenantId`.
- **`src/http.ts` (~lines 150–340):** passkey routes, OAuth authorize and consent (`ownerTenant` comes from the owner session), and rate limits.
- **`src/oauth.ts` (~lines 260–330):** the consent page lists the `frontend` principals of the session's tenant and grants one.
- **Also relevant:**
  - `src/passkey-ui.ts`: page HTML.
  - `scripts/admin.ts`: the `passkey-invite` command, which invites a passkey into the `personal` tenant.
  - `db/migrations/007_passkeys.sql`: the passkey tables, which already have `tenant_id` columns.
- **Data is already isolated.** Every data table is keyed by `tenant_id` and principals carry `tenantId`, so the core tools are already tenant-isolated.

## Constraints

- **Keep `passkey-invite` working exactly as today.** Add a separate `gateway-invite` command that mints an invite bound to a fresh tenant id, such as `t_<random>`, stored on the invite row. Registering with it creates that tenant's first owner passkey.
- **Resolve the tenant from the credential.** Passkey sign-in must take the tenant from the credential's row, not the constant. Challenges, sessions and passkey listing and removal use the session's or credential's tenant.
  - The live database has a real owner passkey in `personal`; don't break its lookup.
- **No other way to create a tenant.** Not through OAuth registration, and not through the consent page without a session.
- **Keep the existing caps on dynamic client registration.** Don't build an account system.
- **Migration:** if you need one, it's `db/migrations/015_gateway_tenants.sql`. **Don't create 014**, because another branch uses it. Add 015 to any integration test that lists migrations explicitly.
- **Never cross tenants.** One tenant's data must never be visible to another.

## Tests (integration)

- An invited tenant can't see, claim or list the `personal` tenant's tasks, memories, sessions or identities.
- An invite works exactly once. An expired invite fails.
- Registration with neither an invite nor a session fails with the invite-only message.
- Consent for a new tenant creates its first identity.
- A minted worker token claims only its own tenant's tasks.
- The existing `personal` owner flows still pass unchanged.

## Rules

- Match the surrounding code style: terse and dense, with the same naming and comment density. No new dependencies. Smallest correct diff, with no abstractions nobody asked for.
- Every new route keeps the existing CSRF, rate-limit and cookie protections. Escape all HTML. Validate inputs.
- Never print secrets or tokens. Put a `timeout` on long commands.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Don't run migrations or commands against the live `DATABASE_URL` in `.env`; use only `TEST_DATABASE_URL` from `.env.test`. Don't restart launchd services and don't push.

## Acceptance

```bash
npm run build
timeout 300 npm test 2>&1 | grep -E "^ℹ (pass|fail)"                       # 0 fail
timeout 400 npx tsx --env-file=.env.test --test tests/*.integration.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^✖"   # 0 fail
```

Report:
- the invite → signup → consent → worker-token flow as built, with routes and pages
- the tests you added
- anything you left out
