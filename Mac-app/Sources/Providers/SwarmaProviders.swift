import Foundation

/// How a `swarm_status` answer becomes cells. Pure, so the mapping can be
/// tested without a client, a store or a clock.
enum SwarmaCells {
    static let agentPrefix = "swarm:agent:"
    static let scopePrefix = "swarm:scope:"
    static let harnessPrefix = "swarm:harness:"
    static let lessonsID = "swarm:lessons"

    /// The cell that stands in for the whole service when nothing has ever been
    /// read from it, so "Swarmaa not running" has somewhere to show.
    static let serviceName = "swarma"

    static func agentID(_ name: String) -> String { agentPrefix + name }
    static func scopeID(_ scope: String) -> String { scopePrefix + scope }
    static func harnessID(_ harness: String) -> String { harnessPrefix + harness }

    /// "project:demo" reads as "demo"; a scope without the prefix is left as it is.
    static func scopeLabel(_ scope: String) -> String {
        scope.hasPrefix("project:") ? String(scope.dropFirst("project:".count)) : scope
    }

    /// A name short enough to sit under a ring.
    static func ringName(_ name: String, limit: Int = 8) -> String {
        name.count <= limit ? name : String(name.prefix(limit - 1)) + "…"
    }

    /// "codex" reads as "Codex"; routing names vendors, not harnesses.
    static func vendorName(_ provider: String) -> String {
        provider.prefix(1).uppercased() + provider.dropFirst()
    }

    /// The agent's vendor mark, reusing the marks the app already draws for
    /// those vendors. `.third` is what an unknown vendor gets.
    static func glyph(forProvider provider: String?) -> ProviderGlyph {
        switch provider?.lowercased() {
        case "claude":                 return .claude
        case "codex":                  return .openai
        case "antigravity", "gemini":  return .antigravity
        case "grok":                   return .grok
        default:                       return .third
        }
    }

    /// Agent cells report status, not quota: the native provider cells own
    /// usage, so a second ring here would show the same service twice.
    /// Offline is red; running and idle are both fine.
    static func agentBand(live: Bool) -> UsageBand { live ? .ample : .critical }

    // MARK: Agents

    static func agentSnapshot(name: String, in status: SwarmaStatus) -> ProviderSnapshot {
        guard let worker = status.workers.first(where: { $0.name == name }) else {
            return unavailable(id: agentID(name), name: name, glyph: .third, detail: L10n.t("offline"))
        }

        let vendor = worker.providers.first

        var targets: [SwarmaCancelTarget] = []
        for task in worker.running {
            guard let row = status.recent.first(where: { $0.id == task.taskId }),
                  let version = row.version else { continue }
            targets.append(SwarmaCancelTarget(taskID: task.taskId, version: version,
                                              title: row.objective ?? task.taskId))
        }

        // The worker the service would hand the next task to says so while it
        // has nothing else to say; a busy one keeps showing its task.
        let isNextUp = worker.live && worker.running.isEmpty
            && status.routing?.recommended.map { worker.providers.contains($0) } == true

        let detail: String
        if !worker.live {
            detail = L10n.t("offline")
        } else if let task = worker.running.first {
            detail = status.recent.first(where: { $0.id == task.taskId })?.objective
                ?? task.scope.map { L10n.t("running in \(scopeLabel($0))") }
                ?? L10n.t("running")
        } else if isNextUp {
            detail = L10n.t("Next tasks → here")
        } else {
            detail = L10n.t("idle")
        }

        let usedText = !worker.live ? L10n.t("offline") : worker.running.isEmpty ? L10n.t("idle") : L10n.t("running")
        let role = L10n.t("\(vendor.map(vendorName) ?? name) worker")

        let window = LimitWindow(
            id: "primary",
            label: role,
            usedText: usedText,
            detail: detail,
            bandOverride: agentBand(live: worker.live),
            prefersUsedText: true
        )
        var snapshot = cell(id: agentID(name), name: role, glyph: glyph(forProvider: vendor), window: window)
        snapshot.swarmTasks = targets
        snapshot.swarmActivity = SwarmaActivity.agent(worker, in: status)
        if let reason = status.routing?.reason, !reason.isEmpty {
            snapshot.windows.append(LimitWindow(id: "routing", label: L10n.t("Routing"), detail: reason))
        }
        return snapshot
    }

