import Foundation
import Security
import Observation

// Explicit wire keys mirror BotsModels and SwarmaTeamsClient. Unknown fields survive edits.
indirect enum JSON: Codable, Equatable, Hashable, Sendable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> JSON {
        get { if case .object(let v) = self { return v[key] ?? .null }; return .null }
        set { var v = object; v[key] = newValue; self = .object(v) }
    }
    var object: [String: JSON] { if case .object(let v) = self { return v }; return [:] }
    var array: [JSON] { if case .array(let v) = self { return v }; return [] }
    var string: String { if case .string(let v) = self { return v }; return "" }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    var int: Int { Int(number ?? 0) }
    var bool: Bool { if case .bool(let v) = self { return v }; return false }
    static func strings(_ values: [String]) -> JSON { .array(values.map(JSON.string)) }
    static func parse(_ text: String) throws -> JSON { try JSONDecoder().decode(JSON.self, from: Data(text.utf8)) }
}

struct Bot: Identifiable, Equatable, Sendable {
    var raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["name"].string }
    var job: String { raw["job"].string }
    var scope: String { raw["scope"].string }
    var threadID: String { raw["thread_id"].string }
    var starred: Bool { raw["starred"].bool } // Absent before I1: false.
    var needsYou: Int { raw["badges"]["needs_you"].int }
    var unread: Int { raw["badges"]["unread"].int }
    var line: String { raw["badges"]["latest"]["line"].string }
    var activity: String { let at = raw["badges"]["latest"]["at"].string; return at.isEmpty ? raw["updated_at"].string : at }
    private var activityDate: Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: activity) ?? ISO8601DateFormatter().date(from: activity) ?? .distantPast
    }
    static func sorted(_ bots: [Bot]) -> [Bot] {
        bots.filter { !$0.raw["archived"].bool }.sorted {
            if ($0.needsYou > 0) != ($1.needsYou > 0) { return $0.needsYou > 0 }
            if ($0.unread > 0) != ($1.unread > 0) { return $0.unread > 0 }
            if $0.activityDate != $1.activityDate { return $0.activityDate > $1.activityDate }
            return $0.id < $1.id
        }
    }
    static func shortcut(_ bots: [Bot]) -> Bot? { sorted(bots).first { $0.starred } }
}

struct Message: Identifiable, Equatable, Sendable {
    var raw: JSON
    var id: String { raw["id"].string }
    var seq: Int { raw["seq"].int }
    var human: Bool { raw["author"]["kind"].string == "human" }
    var text: String { raw["body"].string }
    var kind: String { raw["kind"].string }
    var question: JSON {
        var q = raw["question"] == .null ? raw["body"] : raw["question"]
        if q["id"].string.isEmpty { q["id"] = raw["ref"]["question_id"] }
        return q
    }
}

struct NewBotDraft {
    var name = ""
    var job = ""
    var project = ""
    var lead = ""
    var firstReply = "claude-haiku-5-5"
    let agentKey = UUID().uuidString
    let botKey = UUID().uuidString
    var missing: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give your bot a name." }
        if job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Say what it does to make the bot." }
        if project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Choose a project." }
        return nil
    }
}

// Pairing URLs carry secrets: reject ambiguous inputs and never include them in errors.
struct PairingLink {
    let host: String
    let code: String
    init(_ url: URL) throws {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "swarmaa", parts.host == "pair", parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 2,
              items.filter({ $0.name == "host" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              let host = items.first(where: { $0.name == "host" })?.value,
              host.range(of: "^[a-z2-7]{26}$", options: .regularExpression) != nil,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[a-z]+(-[a-z]+){5}$", options: .regularExpression) != nil
        else { throw AppFailure.invalidPairing }
        self.host = host; self.code = code.replacingOccurrences(of: "-", with: " ")
    }
}

struct HostConnection: Codable, Sendable {
    let hostID: String
    let relay: String
    let token: String
}

struct ConnectionKeychain: Sendable {
    var service = "app.swarmaa.ios.connection"
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
                                       kSecAttrService as String: service, kSecAttrAccount as String: "host"] }
    func save(_ connection: HostConnection) throws {
        let data = try JSONEncoder().encode(connection)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw AppFailure.keychain }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw AppFailure.keychain }
    }
    func load() throws -> HostConnection? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw AppFailure.keychain }
        return try JSONDecoder().decode(HostConnection.self, from: data)
    }
    func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AppFailure.keychain }
    }
}

