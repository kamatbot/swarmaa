import AppKit

/// Where Swarmaa shows itself: a Dock tile, or a menu bar item.
///
/// There is deliberately no "neither": with no Dock tile and no menu bar item
/// there would be nothing left to click to get back into the app.
enum AppPresence: String, CaseIterable, Identifiable {
    /// A normal app: Dock tile, ⌘-Tab entry, menu bar of its own.
    case dock
    /// An icon in the menu bar, and nothing in the Dock.
    case menuBar

    var id: String { rawValue }

    /// A stored value, read safely: the retired "hidden" choice (neither Dock
    /// nor menu bar) lands on the menu bar, and anything unknown is nil.
    init?(stored raw: String?) {
        guard let raw else { return nil }
        self.init(rawValue: raw == "hidden" ? AppPresence.menuBar.rawValue : raw)
    }

    var title: String {
        switch self {
        case .dock:    return L10n.t("Dock")
        case .menuBar: return L10n.t("Menu bar")
        }
    }

    var explanation: String {
        switch self {
        case .dock:
            return L10n.t("A normal app icon in the Dock while Swarmaa is running.")
        case .menuBar:
            return L10n.t("A small icon in the menu bar instead, and nothing in the Dock.")
        }
    }

    /// `.regular` is the only one that gets a Dock tile.
    var activationPolicy: NSApplication.ActivationPolicy {
        self == .dock ? .regular : .accessory
    }

    var wantsStatusItem: Bool { self == .menuBar }
}
