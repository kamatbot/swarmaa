import XCTest
import Foundation

// Deterministic relay peer. All credentials are generated test-only values and never logged.
actor IOSRelaySocket: SwarmaRelayTransport.SwarmaWebSocket {
    var queue: [String] = []
    var waiting: [CheckedContinuation<String, Error>] = []
    var inputs: [(String, JSON)] = []
    var posted = false
    var replyEnabled = true
    var hangingTool = ""
    func hang(_ tool: String) { hangingTool = tool }
    func suppressReplies() { replyEnabled = false }
    var streamID: String?
    var closed = false
    let pairToken = UUID().uuidString
    var bot: JSON = .object(["id": .string("b"), "name": .string("Launch"), "scope": .string("project:test"), "thread_id": .string("thread"), "starred": .bool(true), "version": .number(1)])
    func emit(_ frame: SwarmaRelayTransport.RelayFrame) throws {
        let text = try frame.encode()
        if waiting.isEmpty { queue.append(text) } else { waiting.removeFirst().resume(returning: text) }
    }
    func send(_ text: String) async throws {
        guard !closed, let frame = SwarmaRelayTransport.RelayFrame.decode(from: text) else { throw SwarmaRelayTransport.Failure.closed }
        switch frame {
        case .pairRedeem(let rid, _, _): try emit(.pairResult(rid: rid, token: pairToken, error: nil))
        case .req(let sid, _, let path, _, let body):
            if path.hasPrefix("/api/stream") { streamID = sid; return }
            let tool = String(path.split(separator: "/").last ?? "")
            let input = try JSON.parse(body ?? "{}")
            inputs.append((tool, input))
            if tool == hangingTool { return }
            let result: JSON
            switch tool {
            case "bot_list": result = .object(["bots": .array([bot]), "has_more": .bool(false)]) // the service's real shape
            case "swarm_status": result = .object(["usage": .array([])])
            case "agent_list": result = .object(["agents": .array([])])
            case "thread_post":
                posted = true
                result = .object(["message": .object(["id": .string("human"), "seq": .number(2), "kind": .string("text"), "author": .object(["kind": .string("human")]), "body": input["body"]])])
            case "thread_read":
                let messages: [JSON] = posted && replyEnabled ? [.object(["id": .string("reply"), "seq": .number(3), "kind": .string("text"), "author": .object(["kind": .string("agent")]), "body": .string("The launch is ready.")])] : []
                result = .object(["messages": .array(messages), "typing": .array([.object(["task_id": .string("turn"), "text": .string("Checking the plan…")])])])
            case "task_get": result = .object(["task": .object(["id": input["task_id"], "status": .string("completed"), "version": .number(2)])])
            default: result = .object([:])
            }
            try emit(.res(sid: sid, status: 200, headers: [:]))
            let data = try JSONEncoder().encode(JSON.object(["result": result]))
            try emit(.chunk(sid: sid, data: String(decoding: data, as: UTF8.self)))
            try emit(.end(sid: sid, error: nil))
        default: break
        }
    }
    func receive() async throws -> String {
        if closed { throw SwarmaRelayTransport.Failure.closed }
        if !queue.isEmpty { return queue.removeFirst() }
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }
    func close() async {
        closed = true
        let waiters = waiting; waiting = []
        for waiter in waiters { waiter.resume(throwing: SwarmaRelayTransport.Failure.closed) }
    }
    func stream(_ text: String) throws {
        guard let sid = streamID else { throw AppFailure.invalidResponse }
        try emit(.chunk(sid: sid, data: text))
    }
    func calls(_ name: String) -> [JSON] { inputs.filter { $0.0 == name }.map(\.1) }
}

