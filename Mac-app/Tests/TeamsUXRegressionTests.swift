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
        model.select(threadID: "t", refreshHistory: false)
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
        model.pane = .tasks
        model.isVisible = true
        model.markSelectedRead()
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "other", seq: 5))
        await model.apply(TeamsEvent(cursor: nil, name: "thread.read", threadID: "other", seq: 5))
        XCTAssertEqual(model.badges.count("other"), 1)
        XCTAssertFalse(model.threadIsVisible)
        XCTAssertEqual(marks, 0)
        model.pane = .bots
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
        model.pane = .tasks
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

extension TeamsUXRegressionTests {
    @MainActor func testReopenPagesForwardFromCachedTail() async throws {
        let stub = UXTransport()
        stub.respond = { _, body in
            let after = body["after_seq"] as? Int
            let numbers = after == nil ? [1] : (after == 1 ? Array(2...51) : (after == 51 ? Array(52...101) : (after == 101 ? Array(102...121) : [])))
            let rows = numbers.map { "{\"id\":\"m\($0)\",\"seq\":\($0),\"kind\":\"text\"}" }.joined(separator: ",")
            return (200, "{\"result\":{\"messages\":[\(rows)],\"has_more\":\(after == 1 || after == 51)}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("t")
        await model.loadLatest("t")
        XCTAssertEqual(model.messages["t"]?.map(\.seq), Array(1...121))
        XCTAssertEqual(stub.requests.compactMap { $0.1["after_seq"] as? Int }, [1, 51, 101])
        model.select(threadID: "other")
        model.select(threadID: "t")
        for _ in 0..<50 { await Task.yield() }
        XCTAssertTrue(stub.requests.contains { $0.1["after_seq"] as? Int == 121 })
    }

    @MainActor func testPermanentSendFailureReleasesComposer() async throws {
        for (code, payload) in [(404, #"{"error":{"code":"not_found"}}"#),
                                (403, #"{"error":{"code":"owner_required"}}"#), (400, "{}")] {
            let stub = UXTransport()
            var posts = 0
            stub.respond = { _, _ in
                posts += 1
                return posts == 1 ? (code, payload) : (200, #"{"result":{}}"#)
            }
            let model = TeamsModel(client: try stub.client(self))
            model.drafts["t"] = "rejected"
            let first = await model.sendDraft(threadID: "t")
            XCTAssertFalse(first)
            XCTAssertNil(model.pendingSends["t"])
            model.drafts["t"] = "corrected"
            let second = await model.sendDraft(threadID: "t")
            XCTAssertTrue(second)
            let sent = stub.requests.filter { $0.0 == "thread_post" }
            XCTAssertEqual(sent.last?.1["body"] as? String, "corrected")
            XCTAssertNotEqual(sent.first?.1["idempotency_key"] as? String, sent.last?.1["idempotency_key"] as? String)
        }
    }

    @MainActor func testRetryableSendFailuresKeepThePendingPost() async throws {
        for (code, payload) in [(429, "{}"), (408, "{}"), (200, "not json")] {
            let stub = UXTransport()
            stub.respond = { _, _ in (code, payload) }
            let model = TeamsModel(client: try stub.client(self))
            model.drafts["t"] = "maybe landed"
            let sent = await model.sendDraft(threadID: "t")
            XCTAssertFalse(sent)
            XCTAssertNotNil(model.pendingSends["t"], "HTTP \(code) is retried with the same key, not rejected")
            XCTAssertNil(model.rejectedSends["t"])
        }
    }

    @MainActor func testFailedEventFetchKeepsHistoryAndReadReceipts() async throws {
        let stub = UXTransport()
        var failNext = false
        stub.respond = { tool, _ in
            if tool == "thread_mark_read" { return (200, #"{"result":{}}"#) }
            if failNext { return (500, "{}") }
            return (200, #"{"result":{"messages":[{"id":"m1","seq":1,"kind":"text"}],"has_more":false}}"#)
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("t")
        model.select(threadID: "t", refreshHistory: false)
        model.isVisible = true
        failNext = true
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "t", seq: 2, authorKind: "agent"))
        XCTAssertNil(model.threadErrors["t"], "a failed fetch must not blank the open thread")
        XCTAssertNotNil(model.staleError)
        XCTAssertEqual(model.messages["t"]?.map(\.seq), [1])
    }

    @MainActor func testVisibleEventsDrainReadAcknowledgmentsAndIgnoreOwner() async throws {
        let stub = UXTransport()
        var latest = 1
        stub.respond = { tool, _ in
            if tool == "thread_mark_read" {
                try await Task.sleep(for: .milliseconds(80))
                return (200, #"{"result":{}}"#)
            }
            return (200, "{\"result\":{\"messages\":[{\"id\":\"m\(latest)\",\"seq\":\(latest),\"kind\":\"text\"}],\"has_more\":false}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("t")
        model.select(threadID: "t")
        model.isVisible = true
        for _ in 0..<30 { await Task.yield() }
        latest = 2
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "t", seq: 2, authorKind: "agent"))
        latest = 3
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "t", seq: 3, authorKind: "agent"))
        XCTAssertEqual(model.badges.count("t"), 0)
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "closed", seq: 3, authorKind: "human"))
        XCTAssertEqual(model.badges.count("closed"), 0)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(stub.requests.filter { $0.0 == "thread_mark_read" }.last?.1["seq"] as? Int, 3)
    }

    @MainActor func testResolvedRefreshIsOnePageAndRetainsPartialResults() async throws {
        let stub = UXTransport()
        stub.respond = { tool, body in
            switch tool {
            case "agent_list": return (200, #"{"result":{"agents":[]}}"#)
            case "thread_list": return (200, #"{"result":{"threads":[]}}"#)
            case "swarm_list": return (200, #"{"result":{"swarms":[]}}"#)
            case "question_list": return (200, #"{"result":{"questions":[]}}"#)
            case "attention_list": return (200, #"{"result":{"items":[{"id":"attention","kind":"task","title":"Review","state":"completed"}]}}"#)
            case "swarm_status": return (200, #"{"result":{"scopes":[{"scope":"project:a"},{"scope":"project:b"}]}}"#)
            case "task_list":
                if body["scope"] as? String == "project:b" { return (503, "{}") }
                if body["resolved"] as? Bool == true {
                    return (200, #"{"result":{"tasks":[{"id":"done","scope":"project:a","status":"completed"}],"next_before_id":"done"}}"#)
                }
                return (200, #"{"result":{"tasks":[{"id":"running","scope":"project:a","status":"running"}]}}"#)
            default: return (200, #"{"result":{}}"#)
            }
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.refresh()
        model.stopStream()
        XCTAssertEqual(stub.requests.filter { $0.0 == "task_list" && $0.1["scope"] as? String == "project:a" && $0.1["resolved"] as? Bool == true }.count, 1)
        XCTAssertEqual(model.resolvedTasks.map(\.id), ["done"])
        XCTAssertEqual(model.attention.map(\.id), ["attention"])
        XCTAssertFalse(model.workingTasks.isEmpty)
    }

    @MainActor func testLessonPermissionMessageStaysSpecific() {
        XCTAssertEqual(LessonReviewModel.describe(SwarmaClient.Failure.forbidden), "This Mac's Swarmaa connection can't review lessons yet")
        XCTAssertFalse(SwarmaClient.Failure.forbidden.message.contains("review lessons"))
    }
}

extension TeamsUXRegressionTests {
    @MainActor func testRejectedSendCanBeEditedOrDiscarded() async throws {
        let stub = UXTransport()
        stub.respond = { _, _ in (400, "{}") }
        let model = TeamsModel(client: try stub.client(self))
        model.drafts["t"] = "bad draft"
        _ = await model.sendDraft(threadID: "t")
        XCTAssertNotNil(model.sendErrors["t"])
        XCTAssertEqual(model.rejectedSends["t"]?.body, "bad draft")
        model.drafts["t"] = "new typing"
        model.discardSend("t", edit: true)
        XCTAssertEqual(model.drafts["t"], "bad draft\nnew typing")
        XCTAssertNil(model.rejectedSends["t"])
        _ = await model.sendDraft(threadID: "t")
        model.discardSend("t")
        XCTAssertNil(model.rejectedSends["t"])
        XCTAssertNil(model.sendErrors["t"])
    }

    @MainActor func testQuestionTargetIsBoundedAndClearedOnSwitch() async throws {
        let stub = UXTransport()
        stub.respond = { _, body in
            let seq = body["before_seq"] == nil ? 100 : 50
            return (200, "{\"result\":{\"messages\":[{\"id\":\"m\(seq)\",\"seq\":\(seq),\"kind\":\"text\"}],\"has_more\":true}}")
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.loadLatest("t")
        model.select(threadID: "t", refreshHistory: false)
        model.targetQuestionID = "missing"
        let found = await model.findTargetQuestion(in: "t")
        XCTAssertNil(found)
        XCTAssertNil(model.targetQuestionID)
        XCTAssertEqual(stub.requests.filter { $0.1["before_seq"] != nil }.count, 1)
        model.targetQuestionID = "another"
        model.select(threadID: "other", refreshHistory: false)
        XCTAssertNil(model.targetQuestionID)
    }

    @MainActor func testTaskActiveConflictRefreshesRows() async throws {
        let stub = UXTransport()
        stub.respond = { tool, _ in
            switch tool {
            case "task_get": return (200, #"{"result":{"task":{"id":"t","status":"completed","version":1}}}"#)
            case "task_resolve": return (409, #"{"error":{"code":"task_active"}}"#)
            default: return (200, #"{"result":{"items":[]}}"#)
            }
        }
        let model = TeamsModel(client: try stub.client(self))
        let resolved = await model.resolve("t", true)
        XCTAssertFalse(resolved)
        XCTAssertTrue(model.error?.contains("queued or running") == true)
        XCTAssertEqual(stub.requests.map(\.0), ["task_get", "task_resolve", "attention_list"])
    }

    func testResolvedLoadMoreUsesBeforeID() async throws {
        let stub = UXTransport()
        stub.respond = { _, body in
            if body["before_id"] as? String == "one" { return (200, #"{"result":{"tasks":[{"id":"two"}]}}"#) }
            return (200, #"{"result":{"tasks":[{"id":"one"}],"next_before_id":"one"}}"#)
        }
        let client = try stub.client(self)
        let first = try await client.resolvedTaskPage(scope: "project:test")
        XCTAssertEqual(stub.requests.count, 1)
        XCTAssertEqual(first.tasks.map(\.id), ["one"])
        let second = try await client.resolvedTaskPage(scope: "project:test", beforeID: first.next)
        XCTAssertEqual(second.tasks.map(\.id), ["two"])
        XCTAssertNil(second.next)
    }

    /// A failed `bot_create` after the lead was made: the error shows in the sheet,
    /// and the retry reuses that lead instead of making a second one with its name.
    @MainActor func testNewBotRetryReusesTheLeadItAlreadyMade() async throws {
        let transport = UXTransport()
        var botCalls = 0
        transport.respond = { tool, _ in
            switch tool {
            case "agent_create":
                return (200, #"{"result":{"agent":{"id":"lead-1","name":"Launch","role":"Lead","scope":"project:demo","main_thread_id":"m1","runner":{"mode":"auto"},"edits":false,"version":1}}}"#)
            case "bot_create":
                botCalls += 1
                if botCalls == 1 { return (409, #"{"error":{"code":"name_taken","message":"A bot named Launch already exists in project:demo."}}"#) }
                return (200, #"{"result":{"bot":{"id":"b1","scope":"project:demo","name":"Launch","job":"Ship it","thread_id":"t1","lead_agent_id":"lead-1","member_agent_ids":[],"routing":{},"rules":{},"version":1}}}"#)
            default: return (200, #"{"result":{}}"#)
            }
        }
        let model = TeamsModel(client: try transport.client(self))
        var lead: String?
        let first = await model.createBot(name: "Launch", job: "Ship it", scope: "project:demo", leadAgentID: nil, memberAgentIDs: [], onLeadCreated: { lead = $0 })
        XCTAssertFalse(first)
        XCTAssertEqual(lead, "lead-1")
        XCTAssertNotNil(model.botError, "the sheet must show why nothing happened")
        XCTAssertNil(model.error, "not the window alert hidden behind the sheet")
        let second = await model.createBot(name: "Launch", job: "Ship it", scope: "project:demo", leadAgentID: lead, memberAgentIDs: [])
        XCTAssertTrue(second)
        XCTAssertNil(model.botError)
        XCTAssertEqual(transport.requests.filter { $0.0 == "agent_create" }.count, 1)
    }
}

/// Peak in-flight requests, for the concurrency checks.
private final class InFlight: @unchecked Sendable {
    private let lock = NSLock()
    private var now = 0, top = 0
    var peak: Int { lock.lock(); defer { lock.unlock() }; return top }
    func around<T>(_ work: () async throws -> T) async rethrows -> T {
        lock.lock(); now += 1; top = max(top, now); lock.unlock()
        defer { lock.lock(); now -= 1; lock.unlock() }
        return try await work()
    }
}

extension TeamsUXRegressionTests {
    @MainActor func testRefreshRunsIndependentCallsConcurrentlyBoundedForTasks() async throws {
        let stub = UXTransport()
        let all = InFlight(), lists = InFlight()
        let scopes = (1...6).map { "{\"scope\":\"project:\($0)\"}" }.joined(separator: ",")
        stub.respond = { tool, _ in
            try await all.around {
                let reply = { try await Task.sleep(for: .milliseconds(40)) }
                switch tool {
                case "agent_list": return (200, #"{"result":{"agents":[]}}"#)
                case "swarm_status": try await reply(); return (200, "{\"result\":{\"scopes\":[\(scopes)]}}")
                case "task_list": return try await lists.around { try await reply(); return (200, #"{"result":{"tasks":[]}}"#) }
                default: try await reply(); return (200, #"{"result":{"items":[]}}"#)
                }
            }
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.refresh()
        model.stopStream()
        XCTAssertEqual(stub.requests.filter { $0.0 == "task_list" }.count, 18)
        XCTAssertGreaterThanOrEqual(all.peak, 5, "channels, swarms, questions, status and bots overlap")
        XCTAssertEqual(lists.peak, 8, "task_list runs 8 at once, no more")
    }
}

extension TeamsUXRegressionTests {
    /// Two scopes, one running task each ("project:a-running"), nothing queued or resolved.
    @MainActor fileprivate func taskModel(_ stub: UXTransport, extra: @escaping (String, [String: Any]) -> (Int, String)? = { _, _ in nil }) async throws -> TeamsModel {
        stub.respond = { tool, body in
            if let reply = extra(tool, body) { return reply }
            switch tool {
            case "agent_list": return (200, #"{"result":{"agents":[]}}"#)
            case "swarm_status": return (200, #"{"result":{"scopes":[{"scope":"project:a"},{"scope":"project:b"}]}}"#)
            case "task_get": return (200, #"{"result":{"task":{"id":"project:a-running","scope":"project:a","status":"running","version":7}}}"#)
            case "task_list":
                guard body["status"] as? String == "running", let scope = body["scope"] as? String else { return (200, #"{"result":{"tasks":[]}}"#) }
                return (200, "{\"result\":{\"tasks\":[{\"id\":\"\(scope)-running\",\"scope\":\"\(scope)\",\"status\":\"running\",\"version\":1}]}}")
            default: return (200, #"{"result":{"items":[]}}"#)
            }
        }
        let model = TeamsModel(client: try stub.client(self))
        await model.refresh()
        model.stopStream()
        try await Task.sleep(for: .milliseconds(50))
        return model
    }

    private func taskEvent(_ payload: String) throws -> TeamsEvent {
        try XCTUnwrap(TeamsEvent(SSEParser.Frame(id: "1.1", event: "task.updated", data: "{\"scope\":\"project:a\",\"payload\":\(payload)}")))
    }

    @MainActor func testRunningTaskEventPatchesOneRowWithAtMostOneRequest() async throws {
        let stub = UXTransport()
        let model = try await taskModel(stub)
        var before = stub.requests.count
        // The service's own fields: no request at all.
        await model.apply(try taskEvent(#"{"task_id":"project:a-running","status":"running","version":3,"action":"checkpointed"}"#))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(stub.requests.count - before, 0)
        XCTAssertEqual(model.workingTasks.first { $0.id == "project:a-running" }?.version, 3)
        // No status in the payload: one task_get, merged in, no lists and no bot_list.
        before = stub.requests.count
        await model.apply(try taskEvent(#"{"task_id":"project:a-running"}"#))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(stub.requests.dropFirst(before).map(\.0), ["task_get"])
        XCTAssertEqual(model.workingTasks.first { $0.id == "project:a-running" }?.version, 7)
        XCTAssertEqual(model.workingTasks.count, 2)
        // It finished: it leaves the list, so that scope (and only it) is listed again, with the badges.
        before = stub.requests.count
        await model.apply(try taskEvent(#"{"task_id":"project:a-running","status":"completed","action":"finished"}"#))
        try await Task.sleep(for: .milliseconds(400))
        let after = stub.requests.dropFirst(before)
        XCTAssertEqual(after.filter { $0.0 == "task_list" }.count, 3)
        XCTAssertTrue(after.filter { $0.0 == "task_list" }.allSatisfy { $0.1["scope"] as? String == "project:a" })
        XCTAssertEqual(after.filter { $0.0 == "bot_list" }.count, 1)
    }
}

extension TeamsUXRegressionTests {
    @MainActor func testTurnEventInOpenThreadReadsTypingAndTheReplyReplacesIt() async throws {
        let stub = UXTransport()
        var reply = false
        let model = try await taskModel(stub) { tool, body in
            guard tool == "thread_read" else { return tool == "thread_mark_read" ? (200, #"{"result":{}}"#) : nil }
            let hello = #"{"id":"m1","seq":1,"kind":"text","body":"hi","author":{"kind":"human"},"created_at":"2026-10-28T10:00:00Z"}"#
            let answer = #"{"id":"m2","seq":2,"kind":"text","body":"Done.","author":{"kind":"agent","id":"ag1"},"created_at":"2026-10-28T10:00:09Z"}"#
            let typing = #"[{"task_id":"project:a-running","agent_id":"ag1","text":"Looking at it","updated_at":"2026-10-28T10:00:05Z"}]"#
            if body["after_seq"] == nil { return (200, "{\"result\":{\"messages\":[\(hello)],\"has_more\":false}}") }
            // The task is still running for a moment after its reply posts: typing is still listed.
            return (200, "{\"result\":{\"messages\":[\(reply ? answer : "")],\"typing\":\(typing),\"has_more\":false}}")
        }
        await model.loadLatest("t1")
        XCTAssertEqual(model.liveTyping("t1"), [], "an older-style page without typing keeps none")
        model.select(threadID: "t1", refreshHistory: false)
        model.isVisible = true
        try await Task.sleep(for: .milliseconds(100))
        let before = stub.requests.filter { $0.0 != "thread_mark_read" }.count
        let turn = #"{"task_id":"project:a-running","status":"running","action":"checkpointed","kind":"turn","thread_id":"t1"}"#
        for _ in 0..<3 { await model.apply(try taskEvent(turn)) }
        XCTAssertEqual(model.liveTyping("t1"), [], "debounced")
        try await Task.sleep(for: .milliseconds(500))
        let calls = stub.requests.filter { $0.0 != "thread_mark_read" }.dropFirst(before)
        XCTAssertEqual(calls.map(\.0), ["thread_read"], "three turn events cost one small read, no lists")
        XCTAssertEqual(calls.first?.1["after_seq"] as? Int, 1)
        XCTAssertEqual(model.liveTyping("t1").map(\.text), ["Looking at it"])
        // The agent's message lands: the bubble goes, even though typing is still listed.
        reply = true
        await model.apply(TeamsEvent(cursor: nil, name: "message.created", threadID: "t1", seq: 2, authorKind: "agent"))
        XCTAssertEqual(model.messages["t1"]?.map(\.seq), [1, 2])
        XCTAssertEqual(model.liveTyping("t1"), [])
        XCTAssertEqual(model.typing["t1"]?.count, 1)
        // The task ends: the entry itself goes.
        await model.apply(try taskEvent(#"{"task_id":"project:a-running","status":"completed","action":"finished","kind":"turn","thread_id":"t1"}"#))
        XCTAssertEqual(model.typing["t1"], [])
    }

    func testTypingDecodesAndIsOptional() throws {
        let with = Data(#"{"messages":[],"typing":[{"task_id":"k","agent_id":"a","text":"so far","updated_at":"2026-10-28T10:00:05Z"}]}"#.utf8)
        let page = try SwarmaClient.decoder.decode(SwarmaTeamsClient.MessagePage.self, from: with)
        XCTAssertEqual(page.typing?.first?.agentID, "a")
        XCTAssertNotNil(page.typing?.first?.updatedAt)
        XCTAssertNil(try SwarmaClient.decoder.decode(SwarmaTeamsClient.MessagePage.self, from: Data(#"{"messages":[]}"#.utf8)).typing)
        let event = try XCTUnwrap(TeamsEvent(SSEParser.Frame(id: nil, event: "task.updated",
            data: #"{"scope":"s","payload":{"task_id":"k","status":"running","kind":"turn","thread_id":"t","version":4}}"#)))
        XCTAssertEqual([event.subjectID, event.kind, event.threadID, event.status], ["k", "turn", "t", "running"])
        XCTAssertEqual(event.version, 4)
    }
}
