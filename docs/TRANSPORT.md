# HTTP, MCP and OAuth

This service exposes one shared authorization and tool layer through REST and MCP. All changes still pass through `CoreService`; a transport cannot grant additional projects or permissions. It stores durable state in PostgreSQL rather than in an MCP connection.

## What is implemented

| Interface | Implemented behavior |
| --- | --- |
| REST tools | `POST /api/tools/<tool_name>` with a provisioned bearer connection token and the tool arguments as JSON. Response: `{ "result": ... }`. |
| MCP 2025-11-25 | Stateless Streamable HTTP, legacy `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`; JSON responses. |
| MCP 2026-07-28 | Per-request protocol metadata, mandatory metadata headers, `server/discover`, `ping`, `tools/list`, `tools/call`; `resultType: "complete"` results. |
| Dot MCP Events | `events/list`, `events/subscribe`, `events/unsubscribe` forwarded to the configured event backend, advertised only in modern discovery when the backend exists. See the event documentation for callback validation and delivery. |
| OAuth | Public-client authorization code flow with mandatory S256 PKCE, dynamic client registration, resource-bound opaque access tokens, refresh rotation, token-family revocation on refresh replay, and a browser consent form. |
| Readiness | `GET /healthz` reports process availability. `GET /readyz` checks a database connection. |

`GET /mcp` and `DELETE /mcp` return HTTP 405. This implementation does not create protocol sessions, offer SSE streams, implement `subscriptions/listen`, sample a client model, or request elicitation. These capabilities are not advertised. Asynchronous work uses durable task tools; change notifications use the event webhook extension or `events_poll`.

The MCP implementations are authored against the official revisions linked below. Source review is not a substitute for an interoperability run with the actual clients. The authored test suite was **not executed** in the delivery environment, and no external Claude, Dot, or provider account was connected during authoring.

## Endpoint and proxy configuration

Set `PUBLIC_URL` to the externally visible origin, for example `https://memory.example.com`. Do not include `/mcp`, another path, a query, user credentials, or a fragment. The MCP URL is then `https://memory.example.com/mcp`.

Use HTTPS outside local development. HTTP is accepted only when `ALLOW_INSECURE_LOCALHOST` is explicitly enabled and the public hostname is `127.0.0.1`, `localhost`, or `[::1]`. Bind the development listener to loopback. For a public deployment terminate TLS at a reverse proxy and forward the original `Host` header exactly.

The service validates `Host` against `PUBLIC_URL`. It validates every present `Origin` against the public origin and configured `ALLOWED_ORIGINS`. CORS origins must be exact origins, including a non-default port if relevant. No wildcard is accepted by the configuration validation. Requests without `Origin`, such as CLI and server clients, still require bearer authentication. Local process health checks may use a loopback host and the configured listener port.

Forwarded host and IP headers are not trusted. Apply network rate limits and request timeouts at the TLS proxy as well. All users sharing a proxy IP also share this process's IP limit. The process limits concurrent requests to 64; general traffic to 600 requests per socket IP per minute and 600 per authenticated principal per minute; registrations to 6 per socket IP per minute; authorization-page activity to 30 per minute; and token requests to 60 per minute. These are conservative single-process controls, not a distributed rate-limiting service.

Request bodies are bounded to 512 KiB for tools and MCP, and to 16 KiB for OAuth. A request body has a 15-second read deadline. Compressed request bodies are rejected. Security headers disable caching and referrer transmission; the authorization form is protected against framing and has no scripts. Failure logs contain a generated request ID and safe error code, never credentials, request bodies, SQL, or stack traces. Configure proxy logs to avoid OAuth query strings and all request bodies.

Serialized JSON responses have a fixed 6 MiB maximum, including MCP framing and duplicated text/structured content. The service checks this before committing response headers. An oversized result returns HTTP 413 with `response_too_large`; reduce the list limit or `memory_get` history/proposal limits and retry. This bounds accidental large reads while preserving an explicit repair path.

## Provisioned-token connections

Provision an independent identity for each Claude, Codex, Antigravity, Dot, or Grok connection. Give frontend identities only the projects they can read and submit work to; give worker identities the capabilities their job adapters need. Keep the administrator identity separate from client connections.

For a direct HTTP MCP client, send:

