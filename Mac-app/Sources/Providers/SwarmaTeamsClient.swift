import Foundation

// MARK: - Wire models (docs/TEAMS.md §2 and §4)
//
// Decoded leniently, like `SwarmaStatus`: the service is built alongside this
// app, and one missing optional field should cost a row, not the window.

private extension KeyedDecodingContainer {
    func opt<T: Decodable>(_ type: T.Type, _ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
    func list<T: Decodable>(_ key: Key) -> [T] { opt([T].self, key) ?? [] }
}

/// `{mode:'auto'}` or `{provider, model?, effort?}`.
struct TeamsRunner: Codable, Equatable, Hashable {
    var provider: String?
    var model: String?
    var effort: String?

    static let auto = TeamsRunner()
    func changing(provider: String, effort: String) -> TeamsRunner {
        TeamsRunner(provider: provider, model: self.provider == provider ? model : nil, effort: effort)
    }
    var isAuto: Bool { provider == nil }

    /// "Claude Opus 5.5 · High", "Codex · Medium", "Auto".
    var label: String {
        guard let provider else { return L10n.t("Auto") }
        let name = model.map { SwarmaCells.vendorName(provider) + " " + $0 } ?? SwarmaCells.vendorName(provider)
        return effort.map { name + " · " + $0.prefix(1).uppercased() + $0.dropFirst() } ?? name
    }

    private enum CodingKeys: String, CodingKey { case mode, provider, model, effort }

    init(provider: String? = nil, model: String? = nil, effort: String? = nil) {
        self.provider = provider; self.model = model; self.effort = effort
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let mode = c.opt(String.self, .mode)
        provider = mode == "auto" ? nil : c.opt(String.self, .provider)
        model = provider == nil ? nil : c.opt(String.self, .model)
        effort = provider == nil ? nil : c.opt(String.self, .effort)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        guard let provider else { try c.encode("auto", forKey: .mode); return }
        try c.encode(provider, forKey: .provider)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(effort, forKey: .effort)
    }
}

/// The newest message of a thread, as a sidebar row previews it.
struct TeamsPreview: Decodable, Equatable {
    var body: String?
    var kind: String?
    var createdAt: Date?
    private enum CodingKeys: String, CodingKey { case body, kind, createdAt = "created_at" }
    init(body: String?, kind: String? = nil, createdAt: Date?) { self.body = body; self.kind = kind; self.createdAt = createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        body = c.opt(String.self, .body); kind = c.opt(String.self, .kind); createdAt = c.opt(Date.self, .createdAt)
    }
}

struct TeamsAgent: Decodable, Equatable, Identifiable {
    let id: String
    var name: String
    var role: String?
    var avatar: String?
    var instructions: String?
    var scope: String?
    var runner: TeamsRunner
    var edits: Bool
    var mainThreadID: String?
    /// `idle`, `working`, `waiting_on_you` or `offline`.
    var status: String?
    var version: Int?
    var unread: Int?
    var lastSeq: Int?
    var lastReadSeq: Int?
    var lastMessage: TeamsPreview?
    var archived: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, role, avatar, instructions, scope, runner, edits, status, version, unread, archived
        case unreadCount = "unread_count"
        case mainThreadID = "main_thread_id", lastSeq = "last_seq", lastReadSeq = "last_read_seq", lastMessage = "last_message"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.opt(String.self, .name) ?? ""
        role = c.opt(String.self, .role); avatar = c.opt(String.self, .avatar)
        instructions = c.opt(String.self, .instructions); scope = c.opt(String.self, .scope)
        runner = c.opt(TeamsRunner.self, .runner) ?? .auto
        edits = c.opt(Bool.self, .edits) ?? false
        mainThreadID = c.opt(String.self, .mainThreadID); status = c.opt(String.self, .status)
        version = c.opt(Int.self, .version); unread = c.opt(Int.self, .unreadCount) ?? c.opt(Int.self, .unread)
        lastSeq = c.opt(Int.self, .lastSeq); lastReadSeq = c.opt(Int.self, .lastReadSeq)
        lastMessage = c.opt(TeamsPreview.self, .lastMessage)
        archived = c.opt(Bool.self, .archived) ?? false
    }
}

struct TeamsThread: Decodable, Equatable, Identifiable {
    let id: String
    /// `agent_main`, `agent_side` or `channel`.
    var kind: String
    var name: String?
    var agentID: String?
    var members: [String]
    var leadAgentID: String?
    var archived: Bool
    var unread: Int?
    var lastSeq: Int?
    var lastReadSeq: Int?
    var lastMessage: TeamsPreview?

