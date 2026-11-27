import Foundation

/// Lifecycle stub retained so callers such as `AppDelegate.applicationWillTerminate`
/// compile cleanly. Swarmaa does not inspect Antigravity process arguments, call
/// undocumented local RPCs, or spawn Antigravity's private `language_server` binary.
enum AntigravityBridge {
    final class Owned: @unchecked Sendable {
        func stop() {}
    }

    static let owned = Owned()
}