enum AppFailure: LocalizedError {
    case keychain, invalidPairing, tooManyTries, invalidResponse, unauthorized, offline, timeout, noStar, invalidMessage, service(Int)
    var errorDescription: String? {
        switch self {
        case .keychain: "Could not access this device’s secure connection. Unlock your phone and try again."
        case .invalidPairing: "That code is wrong, already used or expired. Run npm run relay:pair on your Mac for a new one."
        case .tooManyTries: "Too many tries. Wait a few minutes, then use a new code from your Mac."
        case .invalidResponse: "The host returned an unreadable response."
        case .unauthorized: "This connection was revoked. Pair with your Mac again."
        case .offline: "Your host is offline. Try again when your Mac is connected."
        case .timeout: "The host did not respond in time. Check the app before retrying a sent action."
        case .noStar: "Star a bot in Bot settings first."
        case .invalidMessage: "Enter a message to ask your starred bot."
        case .service(let status): "The host could not finish this action (\(status)). Refresh and try again."
        }
    }
}

// No server text is surfaced as an error: it may contain tokens or pairing material.
func safeError(_ error: Error) -> String {
    if let error = error as? AppFailure { return error.localizedDescription }
    if let error = error as? SwarmaRelayTransport.Failure {
        switch error {
        case .hostOffline: return AppFailure.offline.localizedDescription
        case .rateLimited: return AppFailure.tooManyTries.localizedDescription
        case .other(let code) where code == "bad_code": return AppFailure.invalidPairing.localizedDescription
        default: break
        }
    }
    return "Could not reach your host. Check the connection and try again."
}

@MainActor protocol HostService: AnyObject, Sendable {
    func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON
    func events(after: String) -> AsyncThrowingStream<Data, Error>
}

@MainActor final class RelayService: HostService {
    let transport: SwarmaRelayTransport
    let connection: HostConnection
    init(connection: HostConnection, transport: SwarmaRelayTransport? = nil) {
        self.connection = connection
        self.transport = transport ?? SwarmaRelayTransport(relay: connection.relay, hostID: connection.hostID)
    }
    func request(_ path: String) -> URLRequest {
        // URL is only an HTTP envelope; all traffic goes through the relay transport.
        var request = URLRequest(url: URL(string: "https://relay.swarmaa.com" + path)!)
        request.setValue("Bearer " + connection.token, forHTTPHeaderField: "Authorization")
        return request
    }
    func call(_ tool: String, _ input: [String: JSON] = [:]) async throws -> JSON {
        try Task.checkCancellation()
        var request = request("/api/tools/" + tool)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(JSON.object(input))
        let (data, response) = try await Self.bounded(transport: transport, seconds: 15) { [transport, request] in
            try await transport.send(request)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw response.statusCode == 401 ? AppFailure.unauthorized : AppFailure.service(response.statusCode)
        }
        let root = try JSONDecoder().decode(JSON.self, from: data)
        guard root["result"] != .null else { throw AppFailure.invalidResponse }
        return root["result"]
    }
    nonisolated static func bounded<T: Sendable>(transport: SwarmaRelayTransport, seconds: Double,
                                                operation: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: T.self) { group in
                group.addTask { try Task.checkCancellation(); return try await operation() }
                group.addTask {
                    try await Task.sleep(for: .seconds(seconds))
                    await transport.disconnect() // Unblocks transport continuations on timeout.
                    throw AppFailure.timeout
                }
                defer { group.cancelAll() }
                return try await group.next()!
            }
        } onCancel: {
            Task { await transport.disconnect() }
        }
    }
    func events(after: String) -> AsyncThrowingStream<Data, Error> {
        let encoded = after.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "now"
        var req = request("/api/stream?after=" + encoded)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return transport.stream(req)
    }
}

// A byte parser so UTF-8 and CRLF can be split at arbitrary relay chunk boundaries.
struct EventParser {
    var carry = Data()
    var lines: [String] = []
    var frameBytes = 0
    mutating func feed(_ chunk: Data) throws -> [JSON] {
        carry.append(chunk)
        guard carry.count < 1_048_576 else { throw AppFailure.invalidResponse }
        var events: [JSON] = []
        while let end = carry.firstIndex(of: 10) {
            let line = String(decoding: carry[..<end], as: UTF8.self).trimmingCharacters(in: .newlines)
            carry.removeSubrange(...end)
            if line.isEmpty {
                var data: [String] = [], name = "", id = ""
                for l in lines {
                    let p = l.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    let v = p.count > 1 ? String(p[1]).trimmingCharacters(in: .whitespaces) : ""
                    if p[0] == "data" { data.append(v) }
                    if p[0] == "event" { name = v }
                    if p[0] == "id" { id = v }
                }
                lines = []; frameBytes = 0
                if !data.isEmpty {
                    var root = try JSON.parse(data.joined(separator: "\n"))
                    if root["name"] == .null { root["name"] = .string(name) }
                    if root["cursor"] == .null { root["cursor"] = .string(id) }
                    events.append(root)
                }
            } else if !line.hasPrefix(":") {
                frameBytes += line.utf8.count
                guard frameBytes < 1_048_576 else { throw AppFailure.invalidResponse }
                lines.append(line)
            }
        }
        return events
    }
}

