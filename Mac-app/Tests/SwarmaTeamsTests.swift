import XCTest
@testable import Codenotch

/// Fixtures written to TEAMS.md §2 and §4. No network: the client gets stub
/// transports, and the only token is a made-up one in a temporary file.
private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try SwarmaClient.decoder.decode(T.self, from: Data(json.utf8))
}

final class TeamsDecodingTests: XCTestCase {
    private let page = """
    {"messages":[
     {"id":"m1","thread_id":"t1","seq":1,"author":{"kind":"human","id":"owner"},"kind":"text",
      "body":"Plan Friday's launch","created_at":"2026-10-27T10:00:00Z"},
     {"id":"m2","thread_id":"t1","seq":2,"author":{"kind":"system"},"kind":"handoff",
      "body":"Ada gave the task to Linus","created_at":"2026-10-27T10:00:01.250Z"},
     {"id":"m3","thread_id":"t1","seq":3,"author":{"kind":"system"},"kind":"swarm","body":null,
      "ref":{"swarm_id":"s1"},
      "swarm":{"id":"s1","title":"Friday's launch","goal":"Ship it","scope":"project:demo",
               "owner_agent_id":"a1","thread_id":"t1","status":"waiting_on_you","version":4,
               "progress":{"done":3,"total":5},
               "steps":[{"id":"st1","title":"Draft the banner","assignee_agent_id":"a2","needs":[],
                         "status":"done","task_id":"k1","result_message_id":"m9","check":"diff_nonempty"},
                        {"id":"st2","title":"Pick channels","assignee_agent_id":"a3","needs":["st1"],
                         "status":"waiting_on_you"}]}},
     {"id":"m4","thread_id":"t1","seq":4,"author":{"kind":"system"},"kind":"run",
      "ref":{"task_ids":["k1","k2"]},
      "run":{"tasks":[{"id":"k1","status":"completed","provider":"claude"},{"id":"k2","status":"completed"}],
             "duration_ms":2400}},
     {"id":"m5","thread_id":"t1","seq":5,"author":{"kind":"agent","id":"a3"},"kind":"question",
      "ref":{"question_id":"q1"},
      "body":{"prompt":"Which channels should the launch use?","options":["X","LinkedIn"],
              "multi":true,"free_text":false}},
     {"id":"m6","thread_id":"t1","seq":6,"author":{"kind":"human","id":"owner"},"kind":"answer",
      "ref":{"question_id":"q1"},"body":{"choices":["X"],"text":"and the blog"}},
     {"id":"m7","thread_id":"t1","seq":7,"author":{"kind":"system"},"kind":"notice",
      "body":"Atlas now runs on Codex","edited_at":"2026-10-27T10:05:00Z"},
     {"id":"m8","thread_id":"t1","seq":8,"author":{"kind":"system"},"kind":"poll","body":"later"}
    ],"has_more":true}
    """

    func testEveryMessageKind() throws {
        let result = try decode(SwarmaTeamsClient.MessagePage.self, page)
        let m = result.messages
        XCTAssertEqual(result.hasMore, true)
        XCTAssertEqual(m.map(\.kind), [.text, .handoff, .swarm, .run, .question, .answer, .notice, .unknown])
        XCTAssertTrue(m[0].isHuman)
        XCTAssertEqual(m[0].body, "Plan Friday's launch")
        XCTAssertNotNil(m[1].createdAt, "fractional seconds")
        XCTAssertEqual(m[1].body, "Ada gave the task to Linus")
        XCTAssertEqual(m[6].body, "Atlas now runs on Codex")
        XCTAssertNotNil(m[6].editedAt)
    }

    func testSwarmPayload() throws {
        let swarm = try XCTUnwrap(try decode(SwarmaTeamsClient.MessagePage.self, page).messages[2].swarm)
        XCTAssertEqual(swarm.id, "s1")
        XCTAssertEqual(swarm.status, "waiting_on_you")
        XCTAssertEqual(swarm.progress, .init(done: 3, total: 5))
        XCTAssertEqual(swarm.steps.map(\.status), ["done", "waiting_on_you"])
        XCTAssertEqual(swarm.steps[1].needs, ["st1"])
        XCTAssertEqual(swarm.steps[0].check, "diff_nonempty")
        XCTAssertEqual(swarm.steps[0].resultMessageID, "m9")
        XCTAssertEqual(swarm.version, 4)
    }

