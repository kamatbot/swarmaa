import XCTest
import Foundation
@testable import Codenotch


final class WorkingNotesTests: XCTestCase {
    func testWorkingNotesFoldOnlyConsecutiveNotesBetweenHumanAndReply() throws {
        func message(_ id: String, _ kind: String = "notice", _ author: String = "system", _ time: String = "2026-10-28T10:00:00Z") throws -> TeamsMessage {
            let json = """
            {"id":"\(id)","seq":1,"thread_id":"t","kind":"\(kind)","author":{"kind":"\(author)"},"body":"\(id)","created_at":"\(time)"}
            """
            return try SwarmaClient.decoder.decode(TeamsMessage.self, from: Data(json.utf8))
        }
        let human = try message("human", "text", "human")
        let first = try message("first")
        let last = try message("last", "handoff", "agent", "2026-10-28T10:03:00.000Z")
        let reply = try message("reply", "text", "agent")
        let rows = teamsThreadRows([human, first, last, reply])
        XCTAssertEqual(rows.map { $0.messages.map(\.id) }, [["human"], ["first", "last"], ["reply"]])
        XCTAssertEqual(rows[1].label, "Worked for 3m · 2 steps")
        XCTAssertTrue(rows[1].folded)
        XCTAssertFalse(teamsThreadRows([human, first, reply])[1].folded)
        XCTAssertTrue(teamsThreadRows([first, last, reply]).allSatisfy { !$0.folded }, "Partial history has no human boundary")
        XCTAssertTrue(teamsThreadRows([human, first, last]).allSatisfy { !$0.folded }, "Live tail stays visible")
        XCTAssertTrue(teamsThreadRows([human, first, last, human]).allSatisfy { !$0.folded })
        for kind in ["task", "question", "answer", "swarm", "run", "schedule", "unknown"] {
            let card = try message("card", kind)
            let grouped = teamsThreadRows([human, first, last, card, first, last, reply])
            XCTAssertEqual(grouped.map { $0.messages.count }, [1, 2, 1, 2, 1], kind)
            XCTAssertEqual(grouped[2].messages[0].id, "card", kind)
        }
        let systemText = try message("system", "text")
        XCTAssertEqual(teamsThreadRows([human, first, systemText, reply])[1].messages.count, 2)
        let humanNotice = try message("humanNotice", "notice", "human")
        XCTAssertTrue(teamsThreadRows([human, first, humanNotice, last, reply]).allSatisfy { !$0.folded })
        let twoRuns = teamsThreadRows([human, first, last, reply, human, first, last, reply])
        XCTAssertEqual(twoRuns.filter(\.folded).count, 2)
    }

    @MainActor func testWorkingNotesExpansionIsInMemoryAndPerThread() {
        let model = TeamsModel()
        model.expandedWorkingNotes["one", default: []].insert("note")
        XCTAssertTrue(model.expandedWorkingNotes["one", default: []].contains("note"))
        XCTAssertFalse(model.expandedWorkingNotes["two", default: []].contains("note"))
        XCTAssertTrue(TeamsModel().expandedWorkingNotes.isEmpty)
    }
}
