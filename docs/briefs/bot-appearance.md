# Brief: a bot changes its own avatar and colour when you ask

Flow: in a bot's chat you say, for example, "switch to the Scout and make yourself orange". The bot replies and ends its reply with a `bot_appearance` action. The service checks it against the allowed characters and colours and updates the bot. A `bot.updated` event goes out, and the Mac and iOS apps redraw the bot everywhere: the bot list, the thread header and its messages.

Three tasks on three branches, built against this contract.

## Shared rules

- Read the code you touch end to end first; match the surrounding style (terse TypeScript; SwiftUI with `KS.*` styles).
- Change only what this brief names. Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`. Don't run `npm run deploy:local`, restart launchd jobs or touch running bridges. No new dependencies.
- If an Xcode project is missing in your worktree, run `xcodegen` in that app's folder in your own worktree (never in the main checkout). Never create a simulator; use "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`.
- Commit on your branch, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge.

## Contract

- **Characters** (`avatar`): exactly one of `lead`, `runner`, `scout`, `navigator`, `clerk`, `scribe`, `badge-sun`, `badge-peri`, `badge-peach`. These are the existing moji in `Mac-app/Sources/Teams/Moji/moji-<name>.svg` and `iOS-app/Resources/moji-<name>.png`. `mark` is the app's own and is never allowed for a bot. A bot's existing `avatar` that isn't one of these names (older bots hold free text or nothing) keeps today's behaviour: the apps hash it, or the lead agent's id, to pick a character.
- **Colours** (`color`): exactly one of `blue`, `butter`, `peach`, `lilac`, `pink`, `lime`, `sky`, `orchid`, or null (no colour, today's look). These are the Kind Swarm stage colours: blue `#9CC8FF`, butter `#FFE08A`, peach `#FFC4A8`, lilac `#D6C2FF`, pink `#FFB8D9`, lime `#C9F26B`, sky `#A8E6FF`, orchid `#F2C4FF`.
- **Bot view:** gains `color: string | null`. `avatar` is unchanged in shape.
- **`bot_update`:** accepts `color` (one of the names, or null). When `avatar` is given, it must be one of the character names or null; reject anything else with `400 invalid_arguments`. Existing free-text avatars stay readable but can't be newly set.
- **Turn action** `{"type": "bot_appearance", "avatar"?: <character>, "color"?: <colour>}` needs at least one field. It is only valid in a turn whose task has a `bot_id`, and it changes only that bot. It's applied like the other turn actions when the turn finishes (version bump, `bot.updated` event, audit `bot.update` with `reason: 'appearance'`). An invalid value rejects the action the way other invalid actions are rejected today.

## Task 1: service

Files: a new `db/migrations/032_bot_color.sql` (`ALTER TABLE bots ADD COLUMN color text` with a CHECK for the eight names), `src/core/bots.ts`, `src/core/actions.ts`, wherever turn actions are applied (`src/core/actions.ts` / `src/core/tasks.ts`), `src/bridge/adapters.ts` (prompt), `src/core/tools.ts` (schema text), `docs/API.md`, and tests in `tests/`.

1. The migration, the bot view and `bot_update`, per the contract.
2. Parse and apply `bot_appearance` per the contract.
3. In `buildTurnPrompt`, and only for bot turns (the task has `bot_id`), add the action to the valid types list. Include one line naming the characters with a few words each, so a request like "the one with sunglasses" or "the pink one" maps to a name. Read the SVGs to describe them accurately. Also name the colours, saying "orange" maps to `peach` and "green" to `lime`. Keep it to about 5 lines.
4. Tests: `bot_update` color and avatar validation; a bot turn whose answer carries `bot_appearance` updates the bot, bumps its version and emits `bot.updated`; the same action in a non-bot turn is rejected; `mark` and unknown names are rejected.
5. Acceptance: `npx tsc --noEmit`; `npm test`; `TEST_DATABASE_URL=… npm run test:integration` (serial).

## Task 2: Mac app

Files: `Mac-app/Sources/Teams/KS.swift` (`KSMoji`), `Mac-app/Sources/Teams/BotsModels.swift` (decode `color`), `Mac-app/Sources/Teams/BotsViews.swift` (`BotRow`, `BotThreadHeader`), `Mac-app/Sources/Teams/ThreadView.swift` (the bot's avatar on its messages, if shown), tests.

1. `KSMoji`: when the seed is exactly one of the character names, show that character; otherwise hash as today.
2. Where a bot's avatar is drawn (bot row, thread bar pill, its messages), when the bot has a `color`, draw the avatar on a circle of that colour, about 1.2× the avatar size, with no outline. With no colour, nothing changes.
3. The bot list and header update live on `bot.updated`; check this already happens via the existing refresh, and fix it if not.
4. Tests: a unit test that a character name picks that character and other seeds still hash; a `TeamsSnapshotRender` case with a coloured bot row and header. Acceptance: the Mac app builds and those tests pass with `TEST_RUNNER_SWARMAA_SNAPSHOT_DIR` set. Report PNG paths.

## Task 3: iOS app

Files: `iOS-app/Sources/SwarmaaApp.swift` (`Moji`, home `row(_:)`, the thread header pill and its messages), `iOS-app/Sources/AppCore.swift` if `Bot` needs a `color` accessor, tests.

1. `Moji`: a seed that is exactly a character name shows that character; otherwise hash as today.
2. The same coloured circle as the Mac (about 1.2× the avatar) behind the bot's avatar in its home row, the thread header pill and its messages, when the bot has a colour.
3. Live update on `bot.updated` (check the existing handling refreshes the open bot and the list).
4. Tests: a unit test for the name-or-hash rule; a UI test or screenshot in demo mode with a coloured bot (add a demo flag if needed). Acceptance: iOS unit and UI tests pass on the simulator above. Report the screenshot path.
