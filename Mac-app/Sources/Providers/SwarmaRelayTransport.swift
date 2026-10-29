import Foundation

/// WebSocket transport for communicating with a Swarmaa host through Cloudflare Relay
/// (docs/RELAY.md part R3).
///
/// Thread-safe and actor-safe using an internal lock.
public final class SwarmaRelayTransport: @unchecked Sendable {

    // MARK: - Types

    /// A minimal WebSocket protocol for sending and receiving text frames.
    public protocol SwarmaWebSocket: Sendable {
        func send(_ text: String) async throws
        func receive() async throws -> String
        func close() async
    }

    public typealias WebSocketFactory = @Sendable (URL) -> any SwarmaWebSocket
    public typealias SleepFunction = @Sendable (TimeInterval) async -> Void

    /// Host presence information received from the relay.
    public struct Presence: Equatable, Sendable {
        public let online: Bool
        public let lastSeen: Date?
        public let version: String?

        public init(online: Bool, lastSeen: Date? = nil, version: String? = nil) {
            self.online = online
            self.lastSeen = lastSeen
            self.version = version
        }
    }

    /// Errors produced by relay frame errors or socket disconnections.
    public enum Failure: Error, Equatable, Sendable, CustomStringConvertible, LocalizedError {
        case hostOffline
        case rateLimited
        case forbiddenPath
        case closed
        case badCode
        case other(String)

        public static func map(_ error: String) -> Failure {
            switch error {
            case "host_offline": return .hostOffline
            case "rate_limited": return .rateLimited
            case "forbidden_path": return .forbiddenPath
            case "closed": return .closed
            case "bad_code": return .badCode
            default: return .other(error)
            }
        }

        public var description: String {
            switch self {
            case .hostOffline: return "host_offline"
            case .rateLimited: return "rate_limited"
            case .forbiddenPath: return "forbidden_path"
            case .closed: return "closed"
            case .badCode: return "bad_code"
            case .other(let msg): return msg
            }
        }

        public var errorDescription: String? { description }
    }

    /// Wire protocol frames per docs/RELAY.md.
    public enum RelayFrame: Equatable, Sendable, CustomStringConvertible {
        case hello(role: String, version: String)
        case presence(online: Bool, lastSeen: Date?, version: String?)
        case req(sid: String, method: String, path: String, headers: [String: String], body: String?)
        case res(sid: String, status: Int, headers: [String: String])
        case chunk(sid: String, data: String)
        case end(sid: String, error: String?)
        case ping
        case pong
        case pairRedeem(rid: String, code: String, deviceName: String)
        case pairResult(rid: String, token: String?, error: String?)

        public var description: String {
            switch self {
            case .hello(let role, let version):
                return "RelayFrame.hello(role: \(role), version: \(version))"
            case .presence(let online, _, let version):
                return "RelayFrame.presence(online: \(online), version: \(version ?? "nil"))"
            case .req(let sid, let method, let path, _, _):
                return "RelayFrame.req(sid: \(sid), method: \(method), path: \(path))"
            case .res(let sid, let status, _):
                return "RelayFrame.res(sid: \(sid), status: \(status))"
            case .chunk(let sid, _):
                return "RelayFrame.chunk(sid: \(sid))"
            case .end(let sid, let error):
                return "RelayFrame.end(sid: \(sid), error: \(error ?? "nil"))"
            case .ping:
                return "RelayFrame.ping"
            case .pong:
                return "RelayFrame.pong"
            case .pairRedeem(let rid, _, let deviceName):
                // Never log pairing codes
                return "RelayFrame.pairRedeem(rid: \(rid), device: \(deviceName))"
            case .pairResult(let rid, _, let error):
                // Never log tokens
                return "RelayFrame.pairResult(rid: \(rid), error: \(error ?? "nil"))"
            }
        }