    // MARK: Services in use

    /// What the harness cell is called. The five the service names are product
    /// names, the same in every language; anything else is shown as sent.
    static func harnessName(_ harness: String) -> String {
        switch harness.lowercased() {
        case "claude-code": return "Claude Code"
        case "codex":       return "Codex"
        case "antigravity": return "Antigravity"
        case "grok":        return "Grok"
        case "dot":         return "Dot"
        case "other":       return L10n.t("Other")
        default:            return harness.prefix(1).uppercased() + harness.dropFirst()
        }
    }

    static func glyph(forHarness harness: String) -> ProviderGlyph {
        switch harness.lowercased() {
        case "claude-code": return .claude
        case "codex":       return .openai
        case "antigravity": return .antigravity
        case "grok":        return .grok
        default:            return .third   // dot, other, and whatever the service learns next
        }
    }

    /// The harnesses with a chat in progress, each of which gets a cell.
    static func activeHarnesses(in status: SwarmaStatus) -> [String] {
        Array(Set(status.sessions.map(\.harness))).sorted()
    }

    /// Tooltip rows a harness cell lists before summarising the rest, so a busy
    /// day cannot grow the card past the room the notch reserves for it.
    static let maxSessionRows = 5

    static func harnessSnapshot(harness: String, in status: SwarmaStatus, now: Date = Date()) -> ProviderSnapshot {
        // Newest first; a chat with no timestamp is the oldest thing we know of.
        let sessions = status.sessions.filter { $0.harness == harness }
            .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        let name = harnessName(harness)

        let detail: String
        if let latest = sessions.first {
            detail = [latest.title, latest.scope.map(scopeLabel)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        } else {
            detail = L10n.t("idle")
        }
        let count = sessions.count
        let primary = LimitWindow(
            id: "primary",
            label: name,
            used: count,
            usedText: count == 1 ? L10n.t("1 chat") : L10n.t("\(count) chats"),
            detail: detail,
            bandOverride: .ample,
            prefersUsedText: true
        )
        var snapshot = cell(id: harnessID(harness), name: name, glyph: glyph(forHarness: harness), window: primary)
        // The headline row is the newest chat already; the rest follow it.
        for session in sessions.prefix(maxSessionRows) {
            let age = session.updatedAt.map { ElapsedCopy.ago(since: $0, now: now) }
            snapshot.windows.append(LimitWindow(
                id: "session:" + session.id,
                label: session.title.isEmpty ? L10n.t("Untitled chat") : session.title,
                detail: [session.scope.map(scopeLabel), age].compactMap { $0 }.joined(separator: " · ")
            ))
        }
        if count > maxSessionRows {
            snapshot.windows.append(LimitWindow(id: "more", label: L10n.t("\(count - maxSessionRows) more"), detail: ""))
        }
        return snapshot
    }

    // MARK: Scopes

    /// A scope's band. A failure or a blocked task needs a person; queued work
    /// with nobody alive to take it is the quieter version of the same problem.
    static func scopeBand(_ scope: SwarmaStatus.Scope, hasLiveWorker: Bool) -> UsageBand {
        if scope.failed24h > 0 || scope.blocked > 0 { return .critical }
        if scope.queued > 0 && !hasLiveWorker { return .watch }
        return .ample
    }

    static func scopeSnapshot(scope name: String, in status: SwarmaStatus) -> ProviderSnapshot {
        let scope = status.scopes.first(where: { $0.scope == name })
            ?? SwarmaStatus.Scope(scope: name, queued: 0, running: 0, blocked: 0, completed24h: 0, failed24h: 0)
        let label = scopeLabel(name)

        var detail = L10n.t("\(scope.completed24h) done today")
        if scope.failed24h > 0 { detail += " · " + L10n.t("\(scope.failed24h) failed") }
        let counts = L10n.t("\(scope.running) running · \(scope.queued) queued")

        // The tooltip prints a count row's detail and not its text, so the
        // counts the cell reads get a row of their own beside the day's tally.
        let primary = LimitWindow(
            id: "primary",
            label: label,
            used: scope.completed24h,
            // The ring's reading is the project's name: counts don't fit under a ring, and the
            // band and the hover card already carry them.
            usedText: ringName(label),
            detail: detail,
            bandOverride: scopeBand(scope, hasLiveWorker: status.workers.contains(where: \.live)),
            prefersUsedText: true
        )
        let now = LimitWindow(id: "now", label: L10n.t("Now"), used: scope.running, detail: counts)
        var snapshot = cell(id: scopeID(name), name: label, glyph: .third, window: primary)
        snapshot.windows.append(now)
        snapshot.swarmActivity = SwarmaActivity.scope(scope, in: status)
        return snapshot
    }

    // MARK: Lessons

    /// "Lessons — 3 to review", amber: it needs a person but nothing is broken.
    static func lessonsSnapshot(pending: Int) -> ProviderSnapshot {
        let window = LimitWindow(
            id: "primary",
            label: L10n.t("Lessons"),
            used: pending,
            usedText: L10n.t("\(pending) to review"),
            detail: L10n.t("Click to review"),
            bandOverride: .watch,
            prefersUsedText: true
        )
        return cell(id: lessonsID, name: L10n.t("Lessons"), glyph: .third, window: window)
    }

    // MARK: Questions and swarms

    /// The open questions' one cell opens the newest one's thread.
    static func questionsCellID(_ questions: [TeamsQuestion]) -> String? {
        let open = questions.filter { $0.status == "open" && $0.threadID != nil }
        let newest = open.max { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) } ?? open.first
        return newest?.threadID.map(threadCellID)
    }

