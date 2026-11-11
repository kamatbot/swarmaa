import AppKit
import SwiftUI

/// The app's usage colours. Each has a dark and a light value, resolved
/// against whatever appearance the view is drawn in.
enum Palette {
    static let ringTrack     = Color(dark: .white.withAlphaComponent(0.188),
                                     light: .black.withAlphaComponent(0.16))
    static let barTrack      = Color(dark: .white.withAlphaComponent(0.176),
                                     light: .black.withAlphaComponent(0.15))

    /// Named so `UsageBand.rampColor` can interpolate between them per-appearance rather
    /// than blending two already-resolved `Color`s (which would mix in whichever appearance
    /// happened to be current when the `Color` was built, not the one it draws in).
    static let amplePair: (dark: UInt32, light: UInt32) = (0x00FF88, 0x00A356)
    static let watchPair: (dark: UInt32, light: UInt32) = (0xF2FF00, 0xB08800)
    /// Already 3.5:1 on white, so the warning colour is the same in both.
    static let criticalPair: (dark: UInt32, light: UInt32) = (0xFF3F00, 0xFF3F00)

    static let ample         = Color(dark: NSColor(hex: amplePair.dark), light: NSColor(hex: amplePair.light))
    static let watch         = Color(dark: NSColor(hex: watchPair.dark), light: NSColor(hex: watchPair.light))
    static let critical      = Color(dark: NSColor(hex: criticalPair.dark), light: NSColor(hex: criticalPair.light))

    /// A continuous point between two palette anchors, each resolved for the current
    /// appearance first and interpolated in sRGB channels second — resolving after
    /// interpolating would blend whichever appearance was current when the ramp was
    /// evaluated into every later draw, not the appearance it is actually drawn in.
    static func ramp(from: (dark: UInt32, light: UInt32), to: (dark: UInt32, light: UInt32), fraction: Double) -> Color {
        let t = min(max(fraction, 0), 1)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(hex: isDark ? from.dark : from.light)
                .blendedByChannel(with: NSColor(hex: isDark ? to.dark : to.light), fraction: t)
        })
    }

    // Generation-speed bands are independent of cloud quota usage.
    static let generationFast = Color(hex: 0x0A84FF)          // blue
    static let generationSlow = Color(hex: 0xFF453A)          // red

    static let textPrimary   = Color(dark: .white, light: .black)
    static let textSecondary = Color(dark: NSColor(hex: 0x808080), light: NSColor(hex: 0x6B6B6B))
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue:  Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }

    /// Resolved against whatever appearance is current when the colour is drawn.
    init(dark: NSColor, light: NSColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green:   CGFloat((hex >> 8) & 0xFF) / 255,
            blue:    CGFloat(hex & 0xFF) / 255,
            alpha:   1
        )
    }

    /// A linear per-channel sRGB lerp — the same arithmetic the Windows ramp does in JS, kept
    /// deliberately simple rather than going through `blended(withFraction:of:)`, whose
    /// blending colour space is not something either side of a Mac/Windows parity claim
    /// should depend on.
    func blendedByChannel(with other: NSColor, fraction: CGFloat) -> NSColor {
        guard let a = usingColorSpace(.sRGB), let b = other.usingColorSpace(.sRGB) else { return self }
        func lerp(_ x: CGFloat, _ y: CGFloat) -> CGFloat { x + (y - x) * fraction }
        return NSColor(
            srgbRed: lerp(a.redComponent, b.redComponent),
            green:   lerp(a.greenComponent, b.greenComponent),
            blue:    lerp(a.blueComponent, b.blueComponent),
            alpha:   1
        )
    }
}

private struct SwarmaaReduceTransparencyKey: EnvironmentKey {
    static let defaultValue: Bool = false
}

extension EnvironmentValues {
    /// True when macOS Accessibility "Reduce Transparency" is enabled in system settings,
    /// or explicitly overridden via `.environment(\.swarmaaReduceTransparency, ...)`.
    var swarmaaReduceTransparency: Bool {
        get { self[SwarmaaReduceTransparencyKey.self] || self.accessibilityReduceTransparency }
        set { self[SwarmaaReduceTransparencyKey.self] = newValue }
    }
}