        public func encode() throws -> String {
            var dict: [String: Any] = [:]
            switch self {
            case .hello(let role, let version):
                dict["t"] = "hello"
                dict["role"] = role
                dict["version"] = version
            case .presence(let online, let lastSeen, let version):
                dict["t"] = "presence"
                dict["online"] = online
                if let lastSeen {
                    dict["last_seen"] = Int64(lastSeen.timeIntervalSince1970 * 1000)
                }
                if let version {
                    dict["version"] = version
                }
            case .req(let sid, let method, let path, let headers, let body):
                dict["t"] = "req"
                dict["sid"] = sid
                dict["method"] = method
                dict["path"] = path
                dict["headers"] = headers
                if let body {
                    dict["body"] = body
                } else {
                    dict["body"] = NSNull()
                }
            case .res(let sid, let status, let headers):
                dict["t"] = "res"
                dict["sid"] = sid
                dict["status"] = status
                dict["headers"] = headers
            case .chunk(let sid, let data):
                dict["t"] = "chunk"
                dict["sid"] = sid
                dict["data"] = data
            case .end(let sid, let error):
                dict["t"] = "end"
                dict["sid"] = sid
                if let error {
                    dict["error"] = error
                }
            case .ping:
                dict["t"] = "ping"
            case .pong:
                dict["t"] = "pong"
            case .pairRedeem(let rid, let code, let deviceName):
                dict["t"] = "pair_redeem"
                dict["rid"] = rid
                dict["code"] = code
                dict["device_name"] = deviceName
            case .pairResult(let rid, let token, let error):
                dict["t"] = "pair_result"
                dict["rid"] = rid
                if let token {
                    dict["token"] = token
                }
                if let error {
                    dict["error"] = error
                }
            }
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
            return String(decoding: data, as: UTF8.self)
        }

        public static func decode(from text: String) -> RelayFrame? {
            guard let data = text.data(using: .utf8),
                  let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let t = dict["t"] as? String else {
                return nil
            }
            switch t {
            case "hello":
                guard let role = dict["role"] as? String,
                      let version = dict["version"] as? String else { return nil }
                return .hello(role: role, version: version)
            case "presence":
                let online = dict["online"] as? Bool ?? false
                let version = dict["version"] as? String
                var lastSeen: Date? = nil
                if let num = dict["last_seen"] as? Double {
                    lastSeen = num > 10_000_000_000 ? Date(timeIntervalSince1970: num / 1000.0) : Date(timeIntervalSince1970: num)
                } else if let num = dict["last_seen"] as? Int64 {
                    let d = Double(num)
                    lastSeen = d > 10_000_000_000 ? Date(timeIntervalSince1970: d / 1000.0) : Date(timeIntervalSince1970: d)
                } else if let num = dict["last_seen"] as? Int {
                    let d = Double(num)
                    lastSeen = d > 10_000_000_000 ? Date(timeIntervalSince1970: d / 1000.0) : Date(timeIntervalSince1970: d)
                } else if let str = dict["last_seen"] as? String {
                    if let d = Double(str) {
                        lastSeen = d > 10_000_000_000 ? Date(timeIntervalSince1970: d / 1000.0) : Date(timeIntervalSince1970: d)
                    } else {
                        lastSeen = ISO8601DateFormatter().date(from: str)
                    }
                }
                return .presence(online: online, lastSeen: lastSeen, version: version)
            case "req":
                guard let sid = dict["sid"] as? String,
                      let method = dict["method"] as? String,
                      let path = dict["path"] as? String else { return nil }
                let headers = dict["headers"] as? [String: String] ?? [:]
                let body = dict["body"] as? String
                return .req(sid: sid, method: method, path: path, headers: headers, body: body)
            case "res":
                guard let sid = dict["sid"] as? String else { return nil }
                let status = (dict["status"] as? NSNumber)?.intValue ?? (dict["status"] as? Int ?? 200)
                let headers = dict["headers"] as? [String: String] ?? [:]
                return .res(sid: sid, status: status, headers: headers)
            case "chunk":
                guard let sid = dict["sid"] as? String,
                      let chunkData = dict["data"] as? String else { return nil }
                return .chunk(sid: sid, data: chunkData)
            case "end":
                guard let sid = dict["sid"] as? String else { return nil }
                let error = dict["error"] as? String
                return .end(sid: sid, error: error)
            case "ping":
                return .ping
            case "pong":
                return .pong
            case "pair_redeem":
                guard let rid = dict["rid"] as? String,
                      let code = dict["code"] as? String,
                      let deviceName = dict["device_name"] as? String else { return nil }
                return .pairRedeem(rid: rid, code: code, deviceName: deviceName)
            case "pair_result":
                guard let rid = dict["rid"] as? String else { return nil }
                let token = dict["token"] as? String
                let error = dict["error"] as? String
                return .pairResult(rid: rid, token: token, error: error)
            default:
                // Unknown frame type is dropped per spec
                return nil
            }
        }
    }