    private enum CodingKeys: String, CodingKey {
        case id, kind, name, title, members, archived, unread
        case unreadCount = "unread_count"
        case agentID = "agent_id", leadAgentID = "lead_agent_id", lastSeq = "last_seq"
        case lastReadSeq = "last_read_seq", lastMessage = "last_message"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = c.opt(String.self, .kind) ?? "agent_main"
        name = c.opt(String.self, .name) ?? c.opt(String.self, .title); agentID = c.opt(String.self, .agentID)
        members = c.list(.members); leadAgentID = c.opt(String.self, .leadAgentID)
        archived = c.opt(Bool.self, .archived) ?? false
        unread = c.opt(Int.self, .unreadCount) ?? c.opt(Int.self, .unread); lastSeq = c.opt(Int.self, .lastSeq)
        lastReadSeq = c.opt(Int.self, .lastReadSeq); lastMessage = c.opt(TeamsPreview.self, .lastMessage)
    }
}

struct TeamsSection: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    var order: Int
    /// Agent or channel ids.
    var items: [String]
    var collapsed: Bool

    init(id: String, name: String, order: Int, items: [String], collapsed: Bool = false) {
        self.id = id; self.name = name; self.order = order; self.items = items; self.collapsed = collapsed
    }

    private enum CodingKeys: String, CodingKey { case id, name, order, items, collapsed }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.opt(String.self, .name) ?? ""
        order = c.opt(Int.self, .order) ?? 0
        items = c.list(.items)
        collapsed = c.opt(Bool.self, .collapsed) ?? false
    }
}

struct TeamsSwarm: Decodable, Equatable, Identifiable {
    struct Step: Decodable, Equatable, Identifiable {
        let id: String
        var title: String
        var assigneeAgentID: String?
        var needs: [String]
        /// Includes `waiting_on_you`, `done`, `failed`, `blocked`.
        var status: String
        var taskID: String?
        var resultMessageID: String?
        var check: String?
        var failureCode: String?
        var failureDetail: String?
        var orderIndex: Int?
        private enum CodingKeys: String, CodingKey {
            case id, title, needs, status, check
            case assigneeAgentID = "assignee_agent_id", taskID = "task_id", resultMessageID = "result_message_id"
            case failureCode = "failure_code", failureDetail = "failure_detail", orderIndex = "order_index"
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = c.opt(String.self, .title) ?? ""
            assigneeAgentID = c.opt(String.self, .assigneeAgentID)
            needs = c.list(.needs)
            status = c.opt(String.self, .status) ?? "pending"
            taskID = c.opt(String.self, .taskID); resultMessageID = c.opt(String.self, .resultMessageID)
            // A check is a name today; tolerate an object form by ignoring it.
            check = c.opt(String.self, .check)
            failureCode = c.opt(String.self, .failureCode); failureDetail = c.opt(String.self, .failureDetail)
            orderIndex = c.opt(Int.self, .orderIndex)
        }
    }
    struct Progress: Decodable, Equatable { var done: Int; var total: Int }

    let id: String
    var title: String
    var goal: String?
    var scope: String?
    var ownerAgentID: String?
    var threadID: String?
    /// `planning`, `running`, `waiting_on_you`, `blocked`, `done`, `cancelled`.
    var status: String
    var steps: [Step]
    var progress: Progress
    var version: Int?
    var updatedAt: Date?
    var closedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, title, goal, scope, status, steps, progress, version
        case ownerAgentID = "owner_agent_id", threadID = "thread_id", updatedAt = "updated_at", closedAt = "closed_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.opt(String.self, .title) ?? ""
        goal = c.opt(String.self, .goal); scope = c.opt(String.self, .scope)
        ownerAgentID = c.opt(String.self, .ownerAgentID); threadID = c.opt(String.self, .threadID)
        status = c.opt(String.self, .status) ?? "running"
        steps = (c.list(.steps) as [Step]).enumerated()
            .sorted { ($0.element.orderIndex ?? $0.offset, $0.offset) < ($1.element.orderIndex ?? $1.offset, $1.offset) }
            .map(\.element)
        // Derived from the steps when an older payload leaves it out.
        progress = c.opt(Progress.self, .progress)
            ?? Progress(done: steps.filter { $0.status == "done" }.count, total: steps.count)
        version = c.opt(Int.self, .version)
        updatedAt = c.opt(Date.self, .updatedAt); closedAt = c.opt(Date.self, .closedAt)
    }

    /// The agents on steps that are running now.
    var runningAssignees: [String] { steps.filter { $0.status == "running" }.compactMap(\.assigneeAgentID) }
}