/// `key` is the list field of that tool's result: bots, agents, tasks, items (attention_list). No default:
/// a wrong one silently reads nothing, which hid every bot.
@MainActor func allPages(_ service: any HostService, _ tool: String, _ input: [String: JSON] = [:], key: String) async throws -> [JSON] {
    var input = input, values: [JSON] = [], seen = Set<String>()
    // ponytail: 100 pages per refresh. A larger account must use a paged UI; never silently truncate.
    for _ in 0..<100 {
        try Task.checkCancellation()
        let page = try await service.call(tool, input)
        let rows = page[key].array
        values += rows
        let next = page["next_cursor"].string.isEmpty ? page["next_before_id"].string : page["next_cursor"].string
        if next.isEmpty { return values }
        guard !rows.isEmpty, seen.insert(next).inserted else { throw AppFailure.invalidResponse }
        input[tool == "task_list" ? "before_id" : "after"] = .string(next)
    }
    throw AppFailure.invalidResponse
}

enum PushNotification {
    static func tokenHex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
    static func botID(_ payload: [AnyHashable: Any]) -> String? {
        guard let id = payload["bot_id"] as? String,
              !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return id
    }
    static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}

@MainActor @Observable final class AppModel {
    var service: (any HostService)?
    var bots: [Bot] = []
    var messages: [Message] = []
    /// Last messages seen per bot, so reopening a thread shows them at once while new ones load.
    private var threadCache: [String: [Message]] = [:]
    var typing: [JSON] = []
    var tasks: [JSON] = []
    var attention: [JSON] = []
    var status: JSON = .null
    var agents: [JSON] = []
    var openBot: Bot?
    var online = false
    var lastSeen: Date?
    var error: String?
    var busy = false
    var loading = false
    var connected = false
    var isDemo = false
    var didLoadBots = false
    var pendingPushBotID: String?
    var visibleThreadBotID: String?
    var onFirstBotList: (@MainActor () async -> Void)?
    private var pushToken: String?
    private var signingOut = false

