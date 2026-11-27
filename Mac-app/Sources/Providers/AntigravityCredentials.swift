import Foundation

/// Non-secret presence and refusal tracking for Antigravity.
///
/// Swarmaa never extracts OAuth tokens from Antigravity's Keychain item
/// (including via `/usr/bin/security -w`), `~/.omp/agent/agent.db`, or
/// `~/.gemini/oauth_creds.json`. Only non-secret Keychain attribute metadata
/// (never secret bytes) is inspected, and any user refusal recorded via
/// `KeychainRefusal` is respected until the user explicitly asks again.
struct AntigravityCredentials {
    static let service = "gemini"
    static let account = "antigravity"

    private static let refusalLock = NSLock()
    private static var defaultRefusal = KeychainRefusal(key: "antigravity", defaults: .standard)

    /// Tracks whether the user declined Keychain access for Antigravity.
    static var refusal: KeychainRefusal {
        get {
            refusalLock.lock()
            defer { refusalLock.unlock() }
            return defaultRefusal
        }
        set {
            refusalLock.lock()
            defaultRefusal = newValue
            refusalLock.unlock()
        }
    }

    /// Hook used by unit tests to simulate non-secret metadata presence without
    /// touching the login Keychain.
    nonisolated(unsafe) static var metadataPresentForTesting: (() -> Bool)?

    static var isRefused: Bool { refusal.isRefused }

    static func recordRefusal() {
        refusal.set(true)
    }

    static func forgetCached() {
        // No secret credential is cached in memory.
    }

    static func forgetCached(for profile: AntigravityProfile) {
        _ = profile
    }

    /// Clears a recorded refusal when the user explicitly clicks "Allow access…".
    static func askAgain() {
        askAgain(for: .default())
    }

    static func askAgain(for profile: AntigravityProfile) {
        if profile.slug == nil {
            refusal.set(false)
        }
    }

    /// Whether Antigravity appears to be configured on this Mac, checked strictly
    /// via non-secret metadata (Keychain item attributes, never secret data) and
    /// local transcript roots. Returns `false` whenever the user has refused access.
    static func isSignedIn() -> Bool {
        guard !refusal.isRefused else { return false }
        if let metadataPresentForTesting {
            return metadataPresentForTesting()
        }
        if KeychainItem.modifiedAt(service: service, account: account) != nil {
            return true
        }
        return !AntigravityActivity.transcriptRoots.isEmpty
    }

    static func hasCredential(for profile: AntigravityProfile) -> Bool {
        guard profile.slug == nil else { return false }
        return isSignedIn()
    }

    static func isSignedIn(for profile: AntigravityProfile) -> Bool {
        hasCredential(for: profile)
    }

    /// Parses RFC 3339 timestamps with or without fractional seconds and timezone
    /// offsets, without allocating an `ISO8601DateFormatter` per call.
    private static let fractionalISO = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plainISO = Date.ISO8601FormatStyle(includingFractionalSeconds: false)

    static func parse(_ value: String) -> Date? {
        if let date = try? fractionalISO.parse(value) { return date }
        return try? plainISO.parse(value)
    }
}
