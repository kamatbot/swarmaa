import Foundation

/// What `swarm_status` returns: the workers on this Mac, how much of each
/// vendor's quota they have left, and what every project scope is doing.
///
/// Keys are spelled out rather than converted: `convertFromSnakeCase` turns
/// `completed_24h` into `completed24H`, which no property is called.
///
/// Every list defaults to empty rather than failing the decode. The service is
/// ours but it moves faster than this app, and a worker row missing one array
/// should still draw a cell, not blank the whole notch.
struct SwarmaStatus: Decodable, Equatable {
    struct Worker: Equatable {
        struct Running: Decodable, Equatable {
            let taskId: String
            let scope: String?
            /// The fields below are newer-service only; an older one omits them.
            var kind: String? = nil
            var objective: String? = nil
            var requiredCapability: String? = nil
            var startedAt: Date? = nil
            private enum CodingKeys: String, CodingKey {
                case taskId = "task_id", scope, kind, objective
                case requiredCapability = "required_capability", startedAt = "started_at"
            }
        }
        let name: String
        let lastSeenAt: Date?
        let live: Bool
        let running: [Running]
        let providers: [String]
    }

    struct Usage: Equatable {
        struct Window: Decodable, Equatable {
            let name: String?
            let usedPercent: Double?
            let resetsAt: Date?
            private enum CodingKeys: String, CodingKey { case name, usedPercent = "used_percent", resetsAt = "resets_at" }
        }
        let provider: String
        let ok: Bool
        /// Percent of the quota left, 0...100. Nil when the vendor could not be read.
        let headroom: Double?
        let windows: [Window]
        let plan: String?
        let error: String?
        let fetchedAt: Date?
    }

    struct Scope: Equatable {
        let scope: String
        let queued: Int
        let running: Int
        let blocked: Int
        let completed24h: Int
        let failed24h: Int
    }

    struct TaskRow: Equatable {
        let id: String
        let scope: String?
        let kind: String?
        let status: String?
        /// The optimistic-concurrency token `task_cancel` insists on.
        let version: Int?
        let objective: String?
        let requiredCapability: String?
        let updatedAt: Date?
        let worker: String?
        /// Newer services only: who ran it, and what it left behind.
        var provider: String? = nil
        var branch: String? = nil
        var changedFiles: Int? = nil
        private enum CodingKeys: String, CodingKey {
            case id, scope, kind, status, version, objective, worker, provider, branch
            case changedFiles = "changed_files"
            case requiredCapability = "required_capability", updatedAt = "updated_at"
        }
    }

    /// A chat that was active in the last 15 minutes, on any harness. Newer
    /// services only; an older one sends none.
    struct Session: Equatable {
        let id: String
        /// "claude-code", "codex", "antigravity", "dot", "grok" or "other".
        let harness: String
        let title: String
        let scope: String?
        let updatedAt: Date?
    }

    /// Where the service would send new work, and why. Newer services only.
    struct Routing: Equatable {
        struct Provider: Equatable {
            let provider: String
            let headroom: Double?
            let liveWorker: Bool
            let windows: [Usage.Window]
        }
        /// Nil when no vendor has room, or none has a live worker.
        /// Who `by_kind` names for one kind of work, and why. Nil provider: nobody qualifies.
        struct Choice: Equatable {
            let provider: String?
            let reason: String
        }
        let recommended: String?
        let reason: String?
        let providers: [Provider]
        /// Absent on a service that predates routing rules.
        var policy: RoutingPolicy? = nil
        var isDefault: Bool = false
        var byKind: [String: Choice] = [:]
    }

    var workers: [Worker] = []
    var usage: [Usage] = []
    var scopes: [Scope] = []
    var recent: [TaskRow] = []
    var sessions: [Session] = []
    var routing: Routing?
    /// Candidate lessons waiting for review. Newer services only; an older one sends none.
    var lessonsPending: Int = 0
    var generatedAt: Date?

    init(workers: [Worker] = [], usage: [Usage] = [], scopes: [Scope] = [],
         recent: [TaskRow] = [], sessions: [Session] = [], routing: Routing? = nil,
         lessonsPending: Int = 0, generatedAt: Date? = nil) {
        self.lessonsPending = lessonsPending
        self.workers = workers
        self.usage = usage
        self.scopes = scopes
        self.recent = recent
        self.sessions = sessions
        self.routing = routing
        self.generatedAt = generatedAt
    }
}