    /// Only swarms that wait on someone get a cell.
    static func notchSwarms(_ swarms: [TeamsSwarm]) -> [TeamsSwarm] {
        swarms.filter { ["waiting_on_you", "blocked"].contains($0.status) && $0.threadID != nil }
    }

    /// The swarm's thread, suffixed so two swarms (or a swarm and the
    /// questions) in one thread keep distinct cells; `threadID(fromCellID:)`
    /// drops the suffix.
    static func swarmCellID(_ swarm: TeamsSwarm) -> String? {
        swarm.threadID.map { threadCellID($0) + "/swarm/" + swarm.id }
    }

    /// "2 waiting", amber, like the Lessons cell.
    static func questionsSnapshot(id: String, questions: [TeamsQuestion]) -> ProviderSnapshot {
        let open = questions.filter { $0.status == "open" }
        let newest = open.max { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        let window = LimitWindow(id: "primary", label: L10n.t("Questions"), used: open.count,
                                 usedText: L10n.t("\(open.count) waiting"),
                                 detail: newest?.prompt ?? L10n.t("Click to answer"),
                                 bandOverride: .watch, prefersUsedText: true)
        return cell(id: id, name: L10n.t("Questions"), glyph: .third, window: window)
    }

    /// "3/5": amber while it waits on you, red when blocked.
    static func swarmSnapshot(id: String, swarm: TeamsSwarm) -> ProviderSnapshot {
        let window = LimitWindow(id: "primary", label: swarm.title, used: swarm.progress.done,
                                 usedText: "\(swarm.progress.done)/\(swarm.progress.total)",
                                 detail: TeamsCopy.swarmStatus(swarm.status),
                                 bandOverride: swarm.status == "blocked" ? .critical : .watch, prefersUsedText: true)
        return cell(id: id, name: swarm.title, glyph: .third, window: window)
    }

    // MARK: Failure

    /// The cell when the service cannot be read. No ring and no number: what the
    /// last answer said is exactly what can no longer be vouched for.
    static func unavailable(id: String, name: String, glyph: ProviderGlyph, detail: String) -> ProviderSnapshot {
        let window = LimitWindow(id: "primary", label: name, usedText: L10n.t("offline"), detail: detail,
                                 bandOverride: .critical, prefersUsedText: true)
        var snapshot = cell(id: id, name: name, glyph: glyph, window: window)
        snapshot.status = .error(detail)
        return snapshot
    }

    private static func cell(id: String, name: String, glyph: ProviderGlyph, window: LimitWindow) -> ProviderSnapshot {
        ProviderSnapshot(id: id, displayName: name, glyph: glyph, fidelity: .official, status: .ok,
                         windows: [window], headlineID: "primary", weeklyID: nil, block: nil, kind: .swarm)
    }
}

/// One cell per Swarma worker. Never throws: a service that is down is a cell
/// that says so, not a failed fetch for the store to make its own call about.
final class SwarmAgentProvider: UsageProvider {
    let name: String
    private let client: SwarmaClient

