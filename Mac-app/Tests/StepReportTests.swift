import XCTest
@testable import Codenotch

final class StepReportTests: XCTestCase {
    func testBoldLabelsAndLead() throws {
        let (lead, r) = try XCTUnwrap(StepReport.parse("""
        Done with the banner.

        **Result:** Banner drafted.
        **Checks:** Built it;
        ran the snapshot.
        **Not checked**: Dark mode
        **Files:** banner.swift
        """))
        XCTAssertEqual(lead, "Done with the banner.")
        XCTAssertEqual(r[.result], "Banner drafted.")
        XCTAssertEqual(r[.checks], "Built it;\nran the snapshot.")
        XCTAssertEqual(r[.notChecked], "Dark mode")
        XCTAssertEqual(r[.files], "banner.swift")
    }

    func testHeadingsPlainAndCase() throws {
        let headed = try XCTUnwrap(StepReport.parse("## Result\nShipped\n### not checked\nNone"))
        XCTAssertEqual(headed.report[.result], "Shipped")
        XCTAssertEqual(headed.report[.notChecked], "None")
        XCTAssertEqual(headed.lead, "")
        let plain = try XCTUnwrap(StepReport.parse("RESULT: ok\r\nfiles: a.ts"))
        XCTAssertEqual(plain.report[.result], "ok")
        XCTAssertEqual(plain.report[.files], "a.ts")
    }

    func testMissingPartIsNil() throws {
        let r = try XCTUnwrap(StepReport.parse("Result: ok\nChecks: tests pass")).report
        XCTAssertNil(r[.notChecked])
        XCTAssertNil(r[.files])
    }

    func testNonReportIsNil() {
        XCTAssertNil(StepReport.parse("Result: only one part"))
        XCTAssertNil(StepReport.parse("Checks: x\nFiles: y"))
        XCTAssertNil(StepReport.parse("The result of the checks: fine.\nFiles were changed."))
        XCTAssertNil(StepReport.parse("Plain reply, nothing to see."))
    }

    func testQuestionActionDecoding() throws {
        let approval = try JSONDecoder().decode(TeamsQuestion.self, from: Data("""
        {"id":"q","prompt":"Run it?","options":["Approve","Deny"],"status":"open",
         "action":{"kind":"command","summary":"Build the app","detail":"npm run build","where":"~/Projects/app"}}
        """.utf8))
        XCTAssertEqual(approval.action?.kind, .command)
        XCTAssertEqual(approval.action?.detail, "npm run build")
        XCTAssertEqual(approval.action?.where, "~/Projects/app")
        let odd = try JSONDecoder().decode(TeamsQuestion.self, from: Data(#"{"id":"q","prompt":"?","action":{"kind":"teleport","summary":"s","detail":"d"}}"#.utf8))
        XCTAssertEqual(odd.action?.kind, .other)
        XCTAssertNil(odd.action?.where)
        XCTAssertNil(try JSONDecoder().decode(TeamsQuestion.self, from: Data(#"{"id":"q","prompt":"?","action":null}"#.utf8)).action)
        XCTAssertNil(try JSONDecoder().decode(TeamsQuestion.self, from: Data(#"{"id":"q","prompt":"?"}"#.utf8)).action)
    }
}