    func testSwarmProgressDerivedWhenAbsent() throws {
        let s = try decode(TeamsSwarm.self, """
        {"id":"s","title":"T","steps":[{"id":"a","title":"x","status":"done"},{"id":"b","title":"y","status":"running"}]}
        """)
        XCTAssertEqual(s.progress, .init(done: 1, total: 2))
    }

    func testRunCardSummary() throws {
        let run = try XCTUnwrap(try decode(SwarmaTeamsClient.MessagePage.self, page).messages[3].run)
        XCTAssertEqual(run.summary, "Ran 2 subagents · 2 done · 2s")
    }

    func testQuestionAndAnswerPayloads() throws {
        let m = try decode(SwarmaTeamsClient.MessagePage.self, page).messages
        let q = try XCTUnwrap(m[4].question)
        XCTAssertEqual(q.id, "q1", "id falls back to ref.question_id")
        XCTAssertEqual(q.threadID, "t1")
        XCTAssertEqual(q.options, ["X", "LinkedIn"])
        XCTAssertTrue(q.multi)
        XCTAssertFalse(q.freeText)
        XCTAssertEqual(q.status, "open")
        XCTAssertEqual(m[5].answer, TeamsAnswer(choices: ["X"], text: "and the blog"))
        XCTAssertEqual(m[5].ref?.questionID, "q1")

        let listed = try decode([TeamsQuestion].self, """
        [{"id":"q2","thread_id":"t9","agent_id":"a3","prompt":"Ship?","options":["Yes","No"],"multi":false,
          "free_text":true,"swarm_step_id":"st2","status":"answered","answer":{"choices":["Yes"]}}]
        """)
        XCTAssertEqual(listed[0].swarmStepID, "st2")
        XCTAssertEqual(listed[0].answer?.choices, ["Yes"])
    }

    func testAgentRunnerAndSection() throws {
        let page = try decode(SwarmaTeamsClient.AgentPage.self, """
        {"agents":[{"id":"a1","name":"Atlas","role":"Team lead","avatar":"atlas","scope":"project:demo",
          "runner":{"provider":"claude","model":"Opus 5.5","effort":"high"},"edits":true,"main_thread_id":"t1",
          "status":"waiting_on_you","version":2,"unread":3,
          "last_message":{"body":"Done","created_at":"2026-10-27T10:00:00Z"}},
         {"id":"a2","name":"Forge","runner":{"mode":"auto"}}],
         "sections":[{"id":"sec1","name":"Launch","order":0,"items":["a1","c1"],"collapsed":false}],
         "next_cursor":"a2"}
        """)
        XCTAssertEqual(page.agents[0].runner.label, "Claude Opus 5.5 · High")
        XCTAssertTrue(page.agents[1].runner.isAuto)
        XCTAssertEqual(page.agents[1].runner.label, "Auto")
        XCTAssertEqual(page.agents[0].mainThreadID, "t1")
        XCTAssertEqual(page.sections?.first?.items, ["a1", "c1"])
        XCTAssertEqual(page.nextCursor, "a2")

        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TeamsRunner.auto)) as? [String: String]
        XCTAssertEqual(encoded, ["mode": "auto"])
    }

    /// Shapes copied from the live phase 1 service (2026-10-28).
    func testLiveServiceShapes() throws {
        let page = try decode(SwarmaTeamsClient.AgentPage.self, """
        {"agents":[{"id":"160c","scope":"project:swarma","name":"Smoke","role":"Tester","instructions":"x",
          "runner":{"mode":"auto"},"edits":false,"avatar":null,"main_thread_id":"5b38","status":"offline",
          "unread_count":2,"archived":true,"version":2,"created_at":"2026-10-27T23:23:48.659Z"}],
         "has_more":false,"next_cursor":null}
        """)
        XCTAssertEqual(page.agents[0].unread, 2)
        XCTAssertTrue(page.agents[0].archived)
        let threads = try decode([TeamsThread].self, """
        [{"id":"5b38","scope":"project:swarma","agent_id":"160c","kind":"agent_main","title":"Smoke",
          "archived":false,"version":1,"unread_count":2}]
        """)
        XCTAssertEqual(threads[0].unread, 2)
        XCTAssertEqual(threads[0].name, "Smoke")
    }
}

