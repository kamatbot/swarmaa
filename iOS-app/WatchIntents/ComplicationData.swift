import Foundation

/// Tiny App Group store the Watch app writes and the complications read.
enum ComplicationData {
    static let group = "group.app.swarmaa.watch"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: group) }
    static var needsCount: Int { defaults?.integer(forKey: "needs") ?? 0 }
    static var signedIn: Bool { defaults?.bool(forKey: "signedIn") ?? false }
    static func write(needs: Int, signedIn: Bool) { defaults?.set(needs, forKey: "needs"); defaults?.set(signedIn, forKey: "signedIn") }
}
