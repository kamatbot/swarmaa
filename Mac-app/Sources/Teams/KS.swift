import AppKit
import SwiftUI

/// Kind Swarm, toned down for an app window: ink outlines, hard offset
/// shadows, paper ground, muted lime and coral. Matches the "Swarmaa main
/// window" design canvas. System condensed and monospaced type stand in for
/// IBM Plex Sans Condensed and Plex Mono; heavy condensed for the stencil
/// display lines.
enum KS {
    static let ink = Color(hex: 0x15111F)
    static let paper = Color(hex: 0xF4EFE6)
    static let white = Color.white
    static let lime = Color(hex: 0xCFE08A)
    static let coral = Color(hex: 0xE8836B)
    static let coralTint = Color(hex: 0xFBEFE7)
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

    static let border: CGFloat = 2.5
    static let shadow: CGFloat = 5

    static func body(_ size: CGFloat = 15, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight).width(.condensed)
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
    var fill: Color = KS.white
    var ink: Color = KS.ink
    init(_ text: String, fill: Color = KS.white, ink: Color = KS.ink) { self.text = text; self.fill = fill; self.ink = ink }
    var body: some View {
        Text(verbatim: text.uppercased()).font(KS.mono(10, .semibold)).tracking(0.6).lineLimit(1)
            .foregroundStyle(ink)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Capsule().fill(fill))
            .overlay(Capsule().stroke(KS.ink, lineWidth: 2))
            .fixedSize()
    }
}

/// A count in a lime pill.
struct KSBadge: View {
    let count: Int
    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)").font(KS.mono(11, .bold)).foregroundStyle(KS.ink)
            .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 20)
            .background(Capsule().fill(KS.lime))
            .overlay(Capsule().stroke(KS.ink, lineWidth: 2))
            .fixedSize()
            .accessibilityLabel(L10n.t("\(count) new"))
    }
}

extension View {
    /// White card, ink outline, optional hard offset shadow. Never blurred.
    func ksCard(fill: Color = KS.white, radius: CGFloat = 20, shadow: Bool = false, line: CGFloat = KS.border) -> some View {
        background(
            ZStack {
                if shadow { RoundedRectangle(cornerRadius: radius).fill(KS.ink).offset(x: KS.shadow, y: KS.shadow) }
                RoundedRectangle(cornerRadius: radius).fill(fill)
            }
        )
        .overlay(RoundedRectangle(cornerRadius: radius).stroke(KS.ink, lineWidth: line))
    }
}

/// Pill buttons: 2px ink border; `primary` gets the lime fill and a hard
/// shadow that presses flat.
struct KSButtonStyle: ButtonStyle {
    enum Kind { case primary, ink, paper, white }
    var kind: Kind = .white
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let fill: Color = switch kind { case .primary: KS.lime; case .ink: KS.ink; case .paper: KS.paper; case .white: KS.white }
        let fg: Color = kind == .ink ? KS.paper : KS.ink
        let raised = kind == .primary && !pressed
        configuration.label
            .font(KS.body(compact ? 13 : 14, .semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, compact ? 11 : 15)
            .frame(minHeight: compact ? 30 : 36)
            .background(
                ZStack {
                    if raised { Capsule().fill(KS.ink).offset(x: 3, y: 3) }
                    Capsule().fill(fill)
                }
            )
            .overlay(Capsule().stroke(KS.ink, lineWidth: 2))
            .offset(x: kind == .primary && pressed ? 3 : 0, y: kind == .primary && pressed ? 3 : 0)
            .contentShape(Capsule())
            .animation(.easeOut(duration: 0.12), value: pressed)
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

    /// The faces agents draw from; `mark` is the app's own.
    private static let agentKinds: [Kind] = [.lead, .runner, .scout, .navigator, .clerk, .scribe, .badgeSun, .badgePeri, .badgePeach]
    private static var cache: [Kind: NSImage] = [:]

    static func kind(for seed: String) -> Kind {
        agentKinds[Int(seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value } % UInt32(agentKinds.count))]
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
        .accessibilityHidden(true)
    }
}

/// A search field in a white pill.
struct KSSearchField: View {
    let prompt: String
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .semibold)).foregroundStyle(KS.ink)
            TextField(prompt, text: $text).textFieldStyle(.plain).font(KS.body(15))
        }
        .padding(.horizontal, 14).frame(height: 38)
        .background(Capsule().fill(KS.white))
        .overlay(Capsule().stroke(KS.ink, lineWidth: 2))
    }
}
