# Swarmaa for iOS

SwiftUI, iOS 18+, Swift 6; XcodeGen generates the `Swarmaa` target, bundle `app.swarmaa.ios`, team `B4F73U5RGR`. No packages. Open `Swarmaa.xcodeproj` after generation to run on a signed device.

```sh
cd iOS-app
xcodegen
xcrun simctl list devices available
xcodebuild -project Swarmaa.xcodeproj -scheme Swarmaa \
  -destination 'platform=iOS Simulator,name=Piano Review iPhone SE' \
  -derivedDataPath DerivedData test
```

Use an existing iPhone; never create a simulator. The project enables `-disable-sandbox` for simulator Swift compilation because the worker sandbox cannot nest the compiler macro sandbox. This affects compiler plugin execution, not app permissions; device builds retain the default compiler behavior.

The Foundation relay source and its original tests are referenced by path under `Mac-app/`; they are not copied or edited. The original tests have a Swift 6 data-race diagnostic at `SwarmaRelayTransportTests.swift:409` (a task mutates `received` while the test later reads it). They run unchanged in an iOS `RelayCompatibilityTests` target using Swift 5 mode. The app and `SwarmaaTests` use Swift 6 with complete concurrency checking. App tests compile the exact same `AppCore.swift` source and transport, and are hosted in the app for real simulator Keychain access. Each Keychain test uses a random test service and removes its fixture afterward.

First launch offers camera QR scanning and Paste link for `swarmaa://pair?host=…&code=…`. The registered URL scheme accepts the same links. Host ID and six secure word fields appear only under “Type the code instead”. Only the returned connection is kept, in a device-only Keychain item. Pairing text is cleared after success and is never logged. The app stores no token in preferences. Presence, REST tool requests, and live SSE traffic use the relay; the app never runs agents locally. Errors omit server response bodies. Sign out removes this device's saved connection; revocation remains a host operation.

Home has no tabs: You, host presence, Tasks and Usage at the top, search and one starred shortcut at the bottom. Scroll content fills the space beneath the header and above pinned bottom controls. The thread anchors to the newest message, with history available by scrolling upward. Small sheets measure their content for `.presentationDetents([.height(measured)])`; New bot uses a large scrolling sheet with Make bot pinned. Optional `starred` decoding supports older services; changing the star requires I1 on the host.

The Action Button and Shortcuts expose **Open starred bot** and **Ask starred bot**. Ask uses its own relay connection, posts once with an idempotency key, and waits for a subsequent agent reply within one 30-second deadline. On expiry it returns “Your reply will come in the app.” It never automatically retries a post. Thread composer retries preserve their key after uncertain delivery. New-bot retries reuse creation keys and a successfully created lead.

Demo fixtures require `-demo`; they never connect to a relay or load a saved connection. `-screen home|thread|tasks|usage|connect|question|newBot|settings|you` selects a capture surface. Screenshots show examples, not a production connection. With the built app installed and an existing iPhone already booted:

```sh
python3 capture-screenshots.py
```

The original Kind Swarm SVG characters are rasterized with AppKit by `swift render-moji.swift` on macOS. Generated PNGs are bundled for native iOS display; no AppKit is imported by the iOS target. Palette and hash selection follow the Mac KS implementation, with native condensed and monospaced type.

See `VALIDATION.md` for the task checkpoint, test evidence and remaining device/host checks.