/// The tasks one turn started, as the `run` card shows them.
struct TeamsRun: Decodable, Equatable {
    struct Task: Decodable, Equatable {
        var id: String
        var status: String?
        var provider: String?
    }
    var tasks: [Task]
    var durationMS: Int?
    var branch: String?

    var done: Int { tasks.filter { $0.status == "completed" || $0.status == "done" }.count }

    /// "Ran 2 subagents · 2 done · 2s".
    var summary: String {
        var parts = [tasks.count == 1 ? L10n.t("Ran 1 subagent") : L10n.t("Ran \(tasks.count) subagents"),
                     L10n.t("\(done) done")]
        if let durationMS { parts.append(Self.duration(durationMS)) }
        return parts.joined(separator: " · ")
    }

    static func duration(_ ms: Int) -> String {
        let s = ms / 1000
        return s < 60 ? "\(s)s" : s < 3600 ? "\(s / 60)m \(s % 60)s" : "\(s / 3600)h \(s / 60 % 60)m"
    }

    private enum CodingKeys: String, CodingKey { case tasks, durationMS = "duration_ms", branch }
    init(tasks: [Task], durationMS: Int? = nil, branch: String? = nil) { self.tasks = tasks; self.durationMS = durationMS; self.branch = branch }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tasks = c.list(.tasks); durationMS = c.opt(Int.self, .durationMS); branch = c.opt(String.self, .branch)
    }
}

struct TeamsQuestion: Decodable, Equatable, Identifiable {
    var id: String
    var threadID: String?
    var agentID: String?
    var prompt: String
    var options: [String]
    var multi: Bool
    var freeText: Bool
    var swarmStepID: String?
    /// `open`, `answered` or `expired`.
    var status: String
    var answer: TeamsAnswer?
    var createdAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, prompt, options, multi, status, answer
        case threadID = "thread_id", agentID = "agent_id", freeText = "free_text", swarmStepID = "swarm_step_id"
        case createdAt = "created_at"
    }

    init(id: String, prompt: String, options: [String], multi: Bool, freeText: Bool, status: String = "open") {
        self.id = id; self.prompt = prompt; self.options = options; self.multi = multi
        self.freeText = freeText; self.status = status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.opt(String.self, .id) ?? ""
        threadID = c.opt(String.self, .threadID); agentID = c.opt(String.self, .agentID)
        prompt = c.opt(String.self, .prompt) ?? ""
        options = c.list(.options)
        multi = c.opt(Bool.self, .multi) ?? false
        freeText = c.opt(Bool.self, .freeText) ?? false
        swarmStepID = c.opt(String.self, .swarmStepID)
        status = c.opt(String.self, .status) ?? "open"
        answer = c.opt(TeamsAnswer.self, .answer)
        createdAt = c.opt(Date.self, .createdAt)
    }
}

struct TeamsAnswer: Decodable, Equatable {
    var questionID: String?
    var choices: [String]
    var text: String?
    private enum CodingKeys: String, CodingKey { case choices, text, questionID = "question_id" }
    init(choices: [String], text: String?) { self.choices = choices; self.text = text }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        questionID = c.opt(String.self, .questionID)
        choices = c.list(.choices); text = c.opt(String.self, .text)
    }
}

