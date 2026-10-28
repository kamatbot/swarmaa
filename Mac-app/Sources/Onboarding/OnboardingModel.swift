import Foundation
import AppKit

/// Whether first-launch setup is still owed.
enum OnboardingGate {
    /// An install that already has Swarmaa configured (enabled, token file
    /// present) is complete; that is recorded so a later missing token does not
    /// send them back through it. Returns true when onboarding is needed.
    static func needsOnboarding(defaults: UserDefaults = .standard,
                                fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
        if defaults.bool(forKey: Preferences.onboardingCompleteKey) { return false }
        let token = (Preferences.storedSwarmaTokenPath(defaults: defaults) as NSString).expandingTildeInPath
        if Preferences.storedSwarmaEnabled(defaults: defaults), fileExists(token) {
            defaults.set(true, forKey: Preferences.onboardingCompleteKey)
            return false
        }
        return true
    }
}

enum OnboardingPage: Int, CaseIterable {
    case welcome, services, projects, remote, review, progress, summary
    /// "Connect to an existing Swarmaa": waiting for the browser approval, then done. Not part of the local-install sequence.
    case connect, connected
}

/// What the Welcome step is for: where this Mac's Swarmaa comes from.
enum WelcomeChoice: String, CaseIterable {
    /// Install the runtime bundled in the app and set it up here.
    case setUpHere
    /// A Swarmaa service folder already on this Mac (a development checkout).
    case useService
    /// A Swarmaa on another machine, reached with browser sign-in (a second Mac).
    case connectRemote
}

enum WelcomeAction: Hashable { case `continue`, skip }

struct OnboardingProject: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var path: String
    var entry: String { "\(name)=\(path)" }

    static func defaultName(for path: String) -> String {
        let base = (path as NSString).lastPathComponent.lowercased()
        let cleaned = base.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? String($0) : "-" }.joined()
        return cleaned.isEmpty ? "project" : cleaned
    }
}

@MainActor
final class OnboardingModel: ObservableObject {
    struct ServiceChoice: Equatable {
        var connect = false
        var worker = false
        var share = false
    }

    // Page flow
    @Published private(set) var page: OnboardingPage = .welcome

    // Welcome
    @Published var choice: WelcomeChoice
    @Published var remoteAddress = "https://api.swarmaa.com"
    @Published private(set) var installing = false
    @Published private(set) var welcomeError: String?
    @Published private(set) var connecting = false
    @Published var serviceRoot: String { didSet { if oldValue != serviceRoot { rootChanged() } } }
    @Published private(set) var detection: SetupDetection?
    @Published private(set) var detectionError: String?
    @Published private(set) var detecting = false

    // Services
    @Published var choices: [SetupHarness: ServiceChoice] = [:]

    // Projects, remote, login
    @Published var projects: [OnboardingProject] = []
    @Published var hostname = "api.swarmaa.com"
    @Published var setUpRemoteNow = false
    @Published var autostart = true

    // Review / progress / summary
    @Published private(set) var busy = false
    @Published private(set) var steps: [SetupStep] = []
    @Published private(set) var log: [String] = []
    @Published private(set) var preview: SetupSummary?
    @Published private(set) var summary: SetupSummary?
    @Published private(set) var failure: String?

    private let defaults: UserDefaults
    private let engine: SetupEngine
    private let runOffMain: (@escaping () -> Void) -> Void
    private var detectToken = 0
    /// The runtime inside the app, nil in a build that doesn't embed one.
    let bundledRuntime: URL?
    private let installDirectory: URL
    private let installer: RuntimeInstaller
    private let makeFlow: () -> SwarmaOAuthFlow
    private var activeFlow: SwarmaOAuthFlow?