@MainActor final class AppTests: XCTestCase {
    func service() -> (RelayService, IOSRelaySocket) {
        let socket = IOSRelaySocket()
        let transport = SwarmaRelayTransport(hostID: String(repeating: "a", count: 26), socket: socket)
        let service = RelayService(connection: HostConnection(hostID: String(repeating: "a", count: 26), relay: "relay.swarmaa.com", token: UUID().uuidString), transport: transport)
        return (service, socket)
    }
    func testDeviceTokenHexPreservesLeadingZerosAndAllBytes() {
        XCTAssertEqual(PushNotification.tokenHex(Data([0, 1, 15, 16, 127, 128, 255])), "00010f107f80ff")
        XCTAssertEqual(PushNotification.tokenHex(Data(0...255)).count, 512)
    }
    func testNotificationTapWaitsForBotListAndRoutesThroughOpen() async throws {
        let (service, socket) = service()
        let model = AppModel()
        model.service = service
        model.receivePushTap(["bot_id": "b", "aps": ["thread-id": "wrong"]])
        XCTAssertNil(model.takePushBot())
        model.connected = true
        await model.refresh()
        let bot = try XCTUnwrap(model.takePushBot())
        XCTAssertEqual(bot.id, "b")
        await model.open(bot)
        XCTAssertEqual(model.openBot?.threadID, "thread")
        let reads = await socket.calls("thread_read")
        XCTAssertEqual(reads.first?["thread_id"].string, "thread")
        XCTAssertNil(model.takePushBot())
        model.receivePushTap(["bot_id": "unknown"])
        XCTAssertNil(model.takePushBot())
        XCTAssertNil(PushNotification.botID(["bot_id": 42]))
        XCTAssertNil(PushNotification.botID(["bot_id": " "]))
        XCTAssertNil(PushNotification.botID(["aps": ["thread-id": "b"]]))
        await service.transport.disconnect()
    }
    func testPushRegistrationAndSignOutUnregisterBeforeClearingConnection() async throws {
        let (service, socket) = service()
        let keychain = ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString)
        defer { try? keychain.delete() }
        try keychain.save(service.connection)
        let model = AppModel(keychain: keychain)
        model.service = service; model.connected = true
        var firstLoads = 0
        model.onFirstBotList = { firstLoads += 1 }
        XCTAssertEqual(firstLoads, 0)
        await model.refresh()
        await model.refresh()
        XCTAssertEqual(firstLoads, 1)
        let token = Data(repeating: 15, count: 32)
        await model.registerPushToken(token)
        let registrations = await socket.calls("push_register")
        XCTAssertEqual(registrations.first?["token"].string, String(repeating: "0f", count: 32))
        XCTAssertEqual(registrations.first?["environment"].string, "sandbox")
        try await model.signOut()
        let removals = await socket.calls("push_unregister")
        XCTAssertEqual(removals.first?["token"], registrations.first?["token"])
        XCTAssertNil(try keychain.load())
        XCTAssertFalse(model.connected)
    }
    func testPairingPersistsTokenAndHostOnlyInTestKeychain() async throws {
        let keychain = ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString)
        defer { try? keychain.delete() }
        let socket = IOSRelaySocket()
        let transport = SwarmaRelayTransport(hostID: String(repeating: "a", count: 26), socket: socket)
        let model = AppModel(keychain: keychain)
        // Generated arbitrary six-word fixture, not a real pairing code.
        let code = (0..<6).map { "fixture\($0)" }.joined(separator: " ")
        try await model.pair(host: String(repeating: "a", count: 26), code: code, transport: transport)
        let stored = try XCTUnwrap(keychain.load())
        let expected = socket.pairToken
        // Do not let XCTest print secrets in a failing equality assertion.
        XCTAssertTrue(stored.token == expected)
        XCTAssertTrue(stored.hostID == String(repeating: "a", count: 26))
        XCTAssertTrue(model.connected)
        try await model.signOut()
        XCTAssertNil(try keychain.load())
    }
    func testPairingLinkParsingRejectsBadAndAmbiguousLinks() throws {
        let host = String(repeating: "a", count: 26)
        let code = "amberarch-applebay-autumnbird-beachbell-birchbeam-blueboat"
        let link = try PairingLink(XCTUnwrap(URL(string: "swarmaa://pair?host=\(host)&code=\(code)")))
        XCTAssertTrue(link.host == host)
        XCTAssertTrue(link.code == code.replacingOccurrences(of: "-", with: " "))
        for value in [
            "https://pair?host=\(host)&code=\(code)",
            "swarmaa://other?host=\(host)&code=\(code)",
            "swarmaa://pair/path?host=\(host)&code=\(code)",
            "swarmaa://pair?host=bad&code=\(code)",
            "swarmaa://pair?host=\(host)&code=one-two",
            "swarmaa://pair?host=\(host)&code=\(code)&code=\(code)",
            "swarmaa://pair?host=\(host)&code=\(code)&relay=evil.example",
            "swarmaa://pair?host=\(host)&code=\(code)#fragment",
            "swarmaa://pair:443?host=\(host)&code=\(code)",
            "swarmaa://user@pair?host=\(host)&code=\(code)",
            "swarmaa://pair?code=\(code)",
            "swarmaa://pair?host=\(host)&code=one-two-three-four-five-%20six"
        ] {
            guard let url = URL(string: value) else { continue }
            do { _ = try PairingLink(url); XCTFail("Malformed pairing link accepted") } catch {}
        }
    }
    func testURLHandlerPairsThroughRelayAndPersistsConnection() async throws {
        let keychain = ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString)
        defer { try? keychain.delete() }
        let model = AppModel(keychain: keychain)
        let host = String(repeating: "a", count: 26)
        let socket = IOSRelaySocket()
        let transport = SwarmaRelayTransport(hostID: host, socket: socket)
        let url = try XCTUnwrap(URL(string: "swarmaa://pair?host=\(host)&code=amberarch-applebay-autumnbird-beachbell-birchbeam-blueboat"))
        try await model.handlePairingURL(url, transport: transport)
        XCTAssertTrue(model.connected)
        XCTAssertTrue(try keychain.load()?.hostID == host)
        XCTAssertTrue(try keychain.load()?.token == socket.pairToken)
        try await model.signOut()
    }
    func testLiveReplyUsesReplyingAgentRatherThanLead() {
        let model = AppModel(keychain: ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString))
        model.agents = [.object(["id": .string("scout"), "name": .string("Scout")])]
        let agent = model.replyingAgent(.object(["agent_id": .string("scout")]))
        XCTAssertEqual(agent.id, "scout"); XCTAssertEqual(agent.name, "Scout")
    }
    func testInvalidPairingDoesNotWriteKeychain() async throws {
        let keychain = ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString)
        defer { try? keychain.delete() }
        let model = AppModel(keychain: keychain)
        do { try await model.pair(host: "invalid", code: "incomplete"); XCTFail("Invalid input accepted") }
        catch { XCTAssertNil(try keychain.load()) }
    }
    func testHomeOrderingAndSingleShortcut() throws {
        func bot(_ id: String, needs: Int = 0, unread: Int = 0, time: String = "2026-10-28T00:00:00Z", star: Bool = false) -> Bot {
            Bot(raw: .object(["id": .string(id), "starred": .bool(star), "updated_at": .string(time), "badges": .object(["needs_you": .number(Double(needs)), "unread": .number(Double(unread))])]))
        }
        let bots = [bot("old", star: true), bot("new", time: "2026-10-28T12:00:00Z"), bot("unread", unread: 1), bot("need", needs: 1)]
        XCTAssertEqual(Bot.sorted(bots).map(\.id), ["need", "unread", "new", "old"])
        XCTAssertEqual(Bot.shortcut(bots)?.id, "old")
        var moved = bots.map { b -> Bot in var b = b; b.raw["starred"] = .bool(b.id == "new"); return b }
        XCTAssertEqual(Bot.shortcut(moved)?.id, "new")
        moved[1].raw["archived"] = .bool(true)
        XCTAssertNil(Bot.shortcut(moved))
        XCTAssertFalse(Bot(raw: try JSON.parse("{\"id\":\"legacy\"}")).starred)
    }
    func testNewBotValidationTrimsWhitespace() {
        var draft = NewBotDraft()
        XCTAssertEqual(draft.missing, "Give your bot a name.")
        draft.name = "Launch"
        XCTAssertEqual(draft.missing, "Say what it does to make the bot.")
        draft.job = "  \n"
        XCTAssertNotNil(draft.missing)
        draft.job = "Plan launches"
        XCTAssertEqual(draft.missing, "Choose a project.")
        draft.project = "project:test"
        XCTAssertNil(draft.missing)
    }
    func testStreamEventsRefreshOpenThreadTypingAndOneTask() async throws {
        let (service, socket) = service()
        let model = AppModel(keychain: ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString))
        model.service = service
        model.openBot = Bot(raw: await socket.bot)
        model.tasks = [.object(["id": .string("keep"), "status": .string("running")])]
        try await model.handle(try JSON.parse("{\"name\":\"message.created\",\"payload\":{\"thread_id\":\"thread\"}}"))
        var reads = await socket.calls("thread_read")
        XCTAssertEqual(reads.count, 1)
        XCTAssertEqual(model.typing.first?["text"].string, "Checking the plan…")
        try await model.post("Plan launch")
        XCTAssertEqual(model.messages.first?.text, "The launch is ready.")
        try await model.handle(try JSON.parse("{\"name\":\"task.updated\",\"subject_id\":\"changed\",\"payload\":{\"kind\":\"turn\"}}"))
        reads = await socket.calls("thread_read")
        XCTAssertEqual(reads.count, 3)
        XCTAssertEqual(model.tasks.count, 2)
        XCTAssertEqual(model.tasks[0]["id"].string, "keep")
        XCTAssertEqual(model.tasks[1]["status"].string, "completed")
        let before = reads.count
        try await model.handle(try JSON.parse("{\"name\":\"message.created\",\"payload\":{\"thread_id\":\"other\"}}"))
        let after = await socket.calls("thread_read").count
        XCTAssertEqual(before, after)
        await service.transport.disconnect()
    }
    func testBackgroundSocketDropIsQuietAndOtherStreamErrorsClearOnReconnect() async throws {
        @MainActor final class Flaky: HostService {
            var failures: [Error]
            init(_ failures: [Error]) { self.failures = failures }
            func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON { .object([:]) }
            func events(after: String) -> AsyncThrowingStream<Data, Error> {
                let failure = failures.isEmpty ? nil : failures.removeFirst()
                return AsyncThrowingStream { c in
                    if let failure { c.finish(throwing: failure) } else { c.yield(Data(": ok\n\n".utf8)) }
                }
            }
        }
        let model = AppModel(keychain: ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString))
        model.service = Flaky([SwarmaRelayTransport.Failure.closed])
        model.startStream()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(model.error, "a background socket close is not shown")
        let flaky = Flaky([URLError(.notConnectedToInternet)])
        model.service = flaky
        model.startStream()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNotNil(model.error)
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertNil(model.error, "the stream coming back clears its own error")
    }
    func testSSEParserSplitUTF8CRLFAndMultipleFrames() throws {
        var parser = EventParser()
        let bytes = Array("id: c1\r\nevent: message.created\r\ndata: {\"payload\":{\"thread_id\":\"café\"}}\r\n\r\n: heartbeat\n\ndata: {\"name\":\"task.updated\"}\n\n".utf8)
        var results: [JSON] = []
        for byte in bytes { results += try parser.feed(Data([byte])) }
        XCTAssertEqual(results.count, 2)
        XCTAssertEqual(results[0]["payload"]["thread_id"].string, "café")
        XCTAssertEqual(results[0]["cursor"].string, "c1")
        XCTAssertEqual(results[0]["name"].string, "message.created")
    }
    func testRelayStreamFeedsModel() async throws {
        let (service, socket) = service()
        let model = AppModel(keychain: ConnectionKeychain(service: "app.swarmaa.ios.tests." + UUID().uuidString))
        model.service = service; model.openBot = Bot(raw: await socket.bot)
        model.startStream()
        for _ in 0..<100 {
            if await socket.streamID != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        try await socket.stream("event: task.updated\ndata: {\"payload\":{\"kind\":\"turn\",\"task_id\":\"live\"}}\n\n")
        for _ in 0..<100 {
            if !model.typing.isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.typing.first?["text"].string, "Checking the plan…")
        try await model.signOut()
    }
    func testAskStarredBotPostsOnceAndReturnsReply() async throws {
        let (service, socket) = service()
        let reply = try await AskStarredBot.run(service: service, message: "Plan Friday", timeout: 2, poll: .milliseconds(1))
        XCTAssertEqual(reply, "The launch is ready.")
        let calls = await socket.calls("thread_post")
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?["thread_id"].string, "thread")
        XCTAssertFalse(calls.first?["idempotency_key"].string.isEmpty ?? true)
        await service.transport.disconnect()
    }
    func testAskTimeoutReturnsInAppWithoutReposting() async throws {
        let (service, socket) = service()
        await socket.suppressReplies()
        let reply = try await AskStarredBot.run(service: service, message: "Plan Friday", timeout: 0.05, poll: .milliseconds(1))
        XCTAssertEqual(reply, AskStarredBot.later)
        let calls = await socket.calls("thread_post")
        XCTAssertEqual(calls.count, 1)
        await service.transport.disconnect()
    }
    func testCancellationUnblocksRelayRequest() async throws {
        let (service, socket) = service()
        await socket.hang("blocked")
        let task = Task { try await service.call("blocked", [:]) }
        for _ in 0..<100 {
            if await !socket.calls("blocked").isEmpty { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        let start = ContinuousClock.now
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled request returned success") } catch {}
        XCTAssertLessThan(start.duration(to: .now), .seconds(1))
        await service.transport.disconnect()
    }
    func testAskRejectsBlankMessageBeforePosting() async throws {
        let (service, socket) = service()
        do { _ = try await AskStarredBot.run(service: service, message: " \n"); XCTFail("Blank accepted") } catch {}
        let calls = await socket.calls("thread_post")
        XCTAssertTrue(calls.isEmpty)
        await service.transport.disconnect()
    }
}
