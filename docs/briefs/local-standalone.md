# Brief: Swarmaa from GitHub works fully local, with no swarmaa.com

**Repo:** `~/Projects/swarma` (public at github.com/kamatbot/swarmaa).
**Goal:** someone who clones the repo and runs `npm run setup` gets a working local service, local workers (Claude, Codex, Antigravity) and the MCP connections. None of it touches `swarmaa.com` or needs an account, invite or Cloudflare. Remote access stays an optional step, using **their own** domain.

## Problems found

- `scripts/setup-lib.ts:154` sets `DEFAULT_HOSTNAME = 'api.swarmaa.com'`, so setup's remote step defaults to the owner's gateway domain.
- `scripts/tunnel.ts:34` rejects any hostname that isn't `swarmaa.com` or `*.swarmaa.com`, so a GitHub user can't publish on their own domain.
- `scripts/tunnel.ts:45` and `:107` hard-code swarmaa.com in the prompt text and the default.
- `scripts/onboarding.html:130` suggests `api.swarmaa.com` as the example.
- `clients/grok/README.md` describes `https://api.swarmaa.com` as the host.
- `.env.example` should default to local-only.

## Do this

- **Setup:**
  - Remote access is opt-in and off by default.
  - With no hostname given, setup finishes local-only: `PUBLIC_URL` is the loopback origin, and Grok and other remote clients are skipped with a one-line note on how to add remote access later.
  - Remove `DEFAULT_HOSTNAME`, or make it empty.
- **Tunnel:** accept any valid hostname the user controls. Keep `validHostname`, and drop the swarmaa.com-only check and its text. The default is no hostname, so the user must pass `--hostname`. Prompts say "your domain".
- **Examples and docs:** use `swarm.example.com` in `onboarding.html`, `clients/grok/README.md` and `.env.example`. Leave `site/` alone; it's the swarmaa.com marketing site.
- **Gateway mention:** one short line in the setup output and in `clients/grok/README.md`:
  > The hosted gateway at swarmaa.com is invite-only. You don't need it: everything runs on your Mac.
- **Check for a fresh-clone dependency on swarmaa.com.** Look for anything that would make a fresh clone call out to swarmaa.com: worker bridge config, `scripts/smoke.ts`, the MCP launcher `clients/macos/swarma-mcp.sh`, any hard-coded URL in `src/`. Fix every one you find.
  - `noreply@swarmaa.com` as the git author email on worker commits is fine.

## Tests

- Update `tests/setup.test.ts` for the new defaults:
  - a setup plan with no hostname is local-only and valid
  - a tunnel hostname such as `swarm.example.com` is accepted
  - an invalid hostname is still rejected
- Add a test that setup with no hostname never produces a `*.swarmaa.com` URL anywhere in the generated config or plists.

## Rules

- Match the surrounding code style: terse and dense, with the same naming and comment density. No new dependencies. Smallest correct diff.
- Don't change `site/`, `src/core/`, `src/bridge/worker.ts`, `src/oauth.ts`, `src/passkeys.ts`, `src/http.ts` or any migration. Other branches are changing those.
- Don't run setup for real on this Mac, don't create tunnels or touch Cloudflare, and don't restart launchd services. Tests and dry runs only.
- Never print secrets. Put a `timeout` on long commands.
- Conventional commits, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance

```bash
npm run build
timeout 300 npm test 2>&1 | grep -E "^ℹ (pass|fail)"     # 0 fail
grep -rn "swarmaa\.com" scripts clients src .env.example | grep -v noreply   # only the one-line gateway note(s) remain
```

Report the full list of swarmaa.com references you changed or kept.
