# Swarmaa for iOS: build brief

Status: ready to build. Owner: coordinator. Builders: Codex (GPT-6.1 Sol), as two parallel tasks: I1 (service) and I2 (app).

## What it is

A phone app that operates the Swarmaa host on your Mac from anywhere. You talk to your bots, answer their questions, approve their work, and see tasks and usage. The agents never run on the phone. Everything goes through the Cloudflare relay (`docs/RELAY.md`) to the host's service.

**Design (binding):** https://claude.ai/artifact/BG62yZE5DXEJ1dE8xj87fL. These are the 9 screens, also in `design/launch-kit/canvas-ios/` as `.dc.html` sources: open them in a browser, or read the markup for exact sizes, colours and copy.

| # | Screen | File |
|---|---|---|
| 01 | Bots home | `Main.dc.html` |
| 02 | Bot thread | `Thread.dc.html` |
| 03 | Tasks | `Tasks.dc.html` |
| 04 | Usage | `Usage.dc.html` |
| 05 | Connect to a host | `Connect.dc.html` |
| 06 | Answer a question (sheet) | `Question.dc.html` |
| 07 | New bot (sheet) | `NewBot.dc.html` |
| 08 | Bot settings | `BotSettings.dc.html` |
| 09 | You (sheet from the avatar) | `More.dc.html` |

## Look

This is the Kind Swarm system in the Mac app's muted palette: copy `Mac-app/Sources/Teams/KS.swift` and adapt it, rather than inventing a new one.
- **Colours:** ink `#15111F`, paper `#F4EFE6`, white, lime `#CFE08A`, coral `#E8836B`, sage tint `#F1F5E2`, coral tint `#FBEFE7`, sky `#B7CCE8`, butter `#EAD9A6`, lilac `#D9CDEE`, text-soft `#3A3347`, text-muted `#5A5168`.
- **Shape:** 2–3 px ink outlines, hard offset shadows (never blurred), capsule buttons.
- **Type:**
  - Stencil display headlines in caps ending with a full stop: Stardos Stencil, or a heavy condensed system font if you don't bundle the font.
  - Condensed body text (IBM Plex Sans Condensed, or the condensed system font).
  - Mono, upper-case, tracked labels numbered "01 — ".
- **Characters:** the Kind Swarm characters are in `Mac-app/Sources/Teams/Moji/*.svg`. Pick each agent's character by a hash of its id, as `KSMoji` does.
- **Light appearance only** in v1.

## Layout rules (from the owner; binding)

- **Home has no tabs.**
  - **Top row:** the account avatar (opens the You sheet), host status ("Mac Studio" with a green dot when online), and small icon buttons for **Tasks** (with a needs-you badge) and **Usage**.
  - **Bottom:** a **search** bar, and the **starred bot** shortcut at the bottom-right.
  - **The list:** every bot, needs-you first, then unread, then by last activity. Each row shows the character, name, last line, time and badge.
- **Only one bot is starred.** It is the shortcut, and it's also in the list with a ★. Starring another bot (Bot settings → "Star this bot") moves the star.
- Tasks and Usage are full screens with a close X at the top left. New bot, Answer a question and You are sheets sized to their content. Use `.presentationDetents([.height(measured)])`, never `.medium` or a fixed fraction.
- **Everywhere except the home top row:** controls in the lower half, the primary button pinned at the bottom, and a close X at the top left as the only top control. Touch targets are at least 44 pt.

## Behaviour

- **Connect (first launch):**
  - Enter the host's six-word pairing code (`npm run relay:pair` on the Mac prints it), with the host id from the relay.
  - The app sends `pair_redeem` over the relay and stores the returned token in the **Keychain**, along with the `host_id`.
  - It shows presence (online or last seen).
  - "Sign in with an address instead" is **out of scope for v1**: don't show it.
- **Thread:**
  - Messages; task cards (Approve, which is the existing resolve action, and See changes); question cards that open the Answer sheet; and the live reply bubble from `thread_read.typing`.
  - The composer sends `thread_post`. The settings button opens Bot settings.
- **Live updates:** `GET /api/stream` over the relay (`SwarmaRelayTransport.stream`), with the same event handling as the Mac app:
  - a `message.created` for the open thread fetches `thread_read` after the last seq;
  - a `task.updated` with `kind: "turn"` refreshes typing;
  - task events patch one row.
