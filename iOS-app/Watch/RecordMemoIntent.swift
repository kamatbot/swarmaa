import AppIntents
import SwiftUI

/// Where the app should navigate; the Action button intent pushes the memo screen and asks it to record.
@MainActor @Observable final class WatchRouter {
    static let shared = WatchRouter()
    var path: [String] = []
    var recordRequest = 0
    func recordMemo() { if path != ["memos"] { path = ["memos"] }; recordRequest += 1 }
}

/// The app's side of RecordVoiceMemoIntent (the widget extension has a no-op one).
enum RecordMemoAction { @MainActor static func run() { WatchRouter.shared.recordMemo() } }

struct SwarmaaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RecordVoiceMemoIntent(), phrases: ["Record a memo in \(.applicationName)", "Voice memo in \(.applicationName)"], shortTitle: "Record memo", systemImageName: "mic.fill")
    }
}
