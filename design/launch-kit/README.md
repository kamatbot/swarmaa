# Swarmaa launch kit

Every design element made for the Swarmaa Mac app, kept for the launch video. Add to it whenever a new screen, character or visual is made.

## What's here

| Folder | Contents |
|---|---|
| `characters/` | The ten Kind Swarm characters as SVG (master), plus transparent 1024 px PNGs (`<name>@1024.png`) and a strip of all ten (`all-characters.png`). |
| `screens/` | The real SwiftUI screens, rendered at 1440×900 from example data: Bots home, Bot settings, Tasks, Usage, and the usage hover card. |
| `canvas/` | The source artboards of the "Swarmaa main window" design canvas (`.dc.html` and `canvas.json`). |
| `tokens/` | `kind-swarm-tokens.json` (the full Kind Swarm system) and `app-palette.json` (the muted palette the app actually uses). |

## The characters

They come from the Kind Swarm design system (`kind-swarm@1.0.0`) and are copied unchanged. In the app, each agent gets one character, picked from its id so it is stable everywhere, and `mark` is the app's own logo.

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

**Motion, from the system (for the video):** characters bob (3.4 s), blink (5.6 s) and squash on a poke (0.76 s, spring). Pupils follow the pointer by up to 7 px. Buttons lift 2 px on hover and press flat on click.

## Look and voice

- **Muted Kind Swarm, as asked:** ink `#15111F` outlines and text on paper `#F4EFE6`, with hard offset shadows and no blur. The accents are lime `#CFE08A`, coral `#E8836B`, sage `#D6E3A6` and sky `#B7CCE8`.
- **Type:** stencil display headlines in caps with a full stop ("TASKS.", "LAUNCH BOT."), condensed body, and mono section labels numbered with an em dash ("01 — The crew").
- **Copy:** short, calm sentences, with the person always in charge. For example: "A persistent swarm. These settings apply to everything it runs."

## Links

- Design canvas: https://claude.ai/artifact/5d5SkNDBdwAkuhJFDEBKKt (private)
- Kind Swarm design system: https://claude.ai/artifact/GTtCTSDLFihHmqgY9kJnYf (private)
- The renders come from `Mac-app/Tests/TeamsSnapshotRender.swift`. To re-render: `TEST_RUNNER_SWARMAA_SNAPSHOT_DIR=<dir> xcodebuild … test -only-testing:CodenotchTests/TeamsSnapshotRender`.
