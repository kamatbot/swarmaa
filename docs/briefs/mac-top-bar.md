# Brief: unified top bar for the Swarmaa Mac window

Design: https://claude.ai/artifact/SKU9u8ostsvBFMMYKLUhTU (canvas "Swarmaa Mac top bar": Main, States, Build spec). The canvas is the source of truth for look; this brief is the source of truth for behaviour.

Flow: the system title bar goes away. The window content runs to the top edge, and one 52 pt row holds, left to right: the traffic lights on the ink rail, the bot list's search and New bot button, then the open bot's name (a menu), its status, and its actions. Empty parts of the row drag the window; double-clicking them zooms (respect the user's "double-click a window's title bar" setting).

Three tasks on three branches. Shared primitives are already on `main` in `Mac-app/Sources/Teams/KS.swift`: `KS.topBarHeight` (52), `KSTopBar { … }` (paper ground, 2 pt ink bottom rule, 12 pt side padding, 10 pt spacing), `KSBarButton(symbol:label:on:fill:action:)` (32 pt circle, 1.5 pt ink outline, lime when `on`), and `KSSearchField(…, height:)`. Use them; don't restyle them.

## Shared rules

- Read the code you touch end to end first; match the surrounding style (terse SwiftUI, `KS.*` colours and fonts, `L10n.t` for copy).
- Change only what this brief names. Don't touch bot settings content, the thread's messages or composer, the notch, or Settings windows.
- Don't modify `src/bridge/sandbox.ts` or `providerEnvironment`. Don't run `npm run deploy:local`, restart launchd jobs or touch running bridges. No new dependencies.
- Run `xcodegen` only inside your own worktree, and only if you add files (prefer not to).
- Commit on your branch, conventional message ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push or merge.
- Acceptance: the Mac app builds (`cd Mac-app && xcodebuild -project Codenotch.xcodeproj -scheme Codenotch -configuration Debug build`); the Mac tests pass (`xcodebuild test -project Codenotch.xcodeproj -scheme Codenotch -destination 'platform=macOS'`, with `TEST_RUNNER_SWARMAA_SNAPSHOT_DIR=<dir>` so `TeamsSnapshotRender` renders); add or update a `TeamsSnapshotRender` case so your bar is rendered, and look at the PNG. End with a short report listing the PNG paths.

## Task A — window chrome, rail, Tasks/Usage bars

Files: `Mac-app/Sources/Teams/TeamsWindow.swift`, `Mac-app/Sources/Teams/TasksViews.swift`, `Mac-app/Tests/TeamsSnapshotRender.swift`.

1. `TeamsWindowController`: add `.fullSizeContentView`; `titlebarAppearsTransparent = true`; `titleVisibility = .hidden`; keep `window.title = "Swarmaa"` (Mission Control and the Window menu use it). Put the traffic lights vertically centred in the 52 pt row: attach an empty `NSToolbar` with `toolbarStyle = .unified` (its height is 52 pt), or position the standard buttons yourself — whichever leaves them centred, clickable, and correct after resize, full screen and exit from full screen. `TeamsRootView` extends under the title bar (`.ignoresSafeArea(.container, edges: .top)` or equivalent).
2. Every control in the 52 pt row must receive clicks (verify buttons and the search field are not swallowed by the title bar), and empty areas must drag the window and double-click to zoom. If SwiftUI controls in that region don't get clicks, fix it here, generally, for all three columns — Tasks B and C rely on it.
3. `TeamsRail`: its top 52 pt is the traffic lights' space (ink). Move the Swarmaa mark and items down below it; nothing else in the rail changes.
4. Tasks and Usage panes: their title row becomes a `KSTopBar` per the States board, 04 (display title `TASKS.`/`USAGE.`, a one-line summary in `KS.body(13)` `KS.textSoft`, existing search or filters on the right if the pane already has them). Don't add new controls.
5. Connection state: remove the bottom reconnecting/offline strip from `TeamsRootView` and expose what it showed (`staleError`, `streamState`, `lastUpdated`, `retryConnection()`) through a small `TeamsConnectionStatus` view in `TeamsWindow.swift` that Task C places in the thread bar (States board, 03): a `RECONNECTING`/`OFFLINE` chip, "updated N min ago", and a Retry button. Show it in the Tasks/Usage bars too. Task C builds against exactly this signature: `struct TeamsConnectionStatus: View { @ObservedObject var model: TeamsModel }`, rendering nothing when live.

## Task B — bot list bar

Files: `Mac-app/Sources/Teams/BotsViews.swift` (`BotsSidebar` only), `Mac-app/Tests/TeamsSnapshotRender.swift`.

1. The sidebar's top becomes a `KSTopBar`: `KSSearchField(prompt: "Search bots", text: $model.search, height: 32)` filling the width, then a `KSBarButton(symbol: "plus", label: "New bot", fill: KS.lime)` that sets `model.creatingBot = true`.
2. ⌘K focuses the search field (a `.keyboardShortcut` on a hidden button, or the window's key handling — whichever works with the field's `@FocusState`). Show "⌘K" as muted mono text at the field's trailing edge while it's empty and unfocused.
3. Remove the bottom "New bot" bar from the sidebar (the + replaces it). Keep the empty-state "New bot" button when there are no bots.
4. Snapshot: sidebar with two bots, search empty.

## Task C — thread bar

Files: `Mac-app/Sources/Teams/BotsViews.swift` (`BotThreadHeader`, and the settings pane's header only), `Mac-app/Sources/Teams/TeamsModel.swift` if a model call is missing, `Mac-app/Tests/TeamsSnapshotRender.swift`.

Replace `BotThreadHeader` with a `KSTopBar` per the Main and States boards:

1. Left: the bot pill (moji 24, name `KS.body(14, .semibold)`, chevron) as a `Menu`. Items: Bot settings (⌘,), Rename…, Star/Unstar, Earlier messages, divider, Hide bot (danger colour; uses the existing archive path, then returns to the list as Hide does today). Rename uses the existing bot update call; an inline sheet or alert with a text field is fine. Pill fill is lime while the menu is open if SwiftUI lets you observe that; otherwise white.
2. Next to it: status as mono 11 pt, tracked, `KS.textMuted`, with an 8 pt dot: `WORKING · N TASKS` (green dot) when the bot has running or queued tasks, `IDLE` otherwise. Use data the model already has. Then `TeamsConnectionStatus(model:)` from Task A — if Task A hasn't landed on your branch, add a placeholder `struct TeamsConnectionStatus: View { @ObservedObject var model: TeamsModel; var body: some View { EmptyView() } }` in `BotsViews.swift` behind a `// TODO(task A)` comment so it compiles; the merge removes it.
3. Right: "N needs you" (flame fill `KS.coral` or the closest existing token, ink text, capsule) when the bot needs the owner; clicking scrolls the thread to the first open question or review card if `ThreadView` already exposes a scroll target, otherwise it is a non-interactive chip. Then `KSBarButton` star (filled `star.fill` when starred) and `KSBarButton` settings (`slider.horizontal.3`, `on` while settings are open).
4. Bot settings open (States board, 02): the bar shows a back `KSBarButton(chevron.left)`, then "Name / Settings", and the settings button `on`. Back closes settings (`model.editingBotID = nil`).
5. Narrow window (under ~1000 pt wide content, States board, 05): hide the status text (keep the dot, with an accessibility label), and "N needs you" becomes a 32 pt circle showing N. Use `ViewThatFits` or a width reading, not a fixed breakpoint on the window.
6. Snapshots: default (working, 1 needs you), settings open, narrow.