    /// `runOffMain` is injectable so tests can run the engine inline.
    init(defaults: UserDefaults = .standard, engine: SetupEngine = SetupEngine(),
         bundledRuntime: URL? = RuntimeInstaller.bundledRuntime,
         installDirectory: URL = RuntimeInstaller.defaultInstallDirectory,
         installer: RuntimeInstaller = RuntimeInstaller(),
         makeFlow: @escaping () -> SwarmaOAuthFlow = { SwarmaOAuthFlow(open: { NSWorkspace.shared.open($0) }) },
         runOffMain: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.global(qos: .userInitiated).async(execute: $0) }) {
        self.defaults = defaults
        self.engine = engine
        self.bundledRuntime = bundledRuntime
        self.installDirectory = installDirectory
        self.installer = installer
        self.makeFlow = makeFlow
        self.runOffMain = runOffMain
        let stored = defaults.string(forKey: Preferences.serviceRootKey) ?? Preferences.defaultSwarmaaServiceRoot
        self.serviceRoot = stored
        // An existing service on this Mac keeps working as before; otherwise the bundled runtime is the default.
        let storedIsDev = Self.isValidRoot(URL(fileURLWithPath: (stored as NSString).expandingTildeInPath))
            && !RuntimeInstaller.isBundledLayout(URL(fileURLWithPath: (stored as NSString).expandingTildeInPath))
        self.choice = storedIsDev ? .useService : .setUpHere
        for h in SetupHarness.allCases { choices[h] = ServiceChoice() }
        choices[.notchtrader] = ServiceChoice(connect: true)
        rootChanged()
    }

    // MARK: Welcome

    var rootURL: URL { URL(fileURLWithPath: (serviceRoot as NSString).expandingTildeInPath) }

    var rootIsValid: Bool { Self.isValidRoot(rootURL) }

    /// A development checkout (scripts/setup.ts) or an installed runtime (dist/scripts/setup.js).
    static func isValidRoot(_ root: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: root.appendingPathComponent("package.json").path)
            && (fm.fileExists(atPath: root.appendingPathComponent("scripts/setup.ts").path)
                || RuntimeInstaller.isBundledLayout(root))
    }

    /// What the Welcome footer offers right now. "Skip for now" is always there, so no state is a dead end.
    var welcomeActions: Set<WelcomeAction> {
        var actions: Set<WelcomeAction> = [.skip]
        let ready: Bool
        switch choice {
        case .setUpHere: ready = bundledRuntime != nil && !installing
        case .useService: ready = rootIsValid && detection != nil && !detecting
        case .connectRemote: ready = (try? SwarmaOAuth.origin(remoteAddress)) != nil
        }
        if ready { actions.insert(.continue) }
        return actions
    }

    /// Leaves onboarding with usage rings only: nothing is installed or connected.
    func skip() { markComplete() }

    private func rootChanged() {
        detection = nil
        detectionError = nil
        guard rootIsValid else { return }
        detecting = true
        detectToken += 1
        let token = detectToken, root = rootURL, engine = engine
        runOffMain { [weak self] in
            let result = Result { try engine.detect(root: root) }
            DispatchQueue.main.async {
                guard let self, self.detectToken == token else { return }
                self.detecting = false
                switch result {
                case .success(let d): self.apply(detection: d)
                case .failure(let e): self.detectionError = e.localizedDescription
                }
            }
        }
    }

    func retryDetection() { let r = serviceRoot; serviceRoot = ""; serviceRoot = r }

    func apply(detection d: SetupDetection) {
        detection = d
        let state = d.state
        for h in SetupHarness.allCases where h != .notchtrader {
            let installed = d.isInstalled(h)
            let hosted = h == .grok || h == .dot
            var c = ServiceChoice()
            if let state {
                c.connect = state.agents.contains(h.rawValue)
                c.worker = state.workers.contains(h.rawValue)
                c.share = state.sharing.contains(h.rawValue)
            } else {
                c.connect = installed
                c.share = installed && !hosted
            }
            choices[h] = c
        }
        if let state {
            if projects.isEmpty {
                projects = state.folders.compactMap(Self.project(fromEntry:))
            }
            if let autostart = state.autostart { self.autostart = autostart }
            if let host = state.remote?.hostname, !host.isEmpty { hostname = host; setUpRemoteNow = true }
        }
    }

    static func project(fromEntry entry: String) -> OnboardingProject? {
        guard let eq = entry.firstIndex(of: "=") else { return nil }
        return OnboardingProject(name: String(entry[..<eq]), path: String(entry[entry.index(after: eq)...]))
    }

    // MARK: Services

    static func canConnect(_ h: SetupHarness, installed: Bool) -> Bool {
        switch h {
        case .claude, .codex, .agy: return installed
        case .grok, .dot, .notchtrader: return true
        }
    }
    static func hasWorker(_ h: SetupHarness) -> Bool { h == .claude || h == .codex }
    static func hasSharing(_ h: SetupHarness) -> Bool { h == .claude || h == .codex || h == .agy }

    func isInstalled(_ h: SetupHarness) -> Bool { detection?.isInstalled(h) ?? false }

    var needsRemote: Bool { (choices[.grok]?.connect ?? false) || (choices[.dot]?.connect ?? false) }

    // MARK: Projects

    func addFolders(_ urls: [URL]) {
        for url in urls where !projects.contains(where: { $0.path == url.path }) {
            projects.append(OnboardingProject(name: OnboardingProject.defaultName(for: url.path), path: url.path))
        }
    }

    /// Why the project list can't be used yet, if it can't.
    var projectsProblem: String? {
        var seen = Set<String>()
        for p in projects {
            let name = p.name.trimmingCharacters(in: .whitespaces)
            if name.isEmpty || name.contains("=") || name.contains(where: \.isWhitespace) {
                return "Scope names can't be empty or contain spaces or “=”."
            }
            if !seen.insert(name).inserted { return "Two projects are called “\(name)”." }
        }
        return nil
    }

    // MARK: Plan

    func makePlan() -> SetupPlan {
        var harnesses: [String: SetupPlan.Harness] = [:]
        for h in SetupHarness.allCases {
            let c = choices[h] ?? ServiceChoice()
            let connect = h == .notchtrader ? true : c.connect
            harnesses[h.rawValue] = .init(connect: connect,
                                          worker: connect && Self.hasWorker(h) && c.worker,
                                          share: connect && Self.hasSharing(h) && c.share)
        }
        let host = hostname.trimmingCharacters(in: .whitespacesAndNewlines)
        return SetupPlan(harnesses: harnesses,
                         folders: projects.map { "\($0.name.trimmingCharacters(in: .whitespaces))=\($0.path)" },
                         remote: needsRemote && setUpRemoteNow && !host.isEmpty ? .init(hostname: host) : nil,
                         autostart: autostart)
    }

    // MARK: Navigation

    var canContinue: Bool {
        switch page {
        case .welcome: return welcomeActions.contains(.continue)
        case .connect: return false
        case .projects: return projectsProblem == nil
        case .remote: return !setUpRemoteNow || !hostname.trimmingCharacters(in: .whitespaces).isEmpty
        case .review: return preview?.ok == true && !busy
        case .progress: return false
        default: return true
        }
    }

    var canGoBack: Bool { page != .welcome && page != .summary && page != .connected && !(page == .progress && busy) && !installing }

    static func next(after page: OnboardingPage, needsRemote: Bool) -> OnboardingPage? {
        switch page {
        case .projects: return needsRemote ? .remote : .review
        default: return OnboardingPage(rawValue: page.rawValue + 1)
        }
    }

    static func previous(before page: OnboardingPage, needsRemote: Bool) -> OnboardingPage? {
        switch page {
        case .review: return needsRemote ? .remote : .projects
        case .progress: return .review
        case .connect: return .welcome
        default: return OnboardingPage(rawValue: page.rawValue - 1)
        }
    }

    func goBack() {
        guard canGoBack, let p = Self.previous(before: page, needsRemote: needsRemote) else { return }
        if page == .connect { activeFlow?.cancel(); activeFlow = nil; connecting = false }
        failure = nil
        page = p
    }

    /// Continue / Connect.
    func goNext() {
        guard canContinue else { return }
        if page == .welcome {
            switch choice {
            case .setUpHere: installBundledRuntime(); return
            case .connectRemote: page = .connect; connectRemote(); return
            case .useService: defaults.set(serviceRoot, forKey: Preferences.serviceRootKey); defaults.set("token", forKey: Preferences.authModeKey)
            }
        }
        guard let n = Self.next(after: page, needsRemote: needsRemote) else { return }
        page = n
        if n == .review { runPreview() }
        if n == .progress { runForReal() }
    }

    // MARK: Bundled runtime

    /// Copies the app's runtime into Application Support (when newer), points the app at it, and moves on.
    func installBundledRuntime() {
        guard let bundled = bundledRuntime else { return }
        installing = true; welcomeError = nil
        let installer = self.installer, dest = installDirectory
        runOffMain { [weak self] in
            let result = Result { try installer.install(from: bundled, to: dest) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.installing = false
                switch result {
                case .success:
                    self.serviceRoot = dest.path   // re-detects against the installed runtime
                    self.defaults.set(dest.path, forKey: Preferences.serviceRootKey)
                    self.defaults.set("token", forKey: Preferences.authModeKey)
                    self.page = .services
                case .failure(let e): self.welcomeError = "Couldn't install Swarmaa: \(e.localizedDescription)"
                }
            }
        }
    }

    // MARK: Existing Swarmaa (second Mac)

    var connectError: String? { failure }

    func connectRemote() {
        failure = nil; connecting = true
        let flow = makeFlow(), address = remoteAddress
        activeFlow = flow
        Task { [weak self] in
            do {
                try await flow.signIn(address: address)
                await MainActor.run { self?.remoteConnected(address: address) }
            } catch {
                await MainActor.run {
                    guard let self, self.activeFlow === flow else { return }
                    self.connecting = false
                    self.failure = error.localizedDescription
                }
            }
        }
    }

    func remoteConnected(address: String) {
        connecting = false; activeFlow = nil
        if let origin = try? SwarmaOAuth.origin(address) { defaults.set(origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: "swarmaServiceURL") }
        defaults.set("oauth", forKey: Preferences.authModeKey)
        defaults.set(true, forKey: "swarmaEnabled")
        page = .connected
    }

    // MARK: Engine runs

    func runPreview() {
        preview = nil; failure = nil; steps = []; busy = true
        execute(dry: true) { [weak self] summary, error in
            self?.preview = summary
            self?.failure = summary?.ok == false ? (summary?.error ?? "The preview reported a problem.") : error
        }
    }

    func runForReal() {
        summary = nil; failure = nil; steps = []; log = []; busy = true
        execute(dry: false) { [weak self] summary, error in
            guard let self else { return }
            self.summary = summary
            if let summary, summary.ok { self.page = .summary; self.applyToApp(summary) }
            else { self.failure = summary?.error ?? error ?? "Setup did not finish." }
        }
    }

    func retry() {
        switch page {
        case .review: runPreview()
        case .connect: connectRemote()
        default: runForReal()
        }
    }

    private func execute(dry: Bool, done: @escaping (SetupSummary?, String?) -> Void) {
        let plan = makePlan(), root = rootURL, engine = engine
        runOffMain { [weak self] in
            let onMain: (@escaping (OnboardingModel) -> Void) -> Void = { work in
                DispatchQueue.main.async { if let self { work(self) } }
            }
            do {
                let summary = try engine.run(plan: plan, dry: dry, root: root,
                    onEvent: { event in onMain { $0.handle(event) } },
                    onRaw: { line in onMain { $0.log.append(line) } })
                onMain { $0.busy = false; done(summary, nil) }
            } catch {
                onMain { $0.busy = false; done(nil, error.localizedDescription) }
            }
        }
    }

    private func handle(_ event: SetupEvent) {
        switch event {
        case .step(let s):
            if let i = steps.firstIndex(where: { $0.id == s.id }) { steps[i] = s } else { steps.append(s) }
        case .log(let line): log.append(line)
        case .summary, .error: break
        }
    }

    // MARK: Finish

    /// Point the notch at the service that was just set up.
    private func applyToApp(_ summary: SetupSummary) {
        defaults.set(serviceRoot, forKey: Preferences.serviceRootKey)
        defaults.set("token", forKey: Preferences.authModeKey)
        defaults.set(true, forKey: "swarmaEnabled")
        defaults.set(rootURL.appendingPathComponent(".local/notchtrader.json").path, forKey: "swarmaTokenPath")
        if let url = summary.serviceUrl, !url.isEmpty { defaults.set(url, forKey: "swarmaServiceURL") }
    }

    func markComplete() { defaults.set(true, forKey: Preferences.onboardingCompleteKey) }

    func copyMCPURL() {
        guard let url = summary?.mcpUrl else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
    }
}
