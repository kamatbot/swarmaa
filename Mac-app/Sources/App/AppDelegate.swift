import AppKit
import Combine
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// The running delegate. `NSApp.delegate` is SwiftUI's adaptor proxy, not this class, so casting it finds nothing.
    private(set) static weak var shared: AppDelegate?
    /// What the menu bar and the phone read: snapshots plus live sessions.
    private let board = UsageBoard()
    private var store: UsageStore?
    var phoneLinkServer: PhoneLinkServer?
    var phoneLinkServerStatus: PhoneLinkServerStatus?
    var phoneLinkPairing: PhoneLinkPairing?
    var phoneLinkRegistry: PhoneLinkRegistry?
    private var activityCoordinator: ActivityCoordinator?
    private var piResponseMonitor: PiResponseMonitor?
    private var openCodeActivityBridge: OpenCodeActivityBridge?
    private var ollamaRelay: OllamaActivityRelay?
    private var lmstudioMetrics: LMStudioMetrics?
    private var omlxMetrics: OMLXMetrics?

    /// Lightweight mode: usage and the Swarmaa server are asked once a minute
    /// and nothing else polls — no activity monitors, no local-runtime metrics,
    /// no Pi/OpenCode watchers. It was the default while the on-screen overlay
    /// existed (off by default) and is now the only mode.
    // ponytail: constant; flip to false to run the activity monitors again.
    static let isLightweight = true
    @MainActor private static func lightweight(_ preferences: Preferences) -> AnyPublisher<Bool, Never> {
        Just(isLightweight).eraseToAnyPublisher()
    }
    private var preferences: Preferences?
    private var settings: SettingsWindowController?
    private var whatsNew: WhatsNewWindowController?
    /// Held for the life of the app: releasing it stops the scheduled checks.
    private var updater: Updater?
    private var thresholdNotifier: ThresholdNotifier?
    private var resetWatcher: UsageResetWatcher?
    private var limitWatcher: UsageLimitWatcher?
    private var statusItem: StatusItemController?
    /// Keeps the Claude keychain token from ageing out on a Mac where the CLI
    /// is never run by hand. See `ClaudeTokenRefresher`.
    private var tokenRefresher: ClaudeTokenRefresher?
    private var cancellables = Set<AnyCancellable>()
    /// Turns the monitors' running commentary into the one event worth
    /// interrupting for: an agent that has just stopped working.
    private var completions = SessionCompletionWatcher()
    /// Which providers were working as of the last thing a monitor said, so the
    /// moment one stops can be told apart from the many moments it is still
    /// going. Held here rather than asked of `ActivityCoordinator`, which
    /// reports the state after the change and cannot answer what it was before.
    private var busyProviderIDs: Set<String> = []

    /// The unit bundle is hosted by this app, so `xcodebuild test` launches it
    /// for real. Without this guard every test run put a live request on the
    /// usage endpoint — which is both wrong on its own terms and, on an endpoint
    /// that rate-limits, actively harmful.
    private var isRunningTests: Bool { Runtime.isUnderTest }

    /// Quit any copy of Swarmaa that was already running.
    ///
    /// A second copy is not a harmless duplicate: it polls the same accounts,
    /// answers the phone on the same port and puts a second item in the menu
    /// bar. Separate bundles at separate paths launch as separate processes.
    ///
    /// The newcomer wins, deliberately. Quitting the *new* copy instead would
    /// be the wrong way round while developing: the whole point of launching a
    /// fresh build is to replace the one already running.
    ///
    /// Only strictly older instances are asked to go, which is what keeps two
    /// simultaneous launches from each terminating the other and leaving none.
    private static func retireOlderInstances() {
        guard let identifier = Bundle.main.bundleIdentifier else { return }
        let mine = ProcessInfo.processInfo.processIdentifier
        let launched = NSRunningApplication.current.launchDate ?? Date()
        for other in NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
        where other.processIdentifier != mine && (other.launchDate ?? .distantPast) < launched {
            Log.usage.info("retiring an older instance (pid \(other.processIdentifier, privacy: .public))")
            if !other.terminate() { other.forceTerminate() }
        }
    }

    /// The snapshots as the rings draw them: the vendor's own, with the weekly
    /// window leading where that is switched on, and the daily pace laid over
    /// that where it is. One place, so the menu and the phone agree on what a
    /// ring means. The menu bar and the alert watchers are deliberately fed the
    /// vendor's own order instead — see their sink.
    static func drawn(_ snapshots: [ProviderSnapshot], weekly: Bool, paced: Bool)
    -> [ProviderSnapshot] {
        DailyPace.apply(to: WeeklyHeadline.apply(to: snapshots, enabled: weekly), enabled: paced)
    }

    /// Every Claude Code configuration directory on this Mac — `~/.claude` and
    /// any `~/.claude-<slug>` — found once at launch. Each gets a usage
    /// provider and a session monitor of its own, keyed by the same id, so a
    /// work login's sessions spin the work ring and nobody else's.
    private let claudeProfiles = ClaudeProfile.discover()
    private let codexProfiles = CodexProfile.discover()
    private let antigravityProfiles = AntigravityProfile.discover()
    private let commandCodeProfiles = CommandCodeProfile.discover()
    /// Held as concrete providers, not just handed to the store: the token
    /// refresher needs to ask one of them how long its token has left, and the
    /// protocol has no business carrying that.
    private var claudeProviders: [ClaudeOAuthProvider] = []
    /// MiniMax Platform sign-in sheet. Not a UsageProvider — that is MiniMaxProvider.
    private var miniMaxWeb: WebSessionProvider?
    /// Decides which Swarma agent and swarm cells exist; see `SwarmaDirectory`.
    private var swarmaDirectory: SwarmaDirectory?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self
        NotificationCenter.default.addObserver(forName: .swarmaaRunSetup, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.runSetup() }
        }
        // Set here, not in the Info.plist: this call is applied at launch and
        // overrides `LSUIElement` either way. Removing the plist key alone left
        // the app registered as a UIElement with no Dock tile, which looked
        // exactly like the icon having failed to install. The user's choice
        // replaces this a moment later, once preferences exist.
        NSApp.setActivationPolicy(.regular)
        guard !isRunningTests else { return }
        Self.retireOlderInstances()
        ChannelNotifications.installPresenter()

        // Before Preferences reads anything, or the first launch flag and
        // every choice would be read from an empty domain — and before the
        // onboarding gate, which reads the migrated Swarmaa settings.
        if OnboardingGate.needsOnboarding() {
            runSetup()
        } else {
            start()
            openTeams()
        }
    }

    // MARK: Onboarding

    private var onboarding: OnboardingWindowController?
    private var started = false

    /// "Run Setup…", and the first-launch gate. The app starts when the
    /// window closes, if it has not already.
    @MainActor func runSetup() {
        if let onboarding, onboarding.isShowing { onboarding.show(); return }
        let controller = OnboardingWindowController(preferences: preferences) { [weak self] in
            guard let self else { return }
            self.onboarding = nil
            if !self.started { self.start() }
            self.openTeams()
        }
        onboarding = controller
        controller.show()
    }

    @MainActor private func start() {
        started = true
        let preferences = Preferences()
        self.preferences = preferences
        let board = self.board

        // `SWARMAA_DEMO=1` puts fixed sample providers and sessions in the
        // menu bar, for screenshots.
        let isDemo = ProcessInfo.processInfo.environment["SWARMAA_DEMO"] == "1"
        if isDemo {
            board.setSnapshots(Fixtures.snapshots())
            for (id, sessions) in Fixtures.sessions() {
                board.setSessions(providerID: id, sessions: sessions)
            }
            board.setLocalActivities(Fixtures.localActivities())
        } else {
            // DeepSeek's Platform usage page is a browser-session provider:
            // login is explicit, stays in Swarmaa's own WKWebView store, and
            // the page-local requests are refreshed only after that login.
            let deepSeek = WebSessionProvider(site: Sites.deepSeek)
            // QianwenAI's Token Plan is the same kind of provider: no usage API
            // to call, only a console, readable after the user signs in inside
            // this app's own WKWebView. Unlike MiniMax's sheet below, its ring
            // *is* this adapter, so it belongs in `webProviders` — exactly once.
            let qianwen = WebSessionProvider(site: Sites.qianwen)
            let qoder = WebSessionProvider(site: Sites.qoder(region: preferences.qoderRegion))
            // MiniMax's ring is MiniMaxProvider. The sheet is the same kind of
            // WebView DeepSeek uses, but it must not join `webProviders`:
            // those are appended to `allProviders`, and two adapters with
            // id `minimax` would both poll, both draw a row, and fight over
            // the same archive key. Region is applied here and again when
            // Settings changes it, because the fetch URLs live on the site.
            let miniMaxWeb = WebSessionProvider(site: Sites.minimax(region: preferences.minimaxRegion))
            self.miniMaxWeb = miniMaxWeb
            let webProviders: [WebSessionProvider] = [deepSeek, qianwen, qoder]
            // Cursor reads the editor's session, or cursor-agent's if the
            // editor is missing — never a browser one: signing into
            // cursor.com separately created a second, empty account.
            //
            // Built *after* preferences and told what is switched off, so the
            // very first list it draws already excludes them. Constructed first,
            // it drew every provider from the archive and only dropped the
            // switched-off ones once the binding below delivered.
            Log.usage.info("claude profiles: \(self.claudeProfiles.map(\.displayPath).joined(separator: ", "), privacy: .public)")
            Log.usage.info("codex profiles: \(self.codexProfiles.map(\.displayPath).joined(separator: ", "), privacy: .public)")
            Log.usage.info("antigravity profiles: \(self.antigravityProfiles.map(\.displayPath).joined(separator: ", "), privacy: .public)")
            // Named together rather than one by one: a name derived from the
            // signed-in address can collide with another profile's, and only a
            // caller holding every profile can see that.
            let claudeNames = ClaudeProfile.displayNames(for: claudeProfiles)
            let claudeProviders = claudeProfiles.map {
                ClaudeOAuthProvider(profile: $0, displayName: claudeNames[$0.id])
            }
            self.claudeProviders = claudeProviders
            let customProviders: [UsageProvider] = preferences.customEndpoints.filter(\.isEnabled).map { endpoint in
                CustomEndpointProvider(endpoint: endpoint)
            }
            let remoteProviders: [UsageProvider] = preferences.remoteHosts
                .filter { $0.isEnabled && $0.isConfigured }
                .map { $0.makeProvider() }
            let allProviders: [UsageProvider] = claudeProviders
                + [CursorLocalProvider()]
                + codexProfiles.map { CodexLocalProvider(profile: $0) }
                + antigravityProfiles.map { AntigravityProvider(profile: $0) }
                + [GLMProvider(), MiniMaxProvider(web: miniMaxWeb), GrokLocalProvider(), GrokBotProvider(), DevinLocalProvider(), OpenCodeProvider()]
                + commandCodeProfiles.map { CommandCodeProvider(profile: $0) }
                + [GitHubCopilotProvider(), KimiProvider(), KiroProvider(), AmpProvider(),
                   ApifyProvider(), KiloProvider(),
                   MuseLocalProvider(),
                   OllamaLocalProvider(endpoint: URL(string: preferences.ollamaEndpoint)!),
                   LMStudioLocalProvider(endpoint: URL(string: preferences.lmstudioEndpoint)!),
                   OMLXLocalProvider(endpoint: URL(string: preferences.omlxEndpoint)!),
                   OllamaProvider(),
                   // A closure, not the value: the provider is an actor and
                   // re-reads the budget on every fetch, so a ceiling typed
                   // into Settings applies without a restart.
                   GeminiAPIProvider(budget: {
                       Preferences.storedGeminiAPIMonthlyTokenBudget()
                   })]
                + webProviders
                + customProviders
                + remoteProviders
            preferences.reconcile(discoveredIDs: allProviders.map(\.id))
            let store = UsageStore(
                providers: allProviders,
                disconnected: preferences.disconnectedIDs(among: allProviders.map(\.id)),
                // Passed at construction, not left to the sink below, for the
                // same reason `disconnected` is: the sink delivers a run loop
                // turn later, so without this every launch draws the built-in
                // order for a frame and then visibly shuffles.
                order: preferences.providerOrder
            )
            preferences.$customEndpoints
                .map { endpoints in
                    endpoints.filter(\.isEnabled).map {
                        "\($0.id):\($0.name):\($0.baseURL):\($0.apiType.rawValue):\($0.trackingUnit.rawValue):\($0.monthlyBudgetUSD ?? -1):\($0.currentSpendUSD ?? -1):\($0.monthlyBudgetTokensM ?? -1):\($0.currentTokensUsedM ?? -1):\($0.displayRemaining):\($0.showCurrency):\($0.iconPreset ?? ""):\($0.customIconFilename ?? ""):\($0.accentColorHex):\($0.selectedModel):\($0.usageSource.rawValue):\($0.usagePreset?.rawValue ?? ""):\($0.usageURL ?? ""):\($0.usageRecordsPath ?? ""):\($0.usageModelField ?? ""):\($0.usageTokenField ?? ""):\($0.usageModelFilter ?? ""):\($0.usageAuthentication.rawValue)"
                    }
                }
                .removeDuplicates()
                .receive(on: RunLoop.main)
                .sink { [weak store] _ in
                    let stored = Preferences.storedCustomEndpoints()
                    let active = stored.filter(\.isEnabled)
                    let providers: [UsageProvider] = active.map { CustomEndpointProvider(endpoint: $0) }
                    store?.registerCustomProviders(providers)
                }
                .store(in: &cancellables)
            preferences.$remoteHosts
                .map { hosts in
                    hosts.filter { $0.isEnabled && $0.isConfigured }.map {
                        "\($0.id):\($0.kind):\($0.name):\($0.host):\($0.user):\($0.port):\($0.identityFile ?? "")"
                    }
                }
                .removeDuplicates()
                .receive(on: RunLoop.main)
                .sink { [weak store] _ in
                    let stored = Preferences.storedRemoteHosts()
                    let active = stored.filter { $0.isEnabled && $0.isConfigured }
                    let providers: [UsageProvider] = active.map { $0.makeProvider() }
                    store?.registerRemoteProviders(providers)
                }
                .store(in: &cancellables)
            let swarma = SwarmaDirectory(store: store)
            self.swarmaDirectory = swarma
            Self.lightweight(preferences)
                .receive(on: RunLoop.main)
                .sink { [weak swarma, weak store] light in
                    store?.isLightweight = light
                    swarma?.isLightweight = light
                }
                .store(in: &cancellables)
            preferences.$swarmaEnabled
                .removeDuplicates()
                .receive(on: RunLoop.main)
                .sink { [weak swarma] in swarma?.setEnabled($0) }
                .store(in: &cancellables)
            preferences.$swarmaShowsChats
                .removeDuplicates()
                .receive(on: RunLoop.main)
                .sink { [weak swarma] in swarma?.showsChats = $0 }
                .store(in: &cancellables)
            swarma.announcesUpdates = false
            swarma.onRoutingChange = { [weak self] change in self?.announceRouting(change) }
            // A new address or token file is read on the next request; this
            // only makes that request happen now rather than on the timer.
            preferences.$swarmaServiceURL
                .combineLatest(preferences.$swarmaTokenPath)
                .dropFirst()
                .debounce(for: .milliseconds(600), scheduler: RunLoop.main)
                .sink { [weak swarma] _ in swarma?.sync() }
                .store(in: &cancellables)
            Costs.attach(to: store)
            deepSeek.onAuthenticated = { [weak store] in
                store?.providerAuthenticationChanged(providerID: "deepseek")
            }
            qianwen.onAuthenticated = { [weak store] in
                store?.providerAuthenticationChanged(providerID: "qianwenai")
            }
            qoder.onAuthenticated = { [weak store] in
                store?.providerAuthenticationChanged(providerID: "qoder")
            }
            miniMaxWeb.onAuthenticated = { [weak store] in
                store?.providerAuthenticationChanged(providerID: "minimax")
            }

            let updater = Updater()
            self.updater = updater
            // Checked for as it launches; never under test, where it would
            // reach for the real feed.
            if !isRunningTests { updater.start() }

            let relay = OllamaActivityRelay()
            self.ollamaRelay = relay
            // A single publisher chain exceeds Swift's type-checking time limit.
            let relayPreferences = Publishers.CombineLatest3(
                preferences.$connectedProviders,
                preferences.$ollamaEndpoint,
                preferences.$ollamaMetricsEnabled)
            let relayConfiguration = relayPreferences.map { values in
                (enabled: values.0.contains("ollama-local") && values.2, endpoint: values.1)
            }.eraseToAnyPublisher()
            relayConfiguration
                .removeDuplicates { $0.enabled == $1.enabled && $0.endpoint == $1.endpoint }
                .receive(on: RunLoop.main)
                .sink { [weak relay, weak board] configuration in
                    board?.setLocalMetricsEnabled(configuration.enabled)
                    relay?.configure(enabled: configuration.enabled, endpoint: configuration.endpoint)
                }
                .store(in: &cancellables)
            relay.$thinkingModels
                .receive(on: RunLoop.main)
                .sink { [weak board, weak store] models in
                    let previous = board?.thinkingModels ?? [:]
                    board?.setThinkingModels(models)
                    if models.keys.contains(where: { previous[$0] == nil }) { store?.refresh(providerID: "ollama-local") }
                }
                .store(in: &cancellables)

            relay.$performances
                .receive(on: RunLoop.main)
                .sink { [weak board, weak store] measurements in
                    board?.setPerformances(measurements)
                    if !measurements.isEmpty { store?.refresh(providerID: "ollama-local") }
                }
                .store(in: &cancellables)

            // LM Studio needs no relay: its own socket says what each model is
            // doing and its own log says what every request cost. Monitoring
            // follows the provider's switch, and the address follows Settings.
            let lmstudio = LMStudioMetrics()
            self.lmstudioMetrics = lmstudio
            // Split like the relay's chain above, and for the same reason.
            let lmstudioPreferences = Publishers.CombineLatest3(
                preferences.$connectedProviders, preferences.$lmstudioEndpoint, Self.lightweight(preferences))
            let lmstudioConfiguration = lmstudioPreferences.map { values in
                (enabled: values.0.contains(LMStudioMetrics.providerID) && !values.2, endpoint: values.1)
            }.eraseToAnyPublisher()
            lmstudioConfiguration
                .removeDuplicates { $0.enabled == $1.enabled && $0.endpoint == $1.endpoint }
                .receive(on: RunLoop.main)
                .sink { [weak lmstudio] configuration in
                    lmstudio?.configure(enabled: configuration.enabled, endpoint: configuration.endpoint)
                }
                .store(in: &cancellables)
            lmstudio.$activities
                .receive(on: RunLoop.main)
                .sink { [weak board] in board?.setLocalActivities($0, source: LMStudioMetrics.providerID) }
                .store(in: &cancellables)
            lmstudio.$performances
                .receive(on: RunLoop.main)
                .sink { [weak board, weak store] measurements in
                    board?.setPerformances(measurements, source: LMStudioMetrics.providerID)
                    if !measurements.isEmpty { store?.refresh(providerID: LMStudioMetrics.providerID) }
                }
                .store(in: &cancellables)
            lmstudio.$ledger
                .receive(on: RunLoop.main)
                .sink { [weak board] in board?.setLedger($0, source: LMStudioMetrics.providerID) }
                .store(in: &cancellables)

            // oMLX the same way: its admin activity endpoint says what each
            // model is doing, its server log says what every request cost.
            let omlx = OMLXMetrics()
            self.omlxMetrics = omlx
            // Split like the relay's chain above, and for the same reason.
            let omlxPreferences = Publishers.CombineLatest3(
                preferences.$connectedProviders, preferences.$omlxEndpoint, Self.lightweight(preferences))
            let omlxConfiguration = omlxPreferences.map { values in
                (enabled: values.0.contains(OMLXMetrics.providerID) && !values.2, endpoint: values.1)
            }.eraseToAnyPublisher()
            omlxConfiguration
                .removeDuplicates { $0.enabled == $1.enabled && $0.endpoint == $1.endpoint }
                .receive(on: RunLoop.main)
                .sink { [weak omlx] configuration in
                    omlx?.configure(enabled: configuration.enabled, endpoint: configuration.endpoint)
                }
                .store(in: &cancellables)
            omlx.$activities
                .receive(on: RunLoop.main)
                .sink { [weak board] in board?.setLocalActivities($0, source: OMLXMetrics.providerID) }
                .store(in: &cancellables)
            omlx.$performances
                .receive(on: RunLoop.main)
                .sink { [weak board, weak store] measurements in
                    board?.setPerformances(measurements, source: OMLXMetrics.providerID)
                    if !measurements.isEmpty { store?.refresh(providerID: OMLXMetrics.providerID) }
                }
                .store(in: &cancellables)
            omlx.$ledger
                .receive(on: RunLoop.main)
                .sink { [weak board] in board?.setLedger($0, source: OMLXMetrics.providerID) }
                .store(in: &cancellables)

            let dir: URL
            if NSClassFromString("XCTestCase") != nil {
                dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            } else {
                let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                dir = appSupport.appendingPathComponent("Swarmaa/phone-link", isDirectory: true)
            }
            let phoneSecretStore: PhoneLinkSecretStore = NSClassFromString("XCTestCase") != nil
                ? InMemoryPhoneLinkSecretStore()
                : PhoneLinkKeychainSecretStore()
            let phoneRegistry = PhoneLinkRegistry(directory: dir, secretStore: phoneSecretStore)
            let phonePairing = PhoneLinkPairing()
            let serverStatus = PhoneLinkServerStatus()
            self.phoneLinkRegistry = phoneRegistry
            self.phoneLinkPairing = phonePairing
            
            let server = PhoneLinkServer(
                pairing: phonePairing,
                registry: phoneRegistry,
                status: serverStatus,
                getSnapshot: { @Sendable [weak store, weak board, weak preferences] in
                    guard let store, let board, let preferences else { return nil }
                    let snap = await MainActor.run {
                        PhoneLinkSnapshotBuilder.build(
                            snapshots: Self.drawn(store.snapshots,
                                                  weekly: preferences.weeklyHeadline,
                                                  paced: preferences.claudeDailyPaceRing),
                            sessions: Array(board.sessions.values.flatMap { $0 }),
                            disconnected: store.disconnected,
                            order: preferences.providerOrder,
                            serverName: PhoneLinkNetwork.getComputerName(),
                            serverVersion: (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0.0",
                            now: Date()
                        )
                    }
                    return try? JSONEncoder().encode(snap)
                },
                refreshAndGetSnapshot: { @Sendable [weak store, weak board, weak preferences] in
                    guard let store, let board, let preferences else { return nil }
                    // A phone asking to refresh is the same gesture as opening
                    // the menu here, and it is about to render these numbers on
                    // another screen. Nothing cached will do.
                    await MainActor.run { store.refreshNow(freshness: .fromSource) }
                    for _ in 0..<20 {
                        let isRef = await MainActor.run { !store.refreshing.isEmpty }
                        if !isRef { break }
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    }
                    let snap = await MainActor.run {
                        PhoneLinkSnapshotBuilder.build(
                            snapshots: Self.drawn(store.snapshots,
                                                  weekly: preferences.weeklyHeadline,
                                                  paced: preferences.claudeDailyPaceRing),
                            sessions: Array(board.sessions.values.flatMap { $0 }),
                            disconnected: store.disconnected,
                            order: preferences.providerOrder,
                            serverName: PhoneLinkNetwork.getComputerName(),
                            serverVersion: (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "1.0.0",
                            now: Date()
                        )
                    }
                    return try? JSONEncoder().encode(snap)
                }
            )
            self.phoneLinkServerStatus = serverStatus
            self.phoneLinkServer = server

            let settings = SettingsWindowController(
                preferences: preferences,
                // A closure so the sheet re-reads accounts each time it comes
                // forward; a snapshot here is what made a switched account keep
                // showing the old address until the app restarted.
                providers: { [weak store] in store?.providerSummaries ?? [] },
                updater: updater,
                signOut: { [weak store] in store?.signOut(providerID: $0) },
                signIn: { [weak store] in store?.signIn(providerID: $0) ?? false },
                switchAccount: { [weak store] in
                    store?.openAccountSource(providerID: $0, switching: true) ?? false
                },
                retry: { [weak store] in store?.reauthorize(providerID: $0) },
                quit: { NSApp.terminate(nil) },
                previewResetAlert: { [weak self] in
                    self?.previewUsageResetAlert()
                },
                previewSessionLimitAlert: { [weak self] in
                    self?.previewSessionLimitAlert()
                },
                previewWeeklyLimitAlert: { [weak self] in
                    self?.previewWeeklyLimitAlert()
                },
                sendTestNotification: { [weak self] in
                    self?.sendTestNotification()
                },
                usageStore: store, ollamaRelay: relay, lmstudioMetrics: lmstudio, omlxMetrics: omlx,
                phoneLinkPairing: phonePairing, phoneLinkRegistry: phoneRegistry, phoneLinkServerStatus: serverStatus
            )
            self.settings = settings

            // What changed, once per version — including on a fresh install,
            // where it is the introduction.
            let whatsNew = WhatsNewWindowController(
                preferences: preferences, version: updater.currentVersion
            )
            self.whatsNew = whatsNew

            // Once, on the very first run, it opens the one place that
            // explains what to connect.
            //
            // Sequenced behind What's New rather than beside it: two windows
            // arriving together is one to dismiss before you can read either.
            let introduce = { [weak settings] in
                guard preferences.isFirstLaunch else { return }
                AppDelegate.shared?.openSettings()
            }
            whatsNew.onDismiss = introduce
            if !whatsNew.showIfNeeded() {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: introduce)
            }

            let statusItem = StatusItemController { AppDelegate.shared?.openSettings() }
            self.statusItem = statusItem
            // Both are somebody's own click, so neither is answered from
            // anything held: see `UsageFreshness.fromSource`.
            statusItem.onRefreshProvider = { [weak store] id in
                store?.refresh(providerID: id, freshness: .fromSource)
            }
            statusItem.onRefreshAll = { [weak store] in store?.refreshNow(freshness: .fromSource) }
            statusItem.onLook = { [weak store] in store?.refreshBecauseSomeoneIsLooking() }
            // The menu's tick writes to the same preference Settings writes to,
            // and reads nothing back of its own: the sink below carries the new
            // value to the item, and Settings — a published property away —
            // redraws its own switch from it in the same breath.
            statusItem.onToggleLimits = { [weak preferences] in preferences?.showsLimitsInMenuBar = $0 }
            // Read when the menu opens, so a model's line is as current as its cell.
            statusItem.cells = { [weak board] in board?.snapshots ?? [] }
            statusItem.activity = { [weak board] in board?.activity(for: $0) }
            // Handed over up front: the sink below
            // delivers a run loop turn later, and the item would otherwise go
            // up as one thing and then change its mind.
            statusItem.limits = preferences.menuBarLimits
            statusItem.resetTimeFormat = preferences.resetTimeFormat
            statusItem.showsWeeklyLimit = preferences.showsWeeklyLimitInMenuBar
            statusItem.showsRemaining = preferences.showsRemaining

            preferences.$appPresence
                .receive(on: RunLoop.main)
                .sink { [weak self] presence in
                    self?.applyActivationPolicy(presence)
                    if presence.wantsStatusItem { statusItem.show() } else { statusItem.hide() }
                }
                .store(in: &cancellables)

            // What the item shows is presentation alone. It reaches the item and
            // nothing else — no provider is read, refreshed, or switched on or
            // off to answer it — and the item redraws from the readings it
            // already holds, so a change in Settings lands on the bar at once.
            Publishers.CombineLatest(preferences.$showsLimitsInMenuBar, preferences.$menuBarProviders)
                .map { MenuBarLimits(isOn: $0, chosen: $1) }
                .removeDuplicates()
                // Dispatch, not the run loop: switched from the menu's own
                // tick, this has to land while AppKit is still tracking that
                // menu, which the run loop's default mode would hold back.
                .receive(on: DispatchQueue.main)
                .sink { [weak statusItem] in statusItem?.limits = $0 }
                .store(in: &cancellables)

            // Presentation only, like the parent limit switch: redraw from the
            // current snapshots immediately and never start another fetch.
            preferences.$showsWeeklyLimitInMenuBar
                .removeDuplicates()
                .receive(on: DispatchQueue.main)
                .sink { [weak statusItem] in statusItem?.showsWeeklyLimit = $0 }
                .store(in: &cancellables)

            preferences.$qoderRegion
                .dropFirst()
                .removeDuplicates()
                .receive(on: RunLoop.main)
                .sink { [weak qoder, weak store] region in
                    guard let qoder else { return }
                    store?.providerContextChanged(providerID: "qoder") {
                        qoder.apply(site: Sites.qoder(region: region))
                    }
                }
                .store(in: &cancellables)

            // The holiday check is a network request, so it runs only for
            // someone who has DeepSeek on and is shown its pricing. Received on
            // the run loop so `isConnected` reads the value just published.
            Publishers.CombineLatest3(preferences.$deepSeekPricingEnabled,
                                      preferences.$deepSeekPricingSchedule,
                                      preferences.$connectedProviders)
                .receive(on: RunLoop.main)
                .sink { [weak preferences] enabled, schedule, _ in
                    let active = enabled && schedule.offPeakOnChineseHolidays
                        && (preferences?.isConnected("deepseek") ?? false)
                    ChineseHolidays.shared.setActive(active)
                }
                .store(in: &cancellables)

            preferences.$minimaxRegion
                .dropFirst()
                .removeDuplicates()
                .receive(on: RunLoop.main)
                .sink { [weak miniMaxWeb, weak store] region in
                    miniMaxWeb?.apply(site: Sites.minimax(region: region))
                    store?.refresh(providerID: "minimax")
                }
                .store(in: &cancellables)

            preferences.$resetTimeFormat
                .receive(on: RunLoop.main)
                .sink { [weak statusItem] in statusItem?.resetTimeFormat = $0 }
                .store(in: &cancellables)

            preferences.$showsRemaining
                .dropFirst()
                .sink { [weak self] in self?.statusItem?.showsRemaining = $0 }
                .store(in: &cancellables)

            Publishers.CombineLatest(preferences.$connectedProviders, preferences.$disabledModels)
                .receive(on: RunLoop.main)
                .sink { [weak store, weak preferences] _, _ in
                    guard let store, let preferences else { return }
                    store.disconnected = preferences.disconnectedIDs(among: store.knownIDs)
                }
                .store(in: &cancellables)

            preferences.$accountNicknames
                .receive(on: RunLoop.main)
                .sink { [weak store] in store?.nicknames = $0 }
                .store(in: &cancellables)

            preferences.$ollamaEndpoint
                .receive(on: RunLoop.main)
                .sink { [weak store] address in
                    guard let endpoint = try? OllamaEndpoint.parse(address) else { return }
                    store?.updateOllamaEndpoint(endpoint)
                }
                .store(in: &cancellables)

            preferences.$lmstudioEndpoint
                .receive(on: RunLoop.main)
                .sink { [weak store] address in
                    guard let endpoint = try? LMStudioEndpoint.parse(address) else { return }
                    store?.updateLMStudioEndpoint(endpoint)
                }
                .store(in: &cancellables)

            preferences.$omlxEndpoint
                .receive(on: RunLoop.main)
                .sink { [weak store] address in
                    guard let endpoint = try? OMLXEndpoint.parse(address) else { return }
                    store?.updateOMLXEndpoint(endpoint)
                }
                .store(in: &cancellables)

            preferences.$providerOrder
                .receive(on: RunLoop.main)
                .sink { [weak store] in store?.order = $0 }
                .store(in: &cancellables)

            // Redraw the Gemini API ring against the new ceiling.
            //
            // `dropFirst` because `@Published` publishes the value it is given
            // at init, and a refresh there would race the store's first poll.
            // `receive(on:)` because `@Published` emits in `willSet` — the hop
            // to the next run loop pass is what lets the `didSet` persist the
            // number before the provider's closure goes looking for it.
            preferences.$geminiAPIMonthlyTokenBudget
                .dropFirst()
                .receive(on: RunLoop.main)
                .sink { [weak store] _ in store?.refresh(providerID: "gemini-api") }
                .store(in: &cancellables)

            // Limit crossings become notifications here rather than inside
            // the store: the store fetches, the notifier decides what is
            // worth interrupting someone for, and neither needs to know the
            // other.
            let notifier = ThresholdNotifier(
                isMuted: { [weak preferences] in preferences?.isMutedAlerts(for: $0) ?? false },
                deliver: { [weak self] in self?.announceThreshold($0) }
            )
            self.thresholdNotifier = notifier

            let resetWatcher = UsageResetWatcher(
                isMuted: { [weak preferences] in preferences?.isMutedAlerts(for: $0) ?? false },
                deliver: { [weak self] event in
                    MainActor.assumeIsolated {
                        self?.announceUsageReset(event: event)
                    }
                }
            )
            self.resetWatcher = resetWatcher

            let limitWatcher = UsageLimitWatcher(
                isMuted: { [weak preferences] in preferences?.isMutedAlerts(for: $0) ?? false },
                deliver: { [weak self] event in
                    MainActor.assumeIsolated {
                        self?.announceUsageLimit(event: event)
                    }
                }
            )
            self.limitWatcher = limitWatcher

            // The daily-pace window is laid over the store's snapshots here,
            // on the way out, rather than inside a provider: it is a reading
            // of a preference as much as of the account, and the store keeps
            // what the vendor said. Paired with the preference so flipping the
            // toggle redraws at once, without a fetch. The weekly-first ring
            // is laid the same way, and for the same reasons — see `drawn`.
            // Auto-order rides along after the derivations, so "most left"
            // means the window actually leading each ring.
            // The preferences ride as one publisher: `combineLatest` takes four
            // publishers at most, and the snapshots plus the four display
            // choices are five.
            let displayOptions = preferences.$claudeDailyPaceRing.combineLatest(
                preferences.$weeklyHeadline, preferences.$autoOrderByRemaining,
                preferences.$hideDepletedAccounts)
            store.$usageSnapshots
                .combineLatest(displayOptions)
                .receive(on: RunLoop.main)
                .sink { [weak board] snapshots, options in
                    let (paced, weekly, autoOrder, hideDepleted) = options
                    // Before the derivations: the daily pace ring is advisory,
                    // not a spending gate, and judging off it would hide an
                    // account that overspent today's share while the session
                    // still has room.
                    let usable = hideDepleted ? snapshots.filter { !$0.isDepleted } : snapshots
                    var drawn = Self.drawn(usable, weekly: weekly, paced: paced)
                    if autoOrder { drawn = ProviderOrder.byRemainingUsage(drawn) }
                    board?.setSnapshots(drawn)
                }
                .store(in: &cancellables)

            // Not `drawn`: the weekly-first ring is for the rings alone. The
            // menu bar already shows the week beside the short window, under a
            // "Weekly Limit" label that would name the session after a swap.
            // The alert watchers track one headline per provider and tell
            // "session" from "week" by which window leads, so a swap under them
            // re-fires thresholds, announces a reset that did not happen, and
            // leaves a spent session with no "available again" to follow it.
            store.$snapshots
                .combineLatest(preferences.$claudeDailyPaceRing)
                .receive(on: RunLoop.main)
                .sink { [weak statusItem] snapshots, paced in
                    let snapshots = DailyPace.apply(to: snapshots, enabled: paced)
                    statusItem?.snapshots = snapshots
                    let usageSnapshots = snapshots.filter { $0.kind != .swarm }
                    notifier.observe(usageSnapshots)
                    resetWatcher.observe(usageSnapshots)
                    limitWatcher.observe(usageSnapshots)
                }
                .store(in: &cancellables)
            store.start()
            // SWARMAA_DISCOVER=<url> loads that page in the signed-in WebView
            // and logs the API calls it makes — for finding an undocumented
            // endpoint by watching the site rather than guessing at path names.
            if let target = ProcessInfo.processInfo.environment["SWARMAA_DISCOVER"],
               let url = URL(string: target),
               let provider = webProviders.first(where: { url.host?.contains($0.id) == true })
                   ?? webProviders.first {
                Task {
                    let calls = await provider.recordCalls(on: url)
                    Log.usage.notice("discovered: \(calls.joined(separator: "  "), privacy: .public)")
                }
            }
            self.store = store
        }

        // What each agent is doing right now, so the menu can say whether it is
        // still working without you switching to it.
        var monitors: [String: any AgentActivityMonitor] = [
            "cursor": CursorActivityMonitor(),
            "grok": GrokActivityMonitor(),
            "gemini-api": GeminiAPIActivityMonitor(),
            "kimi": KimiActivityMonitor(),
        ]
        for profile in antigravityProfiles {
            monitors[profile.id] = AntigravityActivityMonitor(profile: profile)
        }
        var claudeMonitors: [ClaudeSessionMonitor] = []
        var claudeMonitorsByProfile: [(ClaudeProfile, ClaudeSessionMonitor)] = []
        for profile in claudeProfiles {
            let monitor = ClaudeSessionMonitor(
                directory: profile.sessionsDirectory,
                projects: profile.projectsDirectory
            )
            claudeMonitors.append(monitor)
            claudeMonitorsByProfile.append((profile, monitor))
            monitors[profile.id] = monitor
        }

        // With one profile there is nothing to attribute: every session in the
        // directory is that account's, by definition. With two or more there
        // is, because the Claude desktop app files the sessions it hosts under
        // the *default* profile's directory whichever account it is signed in
        // to — so the second account's work spun the first account's ring, and
        // switching account in the app did not move it. See
        // `ClaudeSessionOwnership`.
        if claudeProfiles.count > 1 {
            let index = ClaudeDesktopSessionIndex()
            let directories = claudeProfiles.map(\.sessionsDirectory)
            var accounts: [String: String] = [:]
            var transcripts: [String: ClaudeTranscriptReader] = [:]
            for profile in claudeProfiles {
                let path = profile.sessionsDirectory.path
                if let account = profile.accountID() { accounts[path] = account }
                transcripts[path] = ClaudeTranscriptReader(projects: profile.projectsDirectory)
            }
            let profileIDs = Dictionary(uniqueKeysWithValues: claudeProfiles.map {
                ($0.sessionsDirectory.path, $0.id)
            })
            for (profile, monitor) in claudeMonitorsByProfile {
                var ownership = ClaudeSessionOwnership(
                    own: profile.sessionsDirectory,
                    directories: directories,
                    accounts: accounts,
                    transcripts: transcripts,
                    index: index
                )
                ownership.isShown = { [weak preferences] directory in
                    guard let preferences, let id = profileIDs[directory.path] else { return true }
                    return preferences.isConnected(id)
                }
                monitor.ownership = ownership
            }
            let named = accounts.count, total = claudeProfiles.count
            Log.sessions.info("claude session ownership: \(named, privacy: .public) of \(total, privacy: .public) profiles name an account")
        }
        for profile in codexProfiles {
            monitors[profile.id] = CodexActivityMonitor(profile: profile)
        }

        // The `/usage` probe is a Claude Code process too, and files a session
        // for the seconds it runs. Every Claude monitor steps over it by pid
        // and by its scratch directory, whether or not a token refresher runs
        // below. Without this the probe showed as a `busy` session, vanished,
        // and was announced as a turn that finished.
        for monitor in claudeMonitors {
            monitor.ignoredPIDs = { ClaudeUsageCLI.runningPIDs }
            monitor.ignoredWorkingDirectories = [ClaudeUsageCLI.scratchLocation().path]
        }

        // Renewing the token runs the Claude command, which registers a session
        // of its own for the second it lives. Every Claude monitor is told to
        // step over that pid, so it never reaches the menu and never counts as
        // work in progress.
        //
        // Only the default profile is renewed. The command writes whichever
        // directory `CLAUDE_CONFIG_DIR` names, so a second profile would need
        // that passed through — behaviour nobody has been able to try on a Mac
        // with two of them, and an unverified guess is worse here than a ring
        // that ages the way it already does.
        if let defaultProvider = claudeProviders.first(where: { $0.profile.slug == nil }) {
            let refresher = ClaudeTokenRefresher(
                expiry: { await defaultProvider.tokenExpiry },
                reload: { await defaultProvider.reloadTokenExpiry() }
            )
            for monitor in claudeMonitors {
                monitor.ignoredPIDs = { [weak refresher] in
                    var pids = ClaudeUsageCLI.runningPIDs
                    if let pid = refresher?.launchedPID { pids.insert(pid) }
                    return pids
                }
            }
            // The one place the failure becomes visible. The store carries the
            // fact; nothing here retries, and the warning clears itself the
            // moment a reading comes back.
            refresher.$outcome
                .receive(on: RunLoop.main)
                .sink { [weak self] outcome in
                    guard case .failed = outcome else { return }
                    self?.store?.reportRenewalFailed(providerID: defaultProvider.id)
                }
                .store(in: &cancellables)

            refresher.start()
            tokenRefresher = refresher
        }
        let activity = ActivityCoordinator(monitors: monitors) { [weak self, weak board] id, sessions in
            guard let board else { return }
            board.setSessions(providerID: id, sessions: sessions)
            self?.statusItem?.setActivity(providerID: id, sessions: sessions)
            self?.announceCompletions(sessions: board.sessions)
            self?.noteWorkState(providerID: id, sessions: sessions)
        }
        self.activityCoordinator = activity
        // Demo mode shows fixed sample data. A live monitor publishes on
        // subscribe, so its first emission (usually no sessions at all) would
        // overwrite the fixture sessions under the same provider id. Never
        // enabling the coordinator also keeps Pi's supplemental sessions out,
        // since it drops them for any provider that is not enabled.
        if !isDemo {
            preferences.$connectedProviders
                .removeDuplicates()
                .combineLatest(Self.lightweight(preferences))
                .receive(on: RunLoop.main)
                .sink { [weak activity] connected, light in
                    activity?.setEnabled(light ? [] : connected)
                }
                .store(in: &cancellables)
        }

        let openCodeBridge = OpenCodeActivityBridge { [weak activity] id, sessions in
            activity?.setSupplementalSessions(providerID: id, source: "opencode", sessions: sessions)
        }
        self.openCodeActivityBridge = openCodeBridge
        Publishers.CombineLatest3(preferences.$customEndpoints, preferences.$connectedProviders,
                                  Self.lightweight(preferences))
            .receive(on: RunLoop.main)
            .sink { [weak openCodeBridge] endpoints, enabled, light in
                openCodeBridge?.configure(endpoints: endpoints, enabled: light ? [] : enabled)
            }
            .store(in: &cancellables)

        let piResponseMonitor = PiResponseMonitor(
            onResponse: { [weak self] providerID in
                _ = self?.store?.refresh(providerID: providerID)
            },
            onActivity: { [weak activity] providerID, snapshots in
                let sessions = snapshots.map {
                    AgentSession(
                        id: $0.id,
                        name: $0.model,
                        detail: L10n.t("Working"),
                        state: .busy,
                        waitingFor: nil,
                        since: $0.since
                    )
                }
                activity?.setSupplementalSessions(
                    providerID: providerID,
                    source: "pi",
                    sessions: sessions
                )
            }
        )
        self.piResponseMonitor = piResponseMonitor
        Self.lightweight(preferences)
            .receive(on: RunLoop.main)
            .sink { [weak piResponseMonitor] light in
                if light { piResponseMonitor?.stop() } else { piResponseMonitor?.start() }
            }
            .store(in: &cancellables)

        store?.isBusy = { [weak self, weak activity] in
            (activity?.isBusy ?? false) || (self?.lmstudioMetrics?.isBusy ?? false)
                || (self?.omlxMetrics?.isBusy ?? false)
        }
        // Read on every look rather than carried in by a sink, for the reason
        // `isBusy` is: a stored copy answers with whatever the preference was
        // when it was last delivered, and this one is a switch somebody flips to
        // compare two numbers on screen right now.
        store?.asksProviderOnLook = { [weak self] in
            self?.preferences?.asksProviderOnLook ?? false
        }

        // Banners need permission; asked at start rather than on the first event.
        ChannelNotifications.requestAuthorizationIfNeeded()

        preferences.$phoneLinkEnabled
            .receive(on: RunLoop.main)
            .sink { [weak self] enabled in
                guard PhoneLink.isAvailable, let self = self, let srv = self.phoneLinkServer else { return }
                Task { @MainActor in
                    if enabled {
                        self.phoneLinkServerStatus?.state = .starting
                        do {
                            let prefPort = self.preferences?.phoneLinkPort ?? 8788
                            let port = try await srv.start(port: prefPort)
                            self.preferences?.phoneLinkPort = port
                            self.phoneLinkServerStatus?.state = .ready(port: port)
                        } catch {
                            self.phoneLinkServerStatus?.state = .failed(error.localizedDescription)
                        }
                    } else {
                        await srv.stop()
                        self.phoneLinkServerStatus?.state = .off
                    }
                }
            }
            .store(in: &cancellables)
    }

    /// Make a noise, and a banner, when something has just finished.
    ///
    /// The watcher is fed on every publication whether or not anything is
    /// switched on, because it is a difference engine: skipping a reading would
    /// leave it comparing against a state two changes old, and the *next*
    /// transition it reported would be one that never happened.
    ///
    /// Several sessions can land in the same reading — one turn ending often
    /// unblocks another — and that gets one banner and one chime rather than a
    /// chord.
    @MainActor
    private func announceCompletions(sessions: [String: [AgentSession]]) {
        let events = completions.absorb(sessions)
        guard let event = events.first, let preferences else { return }
        Log.usage.info("session \(event.session.name, privacy: .public) \(String(describing: event.reason), privacy: .public)")

        if preferences.sessionEndSound {
            SessionChime.play(event.reason == .blocked
                              ? preferences.sessionBlockedSoundName
                              : preferences.sessionEndSoundName)
        }
        guard preferences.announceSessionEnd else { return }
        ChannelNotifications.sessionEnded(name: event.session.name, blocked: event.reason == .blocked)
    }

    /// Takes one reading on the falling edge of a provider's work.
    ///
    /// The rising edge needs nothing: work that has just started has not spent
    /// anything yet, and the busy schedule is already polling. The falling edge
    /// is where the schedule drops to the idle interval and leaves the figure
    /// somebody actually came to look at — what that run cost — alone for five
    /// minutes. The store decides whether to spend a fetch on it; see
    /// `UsageStore.refreshBecauseWorkFinished`.
    @MainActor
    private func noteWorkState(providerID: String, sessions: [AgentSession]) {
        let isBusy = sessions.contains { $0.state == .busy }
        if busyProviderIDs.contains(providerID), !isBusy {
            store?.refreshBecauseWorkFinished(providerID: providerID)
        }
        if isBusy {
            busyProviderIDs.insert(providerID)
        } else {
            busyProviderIDs.remove(providerID)
        }
    }

    @MainActor
    private func announceThreshold(_ alert: ThresholdAlert) {
        ThresholdAlerts.deliver(alert)
    }

    /// Swarmaa moved new work to another vendor. It follows the limit-reached
    /// switches because a switch is what a spent limit causes; with those off
    /// it stays quiet.
    @MainActor
    private func announceRouting(_ change: SwarmaRoutingChange) {
        guard let preferences,
              preferences.announceSessionLimitReached || preferences.announceWeeklyLimitReached else { return }
        ChannelNotifications.post(title: change.title, body: change.body, thread: "swarma.routing")
    }

    /// The test from Settings.
    @MainActor
    private func sendTestNotification() {
        ChannelNotifications.test()
    }

    /// A banner, and the chosen sound, when a limit resets.
    @MainActor
    private func announceUsageReset(event: UsageResetEvent) {
        guard let preferences else { return }
        Log.usage.info("usage reset for \(event.providerName, privacy: .public) (\(event.windowLabel, privacy: .public))")

        if preferences.usageResetSound {
            SessionChime.play(preferences.usageResetSoundName)
        }
        guard preferences.announceUsageReset else { return }
        UsageAlertNotifications.deliver(event)
    }

    @MainActor
    private func previewUsageResetAlert() {
        guard let preferences else { return }
        let demo = UsageResetEvent(
            providerID: "claude",
            providerName: "Claude",
            windowLabel: "5-hour limit",
            glyph: .claude,
            previousFraction: 0.95,
            currentFraction: 0.00,
            resetsAt: Date().addingTimeInterval(5 * 3600)
        )
        if preferences.usageResetSound {
            SessionChime.play(preferences.usageResetSoundName)
        }
        UsageAlertNotifications.deliver(demo)
    }

    /// A banner, and the chosen sound, when a limit is exhausted.
    @MainActor
    private func announceUsageLimit(event: UsageAlertEvent) {
        guard let preferences else { return }

        let isAnnounceEnabled: Bool
        switch event.kind {
        case .sessionLimitReached:
            isAnnounceEnabled = preferences.announceSessionLimitReached
        case .weeklyLimitReached:
            isAnnounceEnabled = preferences.announceWeeklyLimitReached
        case .reset:
            isAnnounceEnabled = preferences.announceUsageReset
        }

        guard isAnnounceEnabled else { return }

        Log.usage.info("usage limit reached for \(event.providerName, privacy: .public) (\(event.windowLabel, privacy: .public))")

        if preferences.limitReachedSound {
            SessionChime.play(preferences.limitReachedSoundName)
        }
        UsageAlertNotifications.deliver(event)
    }

    @MainActor
    private func previewSessionLimitAlert() {
        guard let preferences else { return }
        let demo = UsageAlertEvent(
            kind: .sessionLimitReached,
            providerID: "claude",
            providerName: "Claude",
            windowLabel: "5-hour",
            glyph: .claude,
            previousFraction: 0.95,
            currentFraction: 1.00,
            resetsAt: Date().addingTimeInterval(45 * 60)
        )
        if preferences.limitReachedSound {
            SessionChime.play(preferences.limitReachedSoundName)
        }
        UsageAlertNotifications.deliver(demo)
    }

    @MainActor
    private func previewWeeklyLimitAlert() {
        guard let preferences else { return }
        let demo = UsageAlertEvent(
            kind: .weeklyLimitReached,
            providerID: "claude",
            providerName: "Claude",
            windowLabel: "Weekly",
            glyph: .claude,
            previousFraction: 0.98,
            currentFraction: 1.00,
            resetsAt: Date().addingTimeInterval(3 * 86400)
        )
        if preferences.limitReachedSound {
            SessionChime.play(preferences.limitReachedSoundName)
        }
        UsageAlertNotifications.deliver(demo)
    }

    /// Closing the main window must not take the app with it: the menu bar
    /// item, the phone link and the alerts keep running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Launching the app again while it is already running lands here, so
    /// opening it from Applications or Spotlight reopens the main window.
    func applicationShouldHandleReopen(_ sender: NSApplication,
                                       hasVisibleWindows: Bool) -> Bool {
        if let onboarding, onboarding.isShowing { onboarding.show(); return true }
        openTeams()
        return true
    }

    /// Every "Settings…" entry point: the main window, on its Settings pane.
    @MainActor func openSettings() {
        openTeams()
        teams?.model.pane = .settings
    }

    /// The settings view for the main window's pane.
    @MainActor func settingsPane() -> AnyView? { settings.map { AnyView($0.embeddedView()) } }

    private var teams: TeamsWindowController?

    /// While the main window is open Swarmaa is a regular app, whatever the presence choice:
    /// an accessory app has no ⌘-Tab entry, so switching away buried the window with no way back.
    /// Closing the window returns to the chosen presence (menu bar or none).
    @MainActor func applyActivationPolicy(_ presence: AppPresence? = nil) {
        let chosen = presence ?? preferences?.appPresence ?? .dock
        let windowOpen = teams?.window?.isVisible == true || teams?.window?.isMiniaturized == true
        NSApp.setActivationPolicy(windowOpen ? .regular : chosen.activationPolicy)
    }
    /// The main window, from the status item or the app menu.
    @MainActor func openTeams(threadID: String? = nil) {
        if teams == nil {
            let window = TeamsWindowController()
            store?.$usageSnapshots.receive(on: RunLoop.main)
                .sink { [weak model = window.model] in model?.localUsage = $0 }
                .store(in: &cancellables)
            teams = window
        }
        let cellID = threadID.map { SwarmaCells.threadPrefix + $0 }
        teams?.show(threadID: cellID.flatMap { SwarmaCells.threadID(fromCellID: $0) })
        if let cellID, let swarm = SwarmaCells.swarmID(fromCellID: cellID) { teams?.model.detailSwarmID = swarm }
    }

    private var lessonReview: LessonReviewWindowController?
    /// The Lesson Review window, from the status item or the app menu.
    @MainActor func reviewLessons() {
        if lessonReview == nil {
            lessonReview = LessonReviewWindowController(service: SwarmaClient.shared) { [weak self] in
                self?.swarmaDirectory?.sync()
            }
        }
        lessonReview?.show()
    }
    @MainActor func openConnectPhone() {
        guard PhoneLink.isAvailable, let pairing = phoneLinkPairing, let registry = phoneLinkRegistry, let status = phoneLinkServerStatus else { return }
        if preferences?.phoneLinkEnabled == false { preferences?.phoneLinkEnabled = true }
        PhoneLinkWindowController.shared.show(pairing: pairing, registry: registry, port: preferences?.phoneLinkPort ?? 8788, serverStatus: status)
    }

    func applicationWillTerminate(_ notification: Notification) {
        ollamaRelay?.configure(enabled: false, endpoint: OllamaEndpoint.defaultAddress)
        lmstudioMetrics?.stop()
        omlxMetrics?.stop()
        tokenRefresher?.stop()
        piResponseMonitor?.stop()
        store?.stop()
        openCodeActivityBridge?.stop()
        activityCoordinator?.stop()
        // A language server this app started, if any. Left running it would
        // outlive the reason it exists and keep answering on loopback to
        // nothing.
        AntigravityBridge.owned.stop()
        Task { await phoneLinkServer?.stop() }
    }
}

extension Notification.Name {
    /// "Run Setup…" from places with no direct line to the app delegate (menus, Settings).
    static let swarmaaRunSetup = Notification.Name("app.swarmaa.runSetup")
}