    var kind: ProviderKind { .swarm }
    var id: String { SwarmaCells.agentID(name) }
    var displayName: String { name }
    var glyph: ProviderGlyph { .third }

    init(name: String, client: SwarmaClient = .shared) {
        self.name = name
        self.client = client
    }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        do {
            return SwarmaCells.agentSnapshot(name: name, in: try await client.status())
        } catch {
            let failure = error as? SwarmaClient.Failure ?? .unreachable
            return SwarmaCells.unavailable(id: id, name: name, glyph: .third, detail: failure.message)
        }
    }

}

/// One cell per Swarma project scope.
final class SwarmScopeProvider: UsageProvider {
    let scope: String
    private let client: SwarmaClient

    var kind: ProviderKind { .swarm }
    var id: String { SwarmaCells.scopeID(scope) }
    var displayName: String { SwarmaCells.scopeLabel(scope) }
    var glyph: ProviderGlyph { .third }

    init(scope: String, client: SwarmaClient = .shared) {
        self.scope = scope
        self.client = client
    }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        do {
            return SwarmaCells.scopeSnapshot(scope: scope, in: try await client.status())
        } catch {
            let failure = error as? SwarmaClient.Failure ?? .unreachable
            return SwarmaCells.unavailable(id: id, name: displayName, glyph: .third, detail: failure.message)
        }
    }

}

/// One cell per harness with a chat in progress; it goes when the last one
/// has been quiet for the service's 15 minutes.
final class SwarmHarnessProvider: UsageProvider {
    let harness: String
    private let client: SwarmaClient

    var kind: ProviderKind { .swarm }
    var id: String { SwarmaCells.harnessID(harness) }
    var displayName: String { SwarmaCells.harnessName(harness) }
    var glyph: ProviderGlyph { SwarmaCells.glyph(forHarness: harness) }

    init(harness: String, client: SwarmaClient = .shared) {
        self.harness = harness
        self.client = client
    }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        do {
            return SwarmaCells.harnessSnapshot(harness: harness, in: try await client.status())
        } catch {
            let failure = error as? SwarmaClient.Failure ?? .unreachable
            return SwarmaCells.unavailable(id: id, name: displayName, glyph: glyph, detail: failure.message)
        }
    }
}

/// The Lessons cell: only registered while lessons wait, so it needs no
/// "nothing to review" state.
final class SwarmLessonsProvider: UsageProvider {
    private let client: SwarmaClient

    var kind: ProviderKind { .swarm }
    var id: String { SwarmaCells.lessonsID }
    var displayName: String { L10n.t("Lessons") }
    var glyph: ProviderGlyph { .third }

    init(client: SwarmaClient = .shared) { self.client = client }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        do {
            return SwarmaCells.lessonsSnapshot(pending: try await client.status().lessonsPending)
        } catch {
            let failure = error as? SwarmaClient.Failure ?? .unreachable
            return SwarmaCells.unavailable(id: id, name: displayName, glyph: glyph, detail: failure.message)
        }
    }
}

/// The open questions, as one cell.
final class SwarmQuestionsProvider: UsageProvider {
    let id: String
    private let client: SwarmaTeamsClient

    var kind: ProviderKind { .swarm }
    var displayName: String { L10n.t("Questions") }
    var glyph: ProviderGlyph { .third }

