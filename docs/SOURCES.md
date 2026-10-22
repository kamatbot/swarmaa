# Source provenance and technical references

The companion implementation was authored on 2026-10-21. These are primary references consulted for the design and current client/protocol contracts. A reference supports the documented interface; it does not certify this implementation or imply that the vendor has tested it.

## Reason Network

- Repository: https://github.com/reason-machines/reason-network
- Pinned commit: https://github.com/reason-machines/reason-network/tree/3e08ce1d4e538a5576f52cc06b62ca36c2360998
- Upstream package version at that commit: `0.12.3`.
- Local snapshot: `vendor/reason-network`.
- Source anchors: `src/store.rs` for SQLite message/session/outbox storage and cleanup; `src/daemon/sessions.rs` for stale sessions; `src/daemon/reason.rs` for the external Reason relay integration; `src/main.rs` for CLI argv; `src/mcp.rs` for peer tools; `src/claude.rs` and `src/setup.rs` for supported agent setup.

Reason supplies peer discovery, messaging and agent integration. Its message/session store is not this companion's authoritative memory/task system. The pinned code's outbox and stale-session cleanup are why the companion uses a separate durable database. Hosted Reason account/relay service code is not part of the public snapshot.

The vendor snapshot retains `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE`. It omits `.git` history and `.github` automation. Source fixture keys, if present under upstream test data, are upstream test fixtures and are not service credentials. No installer from the vendor snapshot was executed while preparing the archive.

## MCP, OAuth and events

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://developers.openai.com/plugins/build/mcp-events
- https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- https://www.rfc-editor.org/rfc/rfc7636 — PKCE
- https://www.rfc-editor.org/rfc/rfc8707 — OAuth resource indicators
- https://www.rfc-editor.org/rfc/rfc9728 — protected resource metadata
- https://www.rfc-editor.org/rfc/rfc7009 — token revocation

## Client and worker interfaces

- Claude Code CLI: https://code.claude.com/docs/en/cli-reference
- Claude MCP: https://code.claude.com/docs/en/mcp
- Codex CLI: https://learn.chatgpt.com/docs/cli/reference
- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp
- Antigravity MCP: https://antigravity.google/docs/mcp/
- Antigravity headless CLI: https://antigravity.google/docs/cli/headless/
- Grok Bot custom MCP connection behavior: https://docs.x.ai/grok-bot/team-bots
- Grok Bot routines: https://docs.x.ai/grok-bot/skills-routines-and-automations

The adapter flags and templates target the documented interfaces reviewed during authoring. Verify them against the versions actually installed on the user's machines. No blanket compatibility claim is made for future versions.

## Dependency metadata

Direct npm versions were selected from read-only public package metadata during authoring: `pg`, `ipaddr.js`, `typescript`, `tsx`, `@types/node` and `@types/pg`. The exact selected versions are in `package.json`. Dependencies were not installed or audited and no resolved transitive lockfile was generated in this session.

The optional container uses Node 24 and PostgreSQL 17 image families. Pin reviewed digests and preserve the generated npm lockfile when preparing a maintained deployment.
