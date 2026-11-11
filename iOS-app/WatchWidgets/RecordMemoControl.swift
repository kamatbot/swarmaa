import AppIntents
import SwiftUI
import WidgetKit

/// The extension never records itself: the intent opens the Watch app, which records.
enum RecordMemoAction { @MainActor static func run() {} }

struct RecordMemoControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "app.swarmaa.record-memo") {
            ControlWidgetButton(action: RecordVoiceMemoIntent()) { Label("Record memo", systemImage: "mic.fill") }
        }
        .displayName("Record memo")
        .description("Start a voice memo for your Assistant.")
    }
}

@main struct SwarmaaWatchWidgets: WidgetBundle {
    var body: some Widget { RecordMemoControl() }
}