final class SSEParserTests: XCTestCase {
    func testFrameSplitAcrossChunks() {
        var p = SSEParser()
        XCTAssertEqual(p.feed("id: 77.1\nevent: message.cre"), [])
        XCTAssertEqual(p.feed("ated\ndata: {\"thread_id\":"), [])
        let frames = p.feed("\"t1\"}\n\n")
        XCTAssertEqual(frames, [.init(id: "77.1", event: "message.created", data: "{\"thread_id\":\"t1\"}")])
    }

    func testHeartbeatCommentsAndCRLF() {
        var p = SSEParser()
        XCTAssertEqual(p.feed(": heartbeat\n\n:keepalive\r\n\r\n"), [], "comments make no frame")
        let frames = p.feed("id: 1.2\r\nevent: thread.read\r\ndata: a\r\ndata: b\r\n\r\n")
        XCTAssertEqual(frames, [.init(id: "1.2", event: "thread.read", data: "a\nb")])
    }

    func testIDPersistsAndEventResets() {
        var p = SSEParser()
        let frames = p.feed("id: 5.1\nevent: x\ndata: 1\n\ndata: 2\n\n")
        XCTAssertEqual(frames.map(\.event), ["x", nil])
        XCTAssertEqual(frames.map(\.id), ["5.1", "5.1"])
    }

    func testEventReadsRowShape() throws {
        let frame = SSEParser.Frame(id: "9.9", event: nil, data: """
        {"id":"e1","cursor":"10.3","scope":"project:demo","name":"message.created","subject_id":"m1",
         "payload":{"thread_id":"t1","seq":12,"author":{"kind":"agent"}}}
        """)
        let e = try XCTUnwrap(TeamsEvent(frame))
        XCTAssertEqual(e, TeamsEvent(cursor: "10.3", name: "message.created", subjectID: "m1",
                                     threadID: "t1", seq: 12, authorKind: "agent"))
        XCTAssertNil(TeamsEvent(.init(id: nil, event: nil, data: "{}")))
    }
}

final class TeamsStreamTests: XCTestCase {
    private final class Calls: @unchecked Sendable {
        let lock = NSLock()
        var urls: [URL] = []
        func add(_ u: URL) -> Int { lock.lock(); defer { lock.unlock() }; urls.append(u); return urls.count }
    }

    private func client(_ transport: @escaping SwarmaTeamsClient.StreamTransport) throws -> SwarmaTeamsClient {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("teams-\(UUID().uuidString).json").path
        try Data("{\"token\":\"cn_fake\"}".utf8).write(to: URL(fileURLWithPath: path))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path },
                                transport: { _ in throw URLError(.cannotConnectToHost) }, authMode: { .tokenFile })
        return SwarmaTeamsClient(base: base, streamTransport: transport, sleep: { _ in })
    }

    private static func response(_ url: URL, _ code: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: code, httpVersion: nil, headerFields: nil)!
    }

    private static func chunks(_ parts: [String]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { c in parts.forEach { c.yield($0) }; c.finish() }
    }

    func testReconnectsWithLastCursor() async throws {
        let calls = Calls()
        let client = try client { request in
            let n = calls.add(request.url!)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer cn_fake")
            let parts = n == 1
                ? ["id: 4.1\nevent: message.created\ndata: {\"thread_id\":\"t1\",\"seq\":1}\n", "\n: ping\n\n",
                   "id: 4.2\nevent: thread.read\ndata: {\"thread_id\":\"t1\"}\n\n"]
                : ["id: 5.1\nevent: agent.updated\ndata: {\"subject_id\":\"a1\"}\n\n"]
            return (Self.response(request.url!, 200), Self.chunks(parts))
        }
        var names: [String] = []
        for try await event in client.stream(after: "3.9") {
            names.append(event.name)
            if names.count == 3 { break }
        }
        XCTAssertEqual(names, ["message.created", "thread.read", "agent.updated"])
        XCTAssertEqual(calls.urls.first?.path, "/api/stream")
        XCTAssertEqual(calls.urls.first?.query, "after=3.9")
        XCTAssertEqual(calls.urls.dropFirst().first?.query, "after=4.2", "resumes from the last cursor it saw")
    }

    func testStream404IsServiceTooOld() async throws {
        let client = try client { request in (Self.response(request.url!, 404), Self.chunks([])) }
        do {
            for try await _ in client.stream() {}
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? SwarmaTeamsClient.Failure, .serviceTooOld)
        }
    }
}

