import XCTest
@testable import Swarmaa

final class AntigravityProfileTests: XCTestCase {
    private func home(_ layout: [String: [String]] = [:]) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("AntigravityProfileTests.\(UUID().uuidString)")
        let geminiDir = root.appendingPathComponent(".gemini")
        try FileManager.default.createDirectory(at: geminiDir, withIntermediateDirectories: true)
        for (directory, files) in layout {
            let url = geminiDir.appendingPathComponent(directory)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            for file in files {
                let path = url.appendingPathComponent(file)
                try FileManager.default.createDirectory(at: path.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                try Data().write(to: path)
            }
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    // MARK: - Identity & Paths

    func testDefaultIdentityAndPathsStayCompatible() {
        let profile = AntigravityProfile.default(home: URL(fileURLWithPath: "/Users/test"))
        XCTAssertNil(profile.slug)
        XCTAssertEqual(profile.id, "gemini")
        XCTAssertEqual(profile.displayName, "Antigravity")
        XCTAssertEqual(profile.configDirectory.path, "/Users/test/.gemini/antigravity")
        XCTAssertEqual(profile.authURL.path, "/Users/test/.gemini/antigravity/oauth_creds.json")
        XCTAssertEqual(profile.brainDirectory.path, "/Users/test/.gemini/antigravity/brain")
        XCTAssertEqual(profile.keychainService, "gemini")
        XCTAssertEqual(profile.keychainAccount, "antigravity")
        XCTAssertEqual(profile.sourceName, "Antigravity")
        XCTAssertEqual(AntigravityProvider(profile: profile).signInRoute,
                       .openApp(bundleID: "com.google.antigravity", name: "Antigravity"))
    }

    func testNamedProfileIdentityAndPaths() {
        let home = URL(fileURLWithPath: "/Users/test")
        let dir = home.appendingPathComponent(".gemini/antigravity-work")
        let profile = AntigravityProfile(slug: "work", configDirectory: dir)
        XCTAssertEqual(profile.slug, "work")
        XCTAssertEqual(profile.id, "antigravity-work")
        XCTAssertEqual(profile.displayName, "Antigravity (work)")
        XCTAssertEqual(profile.authURL.path, "/Users/test/.gemini/antigravity-work/oauth_creds.json")
        XCTAssertEqual(profile.brainDirectory.path, "/Users/test/.gemini/antigravity-work/brain")
        XCTAssertNil(profile.keychainService)
        XCTAssertNil(profile.keychainAccount)
        XCTAssertEqual(profile.sourceName, L10n.t("Antigravity in \(profile.displayPath)"))
        XCTAssertEqual(AntigravityProvider(profile: profile).signInRoute,
                       .guidance(L10n.t("Sign in to Antigravity in ~/.gemini/antigravity-work to read your usage")))
    }

    func testProviderIDsAreRecognised() {
        XCTAssertTrue(AntigravityProfile.isAntigravity(providerID: "gemini"))
        XCTAssertTrue(AntigravityProfile.isAntigravity(providerID: "antigravity-work"))
        XCTAssertTrue(AntigravityProfile.isAntigravity(providerID: "antigravity-alpha"))
        XCTAssertFalse(AntigravityProfile.isAntigravity(providerID: "gemini-api"))
        XCTAssertFalse(AntigravityProfile.isAntigravity(providerID: "gemini-work"))
        XCTAssertFalse(AntigravityProfile.isAntigravity(providerID: "geminiapi"))
        XCTAssertFalse(AntigravityProfile.isAntigravity(providerID: "claude"))
        XCTAssertFalse(AntigravityProfile.isAntigravity(providerID: "cursor"))

        XCTAssertEqual(AntigravityProfile.slug(fromProviderID: "antigravity-work"), "work")
        XCTAssertEqual(AntigravityProfile.slug(fromProviderID: "antigravity-client-a"), "client-a")
        XCTAssertNil(AntigravityProfile.slug(fromProviderID: "gemini"))
        XCTAssertNil(AntigravityProfile.slug(fromProviderID: "gemini-api"))
        XCTAssertNil(AntigravityProfile.slug(fromProviderID: "antigravity-"))
        XCTAssertNil(AntigravityProfile.slug(fromProviderID: "cursor"))
    }

    func testDirectorySlugsIgnoreInternalFlavours() {
        XCTAssertEqual(AntigravityProfile.slug(fromDirectoryName: "antigravity-work"), "work")
        XCTAssertEqual(AntigravityProfile.slug(fromDirectoryName: "antigravity-client-1"), "client-1")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity"), "default has no slug")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity-"), "empty slug")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity-ide"), "ide is internal flavour")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity-cli"), "cli is internal flavour")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity-backup"), "backup is internal flavour")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity-api"), "api is internal flavour")
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "not-antigravity-work"))
    }

    // MARK: - Single-Profile Compliance

    func testDiscoveryReturnsOnlyDefaultProfile() throws {
        let root = try home([
            "antigravity": ["oauth_creds.json"],
            "antigravity-work": ["oauth_creds.json"],
            "antigravity-alpha": ["oauth_creds.json"],
            "antigravity-ide": ["oauth_creds.json"],
            "antigravity-cli": ["oauth_creds.json"],
            "antigravity-backup": ["agent.db"],
            "antigravity-empty": [],
            "other-tool": ["oauth_creds.json"]
        ])

        let found = AntigravityProfile.discover(home: root)
        XCTAssertEqual(found.map(\.id), ["gemini"])
        XCTAssertEqual(found.map(\.displayName), ["Antigravity"])
        XCTAssertEqual(found[0].configDirectory, root.appendingPathComponent(".gemini/antigravity"))
    }

    func testDiscoveryIgnoresExtraProfilesEvenWithCustomFilter() throws {
        let root = try home([
            "antigravity-work": ["oauth_creds.json"],
            "antigravity-test": ["oauth_creds.json"]
        ])

        let found = AntigravityProfile.discover(home: root) { _ in true }
        XCTAssertEqual(found.map(\.id), ["gemini"])
    }

    // MARK: - Gemini-API Clash Prevention & Default-Off Rule

    func testGeminiAPIClashPrevention() {
        XCTAssertFalse(AntigravityProfile.isAntigravity(providerID: "gemini-api"))
        XCTAssertNil(AntigravityProfile.slug(fromProviderID: "gemini-api"))
        let summary = ProviderSummary(id: "gemini-api", name: "Gemini API", glyph: .geminiSpark, account: nil, signIn: .guidance(""))
        XCTAssertFalse(summary.usesKeychain)
        XCTAssertFalse(Preferences.isDefaultOnFamily("gemini-api"))
        XCTAssertNil(AntigravityProfile.slug(fromDirectoryName: "antigravity-api"))
    }

    func testAntigravityDefaultsOff() {
        XCTAssertFalse(Preferences.isDefaultOnFamily("gemini"), "Antigravity default must start off")
        XCTAssertFalse(Preferences.isDefaultOnFamily("antigravity-work"), "Antigravity profile must start off")
        XCTAssertFalse(Preferences.isDefaultOnFamily("antigravity-personal"), "Antigravity profile must start off")
        XCTAssertFalse(Preferences.isDefaultOnFamily("gemini-api"), "gemini-api must start off")
        XCTAssertTrue(Preferences.isDefaultOnFamily("claude"), "Claude defaults on")
        XCTAssertTrue(Preferences.isDefaultOnFamily("claude-work"), "Claude profiles default on")
        XCTAssertTrue(Preferences.isDefaultOnFamily("codex"), "Codex defaults on")
        XCTAssertTrue(Preferences.isDefaultOnFamily("codex-work"), "Codex profiles default on")
    }

    // MARK: - Activity Monitor Roots

    @MainActor
    func testActivityMonitorRoots() {
        let defaultProfile = AntigravityProfile.default(home: URL(fileURLWithPath: "/Users/test"))
        let workProfile = AntigravityProfile(slug: "work",
                                             configDirectory: URL(fileURLWithPath: "/Users/test/.gemini/antigravity-work"))

        let defaultMonitor = AntigravityActivityMonitor(profile: defaultProfile)
        XCTAssertNotNil(defaultMonitor)

        let workMonitor = AntigravityActivityMonitor(profile: workProfile)
        XCTAssertNotNil(workMonitor)
    }

    // MARK: - Compliant Non-Secret Presence & Refusal

    func testNamedProfileNeverScrapesOAuthCreds() throws {
        let root = try home([
            "antigravity": [],
            "antigravity-work": []
        ])
        let workProfile = AntigravityProfile(slug: "work", configDirectory: root.appendingPathComponent(".gemini/antigravity-work"))

        let credsJSON = """
        {
            "access_token": "ya29.work-test-token",
            "expiry_date": 1893456000000,
            "email": "work@example.com",
            "project_id": "work-project"
        }
        """
        try credsJSON.data(using: .utf8)!.write(to: workProfile.authURL)

        XCTAssertFalse(AntigravityCredentials.isSignedIn(for: workProfile))
        let provider = AntigravityProvider(profile: workProfile)
        XCTAssertNil(provider.account())
    }

    func testKeychainRefusalIsHonouredAndClearedOnAskAgain() {
        let previousRefusal = AntigravityCredentials.refusal
        let testRefusal = KeychainRefusal(key: "antigravity-test", defaults: nil)
        AntigravityCredentials.refusal = testRefusal
        AntigravityCredentials.metadataPresentForTesting = { true }
        addTeardownBlock {
            AntigravityCredentials.refusal = previousRefusal
            AntigravityCredentials.metadataPresentForTesting = nil
        }

        let defaultProfile = AntigravityProfile.default()
        let provider = AntigravityProvider(profile: defaultProfile)

        XCTAssertTrue(AntigravityCredentials.isSignedIn(for: defaultProfile))
        XCTAssertNotNil(provider.account())

        AntigravityCredentials.recordRefusal()
        XCTAssertTrue(AntigravityCredentials.isRefused)
        XCTAssertFalse(AntigravityCredentials.isSignedIn(for: defaultProfile))
        XCTAssertNil(provider.account())

        provider.forgetCachedCredential()
        XCTAssertFalse(AntigravityCredentials.isRefused)
        XCTAssertTrue(AntigravityCredentials.isSignedIn(for: defaultProfile))
    }

    func testExtraProfileAskAgainDoesNotClearDefaultRefusal() {
        let previousRefusal = AntigravityCredentials.refusal
        let testRefusal = KeychainRefusal(key: "antigravity-iso", defaults: nil)
        AntigravityCredentials.refusal = testRefusal
        addTeardownBlock { AntigravityCredentials.refusal = previousRefusal }

        let defaultProfile = AntigravityProfile.default()
        let workProfile = AntigravityProfile(slug: "work", configDirectory: URL(fileURLWithPath: "/tmp/antigravity-work"))
        let defaultProvider = AntigravityProvider(profile: defaultProfile)
        let workProvider = AntigravityProvider(profile: workProfile)

        AntigravityCredentials.recordRefusal()
        workProvider.forgetCachedCredential()
        XCTAssertTrue(AntigravityCredentials.isRefused, "Extra profile must not clear default refusal")

        defaultProvider.forgetCachedCredential()
        XCTAssertFalse(AntigravityCredentials.isRefused, "Default profile askAgain clears default refusal")
    }
}
