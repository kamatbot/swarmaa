# Swarmaa Bots launch kit

Everything needed to cut a launch video for Swarmaa Bots: the real Mac and iPhone screens, the characters, the app icon, the design canvases, the colours and type, and a suggested shot list. Screens are the shipping apps rendered from example data (Mac build 47, iOS `66ac0e4`, 2026-10-29). Add to this folder whenever a new screen, character or visual is made.

## What Swarmaa Bots is (for the voice-over)

A bot is a small crew of AI agents with one job, like your launches, your releases or watching competitors. Each bot keeps one chat. You talk to it like a person; it splits the work across Claude, Codex and Antigravity, asks before anything goes public, and comes back with branches to review. It runs on your Mac, and you can reach it from your iPhone.

Short lines in the app's own voice:

- "A bot keeps one chat for one job."
- "Make your first bot."
- "Nothing is posted until you approve the drafts."
- "Plan Friday's launch. Ask me before anything goes public."
- "Your crew, in one thread."

## Folders

| Folder | Contents |
|---|---|
| `screens-mac/` | 29 Mac screens at full resolution. `1-bots-home.png` is the hero shot. Also bot settings, Tasks (with multi-select and the task details panel), Usage and its hover card, the thread bar states, a coloured bot (`bot-appearance-*`), the bot row on hover, the photo composer and the real titled window (`0-window-chrome.png`, which shows an "Offline" chip because the test window isn't connected, so prefer `1-bots-home`). |
| `screens-ios/` | 14 iPhone screens (iPhone SE size), status bar set to 9:41. Home, a thread, a coloured bot, Tasks, Usage, bot settings, new bot, a question, the You sheet, the first-bot card a new user sees, folded working notes, and photos in chat. `00-contact-sheet.png` shows them all at once. |
| `characters/` | The ten Kind Swarm characters as SVG masters, transparent 1024 px PNGs (`<name>@1024.png`), and `all-characters.png`. |
| `app-icon/` | The iPhone icon: the swarm in a shawarma wrap. `shawarma@2048.png` on ink, `shawarma-transparent@2048.png` with no background for overlays, `app-icon-1024/512/180/120.png`, and the HTML sources (`shawarma.html`, `shawarma-transparent.html`) with the three character SVGs they use. Re-render with headless Chrome at 1024×1024. |
| `canvas-topbar/` | The Mac top-bar design (Main, States, Build spec), as `.dc.html` artboards. |
| `canvas/`, `canvas-ios/` | The earlier main-window and iPhone design canvases. |
| `motion/` | `motion-showcase.html` (open in a browser: every interaction animation, live, with a Reduce Motion toggle) and `MOTION.md` (curves and timings). |
| `tokens/` | `app-palette.json` (the muted palette the apps use) and `kind-swarm-tokens.json` (the full design system). |
| `archive/2026-10-earlier/` | Screens from before the 2026-10-29 redesign. Kept for reference; don't use them in the video. |

## Look

- **Colours:** ink `#15111F` text and outlines on paper `#F4EFE6`. The bot list is a shade darker (`#EBE4D7`), and columns are parted by shade, not lines. Accents are lime `#CFE08A` (primary actions, selected), coral `#E8836B` (needs you), sage `#D6E3A6`, sky `#B7CCE8` and butter `#EAD9A6`. Hard offset shadows only, never blurred.
- **Type:** heavy compressed display in caps ending with a full stop ("BOTS.", "TASKS."), plain sans body, and mono labels numbered with an em dash ("01 — Updates").
- **Bot colours:** a bot can recolour itself (blue, butter, peach, lilac, pink, lime, sky or orchid). The colour tints the character, not a circle around it.

## The characters

From Kind Swarm (`kind-swarm@1.0.0`), unchanged. Each bot gets one: picked from its id, or chosen by the bot when you ask ("switch to the Scout and make yourself orange"). `mark` is the app's own and is the Bots button in the Mac rail.

| File | Character | Props |
|---|---|---|
| `lead` | Violet, blush cheeks | Antenna; the swarm lead |
| `scribe` | Blue | Antenna |
| `runner` | Blue | Sunglasses and a pointing hand |
| `scout` | Peach | Magnifier |
| `navigator` | Sun | Star wand and sparkles |
| `clerk` | Lilac, tired | One X eye |
| `mark` | Blue, heavy outline | The logo |
| `badge-sun`, `badge-peri`, `badge-peach` | Plain faces | Queue badges |

## Motion (for animating the screens)

- Bot rows ease in on first appearance: up 8 pt with a fade, 35 ms apart.
- Hovering a bot on the Mac: the avatar hops 2 pt, tilts −6° and grows to 1.08, then springs back. On iPhone, pressing a row squashes the avatar (1.08 × 0.92, −6°).
- Screens on iPhone slide in from the right over home, like a navigation stack.
- Badges pop (1 → 1.25 → 1) when something new arrives. Typing shows three pulsing dots.
- Characters, from the design system: bob (3.4 s), blink (5.6 s) and squash on a poke (0.76 s spring).
- Buttons press with a short spring (response 0.28, damping 0.78).

## Suggested shot list (45–60 s)

1. **Cold open (0–4 s):** `app-icon/shawarma-transparent@2048.png` on paper `#F4EFE6`. The three bots bob in the wrap. Title: "Swarmaa Bots."
2. **The problem (4–9 s):** one line on screen: "One job. A whole crew."
3. **Make a bot (9–15 s):** iPhone `10-first-bot-card.png`, then `07-new-bot.png`. "Make your first bot."
4. **Talk to it (15–24 s):** Mac `1-bots-home.png`. Zoom into the thread: the request, the reply, the swarm card splitting the work (Scout, Forge, Pulse, Atlas).
5. **It asks first (24–30 s):** iPhone `08-question.png`. "Nothing is posted until you approve the drafts."
6. **Review the work (30–38 s):** Mac `task-selection-three.png`, then `task-detail-usage.png`: who did what, on which model, with tokens.
7. **Make it yours (38–44 s):** the bot recolouring itself: `screens-ios/03-coloured-bot.png` and `screens-mac/bot-appearance-1000.png`.
8. **Everywhere (44–52 s):** Mac and iPhone side by side (`1-bots-home.png` and `screens-ios/01-bots-home.png`).
9. **End card (52–60 s):** the characters strip (`characters/all-characters.png`) and the icon. "Swarmaa Bots. Your crew, in one thread."

## Links

- Mac top-bar design canvas: https://claude.ai/artifact/SKU9u8ostsvBFMMYKLUhTU (private)
- Kind Swarm design system: https://claude.ai/artifact/GTtCTSDLFihHmqgY9kJnYf (private)
- Re-render the Mac screens: `TEST_RUNNER_SWARMAA_SNAPSHOT_DIR=<dir> xcodebuild test … -only-testing:CodenotchTests/TeamsSnapshotRender` in `Mac-app/`.
- Re-capture the iPhone screens: launch the simulator app with `-demo` plus `-screen <home|thread|tasks|usage|settings|newBot|question|you>`, `-appearance-demo`, `-new-user-demo` or `-working-notes-demo`, then `xcrun simctl io <udid> screenshot <file>`.
