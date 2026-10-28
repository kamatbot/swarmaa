import XCTest

@MainActor private final class ScheduleService: HostService {
    var input: [String: JSON] = [:]
    func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON {
        if tool == "bot_update" { self.input = input; return .object(["bot": .object(["id": .string("bot")])]) }
        return .object(["bots": .array([])])
    }
    func events(after: String) -> AsyncThrowingStream<Data, Error> { AsyncThrowingStream { $0.finish() } }
}

@MainActor final class ScheduleCardTests: XCTestCase {
    func testSettingsSendScheduleAndClearWithoutDroppingPause() async throws {
        let service = ScheduleService(), model = AppModel()
        model.service = service
        var bot = Bot(raw: try JSON.parse(#"{"id":"bot","version":4,"schedule":"0 9 * * *","rules":{"schedule_paused":true}}"#))
        try await model.save(bot)
        XCTAssertEqual(service.input["schedule"], .string("0 9 * * *"))
        XCTAssertEqual(service.input["rules"]?["schedule_paused"], .bool(true))
        XCTAssertEqual(service.input["expected_version"], .number(4))
        bot.raw["schedule"] = .null
        try await model.save(bot)
        XCTAssertEqual(service.input["schedule"], .null)
    }
}
