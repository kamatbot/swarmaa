import XCTest
#if canImport(Codenotch)
@testable import Codenotch
#endif

// MARK: - Fake WebSocket for Testing

final class FakeWebSocket: SwarmaRelayTransport.SwarmaWebSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var sentMessages: [String] = []
    private var receiveQueue: [Result<String, Error>] = []
    private var receiveContinuations: [CheckedContinuation<String, Error>] = []
    private var isClosed = false

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func send(_ text: String) async throws {
        try withLock {
            if isClosed { throw SwarmaRelayTransport.Failure.closed }
            sentMessages.append(text)
        }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            withLock {
                if isClosed {
                    continuation.resume(throwing: SwarmaRelayTransport.Failure.closed)
                    return
                }
                if !receiveQueue.isEmpty {
                    let next = receiveQueue.removeFirst()
                    continuation.resume(with: next)
                } else {
                    receiveContinuations.append(continuation)
                }
            }
        }
    }

    func close() async {
        let continuations = withLock { () -> [CheckedContinuation<String, Error>] in
            isClosed = true
            let c = receiveContinuations
            receiveContinuations.removeAll()
            return c
        }
        for c in continuations {
            c.resume(throwing: SwarmaRelayTransport.Failure.closed)
        }
    }

    func simulateServerMessage(_ text: String) {
        let continuation = withLock { () -> CheckedContinuation<String, Error>? in
            if !receiveContinuations.isEmpty {
                return receiveContinuations.removeFirst()
            } else {
                receiveQueue.append(.success(text))
                return nil
            }
        }
        continuation?.resume(returning: text)
    }

    func simulateFrame(_ frame: SwarmaRelayTransport.RelayFrame) throws {
        let json = try frame.encode()
        simulateServerMessage(json)
    }

    func simulateDrop(error: Error = SwarmaRelayTransport.Failure.closed) {
        let continuations = withLock { () -> [CheckedContinuation<String, Error>] in
            isClosed = true
            let c = receiveContinuations
            receiveContinuations.removeAll()
            return c
        }
        for c in continuations {
            c.resume(throwing: error)
        }
    }

    func getSentMessages() -> [String] {
        withLock { sentMessages }
    }

    func waitForSentMessage(timeout: TimeInterval = 2.0, matching: @Sendable @escaping (String) -> Bool) async throws -> String {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let messages = getSentMessages()
            if let found = messages.first(where: matching) {
                return found
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw SwarmaRelayTransport.Failure.other("waitForSentMessage timeout")
    }

    func waitForSentFrame(timeout: TimeInterval = 2.0, matching: @Sendable @escaping (SwarmaRelayTransport.RelayFrame) -> Bool) async throws -> SwarmaRelayTransport.RelayFrame {
        let msg = try await waitForSentMessage(timeout: timeout) { raw in
            guard let frame = SwarmaRelayTransport.RelayFrame.decode(from: raw) else { return false }
            return matching(frame)
        }
        return SwarmaRelayTransport.RelayFrame.decode(from: msg)!
    }
}

// MARK: - Tests

final class SwarmaRelayTransportTests: XCTestCase {

    // MARK: 1. Frame Codec (both directions)

