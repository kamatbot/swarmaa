import ActivityKit
import SwiftUI
import WidgetKit

enum LiveActivityTheme {
    static let ground = Color(hex: 0x0B182D)
    static let grouped = Color(hex: 0x0D1C33)
    static let surface = Color(hex: 0x12233E)
    static let chip = Color(hex: 0x182C4D)
    static let hairline = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255).opacity(0.08)
    static let ink = Color(hex: 0xE3E9F2)
    static let strong = Color(hex: 0xF2F5FA)
    static let muted = Color(hex: 0x8B9CB6)
    static let soft = Color(hex: 0xB3C1D4)
    static let signal = Color(hex: 0x8FB8FF)
    static let signalTint = Color(hex: 0x8FB8FF).opacity(0.14)
    static let needsTint = Color(hex: 0xE0A77A).opacity(0.16)
    static let needsText = Color(hex: 0xECC09A)
    static let readyTint = Color(hex: 0xB9C9A2).opacity(0.16)
    static let readyText = Color(hex: 0xCDDCB8)
    static let failedTint = Color(hex: 0xE0896A).opacity(0.16)
    static let failedText = Color(hex: 0xE0896A)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 255) / 255,
            green: Double((hex >> 8) & 255) / 255,
            blue: Double(hex & 255) / 255,
            opacity: 1
        )
    }

    init(hexString: String?, fallback: Color = LiveActivityTheme.signal) {
        guard let hexString else { self = fallback; return }
        var cleaned = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") { cleaned.removeFirst() }
        else if cleaned.hasPrefix("0x") { cleaned.removeFirst(2) }
        guard let value = UInt32(cleaned, radix: 16) else { self = fallback; return }
        if cleaned.count == 6 {
            self.init(hex: value)
        } else if cleaned.count == 8 {
            self.init(
                .sRGB,
                red: Double((value >> 24) & 255) / 255,
                green: Double((value >> 16) & 255) / 255,
                blue: Double((value >> 8) & 255) / 255,
                opacity: Double(value & 255) / 255
            )
        } else {
            self = fallback
        }
    }
}

enum BotTurnStatus: Equatable, Sendable {
    case running
    case needsYou
    case done
    case failed
    case other(String)

    init(_ raw: String) {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "running", "queued", "working":
            self = .running
        case "needs_you", "needs you", "needsyou", "needs_attention":
            self = .needsYou
        case "done", "completed", "resolved", "success":
            self = .done
        case "failed", "error", "blocked":
            self = .failed
        default:
            self = .other(raw)
        }
    }

    var text: String {
        switch self {
        case .running: return "Running"
        case .needsYou: return "Needs you"
        case .done: return "Done"
        case .failed: return "Failed"
        case .other(let raw):
            guard let first = raw.first else { return "" }
            return first.uppercased() + raw.dropFirst()
        }
    }

    var textColor: Color {
        switch self {
        case .running: return LiveActivityTheme.signal
        case .needsYou: return LiveActivityTheme.needsText
        case .done: return LiveActivityTheme.readyText
        case .failed: return LiveActivityTheme.failedText
        case .other: return LiveActivityTheme.soft
        }
    }

    var tintColor: Color {
        switch self {
        case .running: return LiveActivityTheme.signalTint
        case .needsYou: return LiveActivityTheme.needsTint
        case .done: return LiveActivityTheme.readyTint
        case .failed: return LiveActivityTheme.failedTint
        case .other: return LiveActivityTheme.chip
        }
    }

    var systemImage: String {
        switch self {
        case .running: return "play.fill"
        case .needsYou: return "person.fill.questionmark"
        case .done: return "checkmark"
        case .failed: return "xmark"
        case .other: return "circle.fill"
        }
    }
}

struct StatusPillView: View {
    let status: BotTurnStatus

    init(_ rawStatus: String) {
        self.status = BotTurnStatus(rawStatus)
    }

    var body: some View {
        Text(status.text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(status.textColor)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(status.tintColor, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct BotTurnLockScreenView: View {
    let context: ActivityViewContext<BotTurnAttributes>

    private var botColor: Color {
        Color(hexString: context.attributes.color)
    }

    private var initial: String {
        let name = context.attributes.botName.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(name.prefix(1)).uppercased()
    }

    private var status: BotTurnStatus {
        BotTurnStatus(context.state.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                ZStack {
                    Circle()
                        .fill(botColor.opacity(0.2))
                        .frame(width: 28, height: 28)
                    Text(initial.isEmpty ? "S" : initial)
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .foregroundStyle(botColor)
                }

                Text(context.attributes.botName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(LiveActivityTheme.strong)
                    .lineLimit(1)

                Spacer()

                StatusPillView(context.state.status)

                if status == .running {
                    Text(context.state.startedAt, style: .timer)
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(LiveActivityTheme.signal)
                }
            }

            if !context.state.step.isEmpty {
                Text(context.state.step)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(LiveActivityTheme.ink)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .activityBackgroundTint(LiveActivityTheme.surface)
        .widgetURL(URL(string: "swarmaa://bot/\(context.attributes.botId)"))
    }
}

@main
struct SwarmaaLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        BotTurnLiveActivity()
    }
}

struct BotTurnLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotTurnAttributes.self) { context in
            BotTurnLockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    let color = Color(hexString: context.attributes.color)
                    let initial = String(context.attributes.botName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
                    HStack(spacing: 8) {
                        ZStack {
                            Circle()
                                .fill(color.opacity(0.2))
                                .frame(width: 24, height: 24)
                            Text(initial.isEmpty ? "S" : initial)
                                .font(.system(size: 12, weight: .bold, design: .rounded))
                                .foregroundStyle(color)
                        }
                        Text(context.attributes.botName)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(LiveActivityTheme.strong)
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    let status = BotTurnStatus(context.state.status)
                    HStack(spacing: 6) {
                        StatusPillView(context.state.status)
                        if status == .running {
                            Text(context.state.startedAt, style: .timer)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                .monospacedDigit()
                                .foregroundStyle(LiveActivityTheme.signal)
                        }
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        if !context.state.step.isEmpty {
                            Text(context.state.step)
                                .font(.system(size: 13, weight: .regular))
                                .foregroundStyle(LiveActivityTheme.ink)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                }
            } compactLeading: {
                let color = Color(hexString: context.attributes.color)
                let initial = String(context.attributes.botName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
                ZStack {
                    Circle()
                        .fill(color.opacity(0.2))
                        .frame(width: 20, height: 20)
                    Text(initial.isEmpty ? "S" : initial)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(color)
                }
                .padding(.leading, 4)
            } compactTrailing: {
                let status = BotTurnStatus(context.state.status)
                Group {
                    if status == .running {
                        Text(context.state.startedAt, style: .timer)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .monospacedDigit()
                            .foregroundStyle(LiveActivityTheme.signal)
                            .frame(minWidth: 32, alignment: .trailing)
                    } else {
                        Image(systemName: status.systemImage)
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(status.textColor)
                    }
                }
                .padding(.trailing, 4)
            } minimal: {
                let color = Color(hexString: context.attributes.color)
                let initial = String(context.attributes.botName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
                ZStack {
                    Circle()
                        .fill(color.opacity(0.2))
                        .frame(width: 20, height: 20)
                    Text(initial.isEmpty ? "S" : initial)
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(color)
                }
            }
            .widgetURL(URL(string: "swarmaa://bot/\(context.attributes.botId)"))
        }
    }
}
