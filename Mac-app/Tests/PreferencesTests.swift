import XCTest
@testable import Swarmaa

/// First-launch defaults. (Round-trip basics live with the other
/// PreferencesTests.)
@MainActor
final class PreferencesDefaultsTests: XCTestCase {
    private func makeDefaults() -> (UserDefaults, String) {
        let name = "PreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return (defaults, name)
    }

    // MARK: Defaults

    /// The retired "neither Dock nor menu bar" choice reads back as the menu bar.
    func testAStoredHiddenPresenceReadsAsTheMenuBar() {
        let (fresh, _) = makeDefaults()
        fresh.set("hidden", forKey: "appPresence")
        XCTAssertEqual(Preferences(defaults: fresh).appPresence, .menuBar)
    }

    func testAFirstLaunchReadsTheDesignedDefaults() {
        let (fresh, _) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        XCTAssertTrue(preferences.isFirstLaunch)
        XCTAssertEqual(preferences.appPresence, .dock)
        XCTAssertTrue(preferences.isConnected("claude"))
        XCTAssertTrue(preferences.isConnected("codex"))
        XCTAssertTrue(preferences.isConnected("claude-work"))
        XCTAssertFalse(preferences.isConnected("cursor"))
        XCTAssertFalse(preferences.isConnected("glm"))
        XCTAssertFalse(preferences.isConnected("kiro"))
        XCTAssertFalse(preferences.isConnected("minimax"))
        XCTAssertTrue(preferences.deepSeekPricingEnabled)
        XCTAssertEqual(preferences.deepSeekPricingSchedule, .current)
    }