private extension KeyedDecodingContainer {
    /// An absent or malformed list is an empty one; see `SwarmaStatus`.
    func list<T: Decodable>(_ key: Key) -> [T] {
        ((try? decodeIfPresent([T].self, forKey: key)) ?? nil) ?? []
    }
}

extension SwarmaStatus {
    private enum CodingKeys: String, CodingKey { case workers, usage, scopes, recent, sessions, routing, generatedAt = "generated_at", lessonsPending = "lessons_pending" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workers = c.list(.workers)
        usage = c.list(.usage)
        scopes = c.list(.scopes)
        recent = c.list(.recent)
        sessions = c.list(.sessions)
        routing = ((try? c.decodeIfPresent(Routing.self, forKey: .routing)) ?? nil)
        generatedAt = try c.decodeIfPresent(Date.self, forKey: .generatedAt)
        lessonsPending = max(0, (try? c.decodeIfPresent(Int.self, forKey: .lessonsPending)) ?? 0)
    }
}

extension SwarmaStatus.Worker: Decodable {
    private enum CodingKeys: String, CodingKey { case name, lastSeenAt = "last_seen_at", live, running, providers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        lastSeenAt = try c.decodeIfPresent(Date.self, forKey: .lastSeenAt)
        live = try c.decodeIfPresent(Bool.self, forKey: .live) ?? false
        running = c.list(.running)
        providers = c.list(.providers)
    }
}

extension SwarmaStatus.Usage: Decodable {
    private enum CodingKeys: String, CodingKey { case provider, ok, headroom, windows, plan, error, fetchedAt = "fetched_at" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        headroom = try c.decodeIfPresent(Double.self, forKey: .headroom)
        windows = c.list(.windows)
        plan = try c.decodeIfPresent(String.self, forKey: .plan)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        fetchedAt = try c.decodeIfPresent(Date.self, forKey: .fetchedAt)
    }
}

extension SwarmaStatus.Scope: Decodable {
    private enum CodingKeys: String, CodingKey { case scope, queued, running, blocked, completed24h = "completed_24h", failed24h = "failed_24h" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scope = try c.decode(String.self, forKey: .scope)
        queued = try c.decodeIfPresent(Int.self, forKey: .queued) ?? 0
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? 0
        blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
        completed24h = try c.decodeIfPresent(Int.self, forKey: .completed24h) ?? 0
        failed24h = try c.decodeIfPresent(Int.self, forKey: .failed24h) ?? 0
    }
}

extension SwarmaStatus.TaskRow: Decodable {}

extension SwarmaStatus.Session: Decodable {
    private enum CodingKeys: String, CodingKey { case id, harness, title, scope, updatedAt = "updated_at" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        harness = try c.decodeIfPresent(String.self, forKey: .harness) ?? "other"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        scope = try c.decodeIfPresent(String.self, forKey: .scope)
        // One unreadable timestamp must not cost the notch every chat.
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? nil
    }
}

extension SwarmaStatus.Routing.Provider: Decodable {
    private enum CodingKeys: String, CodingKey { case provider, headroom, liveWorker = "live_worker", windows }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        headroom = try c.decodeIfPresent(Double.self, forKey: .headroom)
        liveWorker = try c.decodeIfPresent(Bool.self, forKey: .liveWorker) ?? false
        windows = c.list(.windows)
    }
}

extension SwarmaStatus.Routing: Decodable {
    private enum CodingKeys: String, CodingKey { case recommended, reason, providers, policy, isDefault = "is_default", byKind = "by_kind" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recommended = try c.decodeIfPresent(String.self, forKey: .recommended)
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        providers = c.list(.providers)
        policy = (try? c.decodeIfPresent(RoutingPolicy.self, forKey: .policy)) ?? nil
        isDefault = (try? c.decodeIfPresent(Bool.self, forKey: .isDefault)) ?? false
        byKind = ((try? c.decodeIfPresent([String: Choice].self, forKey: .byKind)) ?? nil) ?? [:]
    }
}

extension SwarmaStatus.Routing.Choice: Decodable {
    private enum CodingKeys: String, CodingKey { case provider, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? nil
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
    }
}

/// A running task a cell can offer to cancel. The version is part of it
/// because `task_cancel` refuses a stale one.
struct SwarmaCancelTarget: Equatable {
    let taskID: String
    let version: Int
    let title: String
}

