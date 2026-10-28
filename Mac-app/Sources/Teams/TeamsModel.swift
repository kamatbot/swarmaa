import AppKit
import Foundation
import SwiftUI

/// Unread badges per thread, kept idempotent against the stream: a replayed
/// `message.created` (same or older seq) never counts twice.
struct TeamsBadges: Equatable {
    private(set) var unread: [String: Int] = [:]
    private(set) var lastSeq: [String: Int] = [:]

    mutating func seed(threadID: String, unread count: Int, lastSeq seq: Int?) {
        unread[threadID] = count
        if let seq { lastSeq[threadID] = max(lastSeq[threadID] ?? 0, seq) }
    }

    /// A new message in `threadID`. Returns false for one already seen. The
    /// open thread, and the viewer's own posts, never raise the badge.
    @discardableResult
    mutating func created(threadID: String, seq: Int?, authorKind: String?, isOpen: Bool) -> Bool {
        if let seq {
            if let known = lastSeq[threadID], seq <= known { return false }
            lastSeq[threadID] = seq
        }
        if !isOpen, authorKind != "human" { unread[threadID, default: 0] += 1 }
        return true
    }

    mutating func read(threadID: String) { unread[threadID] = 0 }

    func count(_ threadID: String?) -> Int { threadID.flatMap { unread[$0] } ?? 0 }
}

/// One sidebar row: an agent (its main thread) or a channel.
struct TeamsRow: Identifiable, Equatable {
    let id: String
    let threadID: String?
    let name: String
    let role: String?
    let avatarSeed: String
    let isChannel: Bool
    let status: String?
    let preview: String
    let time: Date?
    let unread: Int
}


/// Consecutive working notes only; cards, answers and incomplete history stay visible.
struct TeamsThreadRow: Identifiable {
    let messages: [TeamsMessage]
    var id: String { messages[0].id }
    var folded: Bool { messages.count > 1 }
    var label: String {
        guard let first = messages[0].createdAt, let last = messages[messages.count - 1].createdAt else { return "Worked · \(messages.count) steps" }
        let seconds = Int(max(0, last.timeIntervalSince(first)))
        let duration = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m"
        return "Worked for \(duration) · \(messages.count) steps"
    }
}

func teamsThreadRows(_ messages: [TeamsMessage]) -> [TeamsThreadRow] {
    // A loaded human message and a later final reply bound each fold. Do not hide a live tail.
    var replyAhead = Array(repeating: false, count: messages.count)
    var hasReply = false
    for i in messages.indices.reversed() {
        let message = messages[i]
        if message.isHuman { hasReply = false }
        else if message.kind.rawValue == "text" && message.author.kind == "agent" { hasReply = true }
        replyAhead[i] = hasReply
    }
    var rows: [TeamsThreadRow] = [], pending: [TeamsMessage] = []
    var hasHuman = false
    func flush() {
        if !pending.isEmpty { rows.append(TeamsThreadRow(messages: pending)); pending = [] }
    }
    for (i, message) in messages.enumerated() {
        let kind = message.kind.rawValue
        let note = !message.isHuman && (kind == "notice" || kind == "handoff" || (kind == "text" && message.author.kind == "system"))
        if hasHuman && replyAhead[i] && note { pending.append(message) }
        else {
            flush()
            rows.append(TeamsThreadRow(messages: [message]))
        }
        if message.isHuman { hasHuman = true }
    }
    flush()
    return rows
}

@MainActor
final class TeamsModel: ObservableObject {
    enum Phase: Equatable { case loading, ready, serviceTooOld, failed(String) }
    enum Pane: Hashable { case bots, tasks, usage }