    func receivePushTap(_ payload: [AnyHashable: Any]) {
        if let id = PushNotification.botID(payload) { pendingPushBotID = id }
    }
    func takePushBot() -> Bot? {
        guard connected, didLoadBots, let id = pendingPushBotID,
              let bot = bots.first(where: { $0.id == id }) else { return nil }
        pendingPushBotID = nil
        return bot
    }
    func registerPushToken(_ data: Data) async {
        guard connected, !isDemo, !signingOut, let service else { return }
        let token = PushNotification.tokenHex(data)
        pushToken = token
        _ = try? await service.call("push_register", ["token": .string(token), "environment": .string(PushNotification.environment)])
    }
    private var streamTask: Task<Void, Never>?
    private var presenceTask: Task<Void, Never>?
    private var cursor = "now"
    private var createdLeads: [String: String] = [:]
    private var pendingPost: (thread: String, text: String, key: String)?
    let keychain: ConnectionKeychain
    init(keychain: ConnectionKeychain = ConnectionKeychain()) { self.keychain = keychain }
    var sortedBots: [Bot] { Bot.sorted(bots) }
    var starred: Bot? { Bot.shortcut(bots) }
    var scopes: [String] {
        Array(Set(status["scopes"].array.map { $0["scope"].string } + bots.map(\.scope))).filter { !$0.isEmpty }.sorted()
    }
    func restore() async {
        do {
            guard let connection = try keychain.load() else { return }
            attach(RelayService(connection: connection))
            await refresh()
        } catch { self.error = safeError(error) }
    }
    func attach(_ service: RelayService) {
        streamTask?.cancel(); presenceTask?.cancel()
        self.service = service; connected = true; didLoadBots = false
        presenceTask = Task { [weak self, transport = service.transport] in
            for await p in transport.presenceStream {
                guard !Task.isCancelled else { break }
                self?.online = p.online; self?.lastSeen = p.lastSeen
            }
        }
        startStream()
    }
    func handlePairingURL(_ url: URL, transport: SwarmaRelayTransport? = nil) async throws {
        let link = try PairingLink(url)
        try await pair(host: link.host, code: link.code, transport: transport)
    }
    func replyingAgent(_ typing: JSON) -> (id: String, name: String) {
        let id = typing["agent_id"].string.isEmpty ? typing["author"]["id"].string : typing["agent_id"].string
        let agent = agents.first { $0["id"].string == id }
        let name = agent?["name"].string ?? typing["author"]["name"].string
        return (id, name.isEmpty ? "Agent" : name)
    }
    /// The 6-digit code from `npm run relay:pair` on the Mac. The relay says which host it belongs to,
    /// then the host's room checks and consumes it.
    func pair(code raw: String, relay: String = "relay.swarmaa.com") async throws {
        let code = raw.filter(\.isNumber)
        guard code.count == 6 else { throw AppFailure.invalidPairing }
        var request = URLRequest(url: URL(string: "https://\(relay)/pair/resolve")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
        let (data, response) = try await URLSession.shared.data(for: request)
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: break
        case 429: throw AppFailure.tooManyTries
        default: throw AppFailure.invalidPairing
        }
        guard let host = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["host_id"] as? String else { throw AppFailure.invalidPairing }
        try await pair(host: host, code: code, relay: relay)
    }
    func pair(host: String, code: String, relay: String = "relay.swarmaa.com", transport supplied: SwarmaRelayTransport? = nil) async throws {
        guard host.range(of: "^[a-z2-7]{26}$", options: .regularExpression) != nil,
              code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil
                || code.split(whereSeparator: \.isWhitespace).count == 6 else { throw AppFailure.invalidPairing }
        let transport = supplied ?? SwarmaRelayTransport(relay: relay, hostID: host)
        do {
            let token = try await RelayService.bounded(transport: transport, seconds: 15) {
                try await transport.pair(code: code, deviceName: "Swarmaa iPhone")
            }
            let connection = HostConnection(hostID: host, relay: relay, token: token)
            try keychain.save(connection)
            if let old = service as? RelayService { await old.transport.disconnect() }
            attach(RelayService(connection: connection, transport: transport))
            await refresh()
        } catch { await transport.disconnect(); throw error }
    }
    func refresh() async {
        guard let service, !isDemo else { return }
        loading = true
        defer { loading = false }
        do {
            async let botRows = allPages(service, "bot_list", ["limit": .number(100)], key: "bots")
            async let swarm = service.call("swarm_status", [:])
            async let agentRows = allPages(service, "agent_list", ["limit": .number(100)], key: "agents")
            (bots, status, agents) = try await (botRows.map { Bot(raw: $0) }, swarm, agentRows)
            error = nil
            if !didLoadBots, connected, !signingOut {
                didLoadBots = true
                await onFirstBotList?()
            }
        } catch { self.error = safeError(error) }
    }
    func readThread(_ bot: Bot, incremental: Bool = false) async throws {
        guard let service else { return }
        let previous = incremental ? (messages.map(\.seq).max() ?? 0) : 0
        var input: [String: JSON] = ["thread_id": .string(bot.threadID), "limit": .number(100)]
        if incremental { input["after_seq"] = .number(Double(previous)) }
        var page = try await service.call("thread_read", input)
        var incoming = page["messages"].array.map { Message(raw: $0) }
        var pages = 1
        // Read every forward page on stream catch-up, not only the first 100 messages.
        while incremental && page["has_more"].bool {
            guard pages < 100, let last = incoming.map(\.seq).max(), last > (input["after_seq"]?.int ?? 0) else { throw AppFailure.invalidResponse }
            input["after_seq"] = .number(Double(last))
            page = try await service.call("thread_read", input)
            incoming += page["messages"].array.map { Message(raw: $0) }; pages += 1
        }
        guard openBot?.id == bot.id else { return }
        var merged = incremental ? messages : []
        for message in incoming {
            if let i = merged.firstIndex(where: { $0.id == message.id }) { merged[i] = message }
            else { merged.append(message) }
        }
        messages = merged.sorted { $0.seq < $1.seq }; typing = page["typing"].array
        threadCache[bot.id] = messages
        if let seq = messages.last?.seq {
            _ = try await service.call("thread_mark_read", ["thread_id": .string(bot.threadID), "seq": .number(Double(seq))])
        }
    }
    func open(_ bot: Bot) async {
        openBot = bot
        if isDemo { return }
        typing = []
        if let cached = threadCache[bot.id], !cached.isEmpty {
            messages = cached  // shown at once; only what is new is fetched
            do { try await readThread(bot, incremental: true) } catch { self.error = safeError(error) }
        } else {
            messages = []
            do { try await readThread(bot) } catch { self.error = safeError(error) }
        }
    }
    func olderMessages() async throws {
        guard let service, let bot = openBot, let first = messages.first else { return }
        let page = try await service.call("thread_read", ["thread_id": .string(bot.threadID), "before_seq": .number(Double(first.seq)), "limit": .number(100)])
        guard openBot?.id == bot.id else { return }
        let ids = Set(messages.map(\.id))
        messages = (page["messages"].array.map { Message(raw: $0) }.filter { !ids.contains($0.id) } + messages).sorted { $0.seq < $1.seq }
    }
    func handle(_ event: JSON) async throws {
        guard let service else { return }
        let payload = event["payload"]
        func value(_ key: String) -> JSON { event[key] == .null ? payload[key] : event[key] }
        let name = value("name").string
        if let bot = openBot,
           (name.hasPrefix("message.") && value("thread_id").string == bot.threadID)
            || (name == "task.updated" && value("kind").string == "turn")
            || name.hasPrefix("question.") {
            try await readThread(bot, incremental: name == "message.created")
        }
        if name.hasPrefix("task.") {
            let id = value("subject_id").string.isEmpty ? value("task_id").string : value("subject_id").string
            if !id.isEmpty {
                let task = try await service.call("task_get", ["task_id": .string(id)])["task"]
                if let index = tasks.firstIndex(where: { $0["id"].string == id }) { tasks[index] = task }
                else { tasks.append(task) }
            }
        }
        if name.hasPrefix("bot.") || name == "message.created" || name.hasPrefix("question.") {
            bots = try await allPages(service, "bot_list", ["limit": .number(100)], key: "bots").map { Bot(raw: $0) }
        }
    }
    func startStream() {
        guard let service, !isDemo else { return }
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            var delay = 1.0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    var parser = EventParser()
                    for try await chunk in service.events(after: self.cursor) {
                        for event in try parser.feed(chunk) {
                            try await self.handle(event)
                            if !event["cursor"].string.isEmpty { self.cursor = event["cursor"].string }
                            delay = 1
                        }
                        if Task.isCancelled { return }
                    }
                } catch {
                    self.error = safeError(error)
                    if case AppFailure.unauthorized = error { return }
                }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                delay = min(30, delay * 2)
            }
        }
    }
    func loadTasks() async throws {
        guard let service, !isDemo else { return }
        // Seven task reads + attention = at most eight concurrent calls, including pagination.
        let scopes = scopes
        var rows: [JSON] = []
        async let needs = allPages(service, "attention_list", ["limit": .number(100)], key: "items")
        for offset in stride(from: 0, to: scopes.count, by: 7) {
            let batch = Array(scopes[offset..<min(offset + 7, scopes.count)])
            let result = try await withThrowingTaskGroup(of: [JSON].self) { group in
                for scope in batch {
                    group.addTask { try await allPages(service, "task_list", ["scope": .string(scope), "limit": .number(100)], key: "tasks") }
                }
                var results: [JSON] = []
                for try await r in group { results += r }
                return results
            }
            rows += result
        }
        tasks = rows; attention = try await needs
    }
    func post(_ text: String) async throws {
        guard let service, let bot = openBot, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AppFailure.invalidMessage }
        let key: String
        if let pendingPost, pendingPost.thread == bot.threadID, pendingPost.text == text { key = pendingPost.key }
        else { key = UUID().uuidString }
        pendingPost = (bot.threadID, text, key)
        _ = try await service.call("thread_post", ["thread_id": .string(bot.threadID), "body": .string(text), "idempotency_key": .string(key)])
        pendingPost = nil
        do { try await readThread(bot, incremental: true) } catch { self.error = safeError(error) }
    }
    func create(_ draft: NewBotDraft) async throws {
        guard draft.missing == nil, let service else { throw AppFailure.invalidResponse }
        var lead = draft.lead.isEmpty ? (createdLeads[draft.agentKey] ?? "") : draft.lead
        if lead.isEmpty {
            let agent = try await service.call("agent_create", ["name": .string(draft.name + " lead"), "role": .string("Lead"), "instructions": .string(draft.job), "scope": .string(draft.project), "runner": .object(["mode": .string("auto")]), "edits": .bool(false), "idempotency_key": .string(draft.agentKey)])
            lead = agent["agent"]["id"].string
            guard !lead.isEmpty else { throw AppFailure.invalidResponse }
            createdLeads[draft.agentKey] = lead
        }
        let result = try await service.call("bot_create", ["name": .string(draft.name), "job": .string(draft.job), "scope": .string(draft.project), "lead_agent_id": .string(lead), "member_agent_ids": .array([]), "rules": .object(["first_reply": .string(draft.firstReply)]), "idempotency_key": .string(draft.botKey)])
        let bot = Bot(raw: result["bot"])
        guard !bot.id.isEmpty else { throw AppFailure.invalidResponse }
        createdLeads.removeValue(forKey: draft.agentKey)
        if !bots.contains(where: { $0.id == bot.id }) { bots.append(bot) }
    }
    func save(_ bot: Bot) async throws {
        guard let service, bot.raw["version"].int > 0 else { throw AppFailure.invalidResponse }
        var input = bot.raw.object.filter { ["name", "job", "lead_agent_id", "member_agent_ids", "routing", "rules", "starred"].contains($0.key) }
        input["bot_id"] = .string(bot.id); input["expected_version"] = bot.raw["version"]
        let updated = Bot(raw: try await service.call("bot_update", input)["bot"])
        // Server enforces uniqueness; refresh both the newly and previously starred rows.
        bots = try await allPages(service, "bot_list", key: "bots").map { Bot(raw: $0) }
        if openBot?.id == updated.id { openBot = updated }
    }
    func resolve(_ id: String) async throws {
        guard let service else { return }
        let task = try await service.call("task_get", ["task_id": .string(id)])["task"]
        _ = try await service.call("task_resolve", ["task_id": .string(id), "expected_version": task["version"], "resolved": .bool(true)])
        if let bot = openBot { try await readThread(bot) }
        try await loadTasks()
    }
    func signOut() async throws {
        guard !signingOut else { return }
        signingOut = true
        defer { signingOut = false }
        if let pushToken, let service {
            _ = try? await service.call("push_unregister", ["token": .string(pushToken)])
        }
        try keychain.delete()
        pushToken = nil; didLoadBots = false; pendingPushBotID = nil; visibleThreadBotID = nil
        streamTask?.cancel(); presenceTask?.cancel()
        if let service = service as? RelayService { await service.transport.disconnect() }
        service = nil; connected = false; online = false; openBot = nil
        bots = []; messages = []; typing = []; tasks = []; attention = []; agents = []; status = .null; cursor = "now"
    }
}