```http
Authorization: Bearer <provisioned-connection-token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The local stdio proxy retrieves its credential from its configured local environment and forwards it over HTTP. Consult the integration instructions for the client-specific MCP configuration. After building, its compiled entry point is `dist/src/stdio-proxy.js`.

REST example, where `COLLECTIVE_TOKEN` is a locally stored provisioned token:

```bash
curl --fail-with-body https://memory.example.com/api/tools/context_get \
  -H "Authorization: Bearer $COLLECTIVE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"scope":"project:demo"}'
```

An OAuth-issued `cn_access_...` token is accepted at `/mcp` and at the read-only event stream `GET /api/stream`, which carries ids and metadata, never bodies, and still requires `events:read` in the grant. That lets apps signed in remotely with OAuth receive live updates. It cannot authenticate a REST tool request, so a token issued for the MCP resource never becomes a credential for the tool API.

## Legacy MCP request example

First send `initialize` with `protocolVersion: "2025-11-25"`, capabilities, and client information. The initialization response includes the negotiated legacy version. The client sends `notifications/initialized` and includes `MCP-Protocol-Version: 2025-11-25` on subsequent requests.

```http
POST /mcp
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-11-25

{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"context_get","arguments":{"scope":"project:demo"}}}
```

Successful calls have a standard MCP `content` text block and, for object results, `structuredContent`. Domain errors such as a stale revision are returned with `isError: true` so the client can repair the tool request. Protocol errors use JSON-RPC errors. Notifications never execute tools or events, and JSON-RPC batches are rejected.

## Modern MCP request example

Modern clients do not use the legacy initialization handshake. Every request carries `protocolVersion` and `clientCapabilities` inside `params._meta`; `clientInfo` is recommended and validated when present. HTTP headers must mirror the body. `Mcp-Name` is required for `tools/call`, `resources/read`, and `prompts/get`, including requests for unsupported methods so that header validation remains consistent.

```http
POST /mcp
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: context_get