    @Published var phase: Phase = .loading
    @Published var pane: Pane = .bots { didSet { if pane == .bots { markSelectedRead() } } }
    @Published var expandedWorkingNotes: [String: Set<String>] = [:]
    @Published var search = ""
    @Published private(set) var agents: [TeamsAgent] = []
    @Published private(set) var channels: [TeamsThread] = []
    @Published private(set) var sections: [TeamsSection] = []
    @Published private(set) var selectedThreadID: String?
    @Published private(set) var messages: [String: [TeamsMessage]] = [:]
    @Published private(set) var hasOlder: [String: Bool] = [:]
    /// `thread_read`'s `typing` per thread: running turns' replies so far.
    @Published private(set) var typing: [String: [TeamsTyping]] = [:]
    @Published private(set) var badges = TeamsBadges()
    @Published private(set) var previews: [String: TeamsPreview] = [:]
    @Published private(set) var swarms: [String: TeamsSwarm] = [:]
    @Published private(set) var openSwarms: [TeamsSwarm] = []
    @Published private(set) var openQuestions: [TeamsQuestion] = []
    @Published private(set) var status: SwarmaStatus?
    /// The app's own account readings (Settings → accounts). Accounts no worker
    /// reports, such as Grokbot, still belong on the Usage pane.
    @Published var localUsage: [ProviderSnapshot] = []
    /// Worker-reported quota first, then local-only accounts.
    var allUsage: [SwarmaStatus.Usage] {
        let reported = status?.usage ?? []
        // The local Antigravity account is "gemini"; workers report it as "antigravity".
        let seen = Set(reported.map(\.provider))
        let extra = localUsage.filter { $0.kind == .usage && !seen.contains($0.id == "gemini" ? "antigravity" : $0.id) }.map { s in
            SwarmaStatus.Usage(provider: s.id, ok: s.headline != nil,
                headroom: s.headline?.usedFraction.map { max(0, min(100, (1 - $0) * 100)) },
                windows: s.windows.map { .init(name: $0.label, usedPercent: $0.usedFraction.map { $0 * 100 }, resetsAt: $0.resetsAt) },
                plan: s.plan, error: nil, fetchedAt: nil)
        }
        return reported + extra
    }
    @Published var detailSwarmID: String?
    @Published var error: String?
    /// The New bot sheet's own error: the window's alert sits behind the sheet.
    @Published var botError: String?
    /// "Needs you", newest first, as `attention_list` sends it.
    @Published private(set) var attention: [TeamsAttentionItem] = []
    @Published private(set) var workingTasks: [TeamsTask] = []
    @Published private(set) var resolvedTasks: [TeamsTask] = []
    @Published private(set) var resolvedCursors: [String: String] = [:]
    @Published private(set) var loadingResolved = false
    /// Review rows whose `git log` has been copied, so they offer Mark resolved.
    @Published private(set) var reviewed: Set<String> = []
    @Published private(set) var busyTasks: Set<String> = []
    /// `question_answer` answered 403 `owner_required`.
    @Published private(set) var answeringBlocked = false
    @Published private(set) var setupRows: [TeamsSetupRow] = []
    @Published private(set) var checkingSetup = false
    @Published var showSetup = false
    @Published var taskSearch = ""
    @Published var taskSort = TeamsTaskSort.newest
    @Published var drafts: [String: String] = [:]
    @Published private(set) var pendingSends: [String: PendingSend] = [:]
    @Published private(set) var rejectedSends: [String: PendingSend] = [:]
    @Published private(set) var sendErrors: [String: String] = [:]
    @Published private(set) var sendingThreads: Set<String> = []
    @Published private(set) var savingRunners: Set<String> = []
    @Published private(set) var threadErrors: [String: String] = [:]
    @Published private(set) var loadingThreads: Set<String> = []
    @Published private(set) var staleThreads: Set<String> = []
    @Published private(set) var swarmErrors: [String: String] = [:]
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var staleError: String?
    @Published private(set) var streamState = "Connecting"
    @Published var targetQuestionID: String?
    @Published var creatingAgent = false
    @Published var creatingBot = false
    /// Bot settings open over the thread pane.
    @Published var editingBotID: String?
    @Published private(set) var bots: [TeamsBot] = []
    /// Whether the bot list's collapsed "Hidden" section is open. Hidden bots are always loaded.
    @Published var showHiddenBots = false {
        didSet {
            if !showHiddenBots, selectedBot?.archived == true || bot(id: editingBotID)?.archived == true {
                select(threadID: nil)
            }
        }
    }
    private var botListGeneration = 0
    /// False while the service has no `bot_list`: agents stand in as one-member bots.
    @Published private(set) var botsSupported = true
    @Published private(set) var savingBot = false
    struct PendingSend: Equatable {
        let body: String
        let key: String
    }
    var threadIsVisible: Bool { isVisible && pane == .bots && editingBotID == nil }
    private var hasLoaded = false
    private var refreshing = false
    private var taskRefresh: Task<Void, Never>?
    private var taskRefreshNeeded = false
    private var taskRefreshScopes: Set<String>? = []
    private var loadingTasks = false
    private var pendingReads: Set<String> = []
    private var typingFetches: Set<String> = []

    /// Set by the window: marking read only counts while it is on screen.
    var isVisible = false { didSet { if isVisible { markSelectedRead() } } }

    private let client: SwarmaTeamsClient
    private var streamTask: Task<Void, Never>?
    private var loadingOlder: Set<String> = []
    private var markedSeq: [String: Int] = [:]

    init(client: SwarmaTeamsClient = .shared) { self.client = client }

    // MARK: Reading

    func agent(id: String?) -> TeamsAgent? { id.flatMap { id in agents.first { $0.id == id } } }
    func agent(threadID: String?) -> TeamsAgent? { threadID.flatMap { t in agents.first { $0.mainThreadID == t } } }
    func channel(threadID: String?) -> TeamsThread? { threadID.flatMap { t in channels.first { $0.id == t } } }

    var isEmpty: Bool { agents.isEmpty && channels.isEmpty }

    func row(for itemID: String) -> TeamsRow? {
        if let a = agent(id: itemID) {
            let t = a.mainThreadID
            let p = t.flatMap { previews[$0] } ?? a.lastMessage
            return TeamsRow(id: a.id, threadID: t, name: a.name, role: a.role, avatarSeed: a.avatar ?? a.id,
                            isChannel: false, status: a.status, preview: p?.body ?? "", time: p?.createdAt,
                            unread: badges.count(t))
        }
        if let c = channels.first(where: { $0.id == itemID }) {
            let p = previews[c.id] ?? c.lastMessage
            return TeamsRow(id: c.id, threadID: c.id, name: c.name ?? L10n.t("Channel"), role: nil, avatarSeed: c.id,
                            isChannel: true, status: nil, preview: p?.body ?? "", time: p?.createdAt,
                            unread: badges.count(c.id))
        }
        return nil
    }