@MainActor enum AskStarredBot {
    nonisolated static let later = "Your reply will come in the app."
    static func run(service: any HostService, message: String, timeout: Double = 30,
                    poll: Duration = .milliseconds(500)) async throws -> String {
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AppFailure.invalidMessage }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(timeout))
        // One deadline includes discovery, post and reply; no automatic mutation retries.
        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                let bots = try await allPages(service, "bot_list", key: "bots").map { Bot(raw: $0) }
                guard let bot = Bot.shortcut(bots) else { throw AppFailure.noStar }
                let initial = try await service.call("thread_read", ["thread_id": .string(bot.threadID), "limit": .number(100)])
                let baseline = initial["messages"].array.map { $0["seq"].int }.max() ?? 0
                let posted = try await service.call("thread_post", ["thread_id": .string(bot.threadID), "body": .string(message), "idempotency_key": .string(UUID().uuidString)])
                let seq = max(baseline, posted["message"]["seq"].int)
                while !Task.isCancelled {
                    let page = try await service.call("thread_read", ["thread_id": .string(bot.threadID), "after_seq": .number(Double(seq)), "limit": .number(100)])
                    if let reply = page["messages"].array.map({ Message(raw: $0) }).first(where: { $0.seq > seq && $0.raw["author"]["kind"].string == "agent" && $0.kind == "text" && !$0.text.isEmpty }) { return reply.text }
                    try await Task.sleep(for: poll)
                }
                return later
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                if let relay = service as? RelayService { await relay.transport.disconnect() }
                return later
            }
            defer { group.cancelAll() }
            do { return try await group.next()! }
            catch { if Task.isCancelled || clock.now >= deadline { return later }; throw error }
        }
    }
}
