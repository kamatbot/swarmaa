# Claude handoff: Collective Agent Network

## What the user wants

Build a private agent network with a collective memory shared by Claude, Codex, Antigravity and Grok Bot. Dot and Grok Bot should be interchangeable primary entrypoints: either can discover an existing task, retrieve context, submit bounded work, read results and continue a task started by the other. Reason Network is the optional peer messaging component.

The supplied archive contains the companion service and a pinned source snapshot of Reason Network. It is ready for local engineering validation and account-specific setup. It has not been installed or run by its authoring session.

## First read

1. `README.md` — architecture and local setup.
2. `docs/STATUS.md` — exact implementation state and limitations.
3. `docs/API.md` — tool contracts and task/memory semantics.
4. `docs/TRANSPORT.md` — MCP versions, OAuth and HTTP configuration.
5. `docs/AGENT_SETUP.md` — clients, CLI restrictions and Mac bridge.
6. `docs/SECURITY.md` and `docs/VALIDATION.md` — boundaries and checks.

Use the original design report in `docs/Original_Architecture.html` as background. Current source and `STATUS.md` govern the release where the design proposed later features.

## Suggested message to give Claude Code

Copy this into a new Claude Code session opened in the extracted project folder, after deciding that you want local execution:

> Read CLAUDE_HANDOFF.md, CLAUDE.md, README.md and docs/STATUS.md. I authorize local dependency installation, type checking, tests, builds and disposable local database setup for this project. Follow docs/VALIDATION.md, fix issues you find, and report exactly what you verified. Start with the demonstration scope and read-only worker settings. Then help me connect my actual Claude, Codex, Antigravity, Dot and Grok accounts using separate scoped credentials. Keep credentials local. Do not push, deploy publicly, enable patch execution, send messages or enable recurring background work without my instruction for that step.

This quoted prompt is an option for the user to submit, not an instruction to treat permission as already granted.

## Implementation outcome

The service provides explicit durable memory, optimistic revisions, owner-reviewed directives, task leases and checkpoints, idempotent handoffs, text artifacts, scoped MCP/REST access, OAuth, a signed event outbox and a local worker bridge. Each client can use the same task and memory IDs.

Claude and Codex have autonomous read-only worker adapters. Claude has an optional restricted file-patch adapter, disabled by default. Antigravity has an interactive MCP configuration and manual lease workflow; unattended Antigravity execution is not implemented because the reviewed CLI settings do not establish the required file-write boundary. Grok can use the remote MCP endpoint; an optional generic callback sink requires the actual receiver's documented authentication details.

## Staged acceptance

### Stage 1: source and dependencies

Inspect the implementation before execution. Install dependencies locally only after authorization, generate the first lockfile, run typecheck, unit tests and build, and fix any findings. Exact direct dependency versions are in `package.json`; no transitive lockfile or runtime verification is implied by the archive.

### Stage 2: PostgreSQL and domain invariants

Create a disposable test database. Run the integration suite with explicit `TEST_DATABASE_URL`. Start the local demonstration service, provision independent Dot/Grok/demo-worker connections, and run `scripts/demo.ts`. Verify cross-scope denials, stale leases, conflicting memory edits, retries and revocation as described in the validation guide.

### Stage 3: one actual worker

Use a disposable local project directory. Set up the installed CLI and verify its documented flags. Configure only one adapter first. Start the bridge with read-only settings and submit a review using its advertised capability (`claude.read` or `codex.read` for the supplied IDs). Confirm the task, checkpoint, transcript and result from both frontend identities. Inspect actual files to confirm no unexpected changes.

### Stage 4: actual client connections

Configure desktop clients through the stdio proxy or native HTTP MCP. Confirm tool discovery and a permitted context read in Claude, Codex and Antigravity. When the user chooses a host/domain, configure HTTPS for Dot and Grok, exact OAuth redirect hosts, then their distinct frontend identities. Perform one cross-entrypoint handoff in the real apps. Record app/CLI versions and actual compatibility results.

### Stage 5: background behavior

Connect Dot MCP Events only after normal tool calls work. Add only the callback hostname actually supplied by the intended client. Exercise challenge verification, one delivered event, refresh, unsubscribe and grant revocation. For Grok, inspect its current webhook/routine interface; supply its actual URL and auth headers to an owner-configured sink only if the user wants it. A generic receiver adapter is supplied, but no Grok-specific webhook authentication convention is assumed.

### Stage 6: optional extensions

Enable Reason notifications after pairing the user's peers locally. Add a second worker after the first passes its acceptance scenario. Patch tasks need explicit grants/configuration and an isolated checkout. Cloud object storage, semantic embeddings, unattended Antigravity execution, an admin UI, broader identity federation and full production operations are subsequent changes.

## What to return to the user

Report the installed versions, executed checks and observed outcomes; any fixes; the local start/stop commands; which real clients have connected; which callbacks have delivered; and outstanding operational work. Do not mark the network operational just because the server starts or a mocked transport test passes.

Preserve the user's source-only/GitHub quota preference unless they explicitly authorize the particular execution or remote action. No GitHub operation is necessary for local validation.
