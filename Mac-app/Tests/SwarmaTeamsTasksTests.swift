import SwiftUI
import XCTest
@testable import Codenotch

/// Teams phase 3b. Fixtures are the live service's own answers, copied from
/// docs/briefs/teams-shapes into Tests/Fixtures. No network: stub transports.
private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/\(name).json"))
}

/// Records each request; answers by tool name with (status, body).
private final class Stub: @unchecked Sendable {
    let lock = NSLock()
    var requests: [URLRequest] = []
    let answer: (String) -> (Int, Data)
    init(_ answer: @escaping (String) -> (Int, Data)) { self.answer = answer }

    var tools: [String] { lock.lock(); defer { lock.unlock() }; return requests.map { $0.url!.lastPathComponent } }
    func body(_ tool: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        return requests.last { $0.url!.lastPathComponent == tool }
            .flatMap { try? JSONSerialization.jsonObject(with: $0.httpBody!) as? [String: Any] }
    }

    func client(_ test: XCTestCase) throws -> SwarmaTeamsClient {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("teams-\(UUID().uuidString).json").path
        try Data("{\"token\":\"cn_fake\"}".utf8).write(to: URL(fileURLWithPath: path))
        test.addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path }, transport: { [self] request in
            lock.lock(); requests.append(request); lock.unlock()
            let (code, data) = answer(request.url!.lastPathComponent)
            return (data, HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
        }, cacheTTL: 0, authMode: { .tokenFile })
        return SwarmaTeamsClient(base: base, streamTransport: { _ in throw URLError(.badURL) }, sleep: { _ in })
    }
}

final class TeamsShapeFileTests: XCTestCase {
    private func client(_ tool: String, _ file: String) throws -> SwarmaTeamsClient {
        let data = try fixture(file)
        return try Stub { $0 == tool ? (200, data) : (404, Data()) }.client(self)
    }

    func testAttentionList() async throws {
        struct R: Decodable { let result: SwarmaTeamsClient.AttentionPage }
        let page = try SwarmaClient.decoder.decode(R.self, from: fixture("attention_list")).result
        XCTAssertEqual(page.hasMore, true)
        XCTAssertEqual(page.nextCursor, "12aaee4d-4e2e-434b-86db-6f5df085fe62")
        let items = page.items
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(items[0].kind, "task")
        XCTAssertEqual(items[0].id, "aa96efb9-0b7f-4c3c-af2f-60804842b2f9")
        XCTAssertEqual(items[0].state, "completed")
        XCTAssertEqual(items[0].nextStep, "Ready for review · branch swarmaa/claude/aa96efb9 · 12 files")
        XCTAssertEqual(items[0].branch, "swarmaa/claude/aa96efb9")
        XCTAssertNotNil(items[0].at)
        XCTAssertNil(items[0].threadID)
    }

