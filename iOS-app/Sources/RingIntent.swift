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
    /// §11.3: this install's random id and the capabilities it can run (empty = none allowed yet, still device-capable).
    let deviceID: String?
    let deviceActions: [String]?

    enum CodingKeys: String, CodingKey {
        case memoID = "memo_id", threadID = "thread_id", transcript, capturedAt = "captured_at", spokenAt = "spoken_at"
        case timeZone = "time_zone", durationSeconds = "duration_seconds", source, timings
        case deviceID = "device_id", deviceActions = "device_actions"
    }

    init(memoID: String, threadID: String, transcript: String, capturedAt: Date, spokenAt: Date, timeZone: TimeZone = .current,
         durationSeconds: Double? = nil, source: String = "ring", timings: [String: Int]? = nil,
         deviceID: String? = nil, deviceActions: [String]? = nil) {
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
        let device = deviceID.flatMap { UUID(uuidString: $0) }?.uuidString.lowercased()
        self.deviceID = device
        // Requires device_id; ≤ 8 unique names of ≤ 32 characters.
        var names: [String] = []
        for name in deviceActions ?? [] where !name.isEmpty && name.count <= 32 && !names.contains(name) && names.count < 8 { names.append(name) }
        self.deviceActions = device == nil ? nil : deviceActions.map { _ in names }
    }

    /// Tool arguments with the same keys as the Codable form.
    var arguments: [String: JSON] {
        var args: [String: JSON] = ["memo_id": .string(memoID), "thread_id": .string(threadID), "transcript": .string(transcript),
                                    "captured_at": .string(capturedAt), "spoken_at": .string(spokenAt), "time_zone": .string(timeZone),
                                    "source": .string(source)]
        if let durationSeconds { args["duration_seconds"] = .number(durationSeconds) }
        if let timings { args["timings"] = .object(timings.mapValues { JSON.number(Double($0)) }) }
        if let deviceID { args["device_id"] = .string(deviceID) }
        if let deviceActions { args["device_actions"] = .strings(deviceActions) }
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
        /// "mac" (default, older hosts) or "device": this iPhone runs `action` (§11.3).
        let runner: String
        let action: DeviceAction?
        enum CodingKeys: String, CodingKey { case id, type, status, summary, undoable, runner, action }
        init(id: String, type: String, status: String, summary: String, undoable: Bool, runner: String = "mac", action: DeviceAction? = nil) {
            self.id = id; self.type = type; self.status = status; self.summary = summary; self.undoable = undoable
            self.runner = runner; self.action = action
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            type = try c.decode(String.self, forKey: .type)
            status = try c.decode(String.self, forKey: .status)
            summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
            undoable = try c.decodeIfPresent(Bool.self, forKey: .undoable) ?? false
            runner = try c.decodeIfPresent(String.self, forKey: .runner) ?? "mac"
            action = (try? c.decodeIfPresent(DeviceAction.self, forKey: .action)) ?? nil
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
    /// Own bound for `voice_intent`, well under the relay's generic 15 s (docs/perf F2).
    static let intentTimeout: Double = 6

    @MainActor static func send(_ request: VoiceIntentRequest, service: any HostService, timeout: Double = intentTimeout) async throws -> VoiceIntentResult {
        let args = request.arguments
        let raw: JSON
        do { raw = try await call(service, "voice_intent", args, seconds: timeout) }
        catch let error where resends(error) {
            // A warm socket the OS closed in the background fails its first send; a half-open one never answers and
            // times out (which drops the socket). The host dedupes on (thread_id, memo_id), so exactly one resend on
            // a fresh connection cannot run the action twice.
            raw = try await call(service, "voice_intent", args, seconds: timeout)
        }
        let result = try decode(raw)
        guard result.memoID.lowercased() == request.memoID.lowercased() else { throw Failure.mismatched }
        return result
    }

    /// Failures after which an idempotent call may be sent once more on a fresh connection.
    static func resends(_ error: Error) -> Bool {
        if let failure = error as? SwarmaRelayTransport.Failure { return failure == .closed }
        if let failure = error as? AppFailure, case .timeout = failure { return true }
        return false
    }

    /// One tool call with its own deadline. On a relay, a timeout drops the socket first (unblocking the pending
    /// send without cancelling it, so no late disconnect can hit the next connection) and then throws
    /// `AppFailure.timeout`; the next call reconnects.
    @MainActor static func call(_ service: any HostService, _ tool: String, _ args: [String: JSON], seconds: Double) async throws -> JSON {
        let race = Race()
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<JSON, Error>) in
            race.continuation = c
            Task { @MainActor in
                do { race.finish(.success(try await service.call(tool, args))) }
                catch { race.finish(.failure(error)) }
            }
            race.timer = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(max(0.1, seconds) * 1_000_000_000))
                guard !Task.isCancelled, race.continuation != nil else { return }
                if let relay = service as? RelayService { await relay.transport.disconnect() }
                race.finish(.failure(AppFailure.timeout))
            }
        }
    }
    @MainActor private final class Race {
        var continuation: CheckedContinuation<JSON, Error>?
        var timer: Task<Void, Never>?
        func finish(_ result: Result<JSON, Error>) {
            guard let c = continuation else { return }
            continuation = nil
            timer?.cancel(); timer = nil
            c.resume(with: result)
        }
    }

    static func decode(_ raw: JSON) throws -> VoiceIntentResult {
        try JSONDecoder().decode(VoiceIntentResult.self, from: JSONEncoder().encode(raw))
    }

    /// Statuses that mean the Mac hasn't finished the action yet.
    static func isPending(_ action: VoiceIntentResult.Action) -> Bool { action.status == "queued" || action.status == "running" }
    static func isPending(_ result: VoiceIntentResult) -> Bool { result.actions.contains { isPending($0) } }
    /// Only Mac rows are worth the follow-up `local_action_list` read; device rows finish on this iPhone.
    static func isPendingOnMac(_ result: VoiceIntentResult) -> Bool { result.actions.contains { $0.runner != "device" && isPending($0) } }
    /// A device row this iPhone should run now.
    static func runsHere(_ action: VoiceIntentResult.Action) -> Bool { action.runner == "device" && action.status == "queued" && action.action != nil }

    /// `local_action_report` (§11.3). Its answer is `{action: view}`; the host formats the card.
    @MainActor static func report(_ report: DeviceReport, service: any HostService, timeout: Double = intentTimeout) async throws -> JSON {
        try await call(service, "local_action_report", report.arguments, seconds: timeout)
    }

    /// Replaces the result's actions with the same ids from a later read; others stay as they were.
    static func merging(_ result: VoiceIntentResult, with fresh: [VoiceIntentResult.Action]) -> VoiceIntentResult {
        let byID = Dictionary(fresh.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return VoiceIntentResult(memoID: result.memoID, route: result.route, messageSeq: result.messageSeq,
                                 actions: result.actions.map { byID[$0.id] ?? $0 }, delegatedTo: result.delegatedTo)
    }
    /// Actions of a `local_action_list` answer (`{actions:[{id,type,status,summary,undoable,…}]}`); bad rows are skipped.
    static func listedActions(_ listed: JSON) -> [VoiceIntentResult.Action] {
        (try? listedActions(JSONEncoder().encode(listed))) ?? []
    }
    static func listedActions(_ data: Data) throws -> [VoiceIntentResult.Action] {
        struct Row: Decodable { let action: VoiceIntentResult.Action?
            init(from decoder: Decoder) throws { action = try? VoiceIntentResult.Action(from: decoder) } }
        struct List: Decodable { let actions: [Row]? }
        return (try JSONDecoder().decode(List.self, from: data).actions ?? []).compactMap(\.action)
    }

    /// Lock-screen text for a result. Content is built and shown on this iPhone only (never via APNs).
    static func notificationText(_ result: VoiceIntentResult) -> (title: String, body: String) {
        let summaries = result.actions.prefix(5).map { $0.summary.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { String($0.prefix(300)) }
        let failed = result.actions.contains { $0.status == "failed" || $0.status == "blocked" }
        let pending = !failed && isPending(result)
        switch result.route {
        case "local" where !summaries.isEmpty, "device" where !summaries.isEmpty:
            return (failed ? "Ring memo needs attention" : pending ? "Working on it…" : "Ring memo", summaries.joined(separator: "\n"))
        case "local" where pending:
            return ("Working on it…", "Your Mac is finishing the action.")
        case "device" where pending:
            return ("Working on it…", "Your iPhone is finishing the action.")
        case "device":
            return (failed ? "Ring memo needs attention" : "Ring memo", "Done on this iPhone")
        case "delegate":
            let name = result.delegatedTo?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return (pending ? "Working on it…" : "Ring memo", name.isEmpty ? "Sent to your bot" : "Sent to \(name.prefix(80))")
        default:
            return (pending ? "Working on it…" : "Ring memo", "Sent to Assistant")
        }
    }

    static func notificationIdentifier(_ result: VoiceIntentResult) -> String { "ring-intent-" + result.memoID.lowercased() }

    /// Lock-screen Undo for a device action (§11.4): a background action, so undo runs without opening the app.
    static let actionCategory = "RING_ACTION", undoAction = "RING_UNDO"
    static var category: UNNotificationCategory {
        UNNotificationCategory(identifier: actionCategory, actions: [UNNotificationAction(identifier: undoAction, title: "Undo", options: [])],
                               intentIdentifiers: [], options: [])
    }
    /// The action id and handle carried by a RING_ACTION notification.
    static func undoRequest(_ userInfo: [AnyHashable: Any]) -> (id: String, handle: String)? {
        guard let id = userInfo["action_id"] as? String, let handle = userInfo["handle"] as? String,
              !id.isEmpty, id.count <= 64, !handle.isEmpty, handle.count <= 1024 else { return nil }
        return (id, handle)
    }

    /// Posts (or, with the same identifier, replaces) the result notification. The follow-up after a poll is silent.
    /// `undo` adds the RING_ACTION Undo button for one finished device action.
    static func notify(_ result: VoiceIntentResult, sound: Bool = true, undo: (id: String, handle: String)? = nil) {
        let text = notificationText(result)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        content.threadIdentifier = "ring-memo"
        if sound { content.sound = .default }
        if let undo {
            content.categoryIdentifier = actionCategory
            content.userInfo = ["action_id": undo.id, "handle": undo.handle]
        } else if result.actions.contains(where: { $0.status == "blocked" }) {
            content.userInfo = [DevicePermissions.openKey: DevicePermissions.openValue]
        }
        let request = UNNotificationRequest(identifier: notificationIdentifier(result), content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

/// Pure timing and retry rules for the ring path (docs/perf/ring-latency-2026-11-22.md F9–F11).
enum RingPolicy {
    /// Wait for the live recognizer's final answer: short, because background time is short.
    static func liveTimeout(duration: Double) -> Double { min(8, 2 + 0.05 * clean(duration)) }
    /// Whole-file fallback recognition.
    static func fileTimeout(duration: Double) -> Double { min(20, 4 + 0.5 * clean(duration)) }
    /// In the background, a recognizer error on the live stream means the file recognizer would fail too;
    /// a live timeout or our own decode failure still deserves the file attempt.
    static func tryFileFallback(background: Bool, liveRecognizerFailed: Bool) -> Bool { !(background && liveRecognizerFailed) }
    /// Consecutive aborted downloads that still schedule a re-check (the next idle push retries regardless).
    static let maxAbortRetries = 3
    static let abortRetryDelay: UInt64 = 2
    static func retriesAfterAbort(streak: Int) -> Bool { streak >= 1 && streak <= maxAbortRetries }
    /// Length of a saved ring M4A from its size (32 kbit/s AAC) when no live capture says it.
    static func estimatedDuration(bytes: Int) -> Double { Double(max(0, bytes)) / 4000 }
    private static func clean(_ value: Double) -> Double { value.isFinite ? max(0, value) : 0 }

    /// Paths of memos saved (ring copy deleted) but not yet handed to the delivery manifest: `ring.undelivered`.
    static let undeliveredLimit = 50
    static func adding(_ path: String, to list: [String]) -> [String] {
        Array((list.filter { $0 != path } + [path]).suffix(undeliveredLimit))
    }
    static func removing(_ path: String, from list: [String]) -> [String] { list.filter { $0 != path } }
    /// Undelivered memos to replay now: in the signed-in generation's folder, still on disk, not already being delivered.
    static func replayable(_ list: [String], generation: String, busy: Set<String>, exists: (String) -> Bool) -> [URL] {
        var seen = Set<String>()
        return list.compactMap { path in
            let url = URL(fileURLWithPath: path)
            let memo = url.deletingPathExtension().lastPathComponent.lowercased()
            guard url.pathExtension == "m4a", url.deletingLastPathComponent().lastPathComponent == generation,
                  !busy.contains(memo), seen.insert(memo).inserted, exists(path) else { return nil }
            return url
        }
    }
}