/// Client for the local Swarma service (`POST {serviceURL}/api/tools/<tool>`).
///
/// One `swarm_status` answer feeds every cell: an agent cell and a swarm cell
/// are each a provider, and each provider fetches on its own, so without
/// sharing a single refresh would be a dozen identical requests. The answer —
/// or the failure — is held for `cacheTTL`, and concurrent callers share the
/// request already in flight.
///
/// The bearer token is read from its file on each request and goes nowhere
/// else: not into the cache, not into an error, not into the log.
actor SwarmaClient {
    static let shared = SwarmaClient()

    /// Everything that can go wrong, each already phrased for a cell.
    enum Failure: Error, Equatable {
        case badURL
        case insecureURL
        case noToken
        case unauthorized
        /// 403: the token is fine but lacks a permission (e.g. `lesson:review`).
        case forbidden
        case http(Int)
        case unreachable
        case badResponse
        /// `routing_set` refused the policy (400 invalid_policy); the service's own words.
        case invalidPolicy(String)

        var message: String {
            switch self {
            case .unreachable:   return L10n.t("Swarmaa not running")
            case .noToken:       return L10n.t("Swarmaa token file unreadable")
            case .unauthorized:  return L10n.t("Swarmaa rejected the token")
            case .forbidden:     return L10n.t("This Mac's Swarmaa connection can't review lessons yet")
            case .badURL:        return L10n.t("Swarmaa service URL is invalid")
            case .insecureURL:   return L10n.t("Swarmaa needs https off this Mac")
            case .http(let status): return L10n.t("Swarmaa error (HTTP \(status))")
            case .badResponse:   return L10n.t("Unexpected Swarmaa response")
            case .invalidPolicy(let text): return text
            }
        }
    }

    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let serviceURL: @Sendable () -> String
    private let tokenPath: @Sendable () -> String
    private let transport: Transport
    private let cacheTTL: TimeInterval
    private let now: @Sendable () -> Date
    private let authMode: @Sendable () -> SwarmaAuthMode
    private let oauth: SwarmaOAuthSession

    private var cached: (key: String, at: Date, result: Result<SwarmaStatus, Failure>)?
    private var inFlight: (key: String, task: Task<SwarmaStatus, Error>)?

    init(
        serviceURL: @escaping @Sendable () -> String = { Preferences.storedSwarmaServiceURL() },
        tokenPath: @escaping @Sendable () -> String = { Preferences.storedSwarmaTokenPath() },
        transport: @escaping Transport = SwarmaClient.liveTransport,
        cacheTTL: TimeInterval = 4,
        now: @escaping @Sendable () -> Date = { Date() },
        authMode: @escaping @Sendable () -> SwarmaAuthMode = { Preferences.storedSwarmaAuthMode() },
        oauth: SwarmaOAuthSession = .shared
    ) {
        self.authMode = authMode
        self.oauth = oauth
        self.serviceURL = serviceURL
        self.tokenPath = tokenPath
        self.transport = transport
        self.cacheTTL = cacheTTL
        self.now = now
    }

    // MARK: - Calls

    func status() async throws -> SwarmaStatus {
        let key = serviceURL() + "|" + tokenPath()
        if let cached, cached.key == key, now().timeIntervalSince(cached.at) < cacheTTL {
            return try cached.result.get()
        }
        if let inFlight, inFlight.key == key { return try await inFlight.task.value }

        let task = Task { () throws -> SwarmaStatus in
            let data = try await self.fetch(tool: "swarm_status", body: Data("{}".utf8))
            do {
                return try Self.decoder.decode(Envelope<SwarmaStatus>.self, from: data).result
            } catch {
                throw Failure.badResponse
            }
        }
        inFlight = (key, task)
        defer { inFlight = nil }
        do {
            let status = try await task.value
            cached = (key, now(), .success(status))
            return status
        } catch {
            let failure = error as? Failure ?? .unreachable
            cached = (key, now(), .failure(failure))
            throw failure
        }
    }

    func cancelTask(id: String, expectedVersion: Int) async throws {
        struct Body: Encodable {
            let taskId: String
            let expectedVersion: Int
            enum CodingKeys: String, CodingKey { case taskId = "task_id", expectedVersion = "expected_version" }
        }
        let body = try JSONEncoder().encode(Body(taskId: id, expectedVersion: expectedVersion))
        _ = try await fetch(tool: "task_cancel", body: body)
        // The next look must see the task gone, not the answer from before.
        cached = nil
    }

    // MARK: - Lessons

    func lessons(limit: Int = 50) async throws -> [SwarmaLesson] {
        let body = try JSONSerialization.data(withJSONObject: ["state": "candidate", "limit": limit])
        return try await call("lesson_list", body: body, as: SwarmaLesson.List.self).lessons
    }

    /// `edits` goes on the wire only when it carries a change.
    func review(id: String, action: SwarmaLesson.Action, reason: String? = nil,
                edits: SwarmaLesson.Edits? = nil) async throws -> SwarmaLesson {
        var object: [String: Any] = ["id": id, "action": action.rawValue]
        if let reason, !reason.isEmpty { object["reason"] = reason }
        if let edits, !edits.isEmpty { object["edits"] = try edits.json() }
        let body = try JSONSerialization.data(withJSONObject: object)
        let lesson = try await call("lesson_review", body: body, as: SwarmaLesson.Reviewed.self).lesson
        cached = nil   // lessons_pending changed
        return lesson
    }

    func session(id: String) async throws -> SwarmaSessionDetail {
        let body = try JSONSerialization.data(withJSONObject: ["id": id])
        return try await call("session_get", body: body, as: SwarmaSessionDetail.Wrapper.self).session
    }

    // MARK: - Routing

    func routingGet() async throws -> RoutingGetResult {
        try await call("routing_get", body: Data("{}".utf8), as: RoutingGetResult.self)
    }

    func routingSet(_ policy: RoutingPolicy) async throws -> RoutingSetResult {
        let result = try await call("routing_set", body: policy.requestBody(), as: RoutingSetResult.self)
        cached = nil   // by_kind changed
        return result
    }

    private func call<T: Decodable>(_ tool: String, body: Data, as: T.Type) async throws -> T {
        let data = try await fetch(tool: tool, body: body)
        do { return try Self.decoder.decode(Envelope<T>.self, from: data).result }
        catch { throw Failure.badResponse }
    }

    // MARK: - Requests

    private struct Envelope<T: Decodable>: Decodable { let result: T }

    private struct TokenFile: Decodable { let token: String }

    /// One tool call, answered as `{"result": …}` whichever way it travelled:
    /// REST with the token file, or MCP `tools/call` with the OAuth access
    /// token (REST refuses OAuth tokens). A 401 in OAuth mode refreshes once.
    func fetchRaw(tool: String, body: Data) async throws -> Data { try await fetch(tool: tool, body: body) }

    private func fetch(tool: String, body: Data) async throws -> Data {
        guard authMode() == .oauth else {
            return try await Self.send(makeRequest(tool: tool, body: body), via: transport)
        }
        var forceRefresh = false
        while true {
            let token: String
            do { token = try await oauth.accessToken(forceRefresh: forceRefresh) } catch { throw Failure.unauthorized }
            let request = try Self.mcpRequest(serviceURL: serviceURL(), tool: tool, arguments: body, accessToken: token)
            do {
                return try Self.unwrapMCP(try await Self.send(request, via: transport))
            } catch Failure.unauthorized where !forceRefresh {
                forceRefresh = true
            }
        }
    }

    // MARK: - MCP

    /// `POST {origin}/mcp` with a JSON-RPC `tools/call`; the service is stateless, so no `initialize`.
    nonisolated static func mcpRequest(serviceURL: String, tool: String, arguments: Data, accessToken: String, id: Int = 1) throws -> URLRequest {
        var url = try endpoint(serviceURL, tool: tool)
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw Failure.badURL }
        parts.path = parts.path.replacingOccurrences(of: "/api/tools/\(tool)", with: "/mcp")
        guard let mcp = parts.url else { throw Failure.badURL }
        url = mcp
        let args = (try? JSONSerialization.jsonObject(with: arguments)) as? [String: Any] ?? [:]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("2025-11-25", forHTTPHeaderField: "MCP-Protocol-Version")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": ["name": tool, "arguments": args] as [String: Any],
        ] as [String: Any])
        return request
    }

    /// Maps a JSON-RPC `tools/call` answer onto the REST envelope the decoders expect.
    nonisolated static func unwrapMCP(_ data: Data) throws -> Data {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.badResponse }
        guard let result = root["result"] as? [String: Any] else { throw Failure.badResponse }
        let structured = result["structuredContent"]
        let text = ((result["content"] as? [[String: Any]])?.first?["text"] as? String)
        if result["isError"] as? Bool == true {
            let code = ((text.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: Any])?["error"] as? [String: Any])?["code"] as? String
            // `owner_required`: a permission only the owner can grant (e.g. `answer_questions`).
            if code?.contains("forbidden") == true || code == "permission_denied" || code == "owner_required" { throw Failure.forbidden }
            if code == "unauthorized" { throw Failure.unauthorized }
            // The REST route answers this as a 404; keep the two transports alike.
            if code == "unknown_tool" { throw Failure.http(404) }
            if code == "invalid_policy" { throw Failure.invalidPolicy(Self.invalidPolicyMessage(text.map { Data($0.utf8) })) }
            throw Failure.badResponse
        }
        let value: Any
        if let structured { value = structured }
        else if let text, let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed) { value = parsed }
        else { throw Failure.badResponse }
        return try JSONSerialization.data(withJSONObject: ["result": value])
    }

    /// `GET {serviceURL}/{path}?query` with the same bearer token a tool call
    /// would carry; the teams SSE stream is the one caller.
    func getRequest(path: String, query: [URLQueryItem]) async throws -> URLRequest {
        var url = try Self.endpoint(serviceURL(), path: path)
        if !query.isEmpty, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            parts.queryItems = query
            url = parts.url ?? url
        }
        let token: String
        if authMode() == .oauth {
            do { token = try await oauth.accessToken(forceRefresh: false) } catch { throw Failure.unauthorized }
        } else {
            token = try readToken()
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func makeRequest(tool: String, body: Data) throws -> URLRequest {
        var request = URLRequest(url: try Self.endpoint(serviceURL(), tool: tool))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(try readToken())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    private func readToken() throws -> String {
        let path = (tokenPath() as NSString).expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: path),
              let file = try? JSONDecoder().decode(TokenFile.self, from: data),
              !file.token.isEmpty
        else { throw Failure.noToken }
        return file.token
    }

    /// Plain http only to this Mac. A bearer token over http to anywhere else
    /// would cross the network readable by whoever is on it.
    nonisolated static func endpoint(_ serviceURL: String, tool: String) throws -> URL {
        try endpoint(serviceURL, path: "api/tools/\(tool)")
    }

    nonisolated static func endpoint(_ serviceURL: String, path: String) throws -> URL {
        guard var parts = URLComponents(string: serviceURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host?.lowercased(), !host.isEmpty
        else { throw Failure.badURL }
        if scheme == "http", !["127.0.0.1", "localhost", "::1", "[::1]"].contains(host) {
            throw Failure.insecureURL
        }
        parts.user = nil
        parts.password = nil
        parts.query = nil
        parts.fragment = nil
        let base = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.path = (base.isEmpty ? "" : "/" + base) + "/" + path
        guard let url = parts.url else { throw Failure.badURL }
        return url
    }

    nonisolated static func errorCode(_ data: Data) -> String? {
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (root?["error"] as? [String: Any])?["code"] as? String ?? root?["error"] as? String
    }

    nonisolated static func invalidPolicyMessage(_ data: Data?) -> String {
        let root = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let message = ((root?["error"] as? [String: Any])?["message"] as? String) ?? root?["message"] as? String
        return message ?? L10n.t("The service refused this routing policy")
    }

    private static func send(_ request: URLRequest, via transport: Transport) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch {
            throw Failure.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
        switch http.statusCode {
        case 200..<300: return data
        case 401:       throw Failure.unauthorized
        case 403:       throw Failure.forbidden
        case 400:
            if errorCode(data) == "invalid_policy" { throw Failure.invalidPolicy(invalidPolicyMessage(data)) }
            throw Failure.http(400)
        default:        throw Failure.http(http.statusCode)
        }
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            // The service writes both "…:00Z" and "…:00.123Z".
            let plain = ISO8601DateFormatter()
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = plain.date(from: text) ?? fractional.date(from: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath,
                                                        debugDescription: "Unrecognised date"))
            }
            return date
        }
        return decoder
    }()

    // MARK: - Live transport

    /// Refuses redirects: a 3xx would otherwise carry the Authorization header
    /// to wherever it points, and the token belongs to the configured URL only.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    static let liveTransport: Transport = { request in
        try await session.data(for: request)
    }
}
