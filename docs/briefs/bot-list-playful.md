# Brief: a roomier, more playful bot list (Mac and iOS)

Flow: the bot list gets taller rows that use the screen's height (people have about 10 bots, never hundreds), with a two-line preview of the latest message. Avatars react: on Mac when you hover a row, on iOS when you press one. Rows ease in when the list first appears. Everything is subtle, and with Reduce Motion on, nothing moves.

Mac is built in the main session. **This brief's task for Codex is iOS only.**

## Shared rules

- Read the code you touch end to end first; match the surrounding style (terse SwiftUI, `KS.*` colours and fonts).
- Change only what this brief names. Don't touch the thread screen, bot settings or the composer.
- Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`. Don't run `npm run deploy:local`, restart launchd jobs or touch running bridges. No new dependencies.
- Never create an iOS simulator; use "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`. If `iOS-app/Swarmaa.xcodeproj` is missing in your worktree, run `xcodegen` inside `iOS-app/` in your own worktree (never in the main checkout).
- Thumb rule: no new controls in the top half of the screen.
- Commit on your branch, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge.

## iOS task (Codex)

File: `iOS-app/Sources/SwarmaaApp.swift` (the home list: `row(_:)`, the `ForEach` that lists bots, and `Moji`), plus tests.

1. **Taller rows.** Moji 48 (was 42), vertical padding 18 (was 14), 6 pt between the name line and the preview. The preview (`bot.line`, else `bot.job`) shows up to 2 lines (3 at accessibility text sizes). Keep the time, star and badge where they are.
2. **Press reaction.** While a row is pressed, its avatar squashes and tilts slightly (scale about 1.08 × 0.92, rotation −6°), springing back on release. Use the existing `PressStyle` press state, or a button style that exposes `isPressed` to the row; don't add a tap gesture to `Moji` itself (it would steal the row's tap).
3. **Entrance.** The first time the home list appears in a session, rows fade in and rise 8 pt, staggered about 35 ms per row, at most 10 rows animated. Not on refresh, search or returning from a thread.
4. **Badge pop.** When a row's unread or needs-you badge appears or its count goes up, the badge pops (scale 1 → 1.25 → 1, about 0.3 s spring). Not when it goes down or away.
5. **Reduce Motion.** With `accessibilityReduceMotion`, none of 2–4 runs. Layout is identical.
6. Tests:
   - Unit-test the "should this badge pop" rule as a pure function: appears or increases yes; decreases, unchanged or removed no.
   - Update `UITests/NavigationTests.swift` so the home list still opens a bot by tapping its row.
   - Run the iOS unit tests and UI tests on the device above. Save a home screen screenshot from the simulator.
   - End with a short report: the screenshot path, test results and what changed.

## Mac (main session, for reference)

The same idea in `BotRow`: hover lifts the row's avatar 2 pt, tilts it −6° and scales it to 1.08 with a spring; taller rows with a 2-line preview; a staggered entrance on first appearance; Reduce Motion respected.