final class TeamsServiceTooOldTests: XCTestCase {
    private func client(status: Int, body: String, oauth: Bool = false) throws -> SwarmaTeamsClient {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("teams-\(UUID().uuidString).json").path
        try Data("{\"token\":\"cn_fake\"}".utf8).write(to: URL(fileURLWithPath: path))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path }, transport: { request in
            (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }, authMode: { .tokenFile })
        return SwarmaTeamsClient(base: base, streamTransport: { _ in throw URLError(.badURL) })
    }

    func testUnknownToolIsServiceTooOld() async throws {
        let client = try client(status: 404, body: #"{"error":{"code":"unknown_tool","message":"Unknown tool name."}}"#)
        do { _ = try await client.agentList(); XCTFail("should throw") }
        catch { XCTAssertEqual(error as? SwarmaTeamsClient.Failure, .serviceTooOld) }
    }

    func testOtherFailuresStayThemselves() async throws {
        let client = try client(status: 500, body: "{}")
        do { _ = try await client.swarmList(); XCTFail("should throw") }
        catch { XCTAssertEqual(error as? SwarmaTeamsClient.Failure, .service(.http(500))) }
    }

    func testMCPUnknownToolMapsLikeREST() throws {
        let rpc = #"{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"{\"error\":{\"code\":\"unknown_tool\",\"message\":\"Unknown tool name.\"}}"}]}}"#
        XCTAssertThrowsError(try SwarmaClient.unwrapMCP(Data(rpc.utf8))) {
            XCTAssertEqual(SwarmaTeamsClient.Failure.map($0), .serviceTooOld)
        }
    }

    func testPagesAgentListAndSendsTool() async throws {
        let calls = LockedURLs()
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("teams-\(UUID().uuidString).json").path
        try Data("{\"token\":\"cn_fake\"}".utf8).write(to: URL(fileURLWithPath: path))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path }, transport: { request in
            let n = calls.add(request)
            let body = n == 1 ? #"{"result":{"agents":[{"id":"a1","name":"Atlas"}],"next_cursor":"a1"}}"#
                              : #"{"result":{"agents":[{"id":"a2","name":"Forge"}],"next_cursor":null}}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, authMode: { .tokenFile })
        let client = SwarmaTeamsClient(base: base, streamTransport: { _ in throw URLError(.badURL) })
        let agents = try await client.agentList().agents
        XCTAssertEqual(agents.map(\.name), ["Atlas", "Forge"])
        XCTAssertEqual(calls.requests.map { $0.url!.path }, ["/api/tools/agent_list", "/api/tools/agent_list"])
        let second = try JSONSerialization.jsonObject(with: calls.requests[1].httpBody!) as? [String: Any]
        XCTAssertEqual(second?["after"] as? String, "a1")
    }

    private final class LockedURLs: @unchecked Sendable {
        let lock = NSLock()
        var requests: [URLRequest] = []
        func add(_ r: URLRequest) -> Int { lock.lock(); defer { lock.unlock() }; requests.append(r); return requests.count }
    }
}

final class TeamsUnreadTests: XCTestCase {
    func testRowCountDerivation() {
        XCTAssertEqual(TeamsUnread.count(unread: 4, lastSeq: 100, lastReadSeq: 0), 4, "service count wins")
        XCTAssertEqual(TeamsUnread.count(unread: nil, lastSeq: 12, lastReadSeq: 9), 3)
        XCTAssertEqual(TeamsUnread.count(unread: nil, lastSeq: 5, lastReadSeq: nil), 5)
        XCTAssertEqual(TeamsUnread.count(unread: nil, lastSeq: 5, lastReadSeq: 8), 0)
        XCTAssertEqual(TeamsUnread.count(unread: nil, lastSeq: nil, lastReadSeq: nil), 0)
    }

