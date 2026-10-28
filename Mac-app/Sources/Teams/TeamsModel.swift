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

@MainActor
final class TeamsModel: ObservableObject {
    enum Phase: Equatable { case loading, ready, serviceTooOld, failed(String) }
    enum Pane: Hashable { case home, tasks, agents, flows, usage }

    @Published var phase: Phase = .loading
    @Published var pane: Pane = .home { didSet { if pane == .agents { markSelectedRead() } } }
    @Published var search = ""
    @Published private(set) var agents: [TeamsAgent] = []
    @Published private(set) var channels: [TeamsThread] = []
    @Published private(set) var sections: [TeamsSection] = []
    @Published private(set) var selectedThreadID: String?
    @Published private(set) var messages: [String: [TeamsMessage]] = [:]
    @Published private(set) var hasOlder: [String: Bool] = [:]
    @Published private(set) var badges = TeamsBadges()
    @Published private(set) var previews: [String: TeamsPreview] = [:]
    @Published private(set) var swarms: [String: TeamsSwarm] = [:]
    @Published private(set) var openSwarms: [TeamsSwarm] = []
    @Published private(set) var openQuestions: [TeamsQuestion] = []
    @Published private(set) var status: SwarmaStatus?
    @Published var detailSwarmID: String?
    @Published var error: String?
    /// "Needs you", newest first, as `attention_list` sends it.
    @Published private(set) var attention: [TeamsAttentionItem] = []
    @Published private(set) var workingTasks: [TeamsTask] = []
    @Published private(set) var resolvedTasks: [TeamsTask] = []
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
    @Published private(set) var sendingThreads: Set<String> = []
    @Published private(set) var savingRunners: Set<String> = []
    @Published private(set) var threadErrors: [String: String] = [:]
    @Published private(set) var loadingThreads: Set<String> = []
    @Published private(set) var swarmErrors: [String: String] = [:]
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var staleError: String?
    @Published private(set) var streamState = "Connecting"
    @Published var targetQuestionID: String?
    @Published var creatingAgent = false
    struct PendingSend: Equatable {
        let body: String
        let key: String
    }
    var threadIsVisible: Bool { isVisible && pane == .agents }
    private var hasLoaded = false
    private var refreshing = false
    private var taskRefresh: Task<Void, Never>?
    private var taskRefreshNeeded = false
    private var taskRefreshScopes: Set<String>? = []
    private var loadingTasks = false
    private var pendingReads: Set<String> = []

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
        do { channels = try await client.threadList(kind: "channel").filter { !$0.archived } }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        do { openSwarms = try await client.swarmList() }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        for s in openSwarms { swarms[s.id] = s }
        do { openQuestions = try await client.questionList() }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        do { status = try await client.status() }
        catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
        await loadTasks()
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
        do {
            let nextAttention = try await client.attentionList()
            // Retain other scopes during a scoped stream refresh. Missing scope
            // metadata uses the full-refresh path for older services.
            var working = scopes.map { selected in workingTasks.filter { !selected.contains($0.scope ?? "") } } ?? []
            var resolved = scopes.map { selected in resolvedTasks.filter { !selected.contains($0.scope ?? "") } } ?? []
            for scope in (status?.scopes ?? []).map(\.scope) where scopes == nil || scopes!.contains(scope) {
                working += try await client.taskList(scope: scope, status: "running")
                working += try await client.taskList(scope: scope, status: "queued")
                resolved += try await client.taskList(scope: scope, resolved: true)
            }
            attention = nextAttention
            workingTasks = working; resolvedTasks = resolved
        } catch { staleError = SwarmaTeamsClient.Failure.map(error).message }
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
            } while taskRefreshNeeded && !Task.isCancelled
            taskRefresh = nil
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
        if messages[t] == nil { await loadLatest(t) }
        select(threadID: t)
        if item.kind == "question" { targetQuestionID = item.id }
        if item.kind == "swarm" { detailSwarmID = item.id }
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

    func select(threadID: String?) {
        selectedThreadID = threadID
        pane = .agents
        guard let threadID else { return }
        Task {
            if messages[threadID] == nil { await loadLatest(threadID) }
            markSelectedRead()
        }
    }

    func loadLatest(_ threadID: String) async {
        guard loadingThreads.insert(threadID).inserted else { return }
        threadErrors[threadID] = nil
        defer { loadingThreads.remove(threadID) }
        do {
            let page = try await client.threadRead(id: threadID, limit: 50)
            merge(page.messages, into: threadID)
            hasOlder[threadID] = page.hasMore ?? (page.messages.count == 50)
            markSelectedRead()
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
        guard threadIsVisible, let t = selectedThreadID, let seq = messages[t]?.last?.seq,
              seq > (markedSeq[t] ?? -1), pendingReads.insert(t).inserted else { return }
        Task {
            defer { pendingReads.remove(t) }
            do {
                try await client.threadMarkRead(id: t, seq: seq)
                markedSeq[t] = seq
                // A later unseen message must survive this acknowledgment.
                if seq >= (badges.lastSeq[t] ?? 0) { badges.read(threadID: t) }
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
            markSelectedRead()
            return true
        } catch {
            self.error = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
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

    func stopStream() { streamTask?.cancel(); streamTask = nil }

    func apply(_ event: TeamsEvent) async {
        switch event.name {
        case "message.created", "message.updated":
            guard let t = event.threadID else { return }
            let isOpen = t == selectedThreadID && threadIsVisible
            if event.name == "message.created",
               !badges.created(threadID: t, seq: event.seq, authorKind: nil, isOpen: false) { return }
            // Bodies never ride the stream: fetch the one message, or the tail.
            do {
                var after = event.name == "message.updated" ? event.seq.map { $0 - 1 } : messages[t]?.last?.seq
                for pageIndex in 0..<100 {
                    let page = try await client.threadRead(id: t, afterSeq: after, limit: 50)
                    if messages[t] != nil { merge(page.messages, into: t) }
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
            } catch { threadErrors[t] = SwarmaTeamsClient.Failure.map(error).message }
            if isOpen { markSelectedRead() }
        case "swarm.updated":
            guard let id = event.subjectID else { return }
            guard let s = try? await client.swarmGet(id: id) else { return }
            swarms[id] = s
            if ["done", "cancelled"].contains(s.status) { openSwarms.removeAll { $0.id == id } }
            else if let i = openSwarms.firstIndex(where: { $0.id == id }) { openSwarms[i] = s }
            else { openSwarms.append(s) }
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
            scheduleTaskRefresh(scope: event.scope)
        case "thread.read":
            // Stream events do not prove they belong to this principal. Only our
            // successful mark-read response (or authenticated refresh) clears badges.
            break
        default: break
        }
    }
}
