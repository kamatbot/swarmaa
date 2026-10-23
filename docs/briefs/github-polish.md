# Brief: polish the public GitHub repo (kamatbot/swarmaa)

**Repo:** `~/Projects/swarma`, public at https://github.com/kamatbot/swarmaa.
**Goal:** a first-time visitor understands what Swarmaa is in ten seconds, sees the logo, and can get it running locally from the README.

## Current state

- `README.md` is stale. It talks about unzipping an archive and "Open in Claude", says "build, tests … were not executed", leads with "Reason Network", and points at `CLAUDE_HANDOFF.md` and `START_HERE.txt`. All of that dates from the original zip handoff.
- The logo exists at `site/public/brand/swarmaa-mark.svg`. It's an animated shawarma wrap with three agents: lime, flame and lilac. A still version is `site/public/favicon.svg`.
- Brand colours: ink `#15111F`, paper `#F4EFE6`, flame `#FF5A3C`, lime `#D4FF3A`, lilac `#CBA8FF`. Wordmark: uppercase **SWARMAA** in Stardos Stencil.

## Do this

1. **`README.md`, rewritten, 150–250 lines.**
   - **Header:** a centred logo `<img>` pointing to a copy at `docs/assets/swarmaa-mark.svg` (copy the animated SVG; GitHub renders SVG motion in README images), then the name and a one-line pitch: "One swarm for all your coding agents: Claude Code, Codex, Antigravity and Grok share memory and hand each other tasks, running on your Mac."
   - **Badges:** MIT license and Node 24, from shields.io static badges only, no tracking.
   - **"What it does":**
     - shared project memory
     - durable tasks routed by quota (Claude first, then Codex …)
     - parallel swarms with slots per worker
     - local git-worktree patches that are never pushed
     - the Swarmaa notch app for macOS
     - Keep each point short. Check every claim against the code and `docs/SWARMA.md`, and don't invent features.
   - **"Quick start (local, no account)":** clone, `npm install`, `npm run setup`, then what to expect.
     - Check the real commands and prerequisites in `package.json`, `scripts/setup.ts` and `docs/SWARMA.md`. Postgres is bundled or installed by setup; say whichever is actually true.
     - State plainly that everything runs on your Mac and the hosted gateway at swarmaa.com is optional and invite-only.
   - **"How it works":** keep or simplify the existing mermaid diagram, dropping Reason Network from the main path (it's optional).
   - **Short sections for:** connecting Claude Code, Codex and Antigravity (setup does it); the Mac app; remote access with your own domain (optional); security model in a few lines, linking `docs/SECURITY.md`; license.
   - **Remove:** the zip-handoff and "not executed" text and the Reason Network lead.
2. **Stale handoff files:** delete `START_HERE.txt`, `CLAUDE_HANDOFF.md` and `BUNDLE_MANIFEST.json` if nothing in `src/`, `scripts/`, `tests/` or `package.json` references them (grep first). If something does, keep the file and tell me what references it.
3. **`docs/assets/social-preview.png`, 1280×640.**
   - Content: logo, wordmark and the one-line pitch on ink `#15111F`.
   - Render it with headless Chrome from a small HTML file under `docs/assets/` (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --screenshot=… --window-size=1280,640 file://…`), with the font from `site/public/fonts/stardos-stencil-700.woff2`.
   - Don't upload it. GitHub's social preview has to be set by hand in Settings, so just say where the file is.
4. **`.github/`:**
   - `ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`, short.
   - `pull_request_template.md`, short.
   - A `.github/workflows/ci.yml` that runs `npm ci && npm run build && npm test` on macos-latest with Node 24, only if `npm test` doesn't need Postgres. Check first; if it does, skip CI and say so.
5. **`.gitignore`:** add `.vscode/`, `.idea/`, `*.pem`, `*.key`, `*.local.json`, `.claude/`, `.codex/` and `.gemini/`. The security review flagged these as missing.
6. **`package.json`:** add `"description"`, `"repository"`, `"homepage": "https://swarmaa.com"` and `"keywords"`. Don't rename the package.

## Rules

- Only touch `README.md`, `docs/assets/`, `.github/`, `.gitignore`, `package.json` (metadata fields only) and the three stale files.
- Don't change `src/`, `scripts/`, `tests/`, `site/`, `db/` or `docs/SWARMA.md`. Other branches are changing those.
- No invented features or numbers. Every claim must match the code.
- Don't push, and don't touch GitHub settings. I'll set the repo description, topics and social preview.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

```bash
npm run build && timeout 300 npm test 2>&1 | grep -E "^ℹ (pass|fail)"     # 0 fail
test -f docs/assets/swarmaa-mark.svg && test -f docs/assets/social-preview.png && sips -g pixelWidth -g pixelHeight docs/assets/social-preview.png
grep -n -i "zip\|not executed\|CLAUDE_HANDOFF\|START_HERE" README.md        # no hits
```

Also report:
- the one-line repo description and up to 8 topics you recommend for me to set
- which stale files you deleted or kept
- whether CI was added