struct TeamsMessage: Decodable, Equatable, Identifiable {
    enum Kind: String { case text, handoff, swarm, run, question, answer, notice, task, unknown }
    struct Author: Decodable, Equatable {
        /// `human`, `agent` or `system`.
        var kind: String
        var id: String?
        var name: String?
    }
    struct Ref: Decodable, Equatable {
        var swarmID: String?
        var taskIDs: [String]
        var questionID: String?
        var taskID: String?
        private enum CodingKeys: String, CodingKey { case swarmID = "swarm_id", taskIDs = "task_ids", questionID = "question_id", taskID = "task_id" }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            swarmID = c.opt(String.self, .swarmID); taskIDs = c.list(.taskIDs); questionID = c.opt(String.self, .questionID); taskID = c.opt(String.self, .taskID)
        }
    }

    let id: String
    var threadID: String
    var seq: Int
    var author: Author
    var kind: Kind
    /// Text for `text`, `handoff` and `notice`. Untrusted when an agent wrote it.
    var body: String?
    var ref: Ref?
    var createdAt: Date?
    var editedAt: Date?
    /// `question`: the question in the body, with its status when resolved.
    var question: TeamsQuestion?
    /// `answer`: the choices and text in the body.
    var answer: TeamsAnswer?
    /// `swarm` / `run`: the card snapshot `thread_read` resolves.
    var swarm: TeamsSwarm?
    var run: TeamsRun?
    /// `task`: the bot task this card stands for.
    var task: TeamsTaskCard?

    var isHuman: Bool { author.kind == "human" }

    private enum CodingKeys: String, CodingKey {
        case id, seq, author, kind, body, ref, swarm, run, question, answer, task
        case threadID = "thread_id", createdAt = "created_at", editedAt = "edited_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        threadID = c.opt(String.self, .threadID) ?? ""
        seq = try c.decode(Int.self, forKey: .seq)
        author = c.opt(Author.self, .author) ?? Author(kind: "system", id: nil, name: nil)
        kind = Kind(rawValue: c.opt(String.self, .kind) ?? "") ?? .unknown
        ref = c.opt(Ref.self, .ref)
        createdAt = c.opt(Date.self, .createdAt); editedAt = c.opt(Date.self, .editedAt)
        swarm = c.opt(TeamsSwarm.self, .swarm); run = c.opt(TeamsRun.self, .run); task = c.opt(TeamsTaskCard.self, .task)
        // `question` and `answer` carry an object body; every other kind a string.
        body = c.opt(String.self, .body)
        switch kind {
        case .question:
            question = c.opt(TeamsQuestion.self, .question) ?? c.opt(TeamsQuestion.self, .body)
            if question?.id.isEmpty == true, let qid = ref?.questionID { question?.id = qid }
            if question?.threadID == nil { question?.threadID = threadID }
        case .answer:
            answer = c.opt(TeamsAnswer.self, .answer) ?? c.opt(TeamsAnswer.self, .body)
                ?? body.map { TeamsAnswer(choices: [], text: $0) }
        default: break
        }
    }

    /// One line for a sidebar row.
    var preview: String {
        switch kind {
        case .text, .handoff, .notice: return body ?? ""
        case .swarm: return swarm.map { "\($0.title) \($0.progress.done)/\($0.progress.total)" } ?? L10n.t("Swarm")
        case .run: return run?.summary ?? L10n.t("Ran subagents")
        case .question: return question?.prompt ?? body ?? L10n.t("Question")
        case .answer: return L10n.t("Answers sent")
        case .task: return body ?? task?.title ?? L10n.t("Task")
        case .unknown: return ""
        }
    }
}

// MARK: - Derivations

enum TeamsUnread {
    /// The row's badge: the service's own count when it sends one, else the
    /// gap between the newest seq and the read cursor.
    static func count(unread: Int?, lastSeq: Int?, lastReadSeq: Int?) -> Int {
        if let unread { return max(0, unread) }
        guard let lastSeq else { return 0 }
        return max(0, lastSeq - (lastReadSeq ?? 0))
    }

    /// Counted from loaded messages: what others wrote past the cursor. The
    /// viewer's own posts are never unread.
    static func count(_ messages: [TeamsMessage], after lastReadSeq: Int) -> Int {
        messages.filter { $0.seq > lastReadSeq && !$0.isHuman }.count
    }
}

enum TeamsAnswerValidation: Error, Equatable {
    case notOpen, empty, tooMany, unknownChoice(String), textNotAllowed, textTooLong

    /// Whether `question_answer` would accept this answer, checked before it is sent.
    static func validate(_ q: TeamsQuestion, choices: [String], text: String) -> TeamsAnswerValidation? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.status == "open" else { return .notOpen }
        if let bad = choices.first(where: { !q.options.contains($0) }) { return .unknownChoice(bad) }
        if !q.multi, choices.count > 1 { return .tooMany }
        if !text.isEmpty, !q.freeText { return .textNotAllowed }
        if text.count > 2000 { return .textTooLong }
        if choices.isEmpty, text.isEmpty { return .empty }
        return nil
    }
}

// MARK: - Live stream

/// One `GET /api/stream` event: ids and metadata, never bodies (TEAMS.md §4).
struct TeamsEvent: Equatable {
    var cursor: String?
    /// `message.created`, `message.updated`, `swarm.updated`, `agent.updated`,
    /// `question.created`, `question.answered`, `thread.read`.
    var name: String
    var subjectID: String?
    var threadID: String?
    var seq: Int?
    var authorKind: String?
    var scope: String?

    init(cursor: String?, name: String, subjectID: String? = nil, threadID: String? = nil, seq: Int? = nil, authorKind: String? = nil, scope: String? = nil) {
        self.cursor = cursor; self.name = name; self.subjectID = subjectID
        self.threadID = threadID; self.seq = seq; self.authorKind = authorKind; self.scope = scope
    }

