import XCTest

@MainActor final class BotAppearanceTests: XCTestCase {
    func testNameOrHash() {
        let names = ["lead", "runner", "scout", "navigator", "clerk", "scribe", "badge-sun", "badge-peri", "badge-peach"]
        for name in names { XCTAssertEqual(mojiCharacter(name), name) }
        for seed in ["", "mark", "Scout", " scout", "old free text", "agent-123", "🤖"] {
            let hash = seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
            XCTAssertEqual(mojiCharacter(seed), names[Int(hash % UInt32(names.count))])
            XCTAssertNotEqual(mojiCharacter(seed), "mark")
        }
    }

    func testAppearanceFallbackAndPalette() {
        var bot = Bot(raw: .object(["lead_agent_id": .string("agent-123")]))
        XCTAssertEqual(bot.avatarSeed, "agent-123")
        XCTAssertNil(bot.colorHex)
        bot.raw["avatar"] = .string("old free text")
        XCTAssertEqual(bot.avatarSeed, "old free text")
        bot.raw["avatar"] = .null
        XCTAssertEqual(bot.avatarSeed, "agent-123")
        let colors: [String: UInt32] = ["blue": 0x9CC8FF, "butter": 0xFFE08A, "peach": 0xFFC4A8, "lilac": 0xD6C2FF, "pink": 0xFFB8D9, "lime": 0xC9F26B, "sky": 0xA8E6FF, "orchid": 0xF2C4FF]
        for (name, hex) in colors { bot.raw["color"] = .string(name); XCTAssertEqual(bot.colorHex, hex) }
        for value in [JSON.null, .string(""), .string("orange")] { bot.raw["color"] = value; XCTAssertNil(bot.colorHex) }
    }

    func testAppearanceEventAndRefreshUpdateOpenBotAndList() async throws {
        final class AppearanceService: HostService {
            var bot: JSON = .object(["id": .string("b"), "thread_id": .string("t"), "avatar": .string("scout"), "color": .string("peach")])
            func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON {
                switch tool {
                case "bot_list": return .object(["bots": .array([bot])])
                case "agent_list": return .object(["agents": .array([])])
                case "swarm_status": return .object([:])
                default: XCTFail("Unexpected call: \(tool)"); throw AppFailure.invalidResponse
                }
            }
            func events(after: String) -> AsyncThrowingStream<Data, Error> { AsyncThrowingStream { $0.finish() } }
        }
        let service = AppearanceService(), model = AppModel()
        model.service = service
        model.openBot = Bot(raw: .object(["id": .string("b"), "thread_id": .string("t")]))
        try await model.handle(.object(["name": .string("bot.updated"), "payload": .object(["bot_id": .string("b"), "reason": .string("appearance")])]))
        XCTAssertEqual(model.openBot, model.bots.first)
        XCTAssertEqual(model.openBot?.avatarSeed, "scout")
        XCTAssertEqual(model.openBot?.colorHex, 0xFFC4A8)
        service.bot["color"] = .null
        await model.refresh()
        XCTAssertEqual(model.openBot, model.bots.first)
        XCTAssertNil(model.openBot?.colorHex)
        model.openBot = Bot(raw: .object(["id": .string("other")]))
        try await model.handle(.object(["name": .string("bot.updated")]))
        XCTAssertEqual(model.openBot?.id, "other")
    }
}