    init(id: String, client: SwarmaTeamsClient) { self.id = id; self.client = client }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        do {
            return SwarmaCells.questionsSnapshot(id: id, questions: try await client.questionList())
        } catch {
            return SwarmaCells.unavailable(id: id, name: displayName, glyph: glyph,
                                           detail: SwarmaTeamsClient.Failure.map(error).message)
        }
    }
}

/// One open swarm that waits on you or is blocked.
final class SwarmWaitingProvider: UsageProvider {
    let id: String
    let swarmID: String
    let displayName: String
    private let client: SwarmaTeamsClient

    var kind: ProviderKind { .swarm }
    var glyph: ProviderGlyph { .third }

    init(id: String, swarm: TeamsSwarm, client: SwarmaTeamsClient) {
        self.id = id; self.swarmID = swarm.id; self.displayName = swarm.title; self.client = client
    }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        do {
            return SwarmaCells.swarmSnapshot(id: id, swarm: try await client.swarmGet(id: swarmID))
        } catch {
            return SwarmaCells.unavailable(id: id, name: displayName, glyph: glyph,
                                           detail: SwarmaTeamsClient.Failure.map(error).message)
        }
    }
}

/// A change of where the service recommends sending new work.
struct SwarmaRoutingChange: Equatable {
    let from: String?
    let to: String
    let reason: String?

    var title: String { L10n.t("Swarmaa switched to \(SwarmaCells.vendorName(to))") }
    var body: String { reason ?? "" }
}

/// Reports a change of recommendation once. The first answer after launch only
/// records, as `ThresholdNotifier` does: what the service already recommended
/// when the app started is not news. An answer with no recommendation is
/// remembered but never announced; there is nothing to switch to.
@MainActor
final class SwarmaRoutingWatcher {
    private var seen = false
    private var last: String?
    private let deliver: (SwarmaRoutingChange) -> Void

    init(deliver: @escaping (SwarmaRoutingChange) -> Void = { _ in }) {
        self.deliver = deliver
    }

    func observe(_ routing: SwarmaStatus.Routing?) {
        let current = routing?.recommended
        defer { seen = true; last = current }
        guard seen, let current, current != last else { return }
        deliver(SwarmaRoutingChange(from: last, to: current, reason: routing?.reason))
    }
}

/// Decides which Swarma cells exist, from what the service reports, so it is
/// asked on a timer and the store is told when the set changes.
@MainActor
final class SwarmaDirectory {
    private let client: SwarmaClient
    private weak var store: UsageStore?
    private let interval: TimeInterval
    private var timer: Timer?
    private var registered: [String] = []
    private var syncing = false

    private(set) var isEnabled = false

    /// Whether harness cells exist. A change is applied by the next sync.
    var showsChats = true {
        didSet { if showsChats != oldValue { sync() } }
    }

    /// Whether task updates are reported. Turning it off forgets the baseline,
    /// so re-enabling records the current state and announces nothing.
    var announcesUpdates = true {
        didSet { if !announcesUpdates { previous = nil; announced = [] } }
    }
    /// Told once per task start/finish/failure, with the answer excerpt and reason when known.
    var onUpdate: ((SwarmaUpdate, SwarmaTaskDetail?) -> Void)?
    private var previous: SwarmaStatus?
    private var announced: Set<String> = []

    /// Told once each time the recommended vendor changes.
    var onRoutingChange: ((SwarmaRoutingChange) -> Void)?
    private lazy var routingWatcher = SwarmaRoutingWatcher { [weak self] in self?.onRoutingChange?($0) }

    private let teams: SwarmaTeamsClient

    init(client: SwarmaClient = .shared, store: UsageStore, interval: TimeInterval = 15) {
        self.client = client
        self.teams = SwarmaTeamsClient(base: client)
        self.store = store
        self.interval = interval
    }

    func setEnabled(_ enabled: Bool) {
        guard enabled != isEnabled else { return }
        isEnabled = enabled
        timer?.invalidate()
        timer = nil
        guard enabled else {
            previous = nil; announced = []
            registered = []
            store?.registerSwarmProviders([])
            return
        }
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sync() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        sync()
    }