    func testOwnMessagesNeverUnread() throws {
        let page = try decode(SwarmaTeamsClient.MessagePage.self, """
        {"messages":[{"id":"1","seq":1,"author":{"kind":"human"},"kind":"text","body":"a"},
                     {"id":"2","seq":2,"author":{"kind":"agent","id":"a1"},"kind":"text","body":"b"},
                     {"id":"3","seq":3,"author":{"kind":"system"},"kind":"notice","body":"c"},
                     {"id":"4","seq":4,"author":{"kind":"human"},"kind":"text","body":"d"}]}
        """)
        XCTAssertEqual(TeamsUnread.count(page.messages, after: 1), 2)
        XCTAssertEqual(TeamsUnread.count(page.messages, after: 3), 0)
    }

    func testLiveBadges() {
        var b = TeamsBadges()
        b.seed(threadID: "t1", unread: 1, lastSeq: 10)
        XCTAssertTrue(b.created(threadID: "t1", seq: 11, authorKind: "agent", isOpen: false))
        XCTAssertEqual(b.count("t1"), 2)
        XCTAssertFalse(b.created(threadID: "t1", seq: 11, authorKind: "agent", isOpen: false), "replay")
        XCTAssertFalse(b.created(threadID: "t1", seq: 9, authorKind: "agent", isOpen: false), "older")
        XCTAssertEqual(b.count("t1"), 2)
        b.created(threadID: "t1", seq: 12, authorKind: "human", isOpen: false)
        XCTAssertEqual(b.count("t1"), 2, "own post")
        b.created(threadID: "t2", seq: 1, authorKind: "agent", isOpen: true)
        XCTAssertEqual(b.count("t2"), 0, "open thread")
        b.read(threadID: "t1")
        XCTAssertEqual(b.count("t1"), 0)
        XCTAssertEqual(b.count(nil), 0)
    }
}

final class QuestionValidationTests: XCTestCase {
    private let single = TeamsQuestion(id: "q", prompt: "Ship?", options: ["Yes", "No"], multi: false, freeText: false)
    private let multi = TeamsQuestion(id: "q", prompt: "Channels?", options: ["X", "LinkedIn", "Blog"], multi: true, freeText: true)

    func testSingleChoice() {
        XCTAssertNil(TeamsAnswerValidation.validate(single, choices: ["Yes"], text: ""))
        XCTAssertEqual(TeamsAnswerValidation.validate(single, choices: [], text: ""), .empty)
        XCTAssertEqual(TeamsAnswerValidation.validate(single, choices: ["Yes", "No"], text: ""), .tooMany)
        XCTAssertEqual(TeamsAnswerValidation.validate(single, choices: ["Maybe"], text: ""), .unknownChoice("Maybe"))
        XCTAssertEqual(TeamsAnswerValidation.validate(single, choices: ["Yes"], text: "because"), .textNotAllowed)
        XCTAssertNil(TeamsAnswerValidation.validate(single, choices: ["Yes"], text: "   "), "blank text is no text")
    }

    func testMultiChoiceWithFreeText() {
        XCTAssertNil(TeamsAnswerValidation.validate(multi, choices: ["X", "Blog"], text: ""))
        XCTAssertNil(TeamsAnswerValidation.validate(multi, choices: [], text: "Only the newsletter"))
        XCTAssertEqual(TeamsAnswerValidation.validate(multi, choices: [], text: " "), .empty)
        XCTAssertEqual(TeamsAnswerValidation.validate(multi, choices: ["X"], text: String(repeating: "a", count: 2001)), .textTooLong)
    }

    func testAnsweredQuestionIsClosed() {
        var q = single
        q.status = "answered"
        XCTAssertEqual(TeamsAnswerValidation.validate(q, choices: ["Yes"], text: ""), .notOpen)
    }
}
