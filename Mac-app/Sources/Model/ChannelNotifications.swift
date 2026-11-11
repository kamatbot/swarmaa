import AppKit
import Foundation
import UserNotifications

/// Banners in Notification Center for every event Swarmaa announces, and a
/// test button that answers whatever state the permission is in.
enum ChannelNotifications {
    static var explanation: String {
        L10n.t("A banner in Notification Center, which reaches you on any display. Sounds play as chosen below.")
    }

    /// Without a delegate, macOS delivers an app's own notifications quietly
    /// to the list while that app is frontmost: the test sent from Settings,
    /// with the Settings window in front, never showed. The delegate asks for
    /// the banner and the sound whatever is in front.
    private final class Presenter: NSObject, UNUserNotificationCenterDelegate {
        func userNotificationCenter(_ center: UNUserNotificationCenter,
                                    willPresent notification: UNNotification,
                                    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
            completionHandler([.banner, .list, .sound])
        }
    }
    private static let presenter = Presenter()

    static func installPresenter() {
        UNUserNotificationCenter.current().delegate = presenter
    }

    /// Asked at start, so the first banner is not also the first permission
    /// dialog.
    static func requestAuthorizationIfNeeded() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    /// A banner; or, when banners are switched off for Swarmaa in System
    /// Settings, that pane, because a test that shows nothing and says
    /// nothing reads as broken.
    static func test() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
                    if ok { post(title: L10n.t("Swarmaa test"), body: L10n.t("This is what one looks like.")) }
                }
            case .denied:
                DispatchQueue.main.async {
                    let id = Bundle.main.bundleIdentifier ?? "app.swarmaa.mac"
                    if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") {
                        NSWorkspace.shared.open(url)
                    }
                }
            default:
                post(title: L10n.t("Swarmaa test"), body: L10n.t("This is what one looks like."))
            }
        }
    }

    static func sessionEnded(name: String, blocked: Bool) {
        post(title: blocked ? L10n.t("\(name) is waiting on you") : L10n.t("\(name) finished"),
             body: blocked ? L10n.t("The agent stopped to ask you something.") : L10n.t("The agent's turn is done."),
             thread: "session|\(name)")
    }

    static func post(title: String, body: String, thread: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let thread { content.threadIdentifier = thread }
        let identifier = "channel|\(thread ?? "")|\(Int(Date().timeIntervalSince1970))"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { error in
            if let error {
                Log.usage.error("notification not accepted: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
