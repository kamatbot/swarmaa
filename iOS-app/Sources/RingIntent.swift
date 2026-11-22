import Foundation
import UserNotifications

/// `voice_intent` request (docs/RING-AGENT.md §8.2). Dates are ISO 8601 strings, as the host expects.
struct VoiceIntentRequest: Codable, Equatable, Sendable {
    static let transcriptLimit = 16_384
    let memoID: String
    let threadID: String
    let transcript: String
    let capturedAt: String
    let spokenAt: String
    let timeZone: String
    let durationSeconds: Double?
    let source: String
    let timings: [String: Int]?

    enum CodingKeys: String, CodingKey {
        case memoID = "memo_id", threadID = "thread_id", transcript, capturedAt = "captured_at", spokenAt = "spoken_at"
        case timeZone = "time_zone", durationSeconds = "duration_seconds", source, timings
    }

    init(memoID: String, threadID: String, transcript: String, capturedAt: Date, spokenAt: Date, timeZone: TimeZone = .current,
         durationSeconds: Double? = nil, source: String = "ring", timings: [String: Int]? = nil) {
        let iso = ISO8601DateFormatter()
        self.memoID = memoID.lowercased()
        self.threadID = threadID.lowercased()
        self.transcript = String(transcript.prefix(Self.transcriptLimit))
        self.capturedAt = iso.string(from: capturedAt)
        self.spokenAt = iso.string(from: spokenAt)
        self.timeZone = String(timeZone.identifier.prefix(64))
        self.durationSeconds = durationSeconds.flatMap { $0.isFinite && $0 >= 0 ? ($0 * 10).rounded() / 10 : nil }
        self.source = source
        self.timings = timings?.isEmpty == true ? nil : timings
    }

    /// Tool arguments with the same keys as the Codable form.
    var arguments: [String: JSON] {
        var args: [String: JSON] = ["memo_id": .string(memoID), "thread_id": .string(threadID), "transcript": .string(transcript),
                                    "captured_at": .string(capturedAt), "spoken_at": .string(spokenAt), "time_zone": .string(timeZone),
                                    "source": .string(source)]
        if let durationSeconds { args["duration_seconds"] = .number(durationSeconds) }
        if let timings { args["timings"] = .object(timings.mapValues { JSON.number(Double($0)) }) }
        return args
    }
}

/// `voice_intent` response. Missing optional fields decode as empty so newer hosts can add fields.
struct VoiceIntentResult: Codable, Equatable, Sendable {
    struct Action: Codable, Equatable, Sendable {
        let id: String
        let type: String
        let status: String
        let summary: String
        let undoable: Bool
        enum CodingKeys: String, CodingKey { case id, type, status, summary, undoable }
        init(id: String, type: String, status: String, summary: String, undoable: Bool) {
            self.id = id; self.type = type; self.status = status; self.summary = summary; self.undoable = undoable
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            type = try c.decode(String.self, forKey: .type)
            status = try c.decode(String.self, forKey: .status)
            summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
            undoable = try c.decodeIfPresent(Bool.self, forKey: .undoable) ?? false
        }
    }
    struct Delegate: Codable, Equatable, Sendable {
        let botID: String
        let name: String
        enum CodingKeys: String, CodingKey { case botID = "bot_id", name }
    }
    let memoID: String
    let route: String
    let messageSeq: Int?
    let actions: [Action]
    let delegatedTo: Delegate?

    enum CodingKeys: String, CodingKey { case memoID = "memo_id", route, messageSeq = "message_seq", actions, delegatedTo = "delegated_to" }

    init(memoID: String, route: String, messageSeq: Int? = nil, actions: [Action] = [], delegatedTo: Delegate? = nil) {
        self.memoID = memoID; self.route = route; self.messageSeq = messageSeq; self.actions = actions; self.delegatedTo = delegatedTo
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memoID = try c.decode(String.self, forKey: .memoID)
        route = try c.decode(String.self, forKey: .route)
        messageSeq = try c.decodeIfPresent(Int.self, forKey: .messageSeq)
        actions = try c.decodeIfPresent([Action].self, forKey: .actions) ?? []
        delegatedTo = try c.decodeIfPresent(Delegate.self, forKey: .delegatedTo)
    }
}

/// Milliseconds since the ring's idle edge (or since the count request when there was none), §6.1.
struct RingTimings: Sendable {
    static let order = ["idle", "count_reply", "first_packet", "last_packet", "saved", "transcribed", "intent_ack", "audio_stored"]
    let origin: Date
    /// True when `origin` is the ring's recording-stopped push, i.e. when speech ended.
    let fromIdleEdge: Bool
    private(set) var marks: [String: Int] = [:]
    init(origin: Date = Date(), fromIdleEdge: Bool) {
        self.origin = origin
        self.fromIdleEdge = fromIdleEdge
        if fromIdleEdge { marks["idle"] = 0 }
    }
    /// Records the first time a stage is reached; later calls keep the first value.
    @discardableResult mutating func mark(_ name: String, at date: Date = Date()) -> Int {
        if let existing = marks[name] { return existing }
        let ms = max(0, Int((date.timeIntervalSince(origin) * 1000).rounded()))
        marks[name] = ms
        return ms
    }
    var line: String {
        let known = Self.order.compactMap { key in marks[key].map { "\(key)=\($0)" } }
        let extra = marks.keys.filter { !Self.order.contains($0) }.sorted().compactMap { key in marks[key].map { "\(key)=\($0)" } }
        return (known + extra).joined(separator: " ")
    }
}

/// Client for the host's `voice_intent` tool and the local result notification.
enum RingIntent {
    enum Failure: Error, Equatable { case mismatched }

    @MainActor static func send(_ request: VoiceIntentRequest, service: any HostService) async throws -> VoiceIntentResult {
        let args = request.arguments
        let raw: JSON
        do { raw = try await service.call("voice_intent", args) }
        catch SwarmaRelayTransport.Failure.closed {
            // A warm socket the OS closed in the background fails its first send. The host dedupes on
            // (thread_id, memo_id), so one resend on a fresh connection cannot run the action twice.
            raw = try await service.call("voice_intent", args)
        }
        let result = try decode(raw)
        guard result.memoID.lowercased() == request.memoID.lowercased() else { throw Failure.mismatched }
        return result
    }

    static func decode(_ raw: JSON) throws -> VoiceIntentResult {
        try JSONDecoder().decode(VoiceIntentResult.self, from: JSONEncoder().encode(raw))
    }

    /// Lock-screen text for a result. Content is built and shown on this iPhone only (never via APNs).
    static func notificationText(_ result: VoiceIntentResult) -> (title: String, body: String) {
        let summaries = result.actions.prefix(5).map { $0.summary.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { String($0.prefix(300)) }
        switch result.route {
        case "local" where !summaries.isEmpty:
            let failed = result.actions.contains { $0.status == "failed" }
            return (failed ? "Ring memo needs attention" : "Ring memo", summaries.joined(separator: "\n"))
        case "delegate":
            let name = result.delegatedTo?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return ("Ring memo", name.isEmpty ? "Sent to your bot" : "Sent to \(name.prefix(80))")
        default:
            return ("Ring memo", "Sent to Assistant")
        }
    }

    static func notify(_ result: VoiceIntentResult) {
        let text = notificationText(result)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        content.threadIdentifier = "ring-memo"
        let request = UNNotificationRequest(identifier: "ring-intent-" + result.memoID.lowercased(), content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
