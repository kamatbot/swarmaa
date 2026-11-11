import AppKit
import SwiftUI

/// Swarmaa's workspace palette: a dark-navy developer tool. Token names predate the
/// navy rebuild ("paper", "ink", "white"), so every view follows; read them as roles:
/// `paper` = window ground, `paperDeep` = side columns, `white` = card, `ink` = primary text.
enum KS {
    /// Primary text.
    static let ink = Color(hex: 0xE3E9F2)
    /// Titles and names.
    static let strong = Color(hex: 0xF2F5FA)
    /// Window ground.
    static let paper = Color(hex: 0x0B182D)
    /// Side columns.
    static let paperDeep = Color(hex: 0x0D1C33)
    /// The window top bar.
    static let topBar = Color(hex: 0x0F1F38)
    /// The leftmost rail.
    static let rail = Color(hex: 0x08142A)
    /// Inset wells: search, composer, code.
    static let well = Color(hex: 0x081326)
    /// Agent message cards.
    static let bubble = Color(hex: 0x102039)
    /// Selected row and your own messages.
    static let selected = Color(hex: 0x1B3155)
    /// Chips, tracks and secondary buttons.
    static let chip = Color(hex: 0x182C4D)
    static let chipAlt = Color(hex: 0x16294A)
    /// A soft separator between rows inside a card.
    static let hairline = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255).opacity(0.08)
    /// Card surface (named for the light theme it replaced).
    static let white = Color(hex: 0x12233E)
    /// Signal blue: primary buttons, progress, running.
    static let signal = Color(hex: 0x8FB8FF)
    /// Text on signal blue (and on any light accent fill).
    static let onSignal = Color(hex: 0x0A1830)
    /// Kept name: the old lime accent is now signal blue.
    static let lime = signal
    /// Failure.
    static let coral = Color(hex: 0xE0896A)
    /// Destructive actions (hide, delete).
    static let danger = Color(hex: 0xE0896A)
    /// A card that needs you: the card, warmed a touch toward amber.
    static let coralTint = Color(hex: 0x1E2C42)
    static let amber = Color(hex: 0xE0A77A)
    static let needsYouTint = Color(hex: 0xE0A77A).opacity(0.16)
    static let needsYouText = Color(hex: 0xECC09A)
    static let readyText = Color(hex: 0xCDDCB8)
    static let failedTint = Color(hex: 0xE0896A).opacity(0.16)
    static let failedText = Color(hex: 0xF0A88E)
    static let neutralTint = chip
    static let hoverTint = Color(hex: 0x213A62)
    static let searchLine = hairline
    static let optionLine = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255).opacity(0.14)
    static let sage = Color(hex: 0xB9C9A2)
    static let sageTint = Color(hex: 0xB9C9A2).opacity(0.18)
    static let sky = Color(hex: 0x7AA7F2)
    static let butter = Color(hex: 0xE0A77A).opacity(0.16)
    static let lilac = Color(hex: 0x2A4068)
    static let textSoft = Color(hex: 0xB3C1D4)
    static let textMuted = Color(hex: 0x8B9CB6)
    static let textDim = Color(hex: 0x7C8EA8)
    /// Idle dots and separators.
    static let idle = Color(hex: 0x4F6688)
    static let onInkSoft = Color(hex: 0xC9D4E4)
    static let onInkMuted = Color(hex: 0x8B9CB6)
    static let inkLine = chip
    static let dash = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255).opacity(0.10)
    static let shadow = Color.black

    static let motion = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.2)
    static let pressMotion = Animation.spring(response: 0.28, dampingFraction: 0.78)

    static func body(_ size: CGFloat = 15, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold) }
    static func mono(_ size: CGFloat = 11, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    /// A provider's ring colour in the rail and on Usage.
    static func providerTint(_ provider: String) -> Color {
        switch provider {
        case "claude": return Color(hex: 0xC99D72)
        case "antigravity": return Color(hex: 0x7AA7F2)
        case "codex": return Color(hex: 0xAEB6BD)
        default: return Color(hex: 0xB9A0D6)
        }
    }
}

/// "01 — The crew": mono, upper case, tracked.
struct KSLabel: View {
    let text: String
    var color: Color = KS.textMuted
    init(_ text: String, color: Color = KS.textMuted) { self.text = text; self.color = color }
    var body: some View {
        Text(verbatim: text.uppercased()).font(KS.body(11, .semibold)).tracking(0.9).foregroundStyle(color)
    }
}

