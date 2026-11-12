import SwiftUI
import WidgetKit

struct ComplicationEntry: TimelineEntry { let date = Date(); let needs: Int; let signedIn: Bool }

struct ComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> ComplicationEntry { ComplicationEntry(needs: 0, signedIn: true) }
    func getSnapshot(in context: Context, completion: @escaping (ComplicationEntry) -> Void) { completion(entry()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ComplicationEntry>) -> Void) { completion(Timeline(entries: [entry()], policy: .never)) }
    private func entry() -> ComplicationEntry { ComplicationEntry(needs: ComplicationData.needsCount, signedIn: ComplicationData.signedIn) }
}

struct NeedsYouView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ComplicationEntry
    private var count: String { entry.signedIn ? "\(entry.needs)" : "–" }
    private var clear: Bool { entry.signedIn && entry.needs == 0 }
    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text(!entry.signedIn ? "Swarmaa · –" : clear ? "Swarmaa · all clear" : "Swarmaa · \(entry.needs) need you")
            case .accessoryCorner:
                Image(systemName: clear ? "checkmark" : "person.fill.questionmark").widgetAccentable()
                    .widgetLabel(!entry.signedIn ? "–" : clear ? "All clear" : "\(entry.needs) need you")
            default:
                VStack(spacing: 0) {
                    Image(systemName: clear ? "checkmark" : "person.fill.questionmark").font(.caption2).widgetAccentable()
                    Text(count).font(.system(size: 24, weight: .bold, design: .rounded)).opacity(clear || !entry.signedIn ? 0.5 : 1)
                }
            }
        }
        .widgetURL(URL(string: "swarmaa://needs"))
        .containerBackground(for: .widget) { Color.clear }
    }
}

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.swarmaa.needs-you", provider: ComplicationProvider()) { NeedsYouView(entry: $0) }
            .configurationDisplayName("Needs you")
            .description("Questions waiting for your answer.")
            .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
    }
}

struct VoiceMemoView: View {
    @Environment(\.widgetFamily) private var family
    var body: some View {
        Group {
            if family == .accessoryCorner {
                Image(systemName: "mic.fill").widgetAccentable().widgetLabel("Memo")
            } else {
                ZStack { AccessoryWidgetBackground(); Image(systemName: "mic.fill").font(.title2).widgetAccentable() }
            }
        }
        .widgetURL(URL(string: "swarmaa://record"))
        .containerBackground(for: .widget) { Color.clear }
    }
}

struct VoiceMemoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.swarmaa.voice-memo", provider: ComplicationProvider()) { _ in VoiceMemoView() }
            .configurationDisplayName("Voice memo")
            .description("Start a voice memo.")
            .supportedFamilies([.accessoryCircular, .accessoryCorner])
    }
}

#Preview(as: .accessoryCircular) { NeedsYouWidget() } timeline: { ComplicationEntry(needs: 0, signedIn: true); ComplicationEntry(needs: 3, signedIn: true) }
#Preview(as: .accessoryCircular) { VoiceMemoWidget() } timeline: { ComplicationEntry(needs: 0, signedIn: true) }
