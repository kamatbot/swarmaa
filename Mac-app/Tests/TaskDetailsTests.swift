import XCTest
@testable import Codenotch

final class TaskDetailsTests: XCTestCase {
    static func detail(usage: Bool = true) throws -> TeamsTaskDetails {
        try SwarmaClient.decoder.decode(TeamsTaskDetails.self, from: Data("""
        {"id":"detail","objective":"Prepare the launch banner","status":"completed","version":7,
         "permission_envelope":{"runner":{"model":"gpt-6-astra","effort":"medium"}},
         "served":{"provider":"codex","model":"gpt-6-astra"},
         "runs":[{"worker_id":"mac-studio","status":"completed","started_at":"2026-10-29T02:00:00Z","ended_at":"2026-10-29T02:02:12Z"}],
         "result":{"agent":"codex","summary":"Updated the launch banner and checked its compact layout.",
         "branch":"swarmaa/codex/launch","changed_files":3,"duration_ms":132000
         \(usage ? ",\"usage\":{\"input_tokens\":12400,\"cached_input_tokens\":8000,\"output_tokens\":1600}" : "")}}
        """.utf8))
    }

    func testDecodeDetailAndOptionalUsage() throws {
        let d = try Self.detail()
        XCTAssertEqual(d.result?.usage?.input_tokens, 12400)
        XCTAssertEqual(d.result?.fileCount, 3)
        XCTAssertEqual(d.permission?.runner?.effort, "medium")
        XCTAssertEqual(d.permission?.runner?.model, "gpt-6-astra")
        XCTAssertEqual(d.runs.count, 1)
        XCTAssertNotNil(d.runs.first?.ended_at)
        XCTAssertNil(d.runs.first?.model, "Do not attribute latest model to historic attempts")
        XCTAssertNil(try Self.detail(usage: false).result?.usage)
        let malformed = try SwarmaClient.decoder.decode(TeamsTaskDetails.self, from: Data(#"{"id":"x","result":{"summary":"kept","changed_files":["a.swift"],"usage":{"input_tokens":"bad"}}}"#.utf8))
        XCTAssertNil(malformed.result?.usage)
        XCTAssertEqual(malformed.result?.summary, "kept")
        XCTAssertEqual(malformed.result?.files, ["a.swift"])
    }

    func testBulkEligibility() {
        for state in ["completed", "failed", "blocked", "cancelled", "running", "queued"] {
            let row = TeamsTaskRow(TeamsAttentionItem(kind: "task", id: state, title: state, state: state, nextStep: ""))
            XCTAssertEqual(TeamsTaskBulk.canApply(row, resolved: true, status: state), ["completed", "failed", "cancelled"].contains(state))
            XCTAssertFalse(TeamsTaskBulk.canApply(row, resolved: false))
            let resolved = TeamsTaskRow(id: state, kind: "task", title: state, section: .resolved, word: "", detail: "", at: nil, threadID: nil, branch: nil, active: ["running", "queued"].contains(state))
            XCTAssertEqual(TeamsTaskBulk.canApply(resolved, resolved: false, status: state), ["completed", "failed", "cancelled"].contains(state))
            XCTAssertFalse(TeamsTaskBulk.canApply(resolved, resolved: true))
        }
        for kind in ["question", "swarm"] {
            let row = TeamsTaskRow(TeamsAttentionItem(kind: kind, id: kind, title: kind, state: "completed", nextStep: ""))
            XCTAssertFalse(TeamsTaskBulk.canApply(row, resolved: true))
        }
    }

    func testPartialFailureMessage() {
        XCTAssertEqual(TeamsTaskBulk.message(resolved: true, succeeded: 3, total: 4, conflicts: 1), "Resolved 3 of 4. 1 changed since you loaded it; try again.")
        XCTAssertEqual(TeamsTaskBulk.message(resolved: false, succeeded: 2, total: 2, conflicts: 0), "Unresolved 2 of 2.")
        XCTAssertEqual(TeamsTaskBulk.message(resolved: true, succeeded: 0, total: 1, conflicts: 0), "Resolved 0 of 1. 1 could not be updated; refresh and try again.")
    }

    @MainActor
    func testBulkRequestsAreBoundedAndVersioned() async throws {
        let probe = BulkProbe()
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("bulk-test-\(UUID().uuidString).json")
        try Data(#"{"token":"cn_fake"}"#.utf8).write(to: path)
        defer { try? FileManager.default.removeItem(at: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path.path }, transport: { request in
            let body = try await probe.respond(request)
            return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, cacheTTL: 0, authMode: { .tokenFile })
        let model = TeamsModel(client: SwarmaTeamsClient(base: base))
        let items = (0..<9).map { TeamsAttentionItem(kind: "task", id: "task-\($0)", title: "Task", state: "completed", nextStep: "Ready for review") }
        let active = TeamsAttentionItem(kind: "task", id: "active", title: "Active", state: "running", nextStep: "Working")
        model.loadFixture(agents: [], bots: [], messages: [:], status: nil, attention: items + [active], select: nil)
        model.taskSelection = Set((items + [active]).map(\.id))
        await model.bulkResolve(true)
        let receipt = await probe.receipt()
        XCTAssertEqual(receipt.count, 9)
        XCTAssertLessThanOrEqual(receipt.peak, 4)
        XCTAssertGreaterThan(receipt.peak, 1)
        XCTAssertTrue(receipt.valid)
        XCTAssertTrue(receipt.refreshed)
        XCTAssertTrue(model.taskSelection.isEmpty)
    }

    func testTokens() {
        XCTAssertEqual(TeamsTaskBulk.tokens(12400), "12.4k")
        XCTAssertEqual(TeamsTaskBulk.tokens(0), "0")
        XCTAssertEqual(TeamsTaskBulk.tokens(999), "999")
        XCTAssertEqual(TeamsTaskBulk.tokens(1000), "1.0k")
    }
}

private actor BulkProbe {
    var active = 0, peak = 0, count = 0
    var valid = true, refreshed = false
    func respond(_ request: URLRequest) async throws -> Data {
        let input = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        switch request.url!.lastPathComponent {
        case "task_get":
            return try JSONSerialization.data(withJSONObject: ["result": ["task": ["id": input["task_id"]!, "status": "completed", "version": 17]]])
        case "task_resolve":
            active += 1; peak = max(peak, active); count += 1
            valid = valid && input["expected_version"] as? Int == 17 && input["resolved"] as? Bool == true && input["task_id"] as? String != "active"
            try await Task.sleep(for: .milliseconds(20))
            active -= 1
            return Data(#"{"result":{}}"#.utf8)
        case "attention_list":
            refreshed = true
            return Data(#"{"result":{"items":[]}}"#.utf8)
        default: throw URLError(.unsupportedURL)
        }
    }
    func receipt() -> (count: Int, peak: Int, valid: Bool, refreshed: Bool) { (count, peak, valid, refreshed) }
}
