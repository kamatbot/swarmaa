# Brief: UX polish, soft surfaces instead of hard outlines (Mac and iOS)

Design: https://claude.ai/artifact/SnndtndebrDgPZcoC3N4KR (canvas "Swarmaa UX polish review": Before, After, Components before/after, iPhone before/after, and the spec board "What changes"). The spec below is the contract; the canvas shows it.

Flow: nothing changes in what any screen does. Inside the content area, chat bubbles, cards, chips, buttons, answer options, the composer, the top-bar icon buttons and the search field lose their 2 px ink outlines and hard offset shadows. Depth comes from soft shadows and tints instead. The ink rail, the shaded columns, the top-bar layout, the characters, the colours and the stencil display type stay as they are.

Two tasks on two branches (Mac, iOS). They touch different files.

## Shared rules

- Read the code you touch end to end first; match the surrounding style (terse SwiftUI, `KS.*`).
- Restyle only; don't change layout, copy, behaviour or which controls exist. Don't touch the ink rail, the bot list's shading, or the motion already shipped.
- Change the shared style primitives first (`KS.swift` on Mac, the `KS`/`card`/`Pill` helpers on iOS), so call sites mostly follow. Then fix call sites that draw their own outlines (`strokeBorder(KS.ink…)`, `.stroke(KS.ink…)`, hard `offset` shadows).
- Accessibility: chip text on its tint must stay at least 4.5:1 (the colours below do); keep 44 pt touch targets on iOS; Reduce Motion unchanged.
- Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`; don't deploy or restart bridges. No new dependencies. If an Xcode project is missing in your worktree, run `xcodegen` in that app's folder in your own worktree (never the main checkout). Never create a simulator; use "Piano Review iPhone SE" `B2EE62FA-1CD0-4F71-8FCD-9FE73EA59B56`.
- Commit on your branch, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge.

## The spec (both apps)

**Surfaces**
- Raised surface: white, radius 16 (cards) or 18 (bubbles), no border. Shadow: `0 1 2` ink at 6 %, plus `0 4 14` ink at 5 % (SwiftUI: two `.shadow` modifiers, y 1 radius 1, and y 4 radius 7).
- Hairline: inset 1 px ink at 6–12 %, only where something light sits on a light ground (search field, answer options).
- A card that needs you (open question, failed task) fills `#FDF5F0` instead of white.

**Bubbles**
- Yours: ink fill, paper text, corner radius 18 with the bottom-trailing corner 5.
- A bot's: raised white surface, radius 18 with the top-leading corner 5. Name above in 12 pt semibold, time in muted.
- Live reply (typing): same as a bot's bubble at 70 % opacity, with the typing dots. No dashed border.

**Chips** (status badges such as Needs you, Ready for review, Failed, Swarm, Scheduled, Bot)
- Height 22 (iOS 20), pill, 11.5 pt semibold, sentence case. No outline, no mono capitals.
- Needs you `#FBE3DA` bg / `#9B3A22` text · Ready or done `#F1F5E2` / `#4A5A12` · Failed `#F6DDD6` / `#8A2410` · Neutral ink 6 % / `#3A3347`.

**Buttons**
- Primary: lime `#CFE08A` fill, ink text, no border, no hard shadow. Press: scale 0.985 with the existing spring.
- Secondary: ink 6 % fill, ink text, no border; hover ink 10 % (Mac).
- Destructive: `#F6DDD6` fill, `#8A2410` text.
- Icon buttons (top bar, composer): 32 pt, no ring; hover and pressed show an ink 6 % circle; "on" toggles a lime circle.
- Answer options: white with a 1 px ink 12 % hairline; chosen fills lime with a check mark.

**Composer**
- One white field, radius 22, shadow `0 1 2` ink 6 % plus `0 6 20` ink 7 %, no border.
- Photo and mic are plain icon buttons. Send is a 36 pt ink circle with an up arrow, at 25 % ink when there's nothing to send.

**Top bar and search**
- The bot pill: white, no border, `0 1 2` ink 8 % shadow.
- Search field: white with a 1 px ink 6 % hairline, no ink outline. Keep the focus ring (lime) on focus.

## Task 1: Mac

Files: `Mac-app/Sources/Teams/KS.swift`, `ThreadView.swift`, `BotsViews.swift`, `TasksViews.swift`, `TeamsWindow.swift` (only where they draw outlines on content), tests.

1. Update the primitives in `KS.swift`: `ksCard` (no border by default, soft shadow), `KSButtonStyle` kinds (primary lime, white/paper → secondary tint, ink stays, danger → destructive tint, all borderless), `KSChip` (tints and sentence case per the spec), `KSBarButton` (no ring, hover circle), `KSSearchField` (hairline instead of ink outline). Add the needed colours to `KS` as named tokens.
2. Apply the spec to bubbles, live reply, swarm/task/question cards, answer options and the composer in `ThreadView.swift`; to the bot pill in `BotsViews.swift`; to task cards and chips in `TasksViews.swift`; and to the Tasks detail panel and bot settings cards where they draw ink outlines.
3. Re-render with `TEST_RUNNER_SWARMAA_SNAPSHOT_DIR=<dir> xcodebuild test … -only-testing:CodenotchTests/TeamsSnapshotRender` and look at the PNGs: `1-bots-home`, `2-bot-settings`, `3-tasks`, `task-detail-usage`, `thread-bar-default`. Acceptance: the Mac app builds; `TeamsSnapshotRender` and `TeamsBotsTests` pass. Report the PNG paths.

## Task 2: iOS

Files: `iOS-app/Sources/SwarmaaApp.swift` (the `KS` enum, `card(...)`, `Pill`, `PressStyle`, message rendering, task/question cards, the composer, the thread header pill, the Tasks screen cards and filters, bot settings), tests.

1. Update `card(...)` so its default is the raised surface (no ink stroke, soft shadow); make `Pill` borderless per the button spec (primary lime, secondary tint, danger destructive). Keep `card(…, shadow: true)` callers working; the hard shadow becomes the soft one.
2. Apply the spec to bubbles, the live reply, the task and question cards, chips, the composer, the thread header pill, the home search bar, and the Tasks screen.
3. Acceptance: iOS unit tests pass, and UI tests pass except the known large-text `testSearchAndUsageWithLargerText` (and `testTappingAPushDoesNotCrash`, which needs a host-sent push). Save simulator screenshots of the home screen and a thread in demo mode (`-demo`, `-demo -screen thread`) via `xcrun simctl io <udid> screenshot` and report their paths.