    /// MiniMax is discovered like everyone else, and stays off until switched
    /// on. Claude and Codex are the only families that default on.
    func testMiniMaxStaysOffAfterReconcile() {
        let (fresh, name) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "minimax"])
        XCTAssertEqual(preferences.connectedProviders, ["claude", "codex"])
        XCTAssertFalse(preferences.isConnected("minimax"))
        XCTAssertTrue(preferences.isConnected("claude"))

        let again = Preferences(defaults: UserDefaults(suiteName: name)!)
        again.reconcile(discoveredIDs: ["claude", "codex", "cursor", "glm", "deepseek", "minimax"])
        XCTAssertFalse(again.isConnected("minimax"))
        XCTAssertFalse(again.isConnected("cursor"))
        XCTAssertFalse(again.isConnected("deepseek"))
        XCTAssertTrue(again.isConnected("claude"))
    }

    /// Kiro is discovered like everyone else, and stays off until switched on.
    /// Claude and Codex are the only families that default on.
    func testKiroStaysOffAfterReconcile() {
        let (fresh, name) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "kiro"])
        XCTAssertFalse(preferences.isConnected("kiro"))
        XCTAssertTrue(preferences.isConnected("claude"))

        let again = Preferences(defaults: UserDefaults(suiteName: name)!)
        again.reconcile(discoveredIDs: ["claude", "codex", "cursor", "glm", "kiro", "deepseek"])
        XCTAssertFalse(again.isConnected("kiro"))
        XCTAssertFalse(again.isConnected("cursor"))
        XCTAssertFalse(again.isConnected("deepseek"))
        XCTAssertTrue(again.isConnected("claude"))
    }

    func testAFirstLaunchSeedsClaudeAndCodexOnceDiscovered() {
        let (fresh, name) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "cursor", "glm", "kiro", "minimax", "claude-work"])
        XCTAssertEqual(preferences.connectedProviders, ["claude", "codex", "claude-work"])
        XCTAssertFalse(preferences.isConnected("cursor"))
        XCTAssertFalse(preferences.isConnected("kiro"))
        XCTAssertFalse(preferences.isConnected("minimax"))

        let again = Preferences(defaults: UserDefaults(suiteName: name)!)
        again.reconcile(discoveredIDs: ["claude", "codex", "cursor", "glm", "kiro", "minimax", "claude-work", "deepseek"])
        XCTAssertFalse(again.isConnected("cursor"))
        XCTAssertFalse(again.isConnected("kiro"))
        XCTAssertFalse(again.isConnected("minimax"))
        XCTAssertFalse(again.isConnected("deepseek"))
        XCTAssertTrue(again.isConnected("claude"))
    }

    func testHiddenProvidersInvertAgainstWhatThisMacHas() {
        let (fresh, _) = makeDefaults()
        fresh.set(["glm", "cursor"], forKey: "hiddenProviders")
        let preferences = Preferences(defaults: fresh)
        XCTAssertFalse(preferences.isConnected("glm"))
        XCTAssertTrue(preferences.isConnected("claude"))
        preferences.reconcile(discoveredIDs: ["claude", "codex", "cursor", "glm"])
        XCTAssertEqual(preferences.connectedProviders, ["claude", "codex"])
        XCTAssertFalse(preferences.isConnected("cursor"))
        XCTAssertTrue(preferences.isConnected("claude"))
    }

    func testANewClaudeProfileTurnsOnWithoutReopeningCursor() {
        let (fresh, name) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "cursor"])
        XCTAssertFalse(preferences.isConnected("cursor"))

        let later = Preferences(defaults: UserDefaults(suiteName: name)!)
        later.reconcile(discoveredIDs: ["claude", "codex", "cursor", "claude-work"])
        XCTAssertTrue(later.isConnected("claude-work"))
        XCTAssertFalse(later.isConnected("cursor"))
    }

    /// A 1.9 install with nothing hidden still shows each loaded model after
    /// the invert. Model cells are not providers: they are absent from the
    /// on-list, and absence there must not mean off.
    func testAnUpgradeDoesNotHideLoadedModels() {
        let (fresh, _) = makeDefaults()
        fresh.set([String](), forKey: "hiddenProviders")
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "ollama-local"])
        let model = "ollama-local:model:qwen3:8b"
        XCTAssertFalse(preferences.disconnectedIDs(among: [
            "claude", "codex", "ollama-local", model
        ]).contains(model))
        XCTAssertTrue(preferences.isConnected(model))
        XCTAssertTrue(preferences.isConnected("ollama-local"))
        XCTAssertTrue(preferences.disabledModels.isEmpty)
    }

    /// Model ids on the old off-list stay off. They are not inverted onto
    /// `connectedProviders`.
    func testAHiddenModelStaysHiddenAfterTheOnListInvert() {
        let (fresh, name) = makeDefaults()
        fresh.set(["glm", "ollama-local:model:qwen3"], forKey: "hiddenProviders")
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "glm", "ollama-local"])
        XCTAssertFalse(preferences.isConnected("glm"))
        XCTAssertTrue(preferences.isConnected("ollama-local"))
        XCTAssertFalse(preferences.isConnected("ollama-local:model:qwen3"))
        XCTAssertEqual(preferences.disabledModels, ["ollama-local:model:qwen3"])
        XCTAssertFalse(preferences.connectedProviders.contains { Preferences.isModelCell($0) })

        let again = Preferences(defaults: UserDefaults(suiteName: name)!)
        XCTAssertFalse(again.isConnected("ollama-local:model:qwen3"))
        XCTAssertTrue(again.isConnected("ollama-local"))
    }

    /// An invert that already wrote `connectedProviders` still left model ids
    /// on `hiddenProviders`. Those hides must not be forgotten.
    func testModelHidesSurviveAPreviousInvertThatDroppedThem() {
        let (fresh, _) = makeDefaults()
        fresh.set(["claude", "codex", "ollama-local"], forKey: "connectedProviders")
        fresh.set(["claude", "codex", "ollama-local"], forKey: "seenProviders")
        fresh.set(["ollama-local:model:qwen3"], forKey: "hiddenProviders")
        let preferences = Preferences(defaults: fresh)
        XCTAssertFalse(preferences.isConnected("ollama-local:model:qwen3"))
        XCTAssertTrue(preferences.isConnected("ollama-local"))
        XCTAssertEqual(preferences.disabledModels, ["ollama-local:model:qwen3"])
    }

    /// Recomputing the store off-list after a provider toggle must not hide
    /// models that nobody hid.
    func testSwitchingAProviderDoesNotHideLoadedModels() {
        let (fresh, _) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "cursor", "ollama-local"])
        let model = "ollama-local:model:qwen3:8b"
        XCTAssertTrue(preferences.isConnected(model))
        preferences.setConnected(true, for: "cursor")
        XCTAssertTrue(preferences.isConnected(model))
        XCTAssertFalse(preferences.disconnectedIDs(among: [
            "claude", "codex", "cursor", "ollama-local", model
        ]).contains(model))
        XCTAssertTrue(preferences.disabledModels.isEmpty)
    }

    /// A newly loaded model is on until hidden, and hiding it does not put it
    /// on the provider on-list.
    func testALoadedModelStaysOffTheProviderOnList() {
        let (fresh, name) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "ollama-local"])
        let model = "ollama-local:model:qwen3:8b"
        XCTAssertTrue(preferences.isConnected(model))
        preferences.setConnected(false, for: model)
        XCTAssertEqual(preferences.disabledModels, [model])
        XCTAssertFalse(preferences.connectedProviders.contains(model))
        XCTAssertFalse(preferences.seenProviders.contains(model))

        let hidden = Preferences(defaults: UserDefaults(suiteName: name)!)
        XCTAssertFalse(hidden.isConnected(model))
        hidden.setConnected(true, for: model)
        XCTAssertTrue(hidden.disabledModels.isEmpty)

        let shown = Preferences(defaults: UserDefaults(suiteName: name)!)
        XCTAssertTrue(shown.isConnected(model))
        XCTAssertFalse(shown.connectedProviders.contains(model))
    }

    func testDeepSeekPricingSettingsSurviveARelaunchAndCanBeReset() {
        let (fresh, name) = makeDefaults()
        let preferences = Preferences(defaults: fresh)
        preferences.deepSeekPricingEnabled = false
        preferences.deepSeekPricingSchedule = DeepSeekPricing.Schedule(
            peakWeekdays: [2],
            windows: [
                .init(startMinute: 120, endMinute: 180),
                .init(startMinute: 360, endMinute: 420),
                .init(startMinute: 900, endMinute: 960)
            ]
        )

        let reloaded = Preferences(defaults: UserDefaults(suiteName: name)!)
        XCTAssertFalse(reloaded.deepSeekPricingEnabled)
        XCTAssertEqual(reloaded.deepSeekPricingSchedule.peakWeekdays, [2])
        XCTAssertEqual(reloaded.deepSeekPricingSchedule.windows.count, 3)
        XCTAssertEqual(reloaded.deepSeekPricingSchedule.windows[2].startMinute, 900)

        reloaded.resetDeepSeekPricingSchedule()
        XCTAssertEqual(reloaded.deepSeekPricingSchedule, .current)
    }

    func testTurningOffTheHolidayRuleSurvivesARelaunch() {
        let (fresh, name) = makeDefaults()
        XCTAssertTrue(Preferences(defaults: fresh).deepSeekPricingSchedule.offPeakOnChineseHolidays)

        var schedule = DeepSeekPricing.Schedule.current
        schedule.offPeakOnChineseHolidays = false
        Preferences(defaults: fresh).deepSeekPricingSchedule = schedule

        let reloaded = Preferences(defaults: UserDefaults(suiteName: name)!)
        XCTAssertFalse(reloaded.deepSeekPricingSchedule.offPeakOnChineseHolidays)
    }

    /// Off by default — used is what Swarmaa has always shown — and once
    /// somebody flips it, it has to stay flipped across a relaunch.
    func testRemainingStaysUsedUntilAskedForAndThenSurvivesARelaunch() {
        let (fresh, name) = makeDefaults()
        XCTAssertFalse(Preferences(defaults: fresh).showsRemaining)

        Preferences(defaults: fresh).showsRemaining = true

        XCTAssertTrue(Preferences(defaults: UserDefaults(suiteName: name)!).showsRemaining)
    }

    /// Off by default — the manual arrangement is what dragging built — and
    /// once somebody flips it, it has to stay flipped across a relaunch.
    func testAutoOrderStaysManualUntilAskedForAndThenSurvivesARelaunch() {
        let (fresh, name) = makeDefaults()
        XCTAssertFalse(Preferences(defaults: fresh).autoOrderByRemaining)

        Preferences(defaults: fresh).autoOrderByRemaining = true

        XCTAssertTrue(Preferences(defaults: UserDefaults(suiteName: name)!).autoOrderByRemaining)
    }

    /// Off by default — rings disappearing unasked would strand the manual
    /// arrangement — and once somebody flips it, it has to stay flipped
    /// across a relaunch.
    func testDepletedAccountsStayVisibleUntilAskedToHideAndThenSurvivesARelaunch() {
        let (fresh, name) = makeDefaults()
        XCTAssertFalse(Preferences(defaults: fresh).hideDepletedAccounts)

        Preferences(defaults: fresh).hideDepletedAccounts = true

        XCTAssertTrue(Preferences(defaults: UserDefaults(suiteName: name)!).hideDepletedAccounts)
    }

    // MARK: The slider, and which control is in charge

}

