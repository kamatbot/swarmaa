import AppKit
import SwiftUI

/// Kind Swarm: soft content surfaces, paper ground, muted lime and coral. Matches the "Swarmaa main
/// window" design canvas. Normal-width system type keeps body copy legible;
/// compressed type is reserved for the stencil display lines.
enum KS {
    static let ink = Color(hex: 0x15111F)
    static let paper = Color(hex: 0xF4EFE6)
    /// The bot list and other side columns: a shade darker than paper, so columns part by tone, not a rule.
    static let paperDeep = Color(hex: 0xEBE4D7)
    /// A soft separator between rows inside a card.
    static let hairline = Color(hex: 0x15111F).opacity(0.10)
    static let white = Color.white
    static let lime = Color(hex: 0xCFE08A)
    static let coral = Color(hex: 0xE8836B)
    /// Destructive actions (hide, delete).
    static let danger = Color(hex: 0xC8452F)
    static let coralTint = Color(hex: 0xFDF5F0)
    static let needsYouTint = Color(hex: 0xFBE3DA)
    static let needsYouText = Color(hex: 0x9B3A22)
    static let readyText = Color(hex: 0x4A5A12)
    static let failedTint = Color(hex: 0xF6DDD6)
    static let failedText = Color(hex: 0x8A2410)
    static let neutralTint = ink.opacity(0.06)
    static let hoverTint = ink.opacity(0.10)
    static let searchLine = ink.opacity(0.06)
    static let optionLine = ink.opacity(0.12)
    static let sage = Color(hex: 0xD6E3A6)
    static let sageTint = Color(hex: 0xF1F5E2)
    static let sky = Color(hex: 0xB7CCE8)
    static let butter = Color(hex: 0xEAD9A6)
    static let lilac = Color(hex: 0xD9CDEE)
    static let textSoft = Color(hex: 0x3A3347)
    static let textMuted = Color(hex: 0x5A5168)
    static let onInkSoft = Color(hex: 0xCFC6E8)
    static let onInkMuted = Color(hex: 0xB9B0CC)
    static let inkLine = Color(hex: 0x3B3358)
    static let dash = Color(hex: 0xCFC6E8)

    static let motion = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.2)
    static let pressMotion = Animation.spring(response: 0.28, dampingFraction: 0.78)

    static func body(_ size: CGFloat = 15, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .black).width(.compressed) }
    static func mono(_ size: CGFloat = 11, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    /// A provider's ring colour in the rail and on Usage.
    static func providerTint(_ provider: String) -> Color {
        switch provider {
        case "claude": return lime
        case "antigravity": return sky
        case "codex": return coral
        default: return butter
        }
    }
}

/// "01 — The crew": mono, upper case, tracked.
struct KSLabel: View {
    let text: String
    var color: Color = KS.textMuted
    init(_ text: String, color: Color = KS.textMuted) { self.text = text; self.color = color }
    var body: some View {
        Text(verbatim: text.uppercased()).font(KS.mono(11)).tracking(1.6).foregroundStyle(color)
    }
}

struct KSChip: View {
    let text: String
    var fill: Color = KS.neutralTint
    var ink: Color = KS.textSoft
    init(_ text: String, fill: Color = KS.neutralTint, ink: Color = KS.textSoft) { self.text = text; self.fill = fill; self.ink = ink }
    var body: some View {
        Text(verbatim: text).font(KS.body(11.5, .semibold)).lineLimit(1)
            .foregroundStyle(ink)
            .padding(.horizontal, 7).frame(height: 22)
            .background(Capsule().fill(fill))
            .fixedSize()
    }
}

/// A count in a lime pill.
struct KSBadge: View {
    let count: Int
    var outlined = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)").font(KS.mono(11, .bold)).foregroundStyle(KS.ink)
            .contentTransition(reduceMotion ? .identity : .numericText())
            .animation(reduceMotion ? nil : KS.motion, value: count)
            .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(KS.lime))
            .overlay { if outlined { Capsule().strokeBorder(KS.ink, lineWidth: 2) } }
            .fixedSize()
            .accessibilityLabel(L10n.t("\(count) new"))
    }
}

extension View {
    /// Raised surface; legacy shadow callers use the same soft depth.
    func ksCard(fill: Color = KS.white, radius: CGFloat = 16, shadow: Bool = true, line: CGFloat = 0) -> some View {
        background(
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(fill)
                .shadow(color: KS.ink.opacity(0.06), radius: 1, y: 1)
                .shadow(color: KS.ink.opacity(0.05), radius: 7, y: 4)
        )
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(KS.hairline, lineWidth: line))
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
        case .primary: KS.lime
        case .ink: KS.ink
        case .danger: KS.failedTint
        case .paper, .white: hovered && isEnabled ? KS.hoverTint : KS.neutralTint
        }
        let fg: Color = kind == .ink ? KS.paper : kind == .danger ? KS.failedText : KS.ink
        configuration.label
            .font(KS.body(compact ? 13 : 14, .semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, compact ? 11 : 15)
            .frame(minHeight: compact ? 30 : 36)
            .background(Capsule().fill(fill))
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .contentShape(Capsule())
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
                    .overlay(RoundedRectangle(cornerRadius: size * 0.3).stroke(KS.ink, lineWidth: 2))
                    .padding(size * 0.1)
            }
        }
        .frame(width: size, height: size)
        .hueRotation(.degrees(Self.hueShift(kind ?? Self.kind(for: seed), color: color)))
        .accessibilityHidden(true)
    }
}

/// A search field in a white pill.
struct KSSearchField: View {
    let prompt: String
    @Binding var text: String
    var height: CGFloat = 38
    @FocusState private var focused: Bool
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .semibold)).foregroundStyle(KS.ink)
            TextField(prompt, text: $text).textFieldStyle(.plain).font(KS.body(15)).focused($focused)
            if !text.isEmpty {
                Button { text = ""; focused = true } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(KS.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.t("Clear search"))
                .help(L10n.t("Clear search"))
            }
        }
        .padding(.horizontal, 14).frame(height: height)
        .background(Capsule().fill(KS.white))
        .overlay(Capsule().strokeBorder(KS.searchLine, lineWidth: 1))
        .overlay(Capsule().strokeBorder(KS.lime, lineWidth: focused ? 3 : 0).padding(3))
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
            .foregroundStyle(send ? KS.paper : KS.ink)
            .background(Circle().fill(send ? KS.ink.opacity(isEnabled ? 1 : 0.25) : on ? KS.lime : (hovered || pressed) && isEnabled ? KS.neutralTint : .clear))
            .contentShape(Circle())
            .onHover { hovered = $0 }
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .offset(y: pressed && !reduceMotion ? 1 : 0)
            .opacity(isEnabled ? (pressed ? 0.8 : 1) : send ? 1 : 0.45)
            .animation(reduceMotion ? nil : KS.pressMotion, value: pressed)
    }
}

/// 32pt round icon button for the top bar. `on` fills it lime: a toggle that is on.
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
        .buttonStyle(KSBarButtonStyle(on: on || fill == KS.lime)).foregroundStyle(KS.ink)
        .accessibilityLabel(label).help(label)
    }
}
