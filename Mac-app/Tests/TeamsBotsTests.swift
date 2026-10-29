import XCTest
@testable import Codenotch

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .iso8601
    return try d.decode(T.self, from: Data(json.utf8))
}

final class TeamsBotsTests: XCTestCase {
    private let botJSON = """
    {"id":"b1","scope":"project:swarma","name":"Launch","job":"Plans launches.","avatar":null,"thread_id":"t1",
     "lead_agent_id":"a1","member_agent_ids":["a2","a3"],
     "routing":{"research":{"mode":"auto"},"patch":{"provider":"claude","model":"claude-opus-5-5","effort":"high"},
                "review":{"mode":"different_from_author"},"summary":{"provider":"antigravity"}},
     "rules":{"quota_floor_pct":0,"approve_public":true,"review_edits":true,"require_tests":false},
     "schedule":null,"next_run_at":null,"archived":false,"version":3,"created_at":"2026-10-28T05:00:00Z","updated_at":"2026-10-28T05:10:00Z",
     "badges":{"unread":2,"needs_you":1,"latest":{"kind":"question","line":"Which channels should the launch use?","at":"2026-10-28T05:09:00Z"}},
     "routing_now":{"research":{"runner":{"mode":"auto"},"provider_now":"antigravity","reason":"most quota left"}}}
    """

    func testNamedCharactersAndLegacySeeds() {
        let faces: [KSMoji.Kind] = [.lead, .runner, .scout, .navigator, .clerk, .scribe, .badgeSun, .badgePeri, .badgePeach]
        for face in faces { XCTAssertEqual(KSMoji.kind(for: face.rawValue), face) }
        for seed in ["", "a1", "old free text", "Scout", " scout", "mark", "🦊"] {
            let hash = seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
            XCTAssertEqual(KSMoji.kind(for: seed), faces[Int(hash % UInt32(faces.count))], seed)
        }
    }

    func testBotColorDecodingAndLegacyDefault() throws {
        XCTAssertNil(try decode(TeamsBot.self, botJSON).color)
        for color in ["blue", "butter", "peach", "lilac", "pink", "lime", "sky", "orchid"] {
            let json = botJSON.replacingOccurrences(of: "\"avatar\":null", with: "\"avatar\":\"scout\",\"color\":\"\(color)\"")
            let bot = try decode(TeamsBot.self, json)
            XCTAssertEqual(bot.color, color)
            XCTAssertEqual(bot.avatar, "scout")
            XCTAssertNotNil(KSMoji.backgroundColor(bot.color))
        }
        XCTAssertNil(try decode(TeamsBot.self, botJSON.replacingOccurrences(of: "\"avatar\":null", with: "\"color\":null")).color)
        XCTAssertNil(KSMoji.backgroundColor(nil))
        XCTAssertNil(KSMoji.backgroundColor("orange"))
    }

    func testDecodesTheBotsShape() throws {
        let bot = try decode(TeamsBot.self, botJSON)
        XCTAssertEqual(bot.threadID, "t1")
        XCTAssertEqual(bot.crewIDs, ["a1", "a2", "a3"])
        XCTAssertNil(bot.routing.research, "auto decodes as nil")
        XCTAssertEqual(bot.routing.patch?.label, "Claude claude-opus-5-5 · High")
        XCTAssertTrue(bot.routing.reviewDifferentFromAuthor)
        XCTAssertEqual(bot.routing.summary?.provider, "antigravity")
        XCTAssertEqual(bot.rules.quotaFloorPct, 0)
        XCTAssertEqual(bot.badges.needsYou, 1)
        XCTAssertEqual(bot.badges.latest?.line, "Which channels should the launch use?")
        XCTAssertEqual(bot.routingNow["research"]?.providerNow, "antigravity")
        XCTAssertTrue(bot.hasUpdates)
    }

