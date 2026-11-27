import XCTest
@testable import Swarmaa

/// The permission a person grants by clicking "Allow access…": one read may
/// show the keychain dialogue, and nothing on a timer ever may.
final class PromptPermissionTests: XCTestCase {
    func testNothingIsOwedUntilSomebodyAsks() {
        XCTAssertFalse(PromptPermission().take())
    }

    func testAskingOwesExactlyOneRead() {
        let permission = PromptPermission()
        permission.grant()
        XCTAssertTrue(permission.take())
        XCTAssertFalse(permission.take(), "a second read spent the same click")
    }

    /// A click whose refresh never reached the keychain must not be spent by
    /// some poll much later — the dialogue would then appear on a timer.
    func testAnUnspentPermissionLapses() {
        final class Clock: @unchecked Sendable { var now = Date(timeIntervalSince1970: 1_000) }
        let clock = Clock()
        let permission = PromptPermission(now: { clock.now })
        permission.grant()
        clock.now = clock.now.addingTimeInterval(PromptPermission.window + 1)
        XCTAssertFalse(permission.take())
    }
}

/// Antigravity never reads secret OAuth bytes from Keychain, and any recorded
/// refusal blocks even metadata checks until the user explicitly asks again.
final class AntigravityKeychainPromptTests: XCTestCase {
    private var previousRefusal: KeychainRefusal!

    override func setUp() {
        super.setUp()
        previousRefusal = AntigravityCredentials.refusal
        AntigravityCredentials.refusal = KeychainRefusal(key: "antigravity-prompt-test", defaults: nil)
        AntigravityCredentials.metadataPresentForTesting = { true }
    }

    override func tearDown() {
        AntigravityCredentials.refusal = previousRefusal
        AntigravityCredentials.metadataPresentForTesting = nil
        super.tearDown()
    }

    func testRefusalBlocksPresenceCheckUntilAskAgain() {
        XCTAssertTrue(AntigravityCredentials.isSignedIn())
        AntigravityCredentials.recordRefusal()
        XCTAssertFalse(AntigravityCredentials.isSignedIn())
        AntigravityCredentials.askAgain()
        XCTAssertTrue(AntigravityCredentials.isSignedIn())
    }
}