    // MARK: - Properties

    public let relay: String
    public let hostID: String
    public let version: String
    public let url: URL

    private let webSocketFactory: WebSocketFactory
    private let sleep: SleepFunction
    private let autoReconnect: Bool

    private let lock = NSLock()
    private var socket: (any SwarmaWebSocket)?
    private var isConnected: Bool = false
    private var isClosedManually: Bool = false
    private var currentBackoff: TimeInterval = 1.0

    private var currentPresence: Presence = Presence(online: false)
    private var presenceContinuations: [UUID: AsyncStream<Presence>.Continuation] = [:]

    private struct SendState {
        let requestURL: URL?
        var statusCode: Int = 200
        var headers: [String: String] = [:]
        var data: Data = Data()
        let continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>
    }

    private struct LiveStreamState {
        let requestURL: URL?
        var headersContinuation: CheckedContinuation<(HTTPURLResponse, AsyncThrowingStream<String, Error>), Error>?
        let streamContinuation: AsyncThrowingStream<String, Error>.Continuation
        let stream: AsyncThrowingStream<String, Error>
    }

    private var inFlightSend: [String: SendState] = [:]
    private var inFlightStream: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    private var inFlightLiveStream: [String: LiveStreamState] = [:]
    private var inFlightPair: [String: CheckedContinuation<String, Error>] = [:]

    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Error>?

    // Allowlisted request headers (lower-cased)
    private static let allowedHeaders: Set<String> = [
        "authorization",
        "accept",
        "content-type",
        "last-event-id"
    ]

    // MARK: - Lock Helper

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    // MARK: - Initialization

    public init(
        relay: String = "relay.swarmaa.com",
        hostID: String,
        version: String = "1.26.0",
        autoConnect: Bool = false,
        autoReconnect: Bool = true,
        session: URLSession = .shared,
        sleep: SleepFunction? = nil,
        webSocketFactory: WebSocketFactory? = nil
    ) {
        self.relay = relay
        self.hostID = hostID
        self.version = version
        self.autoReconnect = autoReconnect
        self.url = Self.makeRelayURL(relay: relay, hostID: hostID) ?? URL(string: "wss://\(relay)/h/\(hostID)")!
        self.sleep = sleep ?? { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
        self.webSocketFactory = webSocketFactory ?? { targetURL in
            let task = session.webSocketTask(with: targetURL)
            return URLSessionWebSocketAdapter(task: task)
        }

        if autoConnect {
            Task { [weak self] in
                try? await self?.connect()
            }
        }
    }

    public convenience init(
        relay: String = "relay.swarmaa.com",
        hostID: String,
        socket: any SwarmaWebSocket,
        version: String = "1.26.0",
        autoReconnect: Bool = false,
        sleep: SleepFunction? = nil
    ) {
        self.init(
            relay: relay,
            hostID: hostID,
            version: version,
            autoConnect: false,
            autoReconnect: autoReconnect,
            sleep: sleep,
            webSocketFactory: { _ in socket }
        )
    }

    deinit {
        pingTask?.cancel()
        receiveTask?.cancel()
        reconnectTask?.cancel()
        connectionTask?.cancel()
    }

    // MARK: - Presence

    public var presence: Presence {
        withLock { currentPresence }
    }

    public var currentPresenceValue: Presence {
        presence
    }

    public var presenceStream: AsyncStream<Presence> {
        AsyncStream { continuation in
            let id = UUID()
            let initial = self.withLock { () -> Presence in
                self.presenceContinuations[id] = continuation
                return self.currentPresence
            }

            continuation.yield(initial)

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.withLock {
                    _ = self.presenceContinuations.removeValue(forKey: id)
                }
            }
        }
    }