struct KSChip: View {
    let text: String
    var fill: Color = KS.neutralTint
    var ink: Color = KS.textSoft
    init(_ text: String, fill: Color = KS.neutralTint, ink: Color = KS.textSoft) { self.text = text; self.fill = fill; self.ink = ink }
    var body: some View {
        Text(verbatim: text).font(KS.mono(11, .medium)).lineLimit(1)
            .foregroundStyle(ink)
            .padding(.horizontal, 7).frame(height: 20)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(fill))
            .fixedSize()
    }
}

/// A count in a signal-blue pill.
struct KSBadge: View {
    let count: Int
    var outlined = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)").font(KS.mono(11, .bold)).foregroundStyle(KS.onSignal)
            .contentTransition(reduceMotion ? .identity : .numericText())
            .animation(reduceMotion ? nil : KS.motion, value: count)
            .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(KS.lime))
            .overlay { if outlined { Capsule().strokeBorder(KS.rail, lineWidth: 2) } }
            .fixedSize()
            .accessibilityLabel(L10n.t("\(count) new"))
    }
}

extension View {
    /// Raised surface; legacy shadow callers use the same soft depth.
    /// Card surface with a hairline edge; navy cards part by tone and line, not shadow.
    func ksCard(fill: Color = KS.white, radius: CGFloat = 12, shadow: Bool = true, line: CGFloat = 1) -> some View {
        background(RoundedRectangle(cornerRadius: min(radius, 12), style: .continuous).fill(fill))
        .overlay(RoundedRectangle(cornerRadius: min(radius, 12), style: .continuous).strokeBorder(KS.hairline, lineWidth: max(line, 1)))
    }
}

/// Borderless pill buttons with a subtle press and secondary hover tint.
struct KSButtonStyle: ButtonStyle {
    enum Kind { case primary, ink, paper, white, danger }
    var kind: Kind = .white
    var compact = false
    @State private var hovered = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let fill: Color = switch kind {
        case .primary: hovered && isEnabled ? Color(hex: 0xA6C7FF) : KS.signal
        case .ink: KS.selected
        case .danger: KS.failedTint
        case .paper, .white: hovered && isEnabled ? KS.hoverTint : KS.chip
        }
        let fg: Color = kind == .primary ? KS.onSignal : kind == .danger ? KS.failedText : KS.ink
        configuration.label
            .font(KS.body(compact ? 13 : 14, .semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, compact ? 11 : 15)
            .frame(minHeight: compact ? 30 : 36)
            .background(RoundedRectangle(cornerRadius: compact ? 8 : 9, style: .continuous).fill(fill))
            .overlay {
                if kind == .paper || kind == .white {
                    RoundedRectangle(cornerRadius: compact ? 8 : 9, style: .continuous).strokeBorder(KS.optionLine, lineWidth: 1)
                }
            }
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 9))
            .opacity(isEnabled ? 1 : 0.45)
            .onHover { hovered = $0 }
            .animation(reduceMotion ? nil : KS.pressMotion, value: pressed)
    }
}

extension ButtonStyle where Self == KSButtonStyle {
    static func ks(_ kind: KSButtonStyle.Kind = .white, compact: Bool = false) -> KSButtonStyle { KSButtonStyle(kind: kind, compact: compact) }
}

/// Kind Swarm's characters (bundled SVGs from the design system). Each
/// agent gets one, picked from its id so it keeps the same face everywhere.
/// Decorative: the name always sits next to it.
struct KSMoji: View {
    enum Kind: String, CaseIterable {
        case lead, scribe, scout, runner, clerk, navigator, mark
        case badgeSun = "badge-sun", badgePeri = "badge-peri", badgePeach = "badge-peach"
    }

    let seed: String
    var size: CGFloat = 40
    var kind: Kind? = nil
    var color: String? = nil

    /// The faces agents draw from; `mark` is the app's own.
    private static let agentKinds: [Kind] = [.lead, .runner, .scout, .navigator, .clerk, .scribe, .badgeSun, .badgePeri, .badgePeach]
    private static var cache: [Kind: NSImage] = [:]