- **Bot settings:**
  - name and job;
  - Chat replies: `rules.first_reply` is one of `claude-haiku-5-5` (default), `claude-sonnet-5-5`, `claude-opus-5-5`, `gemini-3.8-flash-high` or `off`;
  - the crew;
  - the routing per kind (research, patch, review, summary);
  - the rules: `approve_public`, `review_edits` and `require_tests`;
  - **Star this bot** (I1's `starred`).
  - **Save** calls `bot_update` with `expected_version`.
- **New bot:** Name, What it does, Project, Lead ("A new agent" creates one with `agent_create` first), and Chat replies. Make bot stays disabled, and says what's missing, until name, job and project are set. Errors show inside the sheet.
- **Tasks:** counts, filter pills (All, Needs you, Working, Done), and rows with state, bot, provider and next step. Data comes from `attention_list` and `task_list` per scope, run in parallel with at most 8 calls at once.
- **Usage:** one card per provider from `swarm_status.usage` (a ring for what's left, plus the 5-hour and weekly windows), the auto order right now, and Refresh.

## Action Button and Shortcuts (binding)

Add App Intents and an `AppShortcutsProvider`:
- **"Open starred bot"** opens the app straight into the starred bot's thread.
- **"Ask starred bot"** takes a dictated or typed `message` parameter, sends it with `thread_post` without opening the app, and returns the reply when it arrives within 30 s. Otherwise it says the reply will come in the app.

Both show up in Shortcuts, so the owner can assign them to the Action Button. Give them short Siri phrases, for example "Ask Swarmaa".

## I1: service (Codex), the starred bot

- Migration `db/migrations/028_bot_star.sql`: `bots.starred boolean NOT NULL DEFAULT false`, plus a partial unique index on `(tenant_id) WHERE starred AND NOT archived`. That allows one star per account.
- `bot_update` accepts `starred: true`. In the same transaction it unstars the previous one, emits `bot.updated` for both, and returns the bot.
  - `starred: false` unstars it.
  - `bot_create` accepts it too.
  - `bot_list` and `bot_get` return `starred`. In `bot_list`, the starred bot sorts first among equals (after needs-you).
  - Archiving a starred bot unstars it.
- Tests: one star per tenant across concurrent updates; the previous star is cleared; tenant isolation; archive unstars.
- Files: `src/core/bots.ts`, the migration, `tests/bots*.test.ts`, `docs/API.md` and `docs/BOTS.md`.
- Acceptance: `npx tsc --noEmit`, and `node --env-file=.env.test --import tsx --test --test-concurrency=1 tests/*.test.ts` passes in full.

## I2: the iOS app (Codex)

- **Where:** a new `iOS-app/` folder with an XcodeGen `project.yml`.
  - App target `Swarmaa`, bundle id `app.swarmaa.ios`, team `B4F73U5RGR`, iOS 18.0 or later, SwiftUI, Swift 6.
  - Plus a unit-test target.
- **Relay transport:**
  - Reuse `SwarmaRelayTransport.swift`, the Foundation-only relay client from relay part R3. It's on local branch `swarmaa/antigravity/c3058682` and isn't on main yet.
  - Merge that branch into your worktree first, and include `Mac-app/Sources/Providers/SwarmaRelayTransport.swift` in the iOS target by path from `project.yml`. Don't copy it.
  - Run its tests (`Mac-app/Tests/SwarmaRelayTransportTests.swift`) in the iOS test target too, and report any failures.
- **Models:**
  - Port the decoding you need from `Mac-app/Sources/Teams/BotsModels.swift` and `Mac-app/Sources/Providers/SwarmaTeamsClient.swift` (bots, messages, tasks, typing, questions) into iOS files.
  - Don't edit anything under `Mac-app/`, and don't import AppKit.
  - Decode `starred` optionally, so the app works before I1 is deployed.
- **Tests,** with a fake relay socket:
  - pairing stores the token in the Keychain (use a test keychain service name);
  - the home sort and the single starred shortcut;
  - live stream events update the open thread and its typing;
  - New bot validation;
  - the Ask starred bot intent posts once and returns the reply.
- **Simulator:** never create a simulator. Use an existing one:
  ```
  xcrun simctl list devices available | grep -m1 iPhone
  ```
  Prefer a booted device, and shut down any simulator you boot.
- **Acceptance:**
  1. Build and test:
     ```
     cd iOS-app && xcodegen && xcodebuild -project Swarmaa.xcodeproj -scheme Swarmaa -destination 'platform=iOS Simulator,name=<existing iPhone>' test
     ```
     It must pass.
  2. Capture a screenshot of each of the 9 screens on that simulator with example data, using a `-demo` launch argument that loads fixtures. Demo data never appears in real use. Save them to `design/launch-kit/screens-ios/<nn>-<name>.png`.
- **Rules:**
  - Never print tokens or pairing codes.
  - No third-party packages.
  - Commit to your branch with conventional messages. Don't push.

## Not in v1

- Push notifications. These need APNs, plus a relay hop from the host.
- OAuth sign-in by address.
- iPad layout, dark mode, and widgets.