/// Limits in the menu bar: off until asked for, remembered once chosen, and
/// never mixed up with which providers are read.
@MainActor
final class MenuBarLimitsPreferenceTests: XCTestCase {
    private func makeDefaults() throws -> (UserDefaults, String) {
        let name = "MenuBarLimitsPreferenceTests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: name)), name)
    }

    private func reopen(_ name: String) throws -> Preferences {
        Preferences(defaults: try XCTUnwrap(UserDefaults(suiteName: name)))
    }

    /// A fresh install and an upgrade from a version that never had the
    /// switch both keep the icon — an update must not swap it for a readout.
    func testAFreshInstallAndAnUpgradeBothKeepTheIcon() throws {
        let (fresh, freshName) = try makeDefaults()
        defer { fresh.removePersistentDomain(forName: freshName) }
        XCTAssertEqual(Preferences(defaults: fresh).menuBarLimits, .off)

        let (upgraded, name) = try makeDefaults()
        defer { upgraded.removePersistentDomain(forName: name) }
        upgraded.set(true, forKey: "hasLaunchedBefore")
        upgraded.set(AppPresence.menuBar.rawValue, forKey: "appPresence")
        let preferences = Preferences(defaults: upgraded)
        XCTAssertFalse(preferences.showsLimitsInMenuBar)
        XCTAssertFalse(preferences.showsWeeklyLimitInMenuBar)
        XCTAssertNil(preferences.menuBarProviders, "never chosen, not chosen as none")
    }

