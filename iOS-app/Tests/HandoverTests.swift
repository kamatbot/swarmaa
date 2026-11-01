import XCTest

@MainActor private final class AnswerService: HostService {
    var calls: [(String, [String: JSON])] = []
    func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON { calls.append((tool, input)); return .object([:]) }
    func events(after: String) -> AsyncThrowingStream<Data, Error> { AsyncThrowingStream { $0.finish() } }
}

final class HandoverTests: XCTestCase {
    func testReportParsesEveryLabelFormAndKeepsTheLead() throws {
        let text = "Done with the brief.\n\n**Result:** Five points.\nSecond line.\n**Checks**: Dates match.\n## Not checked\nPricing page\nfiles: a.md"
        let report = try XCTUnwrap(StepReport(text))
        XCTAssertEqual(report.lead, "Done with the brief.")
        XCTAssertEqual(report.parts["result"], "Five points.\nSecond line.")
        XCTAssertEqual(report.parts["checks"], "Dates match.")
        XCTAssertEqual(report.parts["not checked"], "Pricing page")
        XCTAssertEqual(report.parts["files"], "a.md")
        XCTAssertEqual(StepReport("RESULT: ok\n### Checks: None")?.parts["checks"], "None")
        XCTAssertNil(StepReport("Result: only a result"), "Result alone is not a report")
        XCTAssertNil(StepReport("Checks: x\nFiles: y"), "No Result")
        XCTAssertNil(StepReport("Results are in\nChecksum: x"), "Words that only start with a label")
        XCTAssertNil(StepReport("#### Result: x\nChecks: y"), "Headings go to ###")
    }

    func testWaitingLinesFollowTheContract() throws {
        let agents = try JSON.parse(#"[{"id":"a","name":"Scout"},{"id":"b","name":"Forge"}]"#).array
        let steps = try JSON.parse(#"""
        [{"id":"s1","title":"Read","assignee_agent_id":"a","status":"done","needs":[]},
         {"id":"s2","title":"Draft","assignee_agent_id":"b","status":"running","needs":["s1"]},
         {"id":"s3","title":"Ship","assignee_agent_id":"zz","status":"pending","needs":["s1","s2"]},
         {"id":"s4","title":"Ask","assignee_agent_id":"a","status":"waiting_on_you","needs":[]},
         {"id":"s5","title":"Fix","assignee_agent_id":"b","status":"failed","needs":[]},
         {"id":"s6","title":"Post","assignee_agent_id":"a","status":"pending","needs":["s5"]}]
        """#).array
        XCTAssertNil(waitingLine(steps[0], in: steps, agents: agents))
        XCTAssertNil(waitingLine(steps[1], in: steps, agents: agents))
        XCTAssertEqual(waitingLine(steps[2], in: steps, agents: agents), "A crew member is waiting on Forge · Draft")
        XCTAssertEqual(waitingLine(steps[3], in: steps, agents: agents), "Scout is waiting on you")
        XCTAssertEqual(waitingLine(steps[5], in: steps, agents: agents), "Scout is blocked: Fix failed")
        XCTAssertEqual(swarmHeadline(steps, agents: agents), "Scout is waiting on you")
        XCTAssertEqual(swarmHeadline(Array(steps.prefix(3)), agents: agents), "A crew member is waiting on Forge · Draft")
        XCTAssertNil(swarmHeadline(Array(steps.prefix(2)), agents: agents))
        // Dependency order: s2 is listed first but needs s1.
        let crew = swarmCrew([steps[2], steps[1], steps[0]], agents: agents)
        XCTAssertEqual(crew.map(\.name), ["Scout", "Forge", "A crew member"])
        XCTAssertEqual(crew.map(\.active), [false, true, false])
    }

    func testQuestionDecodesApprovalAction() throws {
        let plain = try JSON.parse(#"{"id":"q","prompt":"Which?","options":["A"],"action":null}"#)
        XCTAssertNil(ApprovalAction(plain))
        XCTAssertNil(ApprovalAction(try JSON.parse(#"{"id":"q"}"#)))
        let approval = try XCTUnwrap(ApprovalAction(try JSON.parse(#"{"id":"q","action":{"kind":"deploy","summary":"Ship it","detail":"npm run deploy","where":"site"}}"#)))
        XCTAssertEqual(approval, try XCTUnwrap(ApprovalAction(try JSON.parse(#"{"action":{"kind":"deploy","summary":"Ship it","detail":"npm run deploy","where":"site"}}"#))))
        XCTAssertEqual([approval.kind, approval.summary, approval.detail, approval.where_], ["deploy", "Ship it", "npm run deploy", "site"])
        let odd = try XCTUnwrap(ApprovalAction(try JSON.parse(#"{"action":{"kind":"teleport","summary":"x","detail":"y"}}"#)))
        XCTAssertEqual(odd.kind, "other")
        XCTAssertEqual(odd.where_, "")
    }

    @MainActor func testOpenApprovalPausesComposerAndOneTapAnswers() async throws {
        let service = AnswerService(), model = AppModel()
        model.service = service
        let question = try JSON.parse(#"{"id":"q1","status":"open","options":["Approve","Deny"],"action":{"kind":"command","summary":"s","detail":"d"}}"#)
        model.messages = [Message(raw: .object(["id": .string("m"), "kind": .string("question"), "question": question]))]
        XCTAssertTrue(model.hasOpenApproval)
        try await model.answer(question, choice: "Approve")
        XCTAssertEqual(service.calls.first?.0, "question_answer")
        XCTAssertEqual(service.calls.first?.1["choices"], .strings(["Approve"]))
        XCTAssertEqual(service.calls.first?.1["question_id"], .string("q1"))
        var answered = question; answered["status"] = .string("answered")
        model.messages = [Message(raw: .object(["id": .string("m"), "kind": .string("question"), "question": answered]))]
        XCTAssertFalse(model.hasOpenApproval)
        model.messages = [Message(raw: .object(["id": .string("m"), "kind": .string("question"), "question": try JSON.parse(#"{"id":"q2","status":"open"}"#)]))]
        XCTAssertFalse(model.hasOpenApproval, "A plain question does not pause the composer")
    }
}