    func testAttentionListFollowsCursor() async throws {
        let first = try fixture("attention_list")   // has_more: true
        let last = Data(#"{"result":{"items":[],"has_more":false,"next_cursor":null}}"#.utf8)
        var n = 0
        let paged = Stub { _ in n += 1; return (200, n == 1 ? first : last) }
        let items = try await paged.client(self).attentionList()
        XCTAssertEqual(items.count, 3)
        XCTAssertEqual(paged.tools, ["attention_list", "attention_list"])
        XCTAssertEqual(paged.body("attention_list")?["after"] as? String, "12aaee4d-4e2e-434b-86db-6f5df085fe62")
    }

    func testQuestionList() async throws {
        let questions = try await client("question_list", "question_list").questionList()
        XCTAssertEqual(questions, [])
    }

    func testSwarmGet() async throws {
        let s = try await client("swarm_get", "swarm_get").swarmGet(id: "8189aca5-f59b-4a14-b01d-dd49e617e259")
        XCTAssertEqual(s.id, "8189aca5-f59b-4a14-b01d-dd49e617e259")
        XCTAssertEqual(s.title, "Two-step colour check")
        XCTAssertEqual(s.goal, "List three colours and pick the brightest one")
        XCTAssertEqual(s.threadID, "54b186ab-54ff-4c06-987a-7dabe746256c")
        XCTAssertEqual(s.ownerAgentID, "73004e49-fc55-4111-a0c7-a21795be4b76")
        XCTAssertEqual(s.status, "done")
        XCTAssertEqual(s.version, 3)
        XCTAssertNotNil(s.closedAt)
        XCTAssertEqual(s.progress, .init(done: 2, total: 2))
        XCTAssertEqual(s.steps.map(\.title), ["List three colours", "Pick the brightest colour"])
        XCTAssertEqual(s.steps[1].needs, ["918a6560-1261-42e4-86b5-c51b5c48a954"])
        XCTAssertEqual(s.steps[1].assigneeAgentID, "8e6edba1-b977-460a-a895-303a6886a86d")
        XCTAssertEqual(s.steps[1].taskID, "ac80f11a-f07a-4c0f-b8db-a10fac90662b")
        XCTAssertEqual(s.steps[1].resultMessageID, "8175143a-a276-4863-a314-c73417c4e61f")
        XCTAssertNil(s.steps[0].check)
        XCTAssertNil(s.steps[0].failureCode)
        XCTAssertEqual(s.steps.map(\.orderIndex), [0, 1])
    }

    func testSwarmList() async throws {
        let swarms = try await client("swarm_list", "swarm_list").swarmList()
        XCTAssertEqual(swarms.count, 3)
        XCTAssertEqual(swarms.map(\.progress.total), [2, 2, 2])
        XCTAssertEqual(Set(swarms.map(\.status)), ["done"])
    }

    func testThreadListChannel() async throws {
        let threads = try await client("thread_list", "thread_list_channel").threadList(kind: "channel")
        XCTAssertEqual(threads, [])
    }

    func testSectionList() throws {
        struct R: Decodable { struct S: Decodable { let sections: [TeamsSection] }; let result: S }
        XCTAssertEqual(try SwarmaClient.decoder.decode(R.self, from: fixture("section_list")).result.sections, [])
    }

    func testThreadReadSwarmCardHasNoSnapshot() async throws {
        let page = try await client("thread_read", "thread_read_swarm").threadRead(id: "0b704500-6f4b-4ec2-b199-aeaff6b3f0a5")
        XCTAssertEqual(page.hasMore, false)
        XCTAssertEqual(page.messages.map(\.kind), [.text, .text, .swarm, .notice, .text])
        let card = page.messages[2]
        XCTAssertEqual(card.ref?.swarmID, "57b129ff-2484-421d-bf3b-d95ff9b10f4c")
        XCTAssertNil(card.swarm, "the card is fed by swarm_get, not the thread")
        XCTAssertEqual(card.body, "")
        XCTAssertEqual(card.author.kind, "system")
        XCTAssertTrue(page.messages[0].isHuman)
    }
}

final class TeamsTaskGroupingTests: XCTestCase {
    private func items() throws -> [TeamsAttentionItem] {
        struct R: Decodable { let result: SwarmaTeamsClient.AttentionPage }
        let live = try SwarmaClient.decoder.decode(R.self, from: fixture("attention_list")).result.items
        // The other next_step forms the brief quotes from the live service.
        return live + [
            TeamsAttentionItem(kind: "question", id: "q1", title: "Which channels?", state: "open",
                               nextStep: "Needs input · answer the question", at: Date(), threadID: "t1"),
            TeamsAttentionItem(kind: "task", id: "f1", title: "Broke", state: "failed",
                               nextStep: "Failed · quota_exhausted · retry", at: Date(timeIntervalSince1970: 0)),
            TeamsAttentionItem(kind: "swarm", id: "s1", title: "Launch", state: "blocked", nextStep: ""),
        ]
    }

    func testSectionsAndWords() throws {
        let rows = TeamsTaskGrouping.rows(attention: try items(), working: [], resolved: [])
        XCTAssertEqual(rows.map(\.section), [.review, .review, .review, .needsInput, .failed, .failed])
        XCTAssertEqual(rows[0].word, "Ready for review")
        XCTAssertEqual(rows[0].detail, "branch swarmaa/claude/aa96efb9 · 12 files")
        XCTAssertEqual(rows[4].word, "Failed")
        XCTAssertEqual(rows[4].detail, "quota_exhausted · retry")
        XCTAssertEqual(rows[5].word, "Failed", "no next_step: the section names it")
        XCTAssertEqual(rows.map(\.resolvable), [true, true, true, false, true, false])
    }

    func testColours() {
        XCTAssertEqual(TeamsTaskSection.review.color, .green)
        XCTAssertEqual(TeamsTaskSection.needsInput.color, .orange)
        XCTAssertEqual(TeamsTaskSection.working.color, .blue)
        XCTAssertEqual(TeamsTaskSection.failed.color, .red)
    }