    func testTheChoiceSurvivesARelaunch() throws {
        let (defaults, name) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = Preferences(defaults: defaults)
        preferences.showsLimitsInMenuBar = true
        preferences.showsWeeklyLimitInMenuBar = true
        preferences.setInMenuBar(false, for: "claude", among: ["claude", "codex"])

        let reopened = try reopen(name)
        XCTAssertTrue(reopened.showsLimitsInMenuBar)
        XCTAssertTrue(reopened.showsWeeklyLimitInMenuBar)
        XCTAssertEqual(reopened.menuBarProviders, ["codex"])
        XCTAssertFalse(reopened.isInMenuBar("claude"))
        XCTAssertTrue(reopened.isInMenuBar("codex"))
    }

    /// None is a choice, and it is still none after a relaunch — not the
    /// default coming back.
    func testChoosingNoneSurvivesARelaunchAsNone() throws {
        let (defaults, name) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = Preferences(defaults: defaults)
        preferences.showsLimitsInMenuBar = true
        preferences.setInMenuBar(false, for: "claude", among: ["claude", "codex"])
        preferences.setInMenuBar(false, for: "codex", among: ["claude", "codex"])

        let reopened = try reopen(name)
        XCTAssertEqual(reopened.menuBarProviders, [])
        XCTAssertFalse(reopened.isInMenuBar("claude"))
        XCTAssertFalse(reopened.isInMenuBar("codex"))
    }

    /// Off keeps the choice, across a relaunch too, so on again brings back
    /// the same providers.
    func testSwitchingOffKeepsTheChoice() throws {
        let (defaults, name) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = Preferences(defaults: defaults)
        preferences.showsLimitsInMenuBar = true
        preferences.setInMenuBar(true, for: "gemini", among: ["claude", "codex", "gemini"])
        preferences.setInMenuBar(false, for: "codex", among: ["claude", "codex", "gemini"])
        preferences.showsLimitsInMenuBar = false

        let reopened = try reopen(name)
        XCTAssertFalse(reopened.showsLimitsInMenuBar)
        reopened.showsLimitsInMenuBar = true
        XCTAssertEqual(reopened.menuBarLimits, MenuBarLimits(isOn: true, chosen: ["claude", "gemini"]))
    }

    /// The menu bar choice and the connection are two switches: taking Claude
    /// out of the bar leaves it read, and switching Codex off leaves its place
    /// in the bar waiting for it.
    func testTheMenuBarNeverTouchesWhatIsRead() throws {
        let (defaults, name) = try makeDefaults()
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = Preferences(defaults: defaults)
        preferences.reconcile(discoveredIDs: ["claude", "codex", "gemini"])
        let read = preferences.connectedProviders

        preferences.showsLimitsInMenuBar = true
        preferences.setInMenuBar(false, for: "claude", among: ["claude", "codex"])
        XCTAssertTrue(preferences.isConnected("claude"), "out of the bar, still read")
        XCTAssertEqual(preferences.connectedProviders, read)

        preferences.setConnected(false, for: "codex")
        XCTAssertTrue(preferences.isInMenuBar("codex"), "not read today, still chosen for when it is")
        preferences.setInMenuBar(true, for: "gemini", among: ["codex", "gemini"])
        XCTAssertFalse(preferences.isConnected("gemini"), "choosing it for the bar does not start reading it")

        let reopened = try reopen(name)
        XCTAssertTrue(reopened.isConnected("claude"))
        XCTAssertFalse(reopened.isConnected("codex"))
        XCTAssertEqual(reopened.menuBarProviders, ["codex", "gemini"])
    }
}