    /// Reads one SSE frame. The data is the `events_poll` row shape; its
    /// fields win over a payload's, and `id:` / `event:` fill any gap.
    init?(_ frame: SSEParser.Frame) {
        let root = (try? JSONSerialization.jsonObject(with: Data(frame.data.utf8))) as? [String: Any] ?? [:]
        let payload = root["payload"] as? [String: Any] ?? [:]
        func string(_ key: String) -> String? { (root[key] as? String) ?? (payload[key] as? String) }
        guard let name = string("name") ?? frame.event else { return nil }
        self.init(cursor: string("cursor") ?? frame.id, name: name, subjectID: string("subject_id"),
                  threadID: string("thread_id"),
                  seq: (root["seq"] as? Int) ?? (payload["seq"] as? Int),
                  authorKind: string("author_kind") ?? ((payload["author"] as? [String: Any])?["kind"] as? String),
                  scope: string("scope"))
    }
}

/// Server-Sent Events, fed in whatever chunks the network delivers.
struct SSEParser {
    struct Frame: Equatable {
        var id: String?
        var event: String?
        var data: String
    }

    /// Bytes, not a String: Swift reads "\r\n" as one Character, so a
    /// String search for "\n" would miss it.
    private var carry: [UInt8] = []
    private var id: String?
    private var event: String?
    private var data: [String] = []

    /// Every frame completed by this chunk. A line split across chunks waits
    /// for its end; `:` heartbeat comments are dropped.
    // ponytail: "\n" and "\r\n" endings only; a bare "\r" (legal SSE, sent by no server we talk to) is not a break.
    mutating func feed(_ chunk: String) -> [Frame] {
        carry += Array(chunk.utf8)
        var frames: [Frame] = []
        while let end = carry.firstIndex(of: UInt8(ascii: "\n")) {
            var line = carry[..<end]
            if line.last == UInt8(ascii: "\r") { line = line.dropLast() }
            let text = String(decoding: line, as: UTF8.self)
            carry.removeSubrange(...end)
            if let frame = take(text) { frames.append(frame) }
        }
        return frames
    }