    func testWorkingAndResolvedFromTaskList() throws {
        let tasks = try SwarmaClient.decoder.decode([TeamsTask].self, from: Data("""
        [{"id":"w1","objective":"Running one","status":"running","version":2,"scope":"project:demo"},
         {"id":"aa96efb9-0b7f-4c3c-af2f-60804842b2f9","objective":"Done","status":"completed","version":5}]
        """.utf8))
        let rows = TeamsTaskGrouping.rows(attention: try items(), working: [tasks[0]], resolved: [tasks[1]])
        XCTAssertEqual(rows.first { $0.id == "w1" }?.section, .working)
        XCTAssertEqual(rows.first { $0.id == "w1" }?.detail, "demo")
        XCTAssertEqual(rows.filter { $0.id == tasks[1].id }.map(\.section), [.resolved], "resolved wins, listed once")
    }

    func testSectionOrderSearchAndSort() throws {
        let rows = TeamsTaskGrouping.rows(attention: try items(), working: [], resolved: [])
        XCTAssertEqual(TeamsTaskGrouping.sections(rows).map(\.section), [.needsInput, .review, .failed])
        XCTAssertEqual(TeamsTaskGrouping.sections(rows, search: "QUOTA").flatMap { $0.rows.map(\.id) }, ["f1"])
        let byState = TeamsTaskGrouping.sections(rows, sort: .state).flatMap { $0.rows }
        XCTAssertEqual(byState.first?.id, "q1")
        let failed = TeamsTaskGrouping.sections(rows).first { $0.section == .failed }!.rows
        XCTAssertEqual(failed.map(\.id), ["f1", "s1"], "newest first; no date sorts last")
    }
}

final class TeamsResolveTests: XCTestCase {
    private static let task = Data(#"{"result":{"task":{"id":"k1","objective":"x","status":"completed","version":7}}}"#.utf8)

    func testResolveRequest() async throws {
        let stub = Stub { _ in (200, Data(#"{"result":{"task":{"id":"k1"}}}"#.utf8)) }
        try await stub.client(self).taskResolve(id: "k1", resolved: true, expectedVersion: 7)
        XCTAssertEqual(stub.requests.first?.url?.path, "/api/tools/task_resolve")
        let body = try XCTUnwrap(stub.body("task_resolve"))
        XCTAssertEqual(body["task_id"] as? String, "k1")
        XCTAssertEqual(body["resolved"] as? Bool, true)
        XCTAssertEqual(body["expected_version"] as? Int, 7)
        XCTAssertEqual(body.count, 3)
    }

    @MainActor
    func testToggleReadsVersionThenResolvesThenReloads() async throws {
        let empty = Data(#"{"result":{"items":[],"has_more":false}}"#.utf8)
        let stub = Stub { tool in
            switch tool {
            case "task_get": return (200, Self.task)
            case "attention_list": return (200, empty)
            default: return (200, Data(#"{"result":{}}"#.utf8))
            }
        }
        let model = TeamsModel(client: try stub.client(self))
        let ok = await model.resolve("k1", false)
        XCTAssertTrue(ok)
        XCTAssertEqual(stub.tools, ["task_get", "task_resolve", "attention_list"])
        XCTAssertEqual(stub.body("task_resolve")?["resolved"] as? Bool, false, "unchecking moves it back")
        XCTAssertEqual(stub.body("task_resolve")?["expected_version"] as? Int, 7)
    }

    func testRetryContinuesWithVersion() async throws {
        let stub = Stub { _ in (200, Data(#"{"result":{}}"#.utf8)) }
        try await stub.client(self).taskContinue(id: "k1", expectedVersion: 3, instruction: "Retry")
        let body = try XCTUnwrap(stub.body("task_continue"))
        XCTAssertEqual(body["expected_version"] as? Int, 3)
        XCTAssertNotNil(body["idempotency_key"] as? String)
    }
}

final class TeamsSetupProbeTests: XCTestCase {
    private func probe(_ code: Int, _ body: String) async throws -> TeamsSetupRow.State {
        let client = try Stub { _ in (code, Data(body.utf8)) }.client(self)
        do {
            try await client.questionAnswer(id: UUID().uuidString, choices: ["probe"], text: nil)
            return TeamsSetup.answerProbe(nil)
        } catch { return TeamsSetup.answerProbe(error) }
    }

    func testNotFoundMeansAllowed() async throws {
        let state = try await probe(404, #"{"error":{"code":"not_found"}}"#)
        XCTAssertEqual(state, .ready)
    }

    func testOwnerRequiredNeedsSetup() async throws {
        let state = try await probe(403, #"{"error":{"code":"owner_required"}}"#)
        XCTAssertEqual(state, .needsSetup)
    }

    func testAnythingElseIsNotChecked() async throws {
        let state = try await probe(500, "{}")
        XCTAssertEqual(state, .notChecked)
        XCTAssertEqual(TeamsSetup.answerProbe(nil), .notChecked)
    }

    func testMCPOwnerRequiredIsForbidden() {
        let rpc = #"{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"{\"error\":{\"code\":\"owner_required\"}}"}]}}"#
        XCTAssertThrowsError(try SwarmaClient.unwrapMCP(Data(rpc.utf8))) {
            XCTAssertEqual(TeamsSetup.answerProbe($0), .needsSetup)
        }
    }
}

final class TeamsNotchCellTests: XCTestCase {
    private func question(_ id: String, thread: String?, at: String?) throws -> TeamsQuestion {
        var json: [String: Any] = ["id": id, "prompt": "p", "options": ["a"], "status": "open"]
        json["thread_id"] = thread; json["created_at"] = at
        return try SwarmaClient.decoder.decode(TeamsQuestion.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testQuestionsCellIsNewestThread() throws {
        let qs = [try question("q1", thread: "t-old", at: "2026-10-28T01:00:00Z"),
                  try question("q2", thread: "t-new", at: "2026-10-28T02:00:00.500Z"),
                  try question("q3", thread: nil, at: "2026-10-28T03:00:00Z")]
        XCTAssertEqual(SwarmaCells.questionsCellID(qs), "swarm:thread:t-new")
        XCTAssertNil(SwarmaCells.questionsCellID([]))
        let snap = SwarmaCells.questionsSnapshot(id: "swarm:thread:t-new", questions: qs)
        XCTAssertEqual(snap.windows.first?.usedText, "3 waiting")
    }

    func testWaitingSwarmCells() throws {
        struct R: Decodable { struct S: Decodable { let swarms: [TeamsSwarm] }; let result: S }
        var swarms = try SwarmaClient.decoder.decode(R.self, from: fixture("swarm_list")).result.swarms
        XCTAssertTrue(SwarmaCells.notchSwarms(swarms).isEmpty, "done swarms get no cell")
        swarms[1].status = "waiting_on_you"; swarms[2].status = "blocked"   // both in thread 54b186ab…
        let cells = SwarmaCells.notchSwarms(swarms).compactMap(SwarmaCells.swarmCellID)
        XCTAssertEqual(cells, ["swarm:thread:54b186ab-54ff-4c06-987a-7dabe746256c/swarm/19102a0e-c3cf-4e03-a4da-595c3ddfa293",
                               "swarm:thread:54b186ab-54ff-4c06-987a-7dabe746256c/swarm/8189aca5-f59b-4a14-b01d-dd49e617e259"])
        XCTAssertEqual(Set(cells).count, 2, "two swarms in one thread keep two cells")
        XCTAssertEqual(cells.map(SwarmaCells.threadID(fromCellID:)),
                       Array(repeating: "54b186ab-54ff-4c06-987a-7dabe746256c", count: 2))
        XCTAssertEqual(SwarmaCells.swarmSnapshot(id: cells[0], swarm: swarms[1]).windows.first?.usedText, "2/2")
    }

    func testThreadIDRoundTrip() {
        XCTAssertEqual(SwarmaCells.threadID(fromCellID: SwarmaCells.threadCellID("t1")), "t1")
        XCTAssertNil(SwarmaCells.threadID(fromCellID: "swarm:agent:claude"))
    }

    func testProvidersUseTheCellIDs() throws {
        let client = try Stub { _ in (500, Data()) }.client(self)
        var swarm = try SwarmaClient.decoder.decode(TeamsSwarm.self, from: Data(#"{"id":"s1","thread_id":"t2","status":"blocked"}"#.utf8))
        let ids = SwarmaDirectory.teamsProviders(questions: [try question("q", thread: "t1", at: nil)], swarms: [swarm], client: client).map(\.id)
        XCTAssertEqual(ids, ["swarm:thread:t1", "swarm:thread:t2/swarm/s1"])
        swarm.status = "running"
        XCTAssertEqual(SwarmaDirectory.teamsProviders(questions: [], swarms: [swarm], client: client).map(\.id), [])
    }
}
