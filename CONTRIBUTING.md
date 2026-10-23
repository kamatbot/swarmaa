# Contributing to Swarmaa

Thank you for your interest in contributing to Swarmaa!

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 24.x** (see `.nvmrc` and `package.json` `engines`)
- **npm** (bundled with Node.js 24)
- **PostgreSQL 16+** (PostgreSQL 17 recommended; required only when running the service locally or executing `*.integration.test.ts`)

## Development Workflow

1. **Install dependencies:**
   ```bash
   npm ci
   ```
2. **Run static type checking:**
   ```bash
   npm run typecheck
   ```
3. **Run unit tests:**
   ```bash
   npm test
   ```
4. **Build the TypeScript project:**
   ```bash
   npm run build
   ```
5. **Run PostgreSQL integration tests (optional, requires a disposable test database):**
   Create a dedicated test database (never use a production database) and pass `TEST_DATABASE_URL`:
   ```bash
   TEST_DATABASE_URL=postgresql://collective:password@127.0.0.1:54329/collective_test npm run test:integration
   ```
   Each integration suite creates an isolated temporary schema and drops only that schema upon completion.

## Architecture and Security Invariants

Before opening a pull request, read [AGENTS.md](AGENTS.md) and [docs/SECURITY.md](docs/SECURITY.md). In particular:

- Keep tenant, scope, role, and permission checks in `src/core/`, not only in HTTP/MCP handlers.
- Treat all memories, task objectives, chat transcripts, and provider outputs as untrusted data.
- Never log or print bearer tokens, OAuth secrets, cookies, or database credentials.
- Preserve existing compatibility surfaces (`swarma` MCP server name, `com.swarma.*` LaunchAgent labels, `~/.swarma` worktree directory, and `COLLECTIVE_*` / `SWARMAA_*` environment variables).
- Database schema changes must be added as a new numbered SQL file in `db/migrations/` without altering checksums of existing migrations.

## Pull Requests

- Keep changes focused and minimal.
- Ensure `npm run typecheck`, `npm run build`, and `npm test` pass before submitting.
- Describe what you validated and any manual or integration checks that remain.

## License

By contributing to Swarmaa, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