    func testFrameCodecBothDirections() throws {
        // Hello frame
        let hello = SwarmaRelayTransport.RelayFrame.hello(role: "client", version: "1.26.0")
        let helloJSON = try hello.encode()
        let decodedHello = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: helloJSON))
        XCTAssertEqual(hello, decodedHello)

        // Presence frame with timestamp and version
        let testDate = Date(timeIntervalSince1970: 1730000000)
        let presence = SwarmaRelayTransport.RelayFrame.presence(online: true, lastSeen: testDate, version: "0.9.1")
        let presenceJSON = try presence.encode()
        let decodedPresence = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: presenceJSON))
        XCTAssertEqual(presence, decodedPresence)

        // Presence frame offline without lastSeen or version
        let presenceOffline = SwarmaRelayTransport.RelayFrame.presence(online: false, lastSeen: nil, version: nil)
        let offlineJSON = try presenceOffline.encode()
        let decodedOffline = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: offlineJSON))
        XCTAssertEqual(presenceOffline, decodedOffline)

        // Req frame with body
        let req = SwarmaRelayTransport.RelayFrame.req(
            sid: "s123",
            method: "POST",
            path: "/api/tools/run",
            headers: ["authorization": "Bearer tok", "content-type": "application/json"],
            body: "{\"key\":\"value\"}"
        )
        let reqJSON = try req.encode()
        let decodedReq = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: reqJSON))
        XCTAssertEqual(req, decodedReq)

        // Req frame with null body
        let reqNullBody = SwarmaRelayTransport.RelayFrame.req(
            sid: "s124",
            method: "GET",
            path: "/healthz",
            headers: [:],
            body: nil
        )
        let reqNullJSON = try reqNullBody.encode()
        let decodedReqNull = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: reqNullJSON))
        XCTAssertEqual(reqNullBody, decodedReqNull)

        // Res frame
        let res = SwarmaRelayTransport.RelayFrame.res(
            sid: "s123",
            status: 200,
            headers: ["content-type": "application/json"]
        )
        let resJSON = try res.encode()
        let decodedRes = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: resJSON))
        XCTAssertEqual(res, decodedRes)

        // Chunk frame
        let chunk = SwarmaRelayTransport.RelayFrame.chunk(sid: "s123", data: "stream data chunk")
        let chunkJSON = try chunk.encode()
        let decodedChunk = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: chunkJSON))
        XCTAssertEqual(chunk, decodedChunk)

        // End frame without error
        let endOK = SwarmaRelayTransport.RelayFrame.end(sid: "s123", error: nil)
        let endOKJSON = try endOK.encode()
        let decodedEndOK = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: endOKJSON))
        XCTAssertEqual(endOK, decodedEndOK)

        // End frame with error
        let endErr = SwarmaRelayTransport.RelayFrame.end(sid: "s123", error: "host_offline")
        let endErrJSON = try endErr.encode()
        let decodedEndErr = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: endErrJSON))
        XCTAssertEqual(endErr, decodedEndErr)

        // Ping and Pong
        let pingJSON = try SwarmaRelayTransport.RelayFrame.ping.encode()
        XCTAssertEqual(SwarmaRelayTransport.RelayFrame.decode(from: pingJSON), .ping)

        let pongJSON = try SwarmaRelayTransport.RelayFrame.pong.encode()
        XCTAssertEqual(SwarmaRelayTransport.RelayFrame.decode(from: pongJSON), .pong)

        // Pair redeem
        let pairRedeem = SwarmaRelayTransport.RelayFrame.pairRedeem(rid: "r1", code: "word1 word2 word3", deviceName: "MacBook")
        let pairRedeemJSON = try pairRedeem.encode()
        let decodedRedeem = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: pairRedeemJSON))
        XCTAssertEqual(pairRedeem, decodedRedeem)

        // Pair result success
        let pairResOK = SwarmaRelayTransport.RelayFrame.pairResult(rid: "r1", token: "token_12345", error: nil)
        let pairResOKJSON = try pairResOK.encode()
        let decodedPairResOK = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: pairResOKJSON))
        XCTAssertEqual(pairResOK, decodedPairResOK)

        // Pair result error
        let pairResErr = SwarmaRelayTransport.RelayFrame.pairResult(rid: "r1", token: nil, error: "bad_code")
        let pairResErrJSON = try pairResErr.encode()
        let decodedPairResErr = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: pairResErrJSON))
        XCTAssertEqual(pairResErr, decodedPairResErr)

        // Dropping unknown t values
        let unknownT = "{\"t\":\"unknown_type\",\"foo\":\"bar\"}"
        XCTAssertNil(SwarmaRelayTransport.RelayFrame.decode(from: unknownT))

        // Ignoring unknown fields on known frame
        let withExtraFields = "{\"t\":\"res\",\"sid\":\"s9\",\"status\":201,\"headers\":{},\"extra_key\":42}"
        let decodedExtra = try XCTUnwrap(SwarmaRelayTransport.RelayFrame.decode(from: withExtraFields))
        XCTAssertEqual(decodedExtra, .res(sid: "s9", status: 201, headers: [:]))
    }

    // MARK: 2. Send produces right req frame with stripped headers

    func testSendProducesReqFrameWithStrippedHeaders() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            relay: "relay.swarmaa.com",
            hostID: "abcdefghijklmnopqrstuvwxyz",
            socket: fake,
            autoReconnect: false
        )

        var request = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/tools/run?scope=project:demo")!)
        request.httpMethod = "POST"
        request.httpBody = Data("{\"input\":\"test\"}".utf8)

        // Add both allowlisted and non-allowlisted headers
        request.setValue("Bearer secret_tok", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("42", forHTTPHeaderField: "Last-Event-ID")
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        request.setValue("secret-cookie", forHTTPHeaderField: "Cookie")
        request.setValue("custom-val", forHTTPHeaderField: "X-Custom-Header")

        let sendTask = Task {
            try await transport.send(request)
        }

        // Wait for hello frame then req frame
        let reqFrame = try await fake.waitForSentFrame { frame in
            if case .req = frame { return true }
            return false
        }

        guard case .req(let sid, let method, let path, let headers, let body) = reqFrame else {
            XCTFail("Expected req frame")
            return
        }

        XCTAssertFalse(sid.isEmpty)
        XCTAssertLessThanOrEqual(sid.count, 32)
        XCTAssertEqual(method, "POST")
        XCTAssertEqual(path, "/api/tools/run?scope=project:demo")
        XCTAssertEqual(body, "{\"input\":\"test\"}")

        // Allowlisted headers lower-cased only
        XCTAssertEqual(headers["authorization"], "Bearer secret_tok")
        XCTAssertEqual(headers["content-type"], "application/json")
        XCTAssertEqual(headers["accept"], "application/json")
        XCTAssertEqual(headers["last-event-id"], "42")

        // Non-allowlisted headers stripped
        XCTAssertNil(headers["user-agent"])
        XCTAssertNil(headers["cookie"])
        XCTAssertNil(headers["x-custom-header"])
        XCTAssertNil(headers["User-Agent"])
        XCTAssertEqual(headers.count, 4)

        // Complete the request to finish the task
        try fake.simulateFrame(.res(sid: sid, status: 200, headers: [:]))
        try fake.simulateFrame(.end(sid: sid, error: nil))
        _ = try await sendTask.value
    }

    // MARK: 3. Multi-chunk response assembled correctly with status and headers

    func testMultiChunkResponseAssembledCorrectlyWithStatusAndHeaders() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        let request = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/inbox/wait")!)
        let sendTask = Task {
            try await transport.send(request)
        }

        let reqFrame = try await fake.waitForSentFrame { frame in
            if case .req = frame { return true }
            return false
        }
        guard case .req(let sid, _, _, _, _) = reqFrame else {
            XCTFail("Expected req frame")
            return
        }

        // Host responds with res then multiple chunks then end
        try fake.simulateFrame(.res(sid: sid, status: 200, headers: ["content-type": "application/json", "x-host-id": "host123"]))
        try fake.simulateFrame(.chunk(sid: sid, data: "{\"part1\": "))
        try fake.simulateFrame(.chunk(sid: sid, data: "\"hello \", "))
        try fake.simulateFrame(.chunk(sid: sid, data: "\"part2\": \"world\"}"))
        try fake.simulateFrame(.end(sid: sid, error: nil))

        let (data, response) = try await sendTask.value
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(response.url, request.url)
        XCTAssertEqual(response.value(forHTTPHeaderField: "content-type"), "application/json")
        XCTAssertEqual(response.value(forHTTPHeaderField: "x-host-id"), "host123")

        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertEqual(text, "{\"part1\": \"hello \", \"part2\": \"world\"}")
    }

    // MARK: 4. Concurrent requests demultiplexed by sid

    func testConcurrentRequestsDemultiplexedBySID() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        let reqA = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/tools/a")!)
        let reqB = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/tools/b")!)

        let taskA = Task { try await transport.send(reqA) }
        let taskB = Task { try await transport.send(reqB) }

        // Capture both req frames
        let frame1 = try await fake.waitForSentFrame { frame in
            if case .req(_, _, let path, _, _) = frame { return path == "/api/tools/a" }
            return false
        }
        let frame2 = try await fake.waitForSentFrame { frame in
            if case .req(_, _, let path, _, _) = frame { return path == "/api/tools/b" }
            return false
        }

        guard case .req(let sidA, _, _, _, _) = frame1,
              case .req(let sidB, _, _, _, _) = frame2 else {
            XCTFail("Expected req frames for A and B")
            return
        }

        XCTAssertNotEqual(sidA, sidB)

        // Interleaved arrival of frames
        try fake.simulateFrame(.res(sid: sidB, status: 201, headers: ["x-name": "B"]))
        try fake.simulateFrame(.chunk(sid: sidA, data: "A-part1 "))
        try fake.simulateFrame(.chunk(sid: sidB, data: "B-all"))
        try fake.simulateFrame(.res(sid: sidA, status: 200, headers: ["x-name": "A"]))
        try fake.simulateFrame(.chunk(sid: sidA, data: "A-part2"))
        try fake.simulateFrame(.end(sid: sidB, error: nil))
        try fake.simulateFrame(.end(sid: sidA, error: nil))

        let (dataA, resA) = try await taskA.value
        let (dataB, resB) = try await taskB.value

        XCTAssertEqual(resA.statusCode, 200)
        XCTAssertEqual(String(data: dataA, encoding: .utf8), "A-part1 A-part2")

        XCTAssertEqual(resB.statusCode, 201)
        XCTAssertEqual(String(data: dataB, encoding: .utf8), "B-all")
    }

    // MARK: 5. SSE stream yields chunks, and cancel sends end

    func testSSEStreamYieldsChunksAndCancelSendsEnd() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        let request = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/stream")!)
        let stream = transport.stream(request)

        let reqFrame = try await fake.waitForSentFrame { frame in
            if case .req = frame { return true }
            return false
        }
        guard case .req(let sid, _, _, _, _) = reqFrame else {
            XCTFail("Expected req frame")
            return
        }

        let expectationChunk1 = XCTestExpectation(description: "chunk 1 received")
        let expectationChunk2 = XCTestExpectation(description: "chunk 2 received")

        var received: [String] = []

        let consumerTask = Task {
            for try await chunkData in stream {
                if let str = String(data: chunkData, encoding: .utf8) {
                    received.append(str)
                    if received.count == 1 { expectationChunk1.fulfill() }
                    if received.count == 2 {
                        expectationChunk2.fulfill()
                    }
                }
            }
        }

        try fake.simulateFrame(.chunk(sid: sid, data: "event: ping\ndata: 1\n\n"))
        await fulfillment(of: [expectationChunk1], timeout: 2.0)

        try fake.simulateFrame(.chunk(sid: sid, data: "event: task\ndata: 2\n\n"))
        await fulfillment(of: [expectationChunk2], timeout: 2.0)

        // Consumer cancels reading
        consumerTask.cancel()

        // When consumer cancelled, transport must send `{t:"end", sid: sid}`
        let endFrame = try await fake.waitForSentFrame { frame in
            if case .end(let s, _) = frame { return s == sid }
            return false
        }

        guard case .end(let endSid, let error) = endFrame else {
            XCTFail("Expected end frame on cancel")
            return
        }
        XCTAssertEqual(endSid, sid)
        XCTAssertNil(error)
        XCTAssertEqual(received, ["event: ping\ndata: 1\n\n", "event: task\ndata: 2\n\n"])
    }

    // MARK: 6. host_offline mapped to .hostOffline

    func testHostOfflineMappedToHostOffline() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        let request = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/tools/swarm_status")!)
        let sendTask = Task {
            try await transport.send(request)
        }

        let reqFrame = try await fake.waitForSentFrame { frame in
            if case .req = frame { return true }
            return false
        }
        guard case .req(let sid, _, _, _, _) = reqFrame else {
            XCTFail("Expected req frame")
            return
        }

        // Host is offline
        try fake.simulateFrame(.end(sid: sid, error: "host_offline"))

        do {
            _ = try await sendTask.value
            XCTFail("Expected hostOffline error")
        } catch let failure as SwarmaRelayTransport.Failure {
            XCTAssertEqual(failure, .hostOffline)
        }

        // Test other mapped failure codes
        XCTAssertEqual(SwarmaRelayTransport.Failure.map("rate_limited"), .rateLimited)
        XCTAssertEqual(SwarmaRelayTransport.Failure.map("forbidden_path"), .forbiddenPath)
        XCTAssertEqual(SwarmaRelayTransport.Failure.map("closed"), .closed)
        XCTAssertEqual(SwarmaRelayTransport.Failure.map("bad_code"), .badCode)
        XCTAssertEqual(SwarmaRelayTransport.Failure.map("custom_error"), .other("custom_error"))
    }

    // MARK: 7. Pair success and bad_code paths

    func testPairSuccessAndBadCodePaths() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        // Success path
        let successTask = Task {
            try await transport.pair(
                code: "  ALPHA   bravo   CHARLIE\tdelta \n echo  FOXTROT  ",
                deviceName: "Living Room Mac"
            )
        }

        let redeemFrame = try await fake.waitForSentFrame { frame in
            if case .pairRedeem = frame { return true }
            return false
        }
        guard case .pairRedeem(let rid, let code, let deviceName) = redeemFrame else {
            XCTFail("Expected pairRedeem frame")
            return
        }

        // Normalized: lower case, single spaces
        XCTAssertEqual(code, "alpha bravo charlie delta echo foxtrot")
        XCTAssertEqual(deviceName, "Living Room Mac")

        // Reply with pair_result token
        try fake.simulateFrame(.pairResult(rid: rid, token: "swarma_token_abc123", error: nil))
        let token = try await successTask.value
        XCTAssertEqual(token, "swarma_token_abc123")

        // Bad code path
        let badCodeTask = Task {
            try await transport.pair(code: "invalid code", deviceName: "Living Room Mac")
        }

        let badRedeemFrame = try await fake.waitForSentFrame { frame in
            if case .pairRedeem(let r, _, _) = frame { return r != rid }
            return false
        }
        guard case .pairRedeem(let badRID, _, _) = badRedeemFrame else {
            XCTFail("Expected pairRedeem frame")
            return
        }

        // Reply with bad_code error
        try fake.simulateFrame(.pairResult(rid: badRID, token: nil, error: "bad_code"))

        do {
            _ = try await badCodeTask.value
            XCTFail("Expected badCode error")
        } catch let failure as SwarmaRelayTransport.Failure {
            XCTAssertEqual(failure, .badCode)
        }
    }

    // MARK: 8. Socket drop failing in-flight requests

    func testSocketDropFailsInFlightRequests() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        let req = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/tools/run")!)
        let sendTask = Task { try await transport.send(req) }

        let stream = transport.stream(req)
        let streamTask = Task {
            var count = 0
            for try await _ in stream {
                count += 1
            }
            return count
        }

        let pairTask = Task {
            try await transport.pair(code: "one two three four five six", deviceName: "Test Device")
        }

        // Wait for req and pair frames to be sent
        _ = try await fake.waitForSentFrame { frame in
            if case .req = frame { return true }
            return false
        }
        _ = try await fake.waitForSentFrame { frame in
            if case .pairRedeem = frame { return true }
            return false
        }

        // Simulate socket drop
        fake.simulateDrop()

        // In-flight send must fail with .closed
        do {
            _ = try await sendTask.value
            XCTFail("Expected send to fail with .closed")
        } catch let failure as SwarmaRelayTransport.Failure {
            XCTAssertEqual(failure, .closed)
        }

        // In-flight stream must terminate throwing .closed
        do {
            _ = try await streamTask.value
            XCTFail("Expected stream to fail with .closed")
        } catch let failure as SwarmaRelayTransport.Failure {
            XCTAssertEqual(failure, .closed)
        }

        // In-flight pair must fail with .closed
        do {
            _ = try await pairTask.value
            XCTFail("Expected pair to fail with .closed")
        } catch let failure as SwarmaRelayTransport.Failure {
            XCTAssertEqual(failure, .closed)
        }
    }

    // MARK: 9. Presence updates

    func testPresenceUpdates() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        // Initial presence is offline
        XCTAssertFalse(transport.presence.online)
        XCTAssertNil(transport.presence.lastSeen)
        XCTAssertNil(transport.presence.version)

        let presenceExpectation1 = XCTestExpectation(description: "presence became online")
        let presenceExpectation2 = XCTestExpectation(description: "presence became offline")

        var receivedPresences: [SwarmaRelayTransport.Presence] = []
        let presenceStreamTask = Task {
            for await p in transport.presenceStream {
                receivedPresences.append(p)
                if p.online {
                    presenceExpectation1.fulfill()
                } else if receivedPresences.count > 1 {
                    presenceExpectation2.fulfill()
                    break
                }
            }
        }

        // Connect
        try await transport.connect()

        // Receive hello frame
        _ = try await fake.waitForSentFrame { frame in
            if case .hello = frame { return true }
            return false
        }

        // DO sends presence online
        let seenDate = Date(timeIntervalSince1970: 1730005000)
        try fake.simulateFrame(.presence(online: true, lastSeen: seenDate, version: "1.0.0"))
        await fulfillment(of: [presenceExpectation1], timeout: 2.0)

        XCTAssertTrue(transport.presence.online)
        XCTAssertEqual(transport.presence.version, "1.0.0")

        // DO sends presence offline
        try fake.simulateFrame(.presence(online: false, lastSeen: seenDate, version: "1.0.0"))
        await fulfillment(of: [presenceExpectation2], timeout: 2.0)

        XCTAssertFalse(transport.presence.online)
        _ = await presenceStreamTask.value
    }

    // MARK: 10. LiveStream matches SwarmaTeamsClient StreamTransport

    func testLiveStreamMatchesSwarmaTeamsClient() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )

        let req = URLRequest(url: URL(string: "https://relay.swarmaa.com/api/stream")!)
        let streamTask = Task {
            try await transport.liveStream(request: req)
        }

        let reqFrame = try await fake.waitForSentFrame { frame in
            if case .req = frame { return true }
            return false
        }
        guard case .req(let sid, _, _, _, _) = reqFrame else {
            XCTFail("Expected req frame")
            return
        }

        // Server replies with res
        try fake.simulateFrame(.res(sid: sid, status: 200, headers: ["content-type": "text/event-stream"]))

        let (response, chunkStream) = try await streamTask.value
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(response.value(forHTTPHeaderField: "content-type"), "text/event-stream")

        let chunkExp = XCTestExpectation(description: "received text chunk")
        var receivedTexts: [String] = []

        let consumer = Task {
            for try await text in chunkStream {
                receivedTexts.append(text)
                chunkExp.fulfill()
            }
        }

        try fake.simulateFrame(.chunk(sid: sid, data: "event: ping\n\n"))
        await fulfillment(of: [chunkExp], timeout: 2.0)

        consumer.cancel()

        let endFrame = try await fake.waitForSentFrame { frame in
            if case .end(let s, _) = frame { return s == sid }
            return false
        }
        guard case .end(let endSid, _) = endFrame else {
            XCTFail("Expected end frame on cancel")
            return
        }
        XCTAssertEqual(endSid, sid)
        XCTAssertEqual(receivedTexts, ["event: ping\n\n"])
    }

    // MARK: 11. Ping response when server pings client

    func testServerPingTriggersPong() async throws {
        let fake = FakeWebSocket()
        let transport = SwarmaRelayTransport(
            hostID: "host123",
            socket: fake,
            autoReconnect: false
        )
        try await transport.connect()

        _ = try await fake.waitForSentFrame { frame in
            if case .hello = frame { return true }
            return false
        }

        // Server pings client
        try fake.simulateFrame(.ping)

        // Client must reply with pong
        let pongFrame = try await fake.waitForSentFrame { frame in
            frame == .pong
        }
        XCTAssertEqual(pongFrame, .pong)
    }

    // MARK: 12. Security: tokens and codes are never logged in frame descriptions

    func testTokensAndCodesNeverLogged() {
        let secretCode = "my-secret-pairing-code-xyz"
        let secretToken = "my-super-secret-service-token-abc"

        let redeem = SwarmaRelayTransport.RelayFrame.pairRedeem(rid: "r1", code: secretCode, deviceName: "Mac")
        XCTAssertFalse(redeem.description.contains(secretCode))

        let result = SwarmaRelayTransport.RelayFrame.pairResult(rid: "r1", token: secretToken, error: nil)
        XCTAssertFalse(result.description.contains(secretToken))

        let req = SwarmaRelayTransport.RelayFrame.req(
            sid: "s1",
            method: "POST",
            path: "/api/test",
            headers: ["authorization": "Bearer \(secretToken)"],
            body: secretCode
        )
        XCTAssertFalse(req.description.contains(secretToken))
        XCTAssertFalse(req.description.contains(secretCode))
    }
}