    static func kind(for seed: String) -> Kind {
        if let named = Kind(rawValue: seed), named != .mark { return named }
        return agentKinds[Int(seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value } % UInt32(agentKinds.count))]
    }

    /// Each character's body hue, measured from its image. A bot's colour rotates the body to that
    /// colour's hue; eyes and outlines are neutral, so they stay as they are. No colour, no change.
    private static let baseHue: [Kind: Double] = [.lead: 251, .runner: 248, .scout: 352, .navigator: 38, .clerk: 273,
                                                  .scribe: 246, .badgeSun: 39, .badgePeri: 247, .badgePeach: 360]
    private static let colorHue: [String: Double] = ["blue": 213, "butter": 45, "peach": 19, "lilac": 260,
                                                      "pink": 332, "lime": 78, "sky": 197, "orchid": 288]
    static func hueShift(_ kind: Kind, color: String?) -> Double {
        guard let color, let target = colorHue[color], let base = baseHue[kind] else { return 0 }
        return target - base
    }

    static func image(_ kind: Kind) -> NSImage? {
        if let hit = cache[kind] { return hit }
        guard let url = Bundle.main.url(forResource: "moji-" + kind.rawValue, withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { return nil }
        cache[kind] = image
        return image
    }

    var body: some View {
        Group {
            if let image = Self.image(kind ?? Self.kind(for: seed)) {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
            } else {
                RoundedRectangle(cornerRadius: size * 0.3).fill(KS.lilac)
                    .overlay(RoundedRectangle(cornerRadius: size * 0.3).stroke(KS.hairline, lineWidth: 1))
                    .padding(size * 0.1)
            }
        }
        .frame(width: size, height: size)
        .hueRotation(.degrees(Self.hueShift(kind ?? Self.kind(for: seed), color: color)))
        .accessibilityHidden(true)
    }
}

/// A search field in an inset well.
struct KSSearchField: View {
    let prompt: String
    @Binding var text: String
    var height: CGFloat = 38
    @FocusState private var focused: Bool
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .semibold)).foregroundStyle(KS.textDim)
            TextField(prompt, text: $text).textFieldStyle(.plain).font(KS.body(13)).foregroundStyle(KS.ink).focused($focused)
            if !text.isEmpty {
                Button { text = ""; focused = true } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(KS.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.t("Clear search"))
                .help(L10n.t("Clear search"))
            }
        }
        .padding(.horizontal, 10).frame(height: height)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KS.well))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(focused ? KS.signal.opacity(0.7) : KS.searchLine, lineWidth: 1))
    }
}

// MARK: - Top bar

/// The unified window top bar (docs/briefs/mac-top-bar.md). Every column's bar is
/// this tall, so the traffic lights, search, bot name and actions share one row.
extension KS { static let topBarHeight: CGFloat = 52 }

struct KSTopBar<Content: View>: View {
    var fill: Color = KS.paper
    @ViewBuilder var content: Content
    var body: some View {
        HStack(spacing: 10) { content }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: KS.topBarHeight, maxHeight: KS.topBarHeight)
            .background(fill)
    }
}

struct KSBarButtonStyle: ButtonStyle {
    var on = false
    var send = false
    @State private var hovered = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        configuration.label
            .frame(width: send ? 36 : 32, height: send ? 36 : 32)
            .foregroundStyle(send ? KS.onSignal : on ? KS.onSignal : KS.ink)
            .background(RoundedRectangle(cornerRadius: send ? 9 : 8, style: .continuous)
                .fill(send ? KS.signal.opacity(isEnabled ? 1 : 0.3) : on ? KS.signal : (hovered || pressed) && isEnabled ? KS.chip : .clear))
            .contentShape(RoundedRectangle(cornerRadius: 8))
            .onHover { hovered = $0 }
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .offset(y: pressed && !reduceMotion ? 1 : 0)
            .opacity(isEnabled ? (pressed ? 0.8 : 1) : send ? 1 : 0.45)
            .animation(reduceMotion ? nil : KS.pressMotion, value: pressed)
    }
}

/// 32pt icon button for bars. `on` fills it signal blue: a toggle that is on.
struct KSBarButton: View {
    let symbol: String
    let label: String
    var on = false
    var fill: Color = KS.paper
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(KSBarButtonStyle(on: on || fill == KS.lime))
        .accessibilityLabel(label).help(label)
    }
}