    /// The user's sections, then whatever none of them lists.
    var visibleSections: [(section: TeamsSection, rows: [TeamsRow])] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        let listed = Set(sections.flatMap(\.items))
        var all = sections.sorted { $0.order < $1.order }
        let looseAgents = agents.map(\.id).filter { !listed.contains($0) }
        let looseChannels = channels.map(\.id).filter { !listed.contains($0) }
        if !looseAgents.isEmpty { all.append(TeamsSection(id: "_agents", name: L10n.t("Agents"), order: .max, items: looseAgents)) }
        if !looseChannels.isEmpty { all.append(TeamsSection(id: "_channels", name: L10n.t("Channels"), order: .max, items: looseChannels)) }
        return all.compactMap { section in
            let rows = section.items.compactMap(row(for:)).filter {
                query.isEmpty || $0.name.lowercased().contains(query) || ($0.role?.lowercased().contains(query) ?? false)
            }
            return rows.isEmpty && !query.isEmpty ? nil : (section, rows)
        }
    }

    /// Runner choices: Auto, then each routed provider at three efforts.
    var runnerProviders: [SwarmaStatus.Routing.Provider] { status?.routing?.providers ?? [] }

    // MARK: Loading

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        staleError = nil
        if !hasLoaded { phase = .loading }
        do {
            let (agents, sections) = try await client.agentList()
            self.agents = agents.filter { !$0.archived }
            self.sections = sections ?? []
            hasLoaded = true
        } catch {
            let failure = SwarmaTeamsClient.Failure.map(error)
            staleError = failure.message
            phase = hasLoaded ? .ready : (failure == .serviceTooOld ? .serviceTooOld : .failed(failure.message))
            stopStream()
            return
        }
        // Channels, swarms and questions arrive with a later service phase: a
        // service that has agents but not those still gets a working window.
        // Independent calls run at once: through the tunnel each is a round trip.
        async let channelList = client.threadList(kind: "channel")
        async let swarmList = client.swarmList()
        async let questionList = client.questionList()
        async let statusNow = client.status()
        async let botsLoaded: Void = loadBots()
        do { channels = try await channelList.filter { !$0.archived } }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        do { openSwarms = try await swarmList }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        for s in openSwarms { swarms[s.id] = s }
        do { openQuestions = try await questionList }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        do { status = try await statusNow }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        // Tasks need the scopes from `status`.
        await loadTasks()
        await botsLoaded
        for a in agents { if let t = a.mainThreadID { seed(t, a.unread, a.lastSeq, a.lastReadSeq, a.lastMessage) } }
        for c in channels { seed(c.id, c.unread, c.lastSeq, c.lastReadSeq, c.lastMessage) }
        phase = .ready
        if staleError == nil { lastUpdated = Date() }
        if let selectedThreadID { await loadLatest(selectedThreadID) }
        startStream()
    }

    private func seed(_ thread: String, _ unread: Int?, _ last: Int?, _ read: Int?, _ preview: TeamsPreview?) {
        badges.seed(threadID: thread, unread: TeamsUnread.count(unread: unread, lastSeq: last, lastReadSeq: read),
                    lastSeq: last)
        if let preview { previews[thread] = preview }
    }

    // MARK: Bots

    /// Bots with something new first (needs you, then unread), then the rest by last activity.
    var sortedBots: [TeamsBot] {
        return TeamsBotList.filter(bots, showHidden: false, search: search)
            .sorted {
                let a = botNeedsYou($0), b = botNeedsYou($1)
                if a != b { return a > b }
                let ua = botUnread($0), ub = botUnread($1)
                if (ua > 0) != (ub > 0) { return ua > 0 }
                return (botLatest($0)?.at ?? .distantPast) > (botLatest($1)?.at ?? .distantPast)
            }
    }

    /// Hidden bots for the list's "Hidden" section, by name.
    var hiddenBots: [TeamsBot] {
        TeamsBotList.filter(bots, showHidden: true, search: search).filter(\.archived)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func botUnread(_ bot: TeamsBot) -> Int { max(badges.count(bot.threadID), bot.badges.unread) }
    func botNeedsYou(_ bot: TeamsBot) -> Int { bot.badges.needsYou }
    func botHasUpdates(_ bot: TeamsBot) -> Bool { botNeedsYou(bot) > 0 || botUnread(bot) > 0 }
    func botLatest(_ bot: TeamsBot) -> TeamsBot.Badges.Latest? {
        if bot.badges.needsYou == 0, let p = previews[bot.threadID], let body = p.body, !body.isEmpty {
            return TeamsBot.Badges.Latest(kind: p.kind, line: body, at: p.createdAt)
        }
        return bot.badges.latest
    }
    var botsWithUpdates: Int { bots.filter { !$0.archived && botHasUpdates($0) }.count }

    func bot(threadID: String?) -> TeamsBot? { threadID.flatMap { t in bots.first { $0.threadID == t } } }
    func bot(id: String?) -> TeamsBot? { id.flatMap { id in bots.first { $0.id == id } } }
    var selectedBot: TeamsBot? { bot(threadID: selectedThreadID) }
    func crew(_ bot: TeamsBot) -> [TeamsAgent] { bot.crewIDs.compactMap { agent(id: $0) } }

    func loadBots() async {
        botListGeneration += 1
        let generation = botListGeneration
        do {
            let loaded = try await client.botList(includeArchived: true)
            guard generation == botListGeneration else { return }
            bots = loaded
            botsSupported = true
        } catch {
            let failure = SwarmaTeamsClient.Failure.map(error)
            guard generation == botListGeneration else { return }
            guard failure == .serviceTooOld else { staleError = failure.message; return }
            botsSupported = false
            bots = agents.filter { $0.mainThreadID != nil }.map {
                TeamsBot(legacy: $0, unread: badges.count($0.mainThreadID), preview: previews[$0.mainThreadID ?? ""] ?? $0.lastMessage)
            }
        }
        if selectedThreadID == nil, let first = sortedBots.first { select(threadID: first.threadID) }
    }

    #if DEBUG
    func setBotsForTesting(_ bots: [TeamsBot]) { self.bots = bots }
    /// Snapshot renders and previews: example data, no service.
    func loadFixture(agents: [TeamsAgent], bots: [TeamsBot], messages: [String: [TeamsMessage]],
                     status: SwarmaStatus?, attention: [TeamsAttentionItem] = [], select threadID: String?) {
        self.agents = agents; self.bots = bots; self.messages = messages; self.status = status
        self.attention = attention
        for (t, list) in messages { if let last = list.last { previews[t] = TeamsPreview(body: last.preview, createdAt: last.createdAt) } }
        selectedThreadID = threadID
        streamState = "Live"
        phase = .ready
    }
    #endif

    /// `bot_list` carries no `routing_now`; the settings pane fetches it with `bot_get`.
    func refreshBot(_ id: String) async {
        guard botsSupported, let fresh = try? await client.botGet(id: id) else { return }
        replaceBot(fresh)
    }

    private func replaceBot(_ bot: TeamsBot) {
        if let i = bots.firstIndex(where: { $0.id == bot.id }) { bots[i] = bot } else { bots.append(bot) }
    }

    func saveBot(_ bot: TeamsBot, name: String, job: String, leadAgentID: String, memberAgentIDs: [String],
                 routing: TeamsBotRouting, rules: TeamsBotRules, schedule: String?) async -> Bool {
        guard bot.isLegacyAgent == false, let version = bot.version else {
            error = L10n.t("Update the Swarmaa service to configure bots")
            return false
        }
        savingBot = true
        defer { savingBot = false }
        do {
            replaceBot(try await client.botUpdate(id: bot.id, expectedVersion: version, name: name, job: job,
                                                  leadAgentID: leadAgentID, memberAgentIDs: memberAgentIDs,
                                                  routing: routing, rules: rules, schedule: schedule))
            return true
        } catch {
            self.error = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
    }

    @discardableResult
    func setBotHidden(_ bot: TeamsBot, hidden: Bool) async -> Bool {
        guard !bot.isLegacyAgent, !savingBot else { return false }
        savingBot = true
        defer { savingBot = false }
        do {
            let fresh = try await (hidden ? client.botArchive(id: bot.id) : client.botUnarchive(id: bot.id))
            botListGeneration += 1 // An older list response must not undo this write.
            replaceBot(fresh)
            if hidden { select(threadID: nil) }
            return true
        } catch {
            self.error = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
    }

    func deleteBot(_ bot: TeamsBot, confirmName: String) async -> Bool {
        guard !bot.isLegacyAgent, confirmName == bot.name, !savingBot else { return false }
        savingBot = true
        botError = nil
        defer { savingBot = false }
        do {
            // The service deletes only hidden bots; hide it first when deleting straight from settings.
            if !bot.archived { replaceBot(try await client.botArchive(id: bot.id)) }
            try await client.botDelete(id: bot.id, confirmName: confirmName)
            botListGeneration += 1
            bots.removeAll { $0.id == bot.id }
            if selectedThreadID == bot.threadID || editingBotID == bot.id { select(threadID: nil) }
            messages[bot.threadID] = nil
            drafts[bot.threadID] = nil
            typing[bot.threadID] = nil
            previews[bot.threadID] = nil
            return true
        } catch {
            botError = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
    }

    /// A bot needs a lead: an existing agent, or a new one made for it from the bot's job.
    /// `onLeadCreated` hands back a lead made here, so a retry after a failed `bot_create` reuses it
    /// instead of colliding with its name. Errors go to `botError`, shown in the sheet.
    func createBot(name: String, job: String, scope: String, leadAgentID: String?, memberAgentIDs: [String],
                   onLeadCreated: (String) -> Void = { _ in }) async -> Bool {
        savingBot = true
        botError = nil
        defer { savingBot = false }
        do {
            var lead = leadAgentID
            if lead == nil {
                let agent = try await client.agentCreate(name: name, role: L10n.t("Lead"), instructions: job,
                                                         scope: scope, runner: .auto, edits: false)
                replace(agent)
                lead = agent.id
                onLeadCreated(agent.id)
            }
            guard botsSupported else {
                await loadBots()
                if let a = agent(id: lead), let t = a.mainThreadID { select(threadID: t) }
                return true
            }
            let bot = try await client.botCreate(name: name, job: job, scope: scope, leadAgentID: lead!,
                                                 memberAgentIDs: memberAgentIDs, routing: TeamsBotRouting(), rules: TeamsBotRules())
            replaceBot(bot)
            select(threadID: bot.threadID)
            return true
        } catch {
            botError = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
    }

    // MARK: Needs you and Tasks

    var taskRows: [TeamsTaskRow] {
        TeamsTaskGrouping.rows(attention: attention, working: workingTasks, resolved: resolvedTasks)
    }

    /// `attention_list`, plus each scope's running and resolved tasks
    /// (`task_list` wants a scope). A service without them leaves them empty.
    func loadTasks(scopes: Set<String>? = nil) async {
        guard !loadingTasks else { return }
        loadingTasks = true
        defer { loadingTasks = false }
        async let attentionNow = client.attentionList()
        // (scope, "running" | "queued"), or (scope, nil) for the resolved page.
        let jobs: [(String, String?)] = (status?.scopes ?? []).map(\.scope).filter { scopes == nil || scopes!.contains($0) }
            .flatMap { scope -> [(String, String?)] in [(scope, "running"), (scope, "queued"), (scope, nil)] }
        let client = self.client
        await withTaskGroup(of: TaskPage.self) { group in
            func add(_ job: (String, String?)) {
                group.addTask {
                    let (scope, state) = job
                    do {
                        if let state { return TaskPage(scope: scope, state: state, tasks: try await client.taskList(scope: scope, status: state)) }
                        let page = try await client.resolvedTaskPage(scope: scope)
                        return TaskPage(scope: scope, state: nil, tasks: page.tasks, next: page.next)
                    } catch { return TaskPage(scope: scope, state: state, error: error) }
                }
            }
            var pending = jobs[...]
            // At most 8 `task_list` calls in flight.
            for _ in 0..<8 { if let job = pending.popFirst() { add(job) } }
            for await page in group {
                if let job = pending.popFirst() { add(job) }
                let scope = page.scope
                if let error = page.error { staleError = SwarmaTeamsClient.Failure.map(error).message }
                else if let state = page.state {
                    workingTasks.removeAll { $0.scope == scope && $0.status == state }
                    workingTasks += page.tasks
                } else {
                    resolvedTasks.removeAll { $0.scope == scope }
                    resolvedTasks += page.tasks
                    resolvedCursors[scope] = page.next
                }
            }
        }
        do { attention = try await attentionNow }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
    }

    /// One `task_list` answer. A plain struct, not a tuple holding a `Result`:
    /// that child type came back from `group.next()` uninitialized in Release
    /// builds (ASan: 0xbe bytes), crashing launch in `TaskGroup::offer`.
    private struct TaskPage {
        let scope: String, state: String?
        var tasks: [TeamsTask] = [], next: String? = nil, error: Error? = nil
    }

    func loadMoreResolved() async {
        guard !loadingResolved, !loadingTasks else { return }
        loadingResolved = true
        loadingTasks = true
        defer { loadingResolved = false; loadingTasks = false }
        for (scope, cursor) in resolvedCursors {
            do {
                let page = try await client.resolvedTaskPage(scope: scope, beforeID: cursor)
                let known = Set(resolvedTasks.map(\.id))
                resolvedTasks += page.tasks.filter { !known.contains($0.id) }
                guard page.next != cursor else { throw SwarmaClient.Failure.badResponse }
                resolvedCursors[scope] = page.next
            } catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        }
    }

    private var botRefresh: Task<Void, Never>?
    /// Coalesced `bot_list` for message events: badges and previews, no task lists.
    private func scheduleBotRefresh() {
        guard botRefresh == nil else { return }
        botRefresh = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            await self?.loadBots()
            self?.botRefresh = nil
        }
    }

    private func scheduleTaskRefresh(scope: String?) {
        taskRefreshNeeded = true
        if let scope { taskRefreshScopes?.insert(scope) }
        else { taskRefreshScopes = nil }
        guard taskRefresh == nil else { return }
        taskRefresh = Task { [weak self] in
            guard let self else { return }
            repeat {
                try? await Task.sleep(for: .milliseconds(250))
                // A manual refresh may still be fetching; don't discard its
                // trailing stream event just because that request is in flight.
                if loadingTasks { continue }
                taskRefreshNeeded = false
                let scopes = taskRefreshScopes
                taskRefreshScopes = []
                await loadTasks(scopes: scopes)
                await loadBots()
            } while taskRefreshNeeded && !Task.isCancelled
            taskRefresh = nil
        }
    }

    /// One task changed. Patch its cached row from the event's fields (or one `task_get` when they
    /// lack a status), and re-list its scope, with the bot badges, only when the task enters or
    /// leaves a list: submitted, resolved, finished, or not one we hold.
    private func taskUpdated(_ event: TeamsEvent) async {
        if let id = event.subjectID, let status = event.status, !["running", "queued"].contains(status) {
            for t in typing.keys { typing[t]?.removeAll { $0.taskID == id } }
        } else if event.kind == "turn", let t = event.threadID, t == selectedThreadID, threadIsVisible {
            scheduleTypingFetch(t)
        }
        guard let id = event.subjectID, event.action != "submitted", event.resolved == nil,
              workingTasks.contains(where: { $0.id == id }) else { return scheduleTaskRefresh(scope: event.scope) }
        var fresh: TeamsTask?
        if event.status == nil {
            guard let got = try? await client.taskGet(id: id) else { return scheduleTaskRefresh(scope: event.scope) }
            fresh = got
        }
        guard let status = fresh?.status ?? event.status, ["running", "queued"].contains(status),
              let i = workingTasks.firstIndex(where: { $0.id == id }) else { return scheduleTaskRefresh(scope: event.scope) }
        if let fresh { workingTasks[i] = fresh; return }
        workingTasks[i].status = status
        if let version = event.version { workingTasks[i].version = version }
        workingTasks[i].updatedAt = Date()
    }

    // MARK: Typing

    /// What shows as live reply bubbles: each running turn's text, until a message
    /// from that agent lands after it.
    func liveTyping(_ threadID: String) -> [TeamsTyping] {
        let list = messages[threadID] ?? []
        return (typing[threadID] ?? []).filter { entry in
            !list.contains { $0.author.kind == "agent" && $0.author.id == entry.agentID
                && ($0.createdAt ?? .distantPast) >= (entry.updatedAt ?? .distantFuture) }
        }
    }

    /// Newer services send `typing` with the tail; an older one sends nothing and keeps none.
    private func takeTyping(_ page: SwarmaTeamsClient.MessagePage, _ threadID: String) {
        if let list = page.typing { typing[threadID] = list }
    }

    /// A turn in the open thread moved: read the tail and its typing, at most every 300 ms.
    private func scheduleTypingFetch(_ t: String) {
        guard typingFetches.insert(t).inserted else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(300))
            typingFetches.remove(t)
            guard let page = try? await client.threadRead(id: t, afterSeq: messages[t]?.last?.seq, limit: 50) else { return }
            if messages[t] != nil { merge(page.messages, into: t) }
            takeTyping(page, t)
            markSelectedRead()
        }
    }

    /// The thread an attention item opens: its own, else the question's or swarm's.
    func threadID(for item: TeamsAttentionItem) -> String? {
        item.threadID ?? openQuestions.first { $0.id == item.id }?.threadID
            ?? (swarms[item.id] ?? openSwarms.first { $0.id == item.id })?.threadID
    }

    func open(_ item: TeamsAttentionItem) async {
        if item.kind == "swarm", threadID(for: item) == nil { await loadSwarm(item.id) }
        guard let t = threadID(for: item) else { error = L10n.t("This item has no thread to open"); return }
        await loadLatest(t)
        select(threadID: t, refreshHistory: false)
        if item.kind == "question" { targetQuestionID = item.id }
        if item.kind == "swarm" { detailSwarmID = item.id }
    }

    /// `open` has fetched the newest history. Search at most one older page.
    func findTargetQuestion(in threadID: String) async -> TeamsMessage? {
        guard selectedThreadID == threadID, let target = targetQuestionID else { return nil }
        defer {
            if selectedThreadID == threadID, targetQuestionID == target { targetQuestionID = nil }
        }
        func match() -> TeamsMessage? {
            messages[threadID]?.first { $0.question?.id == target || $0.ref?.questionID == target }
        }
        if match() == nil { await loadOlder(threadID) }
        guard selectedThreadID == threadID, targetQuestionID == target else { return nil }
        return match()
    }

    /// Copies `git log -p <branch>` and offers Mark resolved.
    func review(_ row: TeamsTaskRow) {
        guard let branch = row.branch else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("git log -p \(branch)", forType: .string)
        reviewed.insert(row.id)
    }

    /// Checks or unchecks a task's Resolved box. Returns whether it took.
    @discardableResult
    func resolve(_ taskID: String, _ resolved: Bool) async -> Bool {
        await withTask(taskID) { task in
            guard !["running", "queued"].contains(task.status) else { throw SwarmaClient.Failure.serviceCode("task_active") }
            try await self.client.taskResolve(id: taskID, resolved: resolved, expectedVersion: task.version ?? 0)
        }
    }

    @discardableResult
    func retry(_ taskID: String) async -> Bool {
        await withTask(taskID) { task in
            try await self.client.taskContinue(id: taskID, expectedVersion: task.version ?? 0,
                                               instruction: "Retry the task from where it stopped.")
        }
    }

    /// Fresh version from `task_get`, the write, then a reload.
    private func withTask(_ id: String, _ write: (TeamsTask) async throws -> Void) async -> Bool {
        guard busyTasks.insert(id).inserted else { return false }
        defer { busyTasks.remove(id) }
        do {
            try await write(try await client.taskGet(id: id))
        } catch {
            let failure = SwarmaTeamsClient.Failure.map(error)
            if failure == .service(.serviceCode("owner_required")) { answeringBlocked = true }
            self.error = "Task " + String(id.prefix(8)) + ": " + failure.message
            if failure == .service(.serviceCode("task_active")) { await loadTasks() }
            return false
        }
        await loadTasks()
        return true
    }

    func runSetup() async {
        checkingSetup = true
        setupRows = await TeamsSetup.check(client: client) { [weak self] rows in
            await MainActor.run { self?.setupRows = rows }
        }
        checkingSetup = false
    }

    func select(threadID: String?, refreshHistory: Bool = true) {
        if selectedThreadID != threadID { targetQuestionID = nil }
        if refreshHistory, let threadID { staleThreads.insert(threadID) }
        selectedThreadID = threadID
        pane = .bots
        editingBotID = nil
        guard let threadID else { return }
        Task {
            if refreshHistory { await loadLatest(threadID) }
            markSelectedRead()
        }
    }

    func loadLatest(_ threadID: String) async {
        guard loadingThreads.insert(threadID).inserted else { return }
        threadErrors[threadID] = nil
        defer { loadingThreads.remove(threadID); markSelectedRead() }
        do {
            if let last = messages[threadID]?.last?.seq {
                var after = last
                // Keep the contiguous cached prefix on failure so Retry resumes
                // at the last successfully fetched page, never across a gap.
                for index in 0..<100 {
                    try Task.checkCancellation()
                    let page = try await client.threadRead(id: threadID, afterSeq: after, limit: 50)
                    merge(page.messages, into: threadID)
                    takeTyping(page, threadID)
                    guard page.hasMore == true else { break }
                    guard let next = page.messages.last?.seq, next > after else { throw SwarmaClient.Failure.badResponse }
                    after = next
                    if index == 99 { throw SwarmaClient.Failure.badResponse }
                }
            } else {
                let page = try await client.threadRead(id: threadID, limit: 50)
                merge(page.messages, into: threadID)
                takeTyping(page, threadID)
                hasOlder[threadID] = page.hasMore ?? (page.messages.count == 50)
            }
            staleThreads.remove(threadID)
        } catch { threadErrors[threadID] = SwarmaTeamsClient.Failure.map(error).message }
    }

    /// Older history, on scroll-up to the top of what is loaded.
    func loadOlder(_ threadID: String) async {
        guard hasOlder[threadID] == true, !loadingOlder.contains(threadID),
              let first = messages[threadID]?.first else { return }
        loadingOlder.insert(threadID)
        defer { loadingOlder.remove(threadID) }
        do {
            let page = try await client.threadRead(id: threadID, beforeSeq: first.seq, limit: 50)
            merge(page.messages, into: threadID)
            hasOlder[threadID] = page.hasMore ?? (page.messages.count == 50)
        } catch { self.error = SwarmaTeamsClient.Failure.map(error).message }
    }

    private func merge(_ new: [TeamsMessage], into threadID: String) {
        var byID = Dictionary((messages[threadID] ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        for m in new {
            byID[m.id] = m
            if let s = m.swarm { swarms[s.id] = s }
        }
        let sorted = byID.values.sorted { $0.seq < $1.seq }
        messages[threadID] = sorted
        if let last = sorted.last {
            previews[threadID] = TeamsPreview(body: last.preview, kind: nil, createdAt: last.createdAt)
            badges.created(threadID: threadID, seq: last.seq, authorKind: "human", isOpen: true)
        }
    }

    func markSelectedRead() {
        guard threadIsVisible, let t = selectedThreadID, !loadingThreads.contains(t), !staleThreads.contains(t), threadErrors[t] == nil, let seq = messages[t]?.last?.seq,
              seq > (markedSeq[t] ?? -1), pendingReads.insert(t).inserted else { return }
        Task {
            defer { pendingReads.remove(t) }
            do {
                var through = seq
                while true {
                    try await client.threadMarkRead(id: t, seq: through)
                    markedSeq[t] = through
                    if through >= (badges.lastSeq[t] ?? 0) { badges.read(threadID: t) }
                    guard threadIsVisible, selectedThreadID == t,
                          !loadingThreads.contains(t), !staleThreads.contains(t), threadErrors[t] == nil,
                          let latest = messages[t]?.last?.seq, latest > through else { break }
                    through = latest
                }
            } catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        }
    }

    // A pending send owns its thread, text and key even while the editor changes.
    func sendDraft(threadID t: String) async -> Bool {
        guard !sendingThreads.contains(t) else { return false }
        let pending: PendingSend
        if let retry = pendingSends[t] { pending = retry }
        else {
            let text = (drafts[t] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return false }
            pending = PendingSend(body: text, key: UUID().uuidString)
            rejectedSends[t] = nil
            sendErrors[t] = nil
            pendingSends[t] = pending
            drafts[t] = ""
        }
        sendingThreads.insert(t)
        defer { sendingThreads.remove(t) }
        do {
            if let message = try await client.threadPost(id: t, body: pending.body, idempotencyKey: pending.key) {
                merge([message], into: t)
            }
            pendingSends[t] = nil
            sendErrors[t] = nil
            markSelectedRead()
            return true
        } catch {
            let failure = SwarmaTeamsClient.Failure.map(error)
            sendErrors[t] = failure.message
            switch failure {
            // Retryable with the same idempotency key: the post may already have landed (a timeout or an
            // undecodable 2xx), or the service asked us to slow down.
            case .service(.unreachable), .service(.badResponse): break
            case .service(.http(let code)) where (500..<600).contains(code) || code == 408 || code == 429: break
            default:
                rejectedSends[t] = pending
                pendingSends[t] = nil
            }
            return false
        }
    }

    func discardSend(_ t: String, edit: Bool = false) {
        guard !sendingThreads.contains(t) else { return }
        if edit, let failed = rejectedSends[t] ?? pendingSends[t] {
            let draft = drafts[t] ?? ""
            drafts[t] = failed.body + (draft.isEmpty ? "" : "\n" + draft)
        }
        rejectedSends[t] = nil
        pendingSends[t] = nil
        sendErrors[t] = nil
    }

    func answer(_ q: TeamsQuestion, choices: [String], text: String) async -> Bool {
        guard TeamsAnswerValidation.validate(q, choices: choices, text: text) == nil else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await client.questionAnswer(id: q.id, choices: choices, text: trimmed)
        } catch {
            // 403 `owner_required`: the card says how to fix it; no alert.
            if SwarmaTeamsClient.Failure.map(error) == .service(.serviceCode("owner_required")) { answeringBlocked = true }
            else { self.error = SwarmaTeamsClient.Failure.map(error).message }
            return false
        }
        answeringBlocked = false
        markAnswered(q.id, TeamsAnswer(choices: choices, text: trimmed.isEmpty ? nil : trimmed))
        return true
    }

    private func markAnswered(_ questionID: String, _ answer: TeamsAnswer?) {
        openQuestions.removeAll { $0.id == questionID }
        for (t, list) in messages {
            guard let i = list.firstIndex(where: { $0.question?.id == questionID }) else { continue }
            messages[t]?[i].question?.status = "answered"
            if let answer { messages[t]?[i].question?.answer = answer }
        }
    }

    func setRunner(_ runner: TeamsRunner, for agent: TeamsAgent) async {
        guard savingRunners.insert(agent.id).inserted else { return }
        defer { savingRunners.remove(agent.id) }
        guard let version = agent.version else { error = L10n.t("This agent can't be changed yet"); return }
        do { replace(try await client.agentUpdate(id: agent.id, expectedVersion: version, runner: runner)) }
        catch { self.error = SwarmaTeamsClient.Failure.map(error).message }
    }

    func createAgent(name: String, role: String, instructions: String, scope: String,
                     runner: TeamsRunner, edits: Bool) async -> Bool {
        do {
            let agent = try await client.agentCreate(name: name, role: role, instructions: instructions,
                                                     scope: scope, runner: runner, edits: edits)
            replace(agent)
            select(threadID: agent.mainThreadID)
            return true
        } catch {
            self.error = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
    }

    private func replace(_ agent: TeamsAgent) {
        if let i = agents.firstIndex(where: { $0.id == agent.id }) { agents[i] = agent } else { agents.append(agent) }
    }

    func loadSwarm(_ id: String) async {
        swarmErrors[id] = nil
        do { swarms[id] = try await client.swarmGet(id: id) }
        catch { swarmErrors[id] = SwarmaTeamsClient.Failure.map(error).message }
    }

    // MARK: Live updates

    func startStream() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self, client] in
            do {
                for try await event in client.stream(onState: { [weak self] state in
                    Task { @MainActor in self?.streamState = state }
                }) { await self?.apply(event) }
            } catch {
                let failure = SwarmaTeamsClient.Failure.map(error)
                self?.streamState = failure.message
                self?.staleError = failure.message
            }
            self?.streamTask = nil
        }
    }

    /// The banner's Retry: reconnect the stream now (skipping its backoff) and reload.
    func retryConnection() async {
        stopStream()
        streamState = "Connecting"
        startStream()
        await refresh()
    }

    func stopStream() {
        streamTask?.cancel(); streamTask = nil
        staleThreads.formUnion(messages.keys)
    }

    func apply(_ event: TeamsEvent) async {
        switch event.name {
        case "message.created", "message.updated":
            guard let t = event.threadID else { return }
            let isOpen = t == selectedThreadID && threadIsVisible
            if event.name == "message.created",
               !badges.created(threadID: t, seq: event.seq, authorKind: event.authorKind, isOpen: isOpen) { return }
            // Bodies never ride the stream: fetch the one message, or the tail.
            do {
                var after = event.name == "message.updated" ? event.seq.map { $0 - 1 } : messages[t]?.last?.seq
                for pageIndex in 0..<100 {
                    let page = try await client.threadRead(id: t, afterSeq: after, limit: 50)
                    if messages[t] != nil { merge(page.messages, into: t); takeTyping(page, t) }
                    else if let m = page.messages.last { previews[t] = TeamsPreview(body: m.preview, createdAt: m.createdAt) }
                    for m in page.messages where m.kind == .swarm && m.swarm == nil {
                        if let id = m.ref?.swarmID { await loadSwarm(id) }
                    }
                    guard isOpen, after != nil, event.name == "message.created", page.hasMore == true,
                          let last = page.messages.last?.seq, last > (after ?? -1) else { break }
                    guard !Task.isCancelled else { return }
                    if pageIndex == 99 { throw SwarmaClient.Failure.badResponse }
                    after = last
                }
                threadErrors[t] = nil
            } catch {
                // One failed event fetch is a connection problem, not a broken thread: keep the history on
                // screen and read receipts flowing, and say so in the offline banner.
                staleError = SwarmaTeamsClient.Failure.map(error).message
            }
            if isOpen { markSelectedRead() }
            // Only task cards and questions change the task lists; any other message only moves a bot's preview.
            if event.kind == nil || ["task", "question", "answer", "swarm"].contains(event.kind!) { scheduleTaskRefresh(scope: event.scope) }
            else if bot(threadID: t) != nil { scheduleBotRefresh() }
        case "swarm.updated":
            guard let id = event.subjectID else { return }
            guard let s = try? await client.swarmGet(id: id) else { return }
            swarms[id] = s
            if ["done", "cancelled"].contains(s.status) { openSwarms.removeAll { $0.id == id } }
            else if let i = openSwarms.firstIndex(where: { $0.id == id }) { openSwarms[i] = s }
            else { openSwarms.append(s) }
        case "bot.updated":
            scheduleTaskRefresh(scope: event.scope)
        case "agent.updated":
            guard let id = event.subjectID, let a = try? await client.agentGet(id: id) else { return }
            replace(a)
        case "question.created":
            openQuestions = (try? await client.questionList()) ?? openQuestions
            scheduleTaskRefresh(scope: event.scope)
        case "question.answered":
            if let id = event.subjectID { markAnswered(id, nil) }
            scheduleTaskRefresh(scope: event.scope)
        case "task.updated":
            await taskUpdated(event)
        case "thread.read":
            // Stream events do not prove they belong to this principal. Only our
            // successful mark-read response (or authenticated refresh) clears badges.
            break
        default: break
        }
    }
}
