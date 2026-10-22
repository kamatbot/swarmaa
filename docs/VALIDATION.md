# Local validation and acceptance

**Status at handoff:** all tests in this repository are authored and unexecuted. No passing result is claimed. The commands below are for a local engineer or Claude Code session after the user authorizes execution. They do not require GitHub Actions, a remote push or a public deployment.

## 1. Dependencies and source checks

Use Node.js 24 and record the installed Node/npm versions. Install the pinned direct dependencies, inspect the generated dependency lockfile, then run:

```bash
npm install
npm run typecheck
npm test
npm run build
```

The build emits `dist/src/server.js`, `dist/src/bridge.js`, `dist/src/stdio-proxy.js` and compiled scripts/tests. Database migrations remain source files under `db/migrations` for the source migration command; the Dockerfile copies them into `dist/db` for its compiled migration command.

`npm test` runs unit tests and any integration files discovered by the glob. The PostgreSQL suites **skip** if `TEST_DATABASE_URL` is absent. A green run with skipped integration tests is not database verification. Fix actual compiler/test findings before moving on. Do not change assertions merely to hide a behavior defect.

## 2. Disposable PostgreSQL integration tests

Create a database used only for validation. The supplied Compose instance can host a separate `collective_test` database after you initialize local credentials and start it:

```bash
npm run init:local
docker compose up -d db
docker compose exec db createdb -U collective collective_test
```

If `.env` already exists, do not rerun the initializer; it intentionally refuses to overwrite it. Create a private `.env.test` containing an explicit connection URL for the disposable database:

```dotenv
TEST_DATABASE_URL=postgresql://collective:YOUR_LOCAL_PASSWORD@127.0.0.1:54329/collective_test
```

Replace the placeholder privately, restrict the file's permissions, and keep it out of chats/Git. Run:

```bash
node --env-file=.env.test --import tsx --test tests/*.integration.test.ts
```

The suites create randomly named schemas and remove only those schemas. They require schema-creation permission in the designated test database. They do not fall back to `DATABASE_URL`. Always inspect the target URL yourself before executing database tests.

### Authored coverage

| Suite | Important scenarios |
|---|---|
| Core integration | Tenant/scope/role authorization; proposed directives and conflicts; concurrent memory edits; retraction; idempotent submit/continue/finish; stale leases; task cancellation; retries; patch coordination; text artifacts; event cursors |
| OAuth unit/integration | PKCE, redirect validation, browser CSRF, admin rejection, one-use codes, audience binding, hashed tokens, refresh replay, grant narrowing/expiry/revocation and concurrent exchanges |
| Transport unit | Legacy/modern MCP framing, routing metadata, notification handling, auth/Origin guards, safe failures, REST audience separation and body limits |
| Events integration | Signed verification, deterministic refresh, encrypted secrets, rotation, scoped access, delivery, OAuth revocation, unsubscribe and failed challenge handling |
| Webhook unit | Callback URL policy, non-public IPv4/IPv6, authenticated secret encryption and signature binding |
| Bridge source tests | Configuration, lease interruption, capability/mode checks, bounded subprocess behavior, proxy framing and local patch ownership |

The presence of these cases describes intended coverage. It does not establish they compile or pass until you run them. Mock/fake receivers do not replace a real HTTPS callback check.

## 3. Start the demo service

Apply migrations to the local demonstration database, provision the README identities, start `npm run dev`, then run:

```bash
node --env-file=.env --import tsx scripts/demo.ts
```

Expected successful output contains a memory ID, task ID, artifact ID, `task_status: "completed"` and `provider_integration_verified: false`. This demonstrates one service flow with three identities and no model invocation. Confirm that restarting the service retains the records.

Use a second connection restricted to another project and confirm it cannot read the demo memory, task or artifact, even with their UUIDs. Submit the same idempotency key twice and confirm it returns one task; change the payload while reusing the key and confirm rejection. Check that conflicting memory proposals remain inspectable and that owner promotion advances the expected version.

## 4. Real worker acceptance

Choose one installed CLI and a disposable project containing a few non-sensitive text files. Verify its version and supported flags against `src/bridge/adapters.ts` and the official documentation linked in `AGENT_SETUP.md`. Leave patch settings off. Keep the worker's service credentials outside that project.

Configure one project and one provider, start the bridge, and submit a read-only review using the exact configured capability. Observe a queued task becoming running, checkpoints appearing, then an artifact and terminal result. Inspect the actual local directory for unexpected changes. Confirm the result says acceptance criteria remain unverified and includes source evidence in the transcript.

Cancel a running demo task; observe that subsequent writes using its old lease fail and that the provider process is stopped. Interrupt network access or stop the worker and verify bounded expiry/retry behavior. A replacement worker must use a different principal; it should see stored checkpoints and must not reuse the old lease token. Treat a paused/sleeping-host patch scenario as a separate high-risk test before any patch opt-in.

## 5. Actual app interoperability

Record app and CLI versions. For each connection, verify tool discovery, a permitted `context_get`, and denied access to another scope. Desktop clients should work through the provided stdio proxy; use public HTTPS for hosted clients.

Perform this concrete handoff in the actual apps:

1. In Dot, publish a sourced demo note and submit a review task.
2. In Grok, retrieve the same memory and task by ID while it is running.
3. Allow the configured Claude/Codex worker to finish and publish its artifact.
4. In Grok, read the result and continue the task with its expected version and a new stable continuation key.
5. In Dot, read that continuation and its eventual result.
6. In Claude, Codex and Antigravity, read the same shared context through MCP.

This is the acceptance target for the user's collective network. REST calls made with principals named `dot` and `grok` do not establish that the real apps connected.

## 6. OAuth and events

Exercise the real client registration/consent/PKCE flow. Confirm the page shows only the intended non-admin connection and projects. Verify that an OAuth access token is rejected by REST and accepted by `/mcp`. Revoke the family and confirm access stops. Rotate the provisioned connection token and reconnect only the intended client.

For Dot events, configure the actual allowed callback hostname, verify one challenge and one event, repeat subscription refresh, then unsubscribe. Revoke the authorizing OAuth grant and confirm later events are skipped. Inspect the delivery table's metadata without copying callback secrets or URLs into transcripts.

For Grok callbacks, verify the receiver's current URL/auth/payload contract using its own setup screen or official docs. Register a narrow demo-scope sink and confirm a received event leads only to the requested reconciliation. Keep automatic task creation off while checking feedback loops.

## 7. Optional patch and second worker

After read-only acceptance, an explicit user decision can enable the Claude file-patch adapter in an isolated checkout. Provision its `task:patch` permission, enable both local configuration flags, and use one consistent resource key. Review the resulting diff; the adapter does not run tests, commit or integrate it.

Try two bridge processes on the same project root and verify the local patch guard prevents concurrent writers. After a simulated crash, inspect the surviving lock and old processes before removing it. Verify cancellation cooldown and stale-generation rejection. Do not infer cross-host filesystem isolation from this same-host check.

## Record actual results

Create a local validation note with versions, commands, pass/fail/skip counts, migrations applied, client connection results and unresolved defects. Preserve failures that expose real behavior. Only call a component operational after its own acceptance scenario succeeds.

Tests and builds were not run. Local Codex should validate the changes before integration. This guide provides the equivalent sequence for Claude Code when authorized by the user.