{
  "jsonrpc": "2.0",
  "id": "context-1",
  "method": "tools/call",
  "params": {
    "name": "context_get",
    "arguments": { "scope": "project:demo" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "example-client", "version": "1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The service uses `-32020` for missing or mismatched modern headers, `-32022` for unsupported versions, HTTP 404 plus `-32601` for unknown modern methods, and `resultType: "complete"` for successful results. Modern header values using the specified Base64 sentinel are decoded strictly before comparison. This service does not currently publish tool schema parameters with `x-mcp-header` annotations.

## OAuth connection flow

Enable OAuth and configure `OAUTH_REDIRECT_HOSTS` with the exact callback hostnames used by the clients you intend to connect. Hostnames are allowlisted without wildcards. Registered redirect URIs must be canonical HTTPS URLs and are then matched as complete strings, including path, port, and query. Local HTTP callbacks require both an explicit loopback host entry and the local-insecure setting. Do not add a hostname merely to make an unexpected registration succeed; inspect the callback supplied by the actual client.

The routes are:

| Route | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata for the exact `/mcp` audience; advertised by `WWW-Authenticate`. The origin-level resource metadata route is also available. |
| `/.well-known/oauth-authorization-server` | Authorization server metadata, including endpoints and supported PKCE method. |
| `POST /oauth/register` | Public-client dynamic registration. No client secret is issued. |
| `GET /oauth/authorize` | Validate client, exact redirect, resource, and S256 challenge; create a browser-bound request. |
| `POST /oauth/authorize` | Identify a provisioned non-admin connection and then approve or deny its displayed grants. |
| `POST /oauth/token` | Exchange a code using its verifier, or rotate a refresh token. |
| `POST /oauth/revoke` | Revoke the grant family associated with a possessed access or refresh token. |

An authorization request requires `response_type=code`, a registered `client_id`, its exact `redirect_uri`, `resource=https://your-host/mcp`, `code_challenge_method=S256`, and a valid challenge. Clients should send a fresh `state` value and validate it on return. The only OAuth scope is `mcp`; it does not confer a project or role. The service echoes state unchanged and includes its issuer in the authorization response.

1. The user opens the client connection flow and reaches the service authorization page.
2. The user enters the **non-admin connection token** previously provisioned for that client. The token is authenticated and is never saved in the OAuth tables, logged, or rendered into the next page.
3. The page shows the identity, role, projects, permissions, and exact callback URI. The user approves or denies. The client name is explicitly identified as self-reported.
4. Approval creates a short-lived one-use code. The client exchanges it with the original PKCE verifier and resource. A wrong verifier does not consume a valid code.
5. The client receives an access token valid for at most one hour and a rotating refresh token. The authorization family expires at most 30 days after issuance; rotation does not extend that lifetime.

The browser flow uses an HttpOnly SameSite cookie, a separate hashed per-request CSRF nonce, exact Origin verification on POST, and nonce rotation between the identity and approval steps. Authorization requests expire after ten minutes; codes expire after two minutes. Codes, access tokens, and refresh tokens are stored only as SHA-256 digests of cryptographically random material.

Refresh rotation is transactional. A refresh token is consumed once; replay of an already consumed token revokes the whole family, including existing access tokens. A client must therefore serialize refreshes and securely save the new refresh token before its next refresh. Access is checked against both the approved grant snapshot and the current provisioned identity on every request. Adding a project or permission later does not expand an existing authorization. Disabling the principal or turning it into an admin prevents OAuth access. Narrowing is persisted when refreshing. Event subscriptions created through OAuth are bound to the grant family; the event backend rechecks that family and its grants before delivery.

No administrator connection token can be used to authorize OAuth. The client cannot request a tenant, role, permission, or project through the authorization form. The service never accepts a third-party provider token as its own bearer token.

## Operational maintenance

Use PostgreSQL backups and the service's identity-management instructions for revocation. OAuth registration is intentionally bounded to 1,000 registered clients; removing obsolete registrations is an explicit owner database-maintenance operation. Do not automatically delete active clients.

Expired pending authorizations are pruned when new authorizations begin. Schedule ordinary database maintenance for expired code rows, expired grants, and expired access-token rows. Keep consumed refresh-token records until their family expires so replay can still be detected; deleting them early defeats family-replay revocation. A subscription references its OAuth grant, so first archive any required delivery/subscription evidence, then delete eligible delivery rows and their expired/inactive subscriptions before deleting an expired grant. The foreign keys deliberately prevent silently discarding referenced grants. `oauth_grants` cascades deletion to its access and refresh records only. Select retention periods explicitly; these maintenance steps must not automatically discard relevant audit evidence. Do not copy these database tables into client project uploads.

The raw provisioned token is an administrative connection bootstrap credential. Store it securely even after OAuth authorization; rotating or disabling the underlying identity is the service owner's recovery path. For a multi-person public service, use a mature identity provider and security-reviewed OAuth deployment before opening arbitrary user registration. This implementation is intended for the owner's private agent network and does not provide account signup, email login, MFA, or organization membership management.

## Authored validation coverage

`tests/transport.test.ts` covers legacy and modern result framing, metadata/header mismatch, notification mutation rejection, safe errors, event forwarding, Origin/auth guards, body limits, JSON parsing, and REST rejection of OAuth-shaped access tokens.

`tests/oauth.test.ts` covers grant narrowing, redirect policies, PKCE reference values, and consent-page HTML escaping. `tests/oauth.integration.test.ts` uses `TEST_DATABASE_URL`, creates an isolated temporary schema, applies the identity/OAuth migrations, and exercises consent CSRF, admin-token rejection, exact audience binding, bad PKCE, single-use codes, hashed storage, grant narrowing, refresh replay, revocation, and disabled identities. It skips when the dedicated test database variable is absent and never defaults to the live `DATABASE_URL`.

`tests/events.integration.test.ts` uses the same explicit test-database rule and a fake in-memory callback receiver. It covers challenge signing, idempotent refresh, secret rotation, project isolation, durable delivery, OAuth-family revocation, unsubscribe, and failed verification. No real callback endpoint is contacted by this test.

The delivery records these tests as **written, not run**. Run them locally only after choosing to install dependencies and execute the project. Database integration tests need schema-creation permission in the designated disposable test database. No GitHub workflow or hosted CI is required.

## Protocol references

These are the primary sources consulted during authoring on 2026-10-21:

- [MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP 2026-07-28 base protocol and per-request metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
- [MCP 2026-07-28 versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [OpenAI Dot MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [RFC 7636: PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 9728: protected resource metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 8707: OAuth resource indicators](https://www.rfc-editor.org/rfc/rfc8707)
- [RFC 7009: token revocation](https://www.rfc-editor.org/rfc/rfc7009)
