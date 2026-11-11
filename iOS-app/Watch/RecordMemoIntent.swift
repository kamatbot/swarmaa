import AppIntents
import SwiftUI

/// Where the app should navigate; the Action button intent pushes the memo screen and asks it to record.
@MainActor @Observable final class WatchRouter {
    static let shared = WatchRouter()
    var path: [String] = []
    var recordRequest = 0
    func recordMemo() { if path != ["memos"] { path = ["memos"] }; recordRequest += 1 }
}

struct RecordVoiceMemoIntent: AppIntent {
    static let title: LocalizedStringResource = "Record a memo"
    static let description = IntentDescription("Opens Swarmaa and starts recording a voice memo for your Assistant.")
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { WatchRouter.shared.recordMemo(); return .result() }
}

struct SwarmaaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RecordVoiceMemoIntent(), phrases: ["Record a memo in \(.applicationName)", "Voice memo in \(.applicationName)"], shortTitle: "Record memo", systemImageName: "mic.fill")
    }
}
