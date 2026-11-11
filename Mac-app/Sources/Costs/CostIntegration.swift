import AppKit
import Combine
import SwiftUI

/// Where the cost layer plugs into the app: the cost models watch the usage
/// store's snapshots, and the Activity window opens from the menu.
@MainActor
enum Costs {
    private static var subscription: AnyCancellable?
    private static var activityWindow: NSWindow?
    /// Whether the Activity window shows costs. Off, no cost model is built
    /// or fed, so the app never scans transcripts unasked.
    private static var isNeeded: Bool { activityWindow?.isVisible == true }

    static func attach(to store: UsageStore) {
        _ = PlanCatalog.shared
        _ = PriceTable.shared
        _ = CostAccountStore.shared
        subscription = store.$snapshots
            .receive(on: RunLoop.main)
            .sink { snapshots in
                guard isNeeded else { return }
                CostAccountStore.shared.rediscover()
                CostModels.all.forEach { $0.observe(snapshots) }
            }
    }

    static func showActivity() {
        if activityWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
            w.title = L10n.t("Activity")
            w.minSize = NSSize(width: 900, height: 560)
            w.contentViewController = NSHostingController(rootView: TimelinePane().frame(minWidth: 900, minHeight: 560))
            w.isReleasedWhenClosed = false
            w.center()
            activityWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        activityWindow?.makeKeyAndOrderFront(nil)
    }
}