    private mutating func take(_ line: String) -> Frame? {
        if line.isEmpty {
            defer { event = nil; data = [] }
            guard !data.isEmpty else { return nil }
            return Frame(id: id, event: event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring, value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            let v = line[line.index(after: colon)...]
            value = v.first == " " ? v.dropFirst() : v
        } else { field = Substring(line); value = "" }
        switch field {
        case "id": id = String(value)
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}

// MARK: - Client

/// The TEAMS.md §4 tools over the same transport and token handling as
/// `SwarmaClient`, plus the `/api/stream` subscription.
actor SwarmaTeamsClient {
    static let shared = SwarmaTeamsClient()

    enum Failure: Error, Equatable {
        /// The service has no teams tools yet: an unknown tool, or a 404.
        case serviceTooOld
        case service(SwarmaClient.Failure)

        var message: String {
            switch self {
            case .serviceTooOld: return L10n.t("Update the Swarmaa service to use teams")
            case .service(let failure): return failure.message
            }
        }

        static func map(_ error: Error) -> Failure {
            switch error {
            case let failure as Failure: return failure
            case SwarmaClient.Failure.http(404), SwarmaClient.Failure.serviceCode("unknown_tool"): return .serviceTooOld
            case let failure as SwarmaClient.Failure: return .service(failure)
            default: return .service(.badResponse)
            }
        }
    }

    /// Opens one streaming GET; the bytes arrive as text chunks.
    typealias StreamTransport = @Sendable (URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<String, Error>)

    private let base: SwarmaClient
    private let streamTransport: StreamTransport
    private let sleep: @Sendable (TimeInterval) async -> Void

    init(base: SwarmaClient = .shared,
         streamTransport: @escaping StreamTransport = SwarmaTeamsClient.liveStream,
         sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        self.base = base
        self.streamTransport = streamTransport
        self.sleep = sleep
    }

    func status() async throws -> SwarmaStatus { try await base.status() }

    // MARK: Agents

    struct AgentPage: Decodable { var agents: [TeamsAgent]; var sections: [TeamsSection]?; var nextCursor: String?
        private enum CodingKeys: String, CodingKey { case agents, sections, nextCursor = "next_cursor" } }

    /// Every page; sections ride along when the service sends them.
    func agentList(scope: String? = nil) async throws -> (agents: [TeamsAgent], sections: [TeamsSection]?) {
        var agents: [TeamsAgent] = [], sections: [TeamsSection]?, after: String?
        var seen = Set<String>()
        repeat {
            var input: [String: Any] = ["limit": 100]
            input["scope"] = scope; input["after"] = after
            let page = try await call("agent_list", input, as: AgentPage.self)
            agents += page.agents
            sections = sections ?? page.sections
            after = page.agents.isEmpty ? nil : page.nextCursor
            if let after, !seen.insert(after).inserted || seen.count > 100 { throw Failure.service(.badResponse) }
        } while after != nil
        return (agents, sections)
    }

    func agentGet(id: String) async throws -> TeamsAgent {
        try await call("agent_get", ["agent_id": id], as: AgentWrapper.self).agent
    }

    func agentCreate(name: String, role: String, instructions: String, scope: String,
                     runner: TeamsRunner, edits: Bool) async throws -> TeamsAgent {
        try await call("agent_create", ["name": name, "role": role, "instructions": instructions, "scope": scope,
                                        "runner": try json(runner), "edits": edits,
                                        "idempotency_key": UUID().uuidString], as: AgentWrapper.self).agent
    }

    func agentUpdate(id: String, expectedVersion: Int, runner: TeamsRunner) async throws -> TeamsAgent {
        try await call("agent_update", ["agent_id": id, "expected_version": expectedVersion, "runner": try json(runner),
                                        "idempotency_key": UUID().uuidString], as: AgentWrapper.self).agent
    }

    // MARK: Bots (docs/BOTS.md)

    private struct BotWrapper: Decodable { let bot: TeamsBot }

    /// Updates first, as the service orders them.
    func botList() async throws -> [TeamsBot] {
        try await allPages("bot_list", ["limit": 100], as: TeamsBot.self)
    }

    func botGet(id: String) async throws -> TeamsBot {
        try await call("bot_get", ["bot_id": id], as: BotWrapper.self).bot
    }

    func botCreate(name: String, job: String, scope: String, leadAgentID: String, memberAgentIDs: [String],
                   routing: TeamsBotRouting, rules: TeamsBotRules) async throws -> TeamsBot {
        try await call("bot_create", ["name": name, "job": job, "scope": scope, "lead_agent_id": leadAgentID,
                                      "member_agent_ids": memberAgentIDs, "routing": try json(routing),
                                      "rules": try json(rules), "idempotency_key": UUID().uuidString],
                       as: BotWrapper.self).bot
    }

    func botUpdate(id: String, expectedVersion: Int, name: String, job: String, leadAgentID: String,
                   memberAgentIDs: [String], routing: TeamsBotRouting, rules: TeamsBotRules,
                   schedule: String?) async throws -> TeamsBot {
        try await call("bot_update", ["bot_id": id, "expected_version": expectedVersion, "name": name, "job": job,
                                      "lead_agent_id": leadAgentID, "member_agent_ids": memberAgentIDs,
                                      "routing": try json(routing), "rules": try json(rules),
                                      "schedule": schedule.map { $0 as Any } ?? NSNull()],
                       as: BotWrapper.self).bot
    }

    /// Returns the `routing_now` map itself, keyed by kind.
    func botRoutingPreview(id: String) async throws -> [String: TeamsRoutingNow] {
        try await call("bot_routing_preview", ["bot_id": id], as: [String: TeamsRoutingNow].self)
    }

    // MARK: Threads

    struct MessagePage: Decodable { var messages: [TeamsMessage]; var hasMore: Bool?
        private enum CodingKeys: String, CodingKey { case messages, hasMore = "has_more" } }

    func threadRead(id: String, afterSeq: Int? = nil, beforeSeq: Int? = nil, limit: Int = 50) async throws -> MessagePage {
        var input: [String: Any] = ["thread_id": id, "limit": min(limit, 100)]
        input["after_seq"] = afterSeq; input["before_seq"] = beforeSeq
        return try await call("thread_read", input, as: MessagePage.self)
    }

    func threadPost(id: String, body: String, idempotencyKey: String = UUID().uuidString) async throws -> TeamsMessage? {
        try await call("thread_post", ["thread_id": id, "body": body, "idempotency_key": idempotencyKey],
                       as: OptionalMessage.self).message
    }

    func threadMarkRead(id: String, seq: Int) async throws {
        _ = try await raw("thread_mark_read", ["thread_id": id, "seq": seq])
    }

    func threadList(kind: String? = nil, agentID: String? = nil) async throws -> [TeamsThread] {
        var input: [String: Any] = [:]
        input["kind"] = kind; input["agent_id"] = agentID
        return try await allPages("thread_list", input, as: TeamsThread.self)
    }

    func sectionSet(_ sections: [TeamsSection]) async throws {
        _ = try await raw("section_set", ["sections": try json(sections)])
    }

    // MARK: Swarms and questions

    func swarmGet(id: String) async throws -> TeamsSwarm {
        try await call("swarm_get", ["swarm_id": id], as: SwarmWrapper.self).swarm
    }

    func swarmList(status: String = "open") async throws -> [TeamsSwarm] {
        try await allPages("swarm_list", ["status": status, "limit": 100], as: TeamsSwarm.self)
    }

    func questionList(status: String = "open") async throws -> [TeamsQuestion] {
        try await allPages("question_list", ["status": status, "limit": 100], as: TeamsQuestion.self)
    }

    func questionAnswer(id: String, choices: [String], text: String?) async throws {
        var input: [String: Any] = ["question_id": id, "choices": choices, "idempotency_key": UUID().uuidString]
        if let text, !text.isEmpty { input["text"] = text }
        _ = try await raw("question_answer", input)
    }

    // MARK: Attention and tasks

    struct AttentionPage: Decodable {
        var items: [TeamsAttentionItem]; var hasMore: Bool?; var nextCursor: String?
        private enum CodingKeys: String, CodingKey { case items, hasMore = "has_more", nextCursor = "next_cursor" }
    }

    /// Everything waiting on the owner, newest first, every page.
    func attentionList() async throws -> [TeamsAttentionItem] {
        try await allPages("attention_list", ["limit": 100], as: TeamsAttentionItem.self)
    }

    func taskGet(id: String) async throws -> TeamsTask {
        try await call("task_get", ["task_id": id], as: TaskWrapper.self).task
    }

    /// One page of a scope's tasks; `task_list` needs a scope.
    func taskList(scope: String, status: String? = nil, resolved: Bool? = nil, limit: Int = 50) async throws -> [TeamsTask] {
        var input: [String: Any] = ["scope": scope, "limit": min(limit, 100)]
        input["status"] = status; input["resolved"] = resolved
        return try await allPages("task_list", input, as: TeamsTask.self)
    }

    func resolvedTaskPage(scope: String, beforeID: String? = nil) async throws -> (tasks: [TeamsTask], next: String?) {
        var input: [String: Any] = ["scope": scope, "resolved": true, "limit": 50]
        input["before_id"] = beforeID
        let page = try await call("task_list", input, as: ListPage<TeamsTask>.self)
        return (page.items, page.next)
    }

    /// Folds a task into Resolved, or back out. The version comes from `task_get`.
    func taskResolve(id: String, resolved: Bool, expectedVersion: Int) async throws {
        _ = try await raw("task_resolve", ["task_id": id, "resolved": resolved, "expected_version": expectedVersion])
    }

    func taskContinue(id: String, expectedVersion: Int, instruction: String) async throws {
        _ = try await raw("task_continue", ["task_id": id, "expected_version": expectedVersion,
                                            "instruction": instruction, "idempotency_key": UUID().uuidString])
    }

    // MARK: Stream

    /// `GET /api/stream?after=<cursor>`, reconnecting from the last cursor
    /// seen with backoff (1 s doubling to 30 s, reset by any event). Ends by
    /// throwing only for `.serviceTooOld` or `.service(.unauthorized/.noToken)`,
    /// which retrying cannot fix; cancel the consuming task to stop it.
    nonisolated func stream(after: String? = nil, onState: @escaping @Sendable (String) -> Void = { _ in }) -> AsyncThrowingStream<TeamsEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                // `now` starts at the live edge; with no cursor the service replays all history.
                var cursor = after ?? "now"
                var delay: TimeInterval = 1
                while !Task.isCancelled {
                    do {
                        var query: [URLQueryItem] = []
                        query.append(URLQueryItem(name: "after", value: cursor))
                        var request = try await base.getRequest(path: "api/stream", query: query)
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        request.timeoutInterval = 60   // heartbeats every 15 s keep it open
                        let (response, chunks) = try await streamTransport(request)
                        switch response.statusCode {
                        case 200..<300: break
                        case 404: throw Failure.serviceTooOld
                        case 401: throw SwarmaClient.Failure.unauthorized
                        default: throw SwarmaClient.Failure.http(response.statusCode)
                        }
                        onState("Live")
                        var parser = SSEParser()
                        for try await chunk in chunks {
                            for frame in parser.feed(chunk) {
                                guard let event = TeamsEvent(frame) else { continue }
                                if let c = event.cursor { cursor = c }
                                delay = 1
                                continuation.yield(event)
                            }
                        }
                    } catch {
                        let failure = Failure.map(error)
                        if [.serviceTooOld, .service(.unauthorized), .service(.noToken),
                            .service(.badURL), .service(.insecureURL)].contains(failure) {
                            continuation.finish(throwing: failure)
                            return
                        }
                    }
                    if Task.isCancelled { break }
                    onState("Reconnecting")
                    await sleep(delay)
                    delay = min(delay * 2, 30)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Requests

    private struct AgentWrapper: Decodable {
        var agent: TeamsAgent
        init(from decoder: Decoder) throws {
            struct K: Decodable { let agent: TeamsAgent }
            agent = try (try? K(from: decoder).agent) ?? TeamsAgent(from: decoder)
        }
    }
    private struct SwarmWrapper: Decodable {
        var swarm: TeamsSwarm
        init(from decoder: Decoder) throws {
            struct K: Decodable { let swarm: TeamsSwarm }
            swarm = try (try? K(from: decoder).swarm) ?? TeamsSwarm(from: decoder)
        }
    }
    private struct OptionalMessage: Decodable {
        var message: TeamsMessage?
        init(from decoder: Decoder) throws {
            struct K: Decodable { let message: TeamsMessage }
            message = (try? K(from: decoder).message) ?? (try? TeamsMessage(from: decoder))
        }
    }
    private struct TaskWrapper: Decodable { var task: TeamsTask }
    private struct ListPage<T: Decodable>: Decodable {
        let items: [T]
        let next: String?
        private enum K: String, CodingKey { case tasks, threads, swarms, questions, bots, items, next_cursor, next_before_id }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            items = try c.decode([T].self, forKey: [.tasks, .threads, .swarms, .questions, .bots, .items].first { c.contains($0) } ?? .tasks)
            next = try c.decodeIfPresent(String.self, forKey: .next_cursor) ?? c.decodeIfPresent(String.self, forKey: .next_before_id)
        }
    }

    private func allPages<T: Decodable>(_ tool: String, _ input: [String: Any], as: T.Type) async throws -> [T] {
        var input = input, result: [T] = [], seen = Set<String>()
        // ponytail: 100 pages per refresh; fail visibly rather than silently truncate.
        for _ in 0..<100 {
            let page = try await call(tool, input, as: ListPage<T>.self)
            result += page.items
            guard let next = page.next, !page.items.isEmpty else { return result }
            guard seen.insert(next).inserted else { throw Failure.service(.badResponse) }
            input[tool == "task_list" ? "before_id" : "after"] = next
        }
        throw Failure.service(.badResponse)
    }
    private struct Envelope<T: Decodable>: Decodable { let result: T }

    private func json<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: .fragmentsAllowed)
    }

    private func raw(_ tool: String, _ input: [String: Any]) async throws -> Data {
        do { return try await base.fetchRaw(tool: tool, body: JSONSerialization.data(withJSONObject: input)) }
        catch { throw Failure.map(error) }
    }

    private func call<T: Decodable>(_ tool: String, _ input: [String: Any], as: T.Type) async throws -> T {
        let data = try await raw(tool, input)
        do { return try SwarmaClient.decoder.decode(Envelope<T>.self, from: data).result }
        catch { throw Failure.service(.badResponse) }
    }

    // MARK: Live stream transport

    static let liveStream: StreamTransport = { request in
        let (bytes, response) = try await streamSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw SwarmaClient.Failure.badResponse }
        let chunks = AsyncThrowingStream<String, Error> { continuation in
            let task = Task {
                do {
                    // Byte by byte so a frame is delivered as soon as its blank
                    // line arrives; lines are flushed whole.
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        line.append(byte)
                        if byte == UInt8(ascii: "\n") {
                            continuation.yield(String(decoding: line, as: UTF8.self))
                            line.removeAll(keepingCapacity: true)
                        }
                    }
                    if !line.isEmpty { continuation.yield(String(decoding: line, as: UTF8.self)) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (http, chunks)
    }

    /// Long-lived, unlike the tool session's 5 s; refuses redirects for the
    /// same reason (the token belongs to the configured URL only).
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let streamSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 7 * 24 * 3600
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()
}

extension SwarmaCells {
    /// A notch cell whose id starts with this opens the main window on that
    /// thread: the swarm and question items the notch shows (TEAMS.md §1).
    static let threadPrefix = "swarm:thread:"
    static func threadCellID(_ threadID: String) -> String { threadPrefix + threadID }
    static func swarmID(fromCellID id: String) -> String? {
        guard id.hasPrefix(threadPrefix), let range = id.range(of: "/swarm/") else { return nil }
        let value = String(id[range.upperBound...])
        return value.isEmpty ? nil : value
    }
    /// Drops a `/swarm/<id>` suffix: a swarm cell opens its thread too.
    static func threadID(fromCellID id: String) -> String? {
        guard id.hasPrefix(threadPrefix) else { return nil }
        let rest = id.dropFirst(threadPrefix.count)
        return String(rest.split(separator: "/", maxSplits: 1).first ?? rest)
    }
}