    public func makePresenceStream() -> AsyncStream<Presence> {
        presenceStream
    }

    private func updatePresence(_ newPresence: Presence) {
        let continuations = withLock { () -> [AsyncStream<Presence>.Continuation] in
            currentPresence = newPresence
            return Array(presenceContinuations.values)
        }

        for c in continuations {
            c.yield(newPresence)
        }
    }

    // MARK: - Connection Management

    public func connect() async throws {
        try await ensureConnected()
    }

    public func disconnect() async {
        await closeSocket(intentional: true)
    }

    public func close() async {
        await disconnect()
    }

    private enum ConnectionAction {
        case alreadyConnected
        case awaitExisting(Task<Void, Error>)
        case awaitNew(Task<Void, Error>)
    }

    private func ensureConnected() async throws {
        let action = withLock { () -> ConnectionAction in
            if isConnected && socket != nil {
                return .alreadyConnected
            }
            if let existing = connectionTask {
                return .awaitExisting(existing)
            }
            let task = Task<Void, Error> {
                try await self.connectSocket()
            }
            connectionTask = task
            return .awaitNew(task)
        }

        switch action {
        case .alreadyConnected:
            return
        case .awaitExisting(let task):
            try await task.value
        case .awaitNew(let task):
            do {
                try await task.value
                withLock { connectionTask = nil }
            } catch {
                withLock { connectionTask = nil }
                throw error
            }
        }
    }

    private func connectSocket() async throws {
        let ws = webSocketFactory(url)
        withLock {
            self.socket = ws
            self.isConnected = true
            self.isClosedManually = false
        }

        startReceiveTask(for: ws)
        startPingTask()

        // Send client hello
        let hello = RelayFrame.hello(role: "client", version: version)
        let json = try hello.encode()
        do {
            try await ws.send(json)
        } catch {
            await handleSocketDrop(error: error)
            throw error
        }
    }

