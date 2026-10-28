import SwiftUI
import AppKit

/// The first-launch / "Run Setup…" window: a regular, centered window, not the notch.
@MainActor
final class OnboardingWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var model: OnboardingModel?
    private var finished = false
    private let preferences: Preferences?
    private let onClose: () -> Void

    /// `onClose` runs once, whether the user finished or closed the window.
    init(preferences: Preferences?, onClose: @escaping () -> Void) {
        self.preferences = preferences
        self.onClose = onClose
    }

    var isShowing: Bool { window?.isVisible ?? false }

    func show() {
        if let window { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil); return }
        let model = OnboardingModel()
        self.model = model
        let view = OnboardingView(model: model) { [weak self] in self?.finish() }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 640),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "Swarmaa Setup"
        window.contentView = NSHostingView(rootView: view)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func finish() {
        finished = true
        model?.markComplete()
        // Bring a running Preferences in line with what setup just wrote.
        if let p = preferences {
            p.swarmaEnabled = Preferences.storedSwarmaEnabled()
            p.swarmaTokenPath = Preferences.storedSwarmaTokenPath()
            p.swarmaServiceURL = Preferences.storedSwarmaServiceURL()
        }
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        // Closing without finishing counts as skipping: the app still starts,
        // and "Run Setup…" is the way back.
        if !finished { model?.markComplete() }
        window = nil
        model = nil
        onClose()
    }
}