    func testRoutingRoundTripsThroughTheWireShape() throws {
        var routing = TeamsBotRouting(patch: TeamsRunner(provider: "codex", model: nil, effort: "medium"))
        routing.reviewDifferentFromAuthor = false
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(routing)) as! [String: [String: String]]
        XCTAssertEqual(json["research"], ["mode": "auto"])
        XCTAssertEqual(json["patch"]?["provider"], "codex")
        XCTAssertEqual(json["review"], ["mode": "auto"])
        let back = try JSONDecoder().decode(TeamsBotRouting.self, from: JSONEncoder().encode(routing))
        XCTAssertEqual(back, routing)
        routing.reviewDifferentFromAuthor = true
        let json2 = try JSONSerialization.jsonObject(with: JSONEncoder().encode(routing)) as! [String: [String: String]]
        XCTAssertEqual(json2["review"], ["mode": "different_from_author"])
    }

    func testTaskCardStates() throws {
        let review = try decode(TeamsTaskCard.self, #"{"id":"k1","status":"completed","resolved":false,"branch":"swarmaa/claude/4f1e","changed_files":7}"#)
        XCTAssertTrue(review.readyForReview)
        XCTAssertEqual(TaskCardView.state(review).0, "Ready for review")
        let failed = try decode(TeamsTaskCard.self, #"{"id":"k2","status":"failed","resolved":false,"failure":{"code":"quota_exhausted"}}"#)
        XCTAssertTrue(failed.isFailed)
        XCTAssertEqual(TaskCardView.state(failed).0, "Failed")
        let check = try decode(TeamsTaskCard.self, #"{"id":"k3","status":"completed","resolved":false,"branch":"b","check":{"status":"failed"}}"#)
        XCTAssertFalse(check.readyForReview)
        XCTAssertEqual(TaskCardView.state(check).0, "Check failed")
        let message = try decode(TeamsMessage.self, #"{"id":"m1","seq":4,"kind":"task","body":"Forge finished","ref":{"task_id":"k1"},"task":{"id":"k1","status":"completed","resolved":false}}"#)
        XCTAssertEqual(message.kind, .task)
        XCTAssertEqual(message.ref?.taskID, "k1")
        XCTAssertEqual(message.preview, "Forge finished")
    }

    @MainActor func testBotsWithUpdatesComeFirst() throws {
        let model = TeamsModel()
        func bot(_ id: String, needs: Int, unread: Int, at: String) throws -> TeamsBot {
            try decode(TeamsBot.self, """
            {"id":"\(id)","name":"\(id)","job":"j","thread_id":"t\(id)","lead_agent_id":"a",
             "badges":{"unread":\(unread),"needs_you":\(needs),"latest":{"line":"x","at":"\(at)"}}}
            """)
        }
        model.setBotsForTesting([try bot("quiet-new", needs: 0, unread: 0, at: "2026-10-28T09:00:00Z"),
                                 try bot("unread", needs: 0, unread: 3, at: "2026-10-28T01:00:00Z"),
                                 try bot("asks", needs: 1, unread: 0, at: "2026-10-27T01:00:00Z"),
                                 try bot("quiet-old", needs: 0, unread: 0, at: "2026-10-20T00:00:00Z")])
        XCTAssertEqual(model.sortedBots.map(\.id), ["asks", "unread", "quiet-new", "quiet-old"])
        XCTAssertEqual(model.botsWithUpdates, 2)
        model.search = "quiet"
        XCTAssertEqual(model.sortedBots.map(\.id), ["quiet-new", "quiet-old"])
    }

    func testAgentStandsInAsALegacyBot() throws {
        let agent = try decode(TeamsAgent.self, #"{"id":"a1","name":"Atlas","main_thread_id":"t9","scope":"project:swarma","status":"waiting_on_you","runner":{"provider":"claude"}}"#)
        let bot = TeamsBot(legacy: agent, unread: 2, preview: nil)
        XCTAssertTrue(bot.isLegacyAgent)
        XCTAssertEqual(bot.threadID, "t9")
        XCTAssertEqual(bot.badges.needsYou, 1)
        XCTAssertEqual(bot.routing.summary?.provider, "claude")
    }

    func testChatReplyModelDefaultsToHaikuAndRoundTrips() throws {
        let old = try SwarmaClient.decoder.decode(TeamsBotRules.self, from: Data(#"{"quota_floor_pct":0}"#.utf8))
        XCTAssertEqual(old.firstReply, "claude-haiku-5-5", "a service without first_reply means the Haiku default")
        var heavy = TeamsBotRules(); heavy.firstReply = "claude-opus-5-5"
        let wire = try JSONSerialization.jsonObject(with: JSONEncoder().encode(heavy)) as! [String: Any]
        XCTAssertEqual(wire["first_reply"] as? String, "claude-opus-5-5")
        XCTAssertTrue(TeamsBotRules.firstReplyChoices.contains { $0.id == "claude-opus-5-5" })
    }
}