    private func startReceiveTask(for ws: any SwarmaWebSocket) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let text = try await ws.receive()
                    guard let self else { return }
                    await self.handleIncomingMessage(text)
                } catch {
                    guard let self else { return }
                    await self.handleSocketDrop(error: error)
                    break
                }
            }
        }
    }

    private func startPingTask() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.sleep(25)
                if Task.isCancelled { break }
                let active = self.withLock { self.isConnected && self.socket != nil }
                guard active else { break }

                do {
                    let ping = RelayFrame.ping
                    let json = try ping.encode()
                    try await self.sendRaw(json)
                } catch {
                    await self.handleSocketDrop(error: error)
                    break
                }
            }
        }
    }

    private func sendRaw(_ text: String) async throws {
        let ws = try withLock { () -> any SwarmaWebSocket in
            guard let s = self.socket, self.isConnected else {
                throw Failure.closed
            }
            return s
        }
        try await ws.send(text)
    }

    private func handleIncomingMessage(_ text: String) async {
        guard let frame = RelayFrame.decode(from: text) else { return }
        switch frame {
        case .presence(let online, let lastSeen, let version):
            updatePresence(Presence(online: online, lastSeen: lastSeen, version: version))

        case .res(let sid, let status, let headers):
            let liveRes = withLock { () -> (CheckedContinuation<(HTTPURLResponse, AsyncThrowingStream<String, Error>), Error>, URL?, AsyncThrowingStream<String, Error>)? in
                if var send = inFlightSend[sid] {
                    send.statusCode = status
                    send.headers = headers
                    inFlightSend[sid] = send
                }
                if var live = inFlightLiveStream[sid], let hCont = live.headersContinuation {
                    live.headersContinuation = nil
                    inFlightLiveStream[sid] = live
                    return (hCont, live.requestURL, live.stream)
                }
                return nil
            }
            if let (hCont, requestURL, stream) = liveRes {
                let response = HTTPURLResponse(
                    url: requestURL ?? URL(string: "http://localhost")!,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: headers
                ) ?? HTTPURLResponse()
                hCont.resume(returning: (response, stream))
            }

        case .chunk(let sid, let data):
            let (streamCont, liveCont) = withLock { () -> (AsyncThrowingStream<Data, Error>.Continuation?, AsyncThrowingStream<String, Error>.Continuation?) in
                if var send = inFlightSend[sid] {
                    send.data.append(contentsOf: data.utf8)
                    inFlightSend[sid] = send
                }
                return (inFlightStream[sid], inFlightLiveStream[sid]?.streamContinuation)
            }
            streamCont?.yield(Data(data.utf8))
            liveCont?.yield(data)

        case .end(let sid, let error):
            let (send, stream, live) = withLock {
                (inFlightSend.removeValue(forKey: sid),
                 inFlightStream.removeValue(forKey: sid),
                 inFlightLiveStream.removeValue(forKey: sid))
            }

            if let send {
                if let error {
                    send.continuation.resume(throwing: Failure.map(error))
                } else {
                    let response = HTTPURLResponse(
                        url: send.requestURL ?? URL(string: "http://localhost")!,
                        statusCode: send.statusCode,
                        httpVersion: "HTTP/1.1",
                        headerFields: send.headers
                    ) ?? HTTPURLResponse()
                    send.continuation.resume(returning: (send.data, response))
                }
            }

            if let stream {
                if let error {
                    stream.finish(throwing: Failure.map(error))
                } else {
                    stream.finish()
                }
            }

            if let live {
                if let error {
                    live.headersContinuation?.resume(throwing: Failure.map(error))
                    live.streamContinuation.finish(throwing: Failure.map(error))
                } else {
                    live.streamContinuation.finish()
                }
            }

        case .ping:
            let pong = RelayFrame.pong
            if let json = try? pong.encode() {
                try? await sendRaw(json)
            }

        case .pong:
            break

        case .pairResult(let rid, let token, let error):
            let pair = withLock { inFlightPair.removeValue(forKey: rid) }
            if let pair {
                if let token {
                    pair.resume(returning: token)
                } else if let error {
                    pair.resume(throwing: Failure.map(error))
                } else {
                    pair.resume(throwing: Failure.other("empty_pair_result"))
                }
            }

        case .hello, .pairRedeem, .req:
            break
        }
    }

    private func handleSocketDrop(error: Error) async {
        await closeSocket(intentional: false)
    }

    private func closeSocket(intentional: Bool) async {
        let (ws, sends, streams, liveStreams, pairs, shouldReconnect, delay) = withLock { () -> ((any SwarmaWebSocket)?, [String: SendState], [String: AsyncThrowingStream<Data, Error>.Continuation], [String: LiveStreamState], [String: CheckedContinuation<String, Error>], Bool, TimeInterval) in
            if intentional {
                isClosedManually = true
            }
            let ws = self.socket
            self.socket = nil
            self.isConnected = false
            pingTask?.cancel()
            pingTask = nil
            receiveTask?.cancel()
            receiveTask = nil
            connectionTask?.cancel()
            connectionTask = nil

            let sends = inFlightSend
            inFlightSend.removeAll()
            let streams = inFlightStream
            inFlightStream.removeAll()
            let liveStreams = inFlightLiveStream
            inFlightLiveStream.removeAll()
            let pairs = inFlightPair
            inFlightPair.removeAll()

            let shouldReconnect = !isClosedManually && autoReconnect
            let delay = currentBackoff
            if shouldReconnect {
                currentBackoff = min(currentBackoff * 2, 30.0)
            }
            return (ws, sends, streams, liveStreams, pairs, shouldReconnect, delay)
        }

        await ws?.close()

        for (_, send) in sends {
            send.continuation.resume(throwing: Failure.closed)
        }
        for (_, stream) in streams {
            stream.finish(throwing: Failure.closed)
        }
        for (_, live) in liveStreams {
            live.headersContinuation?.resume(throwing: Failure.closed)
            live.streamContinuation.finish(throwing: Failure.closed)
        }
        for (_, pair) in pairs {
            pair.resume(throwing: Failure.closed)
        }

        updatePresence(Presence(online: false, lastSeen: presence.lastSeen, version: presence.version))

        if shouldReconnect {
            scheduleReconnect(after: delay)
        }
    }

    private func scheduleReconnect(after delay: TimeInterval) {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            await self.sleep(delay)
            if Task.isCancelled { return }
            let closed = self.withLock { self.isClosedManually }
            if closed { return }

            do {
                try await self.connectSocket()
                self.withLock { self.currentBackoff = 1.0 }
            } catch {
                await self.handleSocketDrop(error: error)
            }
        }
    }

    // MARK: - Public Request APIs

    /// Sends a request over the relay, turning it into a `req` frame and collecting
    /// `res`, `chunk` and `end` frames into Data and an `HTTPURLResponse`.
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await ensureConnected()
        let sid = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let headers = filterHeaders(request)
        let body = extractBody(request)
        let path = extractPath(request)
        let frame = RelayFrame.req(
            sid: sid,
            method: request.httpMethod ?? "GET",
            path: path,
            headers: headers,
            body: body
        )

        return try await withCheckedThrowingContinuation { continuation in
            withLock {
                inFlightSend[sid] = SendState(requestURL: request.url, continuation: continuation)
            }

            Task {
                do {
                    let json = try frame.encode()
                    try await self.sendRaw(json)
                } catch {
                    // Whoever removes the pending send resumes it: a disconnect may already have.
                    let pending = self.withLock { self.inFlightSend.removeValue(forKey: sid) }
                    pending?.continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Exposes SSE streaming as an `AsyncThrowingStream<Data, Error>`.
    /// Sends `{t:"end",sid}` when consumer cancels.
    public func stream(_ request: URLRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let sid = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()

            withLock {
                inFlightStream[sid] = continuation
            }

            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                let wasPresent = self.withLock {
                    self.inFlightStream.removeValue(forKey: sid) != nil
                }

                if wasPresent {
                    Task {
                        let endFrame = RelayFrame.end(sid: sid, error: nil)
                        if let json = try? endFrame.encode() {
                            try? await self.sendRaw(json)
                        }
                    }
                }
            }

            Task {
                do {
                    try await self.ensureConnected()
                    let headers = self.filterHeaders(request)
                    let body = self.extractBody(request)
                    let path = self.extractPath(request)
                    let frame = RelayFrame.req(
                        sid: sid,
                        method: request.httpMethod ?? "GET",
                        path: path,
                        headers: headers,
                        body: body
                    )
                    let json = try frame.encode()
                    try await self.sendRaw(json)
                } catch {
                    self.withLock {
                        _ = self.inFlightStream.removeValue(forKey: sid)
                    }
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    /// Streaming transport matching `SwarmaTeamsClient.StreamTransport`.
    public func liveStream(request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<String, Error>) {
        try await ensureConnected()
        let sid = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let headers = filterHeaders(request)
        let body = extractBody(request)
        let path = extractPath(request)
        let frame = RelayFrame.req(
            sid: sid,
            method: request.httpMethod ?? "GET",
            path: path,
            headers: headers,
            body: body
        )

        return try await withCheckedThrowingContinuation { headersContinuation in
            var continuationHolder: AsyncThrowingStream<String, Error>.Continuation?
            let stream = AsyncThrowingStream<String, Error> { streamCont in
                continuationHolder = streamCont
            }

            guard let streamCont = continuationHolder else {
                headersContinuation.resume(throwing: Failure.closed)
                return
            }

            withLock {
                inFlightLiveStream[sid] = LiveStreamState(
                    requestURL: request.url,
                    headersContinuation: headersContinuation,
                    streamContinuation: streamCont,
                    stream: stream
                )
            }

            streamCont.onTermination = { [weak self] _ in
                guard let self else { return }
                let wasPresent = self.withLock {
                    self.inFlightLiveStream.removeValue(forKey: sid) != nil
                }

                if wasPresent {
                    Task {
                        let endFrame = RelayFrame.end(sid: sid, error: nil)
                        if let json = try? endFrame.encode() {
                            try? await self.sendRaw(json)
                        }
                    }
                }
            }

            Task {
                do {
                    let json = try frame.encode()
                    try await self.sendRaw(json)
                } catch {
                    let state = self.withLock {
                        self.inFlightLiveStream.removeValue(forKey: sid)
                    }
                    state?.headersContinuation?.resume(throwing: error)
                    streamCont.finish(throwing: error)
                }
            }
        }
    }

    /// Closure matching `SwarmaTeamsClient.StreamTransport`.
    public var streamTransport: @Sendable (URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<String, Error>) {
        return { [weak self] req in
            guard let self else { throw Failure.closed }
            return try await self.liveStream(request: req)
        }
    }

    /// Normalizes the code (lower case, single spaces), sends `pair_redeem`,
    /// and returns the connection token from `pair_result` or throws.
    public func pair(code: String, deviceName: String) async throws -> String {
        try await ensureConnected()
        let normalized = code.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let rid = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()

        return try await withCheckedThrowingContinuation { continuation in
            withLock {
                inFlightPair[rid] = continuation
            }

            Task {
                do {
                    let frame = RelayFrame.pairRedeem(rid: rid, code: normalized, deviceName: deviceName)
                    let json = try frame.encode()
                    try await self.sendRaw(json)
                } catch {
                    let pending = self.withLock { self.inFlightPair.removeValue(forKey: rid) }
                    pending?.resume(throwing: error)
                }
            }
        }
    }

    // MARK: - Helpers

    private static func makeRelayURL(relay: String, hostID: String) -> URL? {
        var raw = relay.trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme: String
        if raw.hasPrefix("https://") {
            scheme = "wss://"
            raw = String(raw.dropFirst("https://".count))
        } else if raw.hasPrefix("http://") {
            scheme = "ws://"
            raw = String(raw.dropFirst("http://".count))
        } else if raw.hasPrefix("wss://") {
            scheme = "wss://"
            raw = String(raw.dropFirst("wss://".count))
        } else if raw.hasPrefix("ws://") {
            scheme = "ws://"
            raw = String(raw.dropFirst("ws://".count))
        } else {
            scheme = "wss://"
        }
        raw = raw.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: "\(scheme)\(raw)/h/\(hostID)")
    }

    private func extractPath(_ request: URLRequest) -> String {
        guard let url = request.url else { return "/" }
        var path = url.path
        if path.isEmpty { path = "/" }
        if let query = url.query, !query.isEmpty {
            path += "?\(query)"
        }
        return path
    }

    private func filterHeaders(_ request: URLRequest) -> [String: String] {
        var result: [String: String] = [:]
        guard let all = request.allHTTPHeaderFields else { return result }
        for (k, v) in all {
            let lower = k.lowercased()
            if Self.allowedHeaders.contains(lower) {
                result[lower] = v
            }
        }
        return result
    }

    private func extractBody(_ request: URLRequest) -> String? {
        guard let data = request.httpBody, !data.isEmpty else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - URLSessionWebSocket Adapter

    private final class URLSessionWebSocketAdapter: SwarmaWebSocket, @unchecked Sendable {
        private let task: URLSessionWebSocketTask

        init(task: URLSessionWebSocketTask) {
            self.task = task
            self.task.resume()
        }

        func send(_ text: String) async throws {
            try await task.send(.string(text))
        }

        func receive() async throws -> String {
            let message = try await task.receive()
            switch message {
            case .string(let text):
                return text
            case .data(let data):
                guard let text = String(data: data, encoding: .utf8) else {
                    throw SwarmaRelayTransport.Failure.other("invalid_utf8")
                }
                return text
            @unknown default:
                throw SwarmaRelayTransport.Failure.other("unknown_message_type")
            }
        }

        func close() async {
            task.cancel(with: .normalClosure, reason: nil)
        }
    }
}
