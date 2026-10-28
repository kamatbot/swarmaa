import XCTest
@testable import Codenotch

final class ScheduleCardTests: XCTestCase {
    func testSchedulePayloadAndPauseRuleRoundTrip() throws {
        let message = try SwarmaClient.decoder.decode(TeamsMessage.self, from: Data(#"{"id":"card","thread_id":"thread","seq":1,"kind":"schedule","body":"Daily at 09:00","ref":{"bot_id":"bot","cron":"0 9 * * *","description":"Daily at 09:00","timezone":"UTC","next_runs":["2026-10-29T09:00:00.000Z"],"paused":false}}"#.utf8))
        XCTAssertEqual(message.kind, .schedule)
        XCTAssertEqual(message.schedule?.botID, "bot")
        XCTAssertEqual(message.schedule?.nextRuns.count, 1)
        XCTAssertEqual(message.preview, "Daily at 09:00")
        var rules = TeamsBotRules(); rules.schedulePaused = true
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(rules)) as! [String: Any]
        XCTAssertEqual(wire["schedule_paused"] as? Bool, true)
        let unknown = try SwarmaClient.decoder.decode(TeamsMessage.self, from: Data(#"{"id":"u","seq":2,"kind":"future"}"#.utf8))
        XCTAssertEqual(unknown.kind, .unknown)
    }
}
