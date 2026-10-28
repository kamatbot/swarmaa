import AppKit
import XCTest
@testable import Codenotch

private final class UXTransport: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [(String, [String: Any])] = []
    var respond: (String, [String: Any]) async throws -> (Int, String) = { _, _ in (200, "{\"result\":{}}") }
    var requests: [(String, [String: Any])] { lock.lock(); defer { lock.unlock() }; return recorded }
    func record(_ tool: String, _ body: [String: Any]) { lock.lock(); recorded.append((tool, body)); lock.unlock() }
    func client(_ test: XCTestCase) throws -> SwarmaTeamsClient {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(#"{"token":"test-only"}"#.utf8).write(to: path)
        test.addTeardownBlock { try? FileManager.default.removeItem(at: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path.path }, transport: { [self] request in
            let tool = request.url!.lastPathComponent
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            record(tool, body)
            let (code, text) = try await respond(tool, body)
            return (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
        }, cacheTTL: 0, authMode: { .tokenFile })
        return SwarmaTeamsClient(base: base, streamTransport: { _ in throw SwarmaClient.Failure.unauthorized })
    }
}

final class TeamsUXRegressionTests: XCTestCase {
    func testEmbeddedCardsAndLegacyFallback() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/thread_embedded_cards.json")
        let page = try SwarmaClient.decoder.decode(SwarmaTeamsClient.MessagePage.self, from: Data(contentsOf: url))
        XCTAssertEqual(page.messages[0].question?.options, ["Ship", "Wait"])
        XCTAssertEqual(page.messages[0].question?.threadID, "t1")
        XCTAssertEqual(page.messages[1].answer?.choices, ["Ship"])
        XCTAssertEqual(page.messages[1].answer?.questionID, "q1")
        XCTAssertEqual(page.messages[2].swarm?.progress.total, 2)
        XCTAssertNil(page.messages[3].question)
        XCTAssertEqual(page.messages[3].preview, "Legacy question")
        XCTAssertEqual(page.messages[4].answer?.text, "Legacy answer")
        XCTAssertNil(page.messages[5].swarm)
        XCTAssertEqual(page.messages[5].ref?.swarmID, "s-old")
    }

    @MainActor func testNewestPageOlderAndForwardGap() async throws {
        let stub = UXTransport()
        stub.respond = { _, body in
            let seq: Int
            if body["before_seq"] as? Int == 51 { seq = 50 }
            else if let after = body["after_seq"] as? Int { seq = after + 1 }
            else { seq = 51 }
            return (200, "{\"result\":{\"messages\":[{\"id\":\"m\(seq)\",\"seq\":\(seq),\"thread_id\":\"t\",\"kind\":\"text\",\"body\":\"hello\"}],\"has_more\":\(seq == 51 || seq == 52)}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("t")
        XCTAssertEqual(model.messages["t"]?.map(\.seq), [51])
        XCTAssertNil(stub.requests.first?.1["after_seq"])
        await model.loadOlder("t")
        XCTAssertEqual(model.messages["t"]?.map(\.seq), [50, 51])
        model.select(threadID: "t")
        model.isVisible = true
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "t", seq: 53))
        XCTAssertEqual(model.messages["t"]?.map(\.seq), [50, 51, 52, 53])
        XCTAssertEqual(stub.requests.filter { $0.0 == "thread_read" }.compactMap { $0.1["after_seq"] as? Int }, [51, 52])
    }

    @MainActor func testDraftsSendTargetAndRetryPreserveNewTyping() async throws {
        let stub = UXTransport()
        var posts = 0
        stub.respond = { tool, _ in
            if tool == "thread_post" {
                posts += 1
                return posts == 1 ? (503, "{}") : (200, "{\"result\":{}}")
            }
            return (200, "{\"result\":{\"messages\":[],\"has_more\":false}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        model.drafts["a"] = "first"
        model.drafts["b"] = "second"
        model.select(threadID: "b")
        let failed = await model.sendDraft(threadID: "a")
        XCTAssertFalse(failed)
        model.drafts["a"] = "new typing"
        let success = await model.sendDraft(threadID: "a")
        XCTAssertTrue(success)
        XCTAssertEqual(model.drafts["a"], "new typing")
        XCTAssertEqual(model.drafts["b"], "second")
        let sent = stub.requests.filter { $0.0 == "thread_post" }.map(\.1)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[0]["thread_id"] as? String, "a")
        XCTAssertEqual(sent[1]["body"] as? String, "first")
        XCTAssertEqual(sent[0]["idempotency_key"] as? String, sent[1]["idempotency_key"] as? String)
    }

    @MainActor func testUnreadDoesNotClearOnHomeOrForeignReadAndRetriesFailure() async throws {
        let stub = UXTransport()
        var marks = 0
        stub.respond = { tool, _ in
            if tool == "thread_mark_read" { marks += 1; return marks == 1 ? (503, "{}") : (200, "{\"result\":{}}") }
            return (200, "{\"result\":{\"messages\":[{\"id\":\"m\",\"seq\":1,\"kind\":\"text\",\"body\":\"x\"}],\"has_more\":false}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("t")
        model.select(threadID: "t")
        model.pane = .home
        model.isVisible = true
        model.markSelectedRead()
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "other", seq: 5))
        await model.apply(TeamsEvent(cursor: nil, name: "thread.read", threadID: "other", seq: 5))
        XCTAssertEqual(model.badges.count("other"), 1)
        XCTAssertFalse(model.threadIsVisible)
        XCTAssertEqual(marks, 0)
        model.pane = .agents
        model.markSelectedRead()
        for _ in 0..<30 { await Task.yield() }
        XCTAssertNotNil(model.staleError)
        model.markSelectedRead()
        for _ in 0..<30 { await Task.yield() }
        XCTAssertEqual(marks, 2)
    }

    func testResolveGatesActiveAndRunnerKeepsModel() {
        for state in ["running", "queued"] {
            let row = TeamsTaskRow(TeamsAttentionItem(kind: "task", id: state, title: state, state: state, nextStep: "Working"))
            XCTAssertFalse(row.resolvable)
        }
        XCTAssertTrue(TeamsTaskRow(TeamsAttentionItem(kind: "task", id: "done", title: "Done", state: "completed", nextStep: "Ready for review")).resolvable)
        let runner = TeamsRunner(provider: "codex", model: "configured-model", effort: "low")
        XCTAssertEqual(runner.changing(provider: "codex", effort: "high").model, "configured-model")
        XCTAssertNil(runner.changing(provider: "claude", effort: "high").model)
    }

    func testProbeRequiresStructuredCode() {
        XCTAssertEqual(TeamsSetup.answerProbe(SwarmaClient.Failure.serviceCode("not_found")), .ready)
        XCTAssertEqual(TeamsSetup.answerProbe(SwarmaClient.Failure.serviceCode("owner_required")), .needsSetup)
        XCTAssertEqual(TeamsSetup.answerProbe(SwarmaClient.Failure.serviceCode("unknown_tool")), .needsSetup)
        XCTAssertNotEqual(TeamsSetup.answerProbe(SwarmaClient.Failure.http(404)), .ready)
        XCTAssertEqual(TeamsSetup.answerProbe(SwarmaClient.Failure.forbidden), .notChecked)
    }

    @MainActor func testFailedTaskRefreshPreservesDataAndMarksStale() async throws {
        let stub = UXTransport()
        var fail = false
        stub.respond = { _, _ in
            fail ? (503, "{}") : (200, "{\"result\":{\"items\":[{\"id\":\"t\",\"kind\":\"task\",\"title\":\"Keep me\",\"state\":\"completed\"}],\"has_more\":false}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadTasks()
        XCTAssertEqual(model.attention.count, 1)
        fail = true
        await model.loadTasks()
        XCTAssertEqual(model.attention.first?.title, "Keep me")
        XCTAssertNotNil(model.staleError)
    }

    func testTaskPaginationUsesBeforeID() async throws {
        let stub = UXTransport()
        stub.respond = { _, body in
            if body["before_id"] as? String == "one" { return (200, "{\"result\":{\"tasks\":[{\"id\":\"two\"}],\"next_before_id\":null}}") }
            return (200, "{\"result\":{\"tasks\":[{\"id\":\"one\"}],\"next_before_id\":\"one\"}}")
        }
        let tasks = try await stub.client(self).taskList(scope: "project:test")
        XCTAssertEqual(tasks.map(\.id), ["one", "two"])
        XCTAssertNil(stub.requests.last?.1["after"])
    }

    func testSwarmLinkRetainsTarget() {
        XCTAssertEqual(SwarmaCells.swarmID(fromCellID: "swarm:thread:t/swarm/s"), "s")
        XCTAssertEqual(SwarmaCells.threadID(fromCellID: "swarm:thread:t/swarm/s"), "t")
    }
}

final class TeamsWindowAccessibilityTests: XCTestCase {
    @MainActor func testMainWindowAccessibilityContract() throws {
        // Opt in on a desktop test session. Worker tasks prohibit app launch and
        // must not silently turn a build check into a GUI/service connection.
        try XCTSkipUnless(ProcessInfo.processInfo.environment["SWARMAA_AX_WINDOW_TEST"] == "1",
                          "Requires authorized desktop AX session; no application launch in this worker")
        _ = NSApplication.shared
        let controller = TeamsWindowController()
        controller.show(connect: false)
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        XCTAssertTrue(window.isAccessibilityElement())
        XCTAssertEqual(window.accessibilityRole(), .window)
        XCTAssertFalse((window.accessibilityChildren() ?? []).isEmpty)
        XCTAssertTrue(NSApp.windows.contains(window))
        let axWindows = NSApp.accessibilityWindows() as? [NSWindow] ?? []
        XCTAssertTrue(axWindows.contains(window), "Main window must be in application AXWindows")
    }
}

extension TeamsUXRegressionTests {
    @MainActor func testEmbeddedQuestionReachesOwnerRequiredAndSwarmFailureEndsLoading() async throws {
        let stub = UXTransport()
        stub.respond = { tool, _ in
            if tool == "question_answer" { return (403, #"{"error":{"code":"owner_required"}}"#) }
            return (503, "{}")
        }
        let model = TeamsModel(client: try stub.client(self))
        let data = Data(#"{"id":"m","seq":1,"kind":"question","body":"Ship?","question":{"id":"q","prompt":"Ship?","options":["Yes"],"status":"open"}}"#.utf8)
        let message = try SwarmaClient.decoder.decode(TeamsMessage.self, from: data)
        let answered = await model.answer(try XCTUnwrap(message.question), choices: ["Yes"], text: "")
        XCTAssertFalse(answered)
        XCTAssertTrue(model.answeringBlocked)
        await model.loadSwarm("missing")
        XCTAssertNotNil(model.swarmErrors["missing"])
    }

    func testMCPStructuredProbeErrors() {
        for code in ["not_found", "owner_required", "unknown_tool"] {
            let data = Data("{\"result\":{\"isError\":true,\"structuredContent\":{\"error\":{\"code\":\"\(code)\"}}}}".utf8)
            XCTAssertThrowsError(try SwarmaClient.unwrapMCP(data)) { error in
                XCTAssertEqual(error as? SwarmaClient.Failure, .serviceCode(code))
            }
        }
    }

    func testQuestionListFollowsCursor() async throws {
        let stub = UXTransport()
        stub.respond = { _, body in
            if body["after"] as? String == "q1" { return (200, #"{"result":{"questions":[{"id":"q2"}],"next_cursor":null}}"#) }
            return (200, #"{"result":{"questions":[{"id":"q1"}],"next_cursor":"q1"}}"#)
        }
        let questions = try await stub.client(self).questionList()
        XCTAssertEqual(questions.map(\.id), ["q1", "q2"])
    }
}

extension TeamsUXRegressionTests {
    @MainActor func testOpeningAnotherThreadDoesNotAcknowledgePreviousHiddenSelection() async throws {
        let stub = UXTransport()
        stub.respond = { _, _ in (200, #"{"result":{"messages":[{"id":"m","seq":1,"kind":"text","body":"x"}],"has_more":false}}"#) }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("old")
        await model.loadLatest("new")
        model.select(threadID: "old")
        model.pane = .home
        model.isVisible = true
        model.select(threadID: "new")
        for _ in 0..<30 { await Task.yield() }
        let readThreads = stub.requests.filter { $0.0 == "thread_mark_read" }.compactMap { $0.1["thread_id"] as? String }
        XCTAssertFalse(readThreads.contains("old"))
        XCTAssertTrue(readThreads.contains("new"))
    }

    @MainActor func testTaskEventsCoalesce() async throws {
        let stub = UXTransport()
        stub.respond = { _, _ in (200, #"{"result":{"items":[],"next_cursor":null}}"#) }
        let model = TeamsModel(client: try stub.client(self))
        for _ in 0..<8 { await model.apply(TeamsEvent(cursor: nil, name: "task.updated")) }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(stub.requests.filter { $0.0 == "attention_list" }.count, 1)
    }
}

extension TeamsUXRegressionTests {
    @MainActor func testScopedTaskEventPreservesOtherScopes() async throws {
        let stub = UXTransport()
        stub.respond = { tool, body in
            switch tool {
            case "agent_list": return (200, #"{"result":{"agents":[]}}"#)
            case "thread_list": return (200, #"{"result":{"threads":[]}}"#)
            case "swarm_list": return (200, #"{"result":{"swarms":[]}}"#)
            case "question_list": return (200, #"{"result":{"questions":[]}}"#)
            case "attention_list": return (200, #"{"result":{"items":[]}}"#)
            case "swarm_status": return (200, #"{"result":{"scopes":[{"scope":"project:a"},{"scope":"project:b"}]}}"#)
            case "task_list":
                if body["resolved"] as? Bool == true { return (200, #"{"result":{"tasks":[]}}"#) }
                let scope = body["scope"] as! String, state = body["status"] as! String
                return (200, "{\"result\":{\"tasks\":[{\"id\":\"\(scope)-\(state)\",\"scope\":\"\(scope)\",\"status\":\"\(state)\"}]}}")
            default: return (500, "{}")
            }
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.refresh()
        defer { model.stopStream() }
        let before = stub.requests.count
        let event = try XCTUnwrap(TeamsEvent(SSEParser.Frame(id: "1.1", event: "task.updated",
            data: #"{"scope":"project:a","payload":{"subject_id":"task-a"}}"#)))
        XCTAssertEqual(event.scope, "project:a")
        await model.apply(event)
        try await Task.sleep(for: .milliseconds(400))
        let calls = stub.requests.dropFirst(before).filter { $0.0 == "task_list" }
        XCTAssertEqual(calls.count, 3)
        XCTAssertTrue(calls.allSatisfy { $0.1["scope"] as? String == "project:a" })
        XCTAssertEqual(model.workingTasks.filter { $0.scope == "project:b" }.count, 2)
    }
}