    /// Ask the service, then register or refresh. Cells already on screen are
    /// kept when the service goes quiet; they flip to offline by refreshing.
    func sync() {
        guard isEnabled, !syncing else { return }
        syncing = true
        Task { [weak self] in
            guard let self else { return }
            let result: Result<SwarmaStatus, Error>
            do { result = .success(try await client.status()) } catch { result = .failure(error) }
            // Questions and swarms come from the teams tools; a service without them has neither.
            var questions: [TeamsQuestion] = [], swarms: [TeamsSwarm] = []
            if case .success = result {
                questions = (try? await teams.questionList()) ?? []
                swarms = (try? await teams.swarmList()) ?? []
            }
            finishSync(result, questions: questions, swarms: swarms)
        }
    }

    private func finishSync(_ result: Result<SwarmaStatus, Error>, questions: [TeamsQuestion] = [], swarms: [TeamsSwarm] = []) {
        syncing = false
        guard isEnabled, let store else { return }
        let providers: [UsageProvider]?
        switch result {
        case .success(let status):
            providers = Self.providers(for: status, client: client, showsChats: showsChats)
                + Self.teamsProviders(questions: questions, swarms: swarms, client: teams)
            routingWatcher.observe(status.routing)
            if announcesUpdates {
                let updates = SwarmaUpdates.diff(previous: previous, current: status, announced: &announced)
                previous = status
                announce(updates)
            }
        case .failure:
            // Nothing has ever answered: one cell, so the notch says it.
            // Otherwise the cells already up flip to offline on refresh.
            providers = registered.isEmpty ? [SwarmAgentProvider(name: SwarmaCells.serviceName, client: client)] : nil
        }
        if let providers, providers.map(\.id) != registered {
            registered = providers.map(\.id)
            store.registerSwarmProviders(providers)
        } else {
            store.refreshSwarm()
        }
    }

    private func announce(_ updates: [SwarmaUpdate]) {
        guard !updates.isEmpty else { return }
        Task { [weak self] in
            for update in updates {
                guard let self else { return }
                let detail = update.kind == .started ? nil : try? await client.taskDetail(id: update.taskID)
                onUpdate?(update, detail)
            }
        }
    }

    nonisolated static func providers(for status: SwarmaStatus, client: SwarmaClient,
                                      showsChats: Bool = true) -> [UsageProvider] {
        // A worker gets a cell only while it runs a task: idle and offline workers are noise in the notch.
        status.workers.filter { !$0.running.isEmpty }.map(\.name).sorted().map { SwarmAgentProvider(name: $0, client: client) }
            + (showsChats ? SwarmaCells.activeHarnesses(in: status).map { SwarmHarnessProvider(harness: $0, client: client) } : [])
            // Only active swarms: a project gets a cell while it has queued, running or blocked work.
            // Finished work stays visible on the worker cells' activity cards.
            + status.scopes.filter { $0.queued + $0.running + $0.blocked > 0 }
                .map(\.scope).sorted().map { SwarmScopeProvider(scope: $0, client: client) }
            + (status.lessonsPending > 0 ? [SwarmLessonsProvider(client: client)] : [])
    }

    /// The questions cell and one cell per swarm waiting on you or blocked.
    nonisolated static func teamsProviders(questions: [TeamsQuestion], swarms: [TeamsSwarm],
                                           client: SwarmaTeamsClient) -> [UsageProvider] {
        (SwarmaCells.questionsCellID(questions).map { [SwarmQuestionsProvider(id: $0, client: client)] } ?? [])
            + SwarmaCells.notchSwarms(swarms).compactMap { s in
                SwarmaCells.swarmCellID(s).map { SwarmWaitingProvider(id: $0, swarm: s, client: client) }
            }
    }

    /// Cancel a task from a cell's menu, then look again so the cell shows it.
    func cancel(_ target: SwarmaCancelTarget) async {
        do {
            try await client.cancelTask(id: target.taskID, expectedVersion: target.version)
        } catch {
            let message = (error as? SwarmaClient.Failure)?.message ?? "unknown error"
            Log.usage.error("swarma cancel failed: \(message, privacy: .public)")
        }
        sync()
    }
}
