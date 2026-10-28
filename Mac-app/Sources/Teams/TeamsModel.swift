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
    @Published var pane: Pane = .home
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
        if phase != .ready { phase = .loading }
        do {
            let (agents, sections) = try await client.agentList()
            self.agents = agents.filter { !$0.archived }
            self.sections = sections ?? []
        } catch {
            let failure = SwarmaTeamsClient.Failure.map(error)
            phase = failure == .serviceTooOld ? .serviceTooOld : .failed(failure.message)
            stopStream()
            return
        }
        // Channels, swarms and questions arrive with a later service phase: a
        // service that has agents but not those still gets a working window.
        channels = ((try? await client.threadList(kind: "channel")) ?? []).filter { !$0.archived }
        openSwarms = (try? await client.swarmList()) ?? []
        for s in openSwarms { swarms[s.id] = s }
        openQuestions = (try? await client.questionList()) ?? []
        status = try? await SwarmaClient.shared.status()
        await loadTasks()
        for a in agents { if let t = a.mainThreadID { seed(t, a.unread, a.lastSeq, a.lastReadSeq, a.lastMessage) } }
        for c in channels { seed(c.id, c.unread, c.lastSeq, c.lastReadSeq, c.lastMessage) }
        phase = .ready
        if let selectedThreadID { await loadLatest(selectedThreadID) }
        startStream()
    }

    private func seed(_ thread: String, _ unread: Int?, _ last: Int?, _ read: Int?, _ preview: TeamsPreview?) {
        let isOpen = thread == selectedThreadID && isVisible
        badges.seed(threadID: thread, unread: isOpen ? 0 : TeamsUnread.count(unread: unread, lastSeq: last, lastReadSeq: read),
                    lastSeq: last)
        if let preview { previews[thread] = preview }
    }

    // MARK: Needs you and Tasks

    var taskRows: [TeamsTaskRow] {
        TeamsTaskGrouping.rows(attention: attention, working: workingTasks, resolved: resolvedTasks)
    }

    /// `attention_list`, plus each scope's running and resolved tasks
    /// (`task_list` wants a scope). A service without them leaves them empty.
    func loadTasks() async {
        attention = (try? await client.attentionList()) ?? attention
        var working: [TeamsTask] = [], resolved: [TeamsTask] = []
        for scope in (status?.scopes ?? []).map(\.scope) {
            working += (try? await client.taskList(scope: scope, status: "running")) ?? []
            resolved += (try? await client.taskList(scope: scope, resolved: true)) ?? []
        }
        workingTasks = working; resolvedTasks = resolved
    }

    /// The thread an attention item opens: its own, else the question's or swarm's.
    func threadID(for item: TeamsAttentionItem) -> String? {
        item.threadID ?? openQuestions.first { $0.id == item.id }?.threadID
            ?? (swarms[item.id] ?? openSwarms.first { $0.id == item.id })?.threadID
    }

    func open(_ item: TeamsAttentionItem) async {
        if item.kind == "swarm", threadID(for: item) == nil { await loadSwarm(item.id) }
        guard let t = threadID(for: item) else { error = L10n.t("This item has no thread to open"); return }
        select(threadID: t)
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
            self.error = SwarmaTeamsClient.Failure.map(error).message
            return false
        }
        await loadTasks()
        return true
    }

    func runSetup() async {
        checkingSetup = true
        setupRows = await TeamsSetup.check(client: client)
        checkingSetup = false
    }

    func select(threadID: String?) {
        pane = .agents
        selectedThreadID = threadID
        guard let threadID else { return }
        Task {
            if messages[threadID] == nil { await loadLatest(threadID) }
            markSelectedRead()
        }
    }

    private func loadLatest(_ threadID: String) async {
        do {
            let page = try await client.threadRead(id: threadID, limit: 50)
            merge(page.messages, into: threadID)
            hasOlder[threadID] = page.hasMore ?? (page.messages.count == 50)
        } catch { self.error = SwarmaTeamsClient.Failure.map(error).message }
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
        guard isVisible, let t = selectedThreadID, let seq = messages[t]?.last?.seq else { return }
        badges.read(threadID: t)
        guard seq > (markedSeq[t] ?? -1) else { return }
        markedSeq[t] = seq
        Task { try? await client.threadMarkRead(id: t, seq: seq) }
    }

    // MARK: Writing

    /// Returns false when nothing was sent, so the composer keeps the text.
    func send(_ text: String) async -> Bool {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, let t = selectedThreadID else { return false }
        do {
            if let message = try await client.threadPost(id: t, body: body) { merge([message], into: t) }
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
            if SwarmaTeamsClient.Failure.map(error) == .service(.forbidden) { answeringBlocked = true }
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
        if let s = try? await client.swarmGet(id: id) { swarms[id] = s }
    }

    // MARK: Live updates

    func startStream() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self, client] in
            do {
                for try await event in client.stream() { await self?.apply(event) }
            } catch {
                if SwarmaTeamsClient.Failure.map(error) == .serviceTooOld { self?.phase = .serviceTooOld }
            }
            self?.streamTask = nil
        }
    }

    func stopStream() { streamTask?.cancel(); streamTask = nil }

    func apply(_ event: TeamsEvent) async {
        switch event.name {
        case "message.created", "message.updated":
            guard let t = event.threadID else { return }
            let isOpen = t == selectedThreadID && isVisible
            if event.name == "message.created",
               !badges.created(threadID: t, seq: event.seq, authorKind: event.authorKind, isOpen: isOpen) { return }
            // Bodies never ride the stream: fetch the one message, or the tail.
            let after = event.seq.map { $0 - 1 } ?? messages[t]?.last?.seq
            if let page = try? await client.threadRead(id: t, afterSeq: after, limit: event.seq == nil ? 50 : 1) {
                if messages[t] != nil { merge(page.messages, into: t) }
                else if let m = page.messages.last { previews[t] = TeamsPreview(body: m.preview, createdAt: m.createdAt) }
                // Swarm cards carry no snapshot: refetch the swarm they point at.
                for m in page.messages where m.kind == .swarm { if let id = m.ref?.swarmID { await loadSwarm(id) } }
            }
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
            await loadTasks()
        case "question.answered":
            if let id = event.subjectID { markAnswered(id, nil) }
            await loadTasks()
        case "task.updated":
            await loadTasks()
        case "thread.read":
            if let t = event.threadID ?? event.subjectID { badges.read(threadID: t) }
        default: break
        }
    }
}
