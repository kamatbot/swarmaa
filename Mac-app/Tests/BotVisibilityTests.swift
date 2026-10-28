import XCTest
@testable import Codenotch

final class BotVisibilityTests: XCTestCase {
    private func bot(_ id: String, archived: Bool = false, paused: Bool = false, schedule: String? = nil) throws -> TeamsBot {
        let wire: [String: Any] = ["id": id, "thread_id": "t-" + id, "name": id, "job": "Launch planning",
                                   "archived": archived, "rules": ["schedule_paused": paused],
                                   "schedule": schedule as Any? ?? NSNull(), "next_run_at": NSNull()]
        return try SwarmaClient.decoder.decode(TeamsBot.self, from: JSONSerialization.data(withJSONObject: wire))
    }

    func testHiddenFilterPreservesSearchAndOrder() throws {
        let bots = [try bot("Visible"), try bot("Hidden", archived: true)]
        XCTAssertEqual(TeamsBotList.filter(bots, showHidden: false).map(\.id), ["Visible"])
        XCTAssertEqual(TeamsBotList.filter(bots, showHidden: true).map(\.id), ["Visible", "Hidden"])
        XCTAssertEqual(TeamsBotList.filter(bots, showHidden: true, search: " HIDDEN ").map(\.id), ["Hidden"])
        XCTAssertTrue(TeamsBotList.filter(bots, showHidden: false, search: "hidden").isEmpty)
        XCTAssertEqual(TeamsBotList.filter(bots, showHidden: true, search: "planning").count, 2)
        XCTAssertTrue(TeamsBotList.filter([], showHidden: true).isEmpty)
    }

    func testPausedScheduleWithNoNextRunSaysPaused() throws {
        XCTAssertEqual(TeamsBotList.label(try bot("Paused", paused: true, schedule: "0 9 * * *")), "Paused")
        XCTAssertEqual(TeamsBotList.label(try bot("Scheduled", schedule: "0 9 * * *")), "Scheduled")
        XCTAssertEqual(TeamsBotList.label(try bot("Manual")), "Bot")
    }

    @MainActor func testSidebarUsesHiddenFilter() throws {
        let model = TeamsModel()
        model.setBotsForTesting([try bot("Hidden", archived: true)])
        XCTAssertTrue(model.sortedBots.isEmpty)
        model.showHiddenBots = true
        XCTAssertEqual(model.sortedBots.map(\.id), ["Hidden"])
        model.select(threadID: "t-Hidden", refreshHistory: false)
        model.editingBotID = "Hidden"
        model.showHiddenBots = false
        XCTAssertNil(model.selectedThreadID)
        XCTAssertNil(model.editingBotID)
    }
}

/// No service or real credentials: every call is answered by this transport.
private final class BotVisibilityStub: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    var rejectDelete = false

    func body(_ tool: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        return requests.last { $0.url?.lastPathComponent == tool }
            .flatMap { $0.httpBody }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    func client(_ test: XCTestCase) throws -> SwarmaTeamsClient {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("bot-visibility-\(UUID().uuidString).json")
        try Data(#"{"token":"cn_fake"}"#.utf8).write(to: path)
        test.addTeardownBlock { try? FileManager.default.removeItem(at: path) }
        let base = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path.path }, transport: { [self] request in
            lock.lock(); requests.append(request); lock.unlock()
            let tool = request.url!.lastPathComponent
            let archived = tool == "bot_archive" || tool == "bot_list"
            let bot: [String: Any] = ["id": "b", "thread_id": "t", "name": "Launch", "archived": archived]
            let result: [String: Any] = tool == "bot_list" ? ["bots": [bot]]
                : tool == "bot_delete" ? ["deleted": !rejectDelete] : ["bot": bot]
            return (try JSONSerialization.data(withJSONObject: ["result": result]),
                    HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, cacheTTL: 0, authMode: { .tokenFile })
        return SwarmaTeamsClient(base: base, streamTransport: { _ in throw URLError(.badURL) })
    }
}

final class BotVisibilityCallsTests: XCTestCase {
    @MainActor func testHideUnhideAndDeleteUseContractAndClearSelection() async throws {
        let stub = BotVisibilityStub()
        let model = TeamsModel(client: try stub.client(self))
        let bot = try SwarmaClient.decoder.decode(TeamsBot.self, from: Data(#"{"id":"b","thread_id":"t","name":"Launch"}"#.utf8))
        model.setBotsForTesting([bot])
        model.select(threadID: "t", refreshHistory: false)
        model.editingBotID = "b"
        let hidden = await model.setBotHidden(bot, hidden: true)
        XCTAssertTrue(hidden)
        XCTAssertEqual(stub.body("bot_archive")?["bot_id"] as? String, "b")
        XCTAssertTrue(model.sortedBots.isEmpty)
        XCTAssertNil(model.selectedThreadID)
        XCTAssertNil(model.editingBotID)
        let archived = try XCTUnwrap(model.bot(id: "b"))
        XCTAssertTrue(archived.archived)
        let unhidden = await model.setBotHidden(archived, hidden: false)
        XCTAssertTrue(unhidden)
        XCTAssertEqual(stub.body("bot_unarchive")?["bot_id"] as? String, "b")
        XCTAssertEqual(model.sortedBots.map(\.id), ["b"])

        let activeDelete = await model.deleteBot(bot, confirmName: "Launch")
        XCTAssertFalse(activeDelete)
        let wrongName = await model.deleteBot(archived, confirmName: " Launch ")
        XCTAssertFalse(wrongName)
        XCTAssertNil(stub.body("bot_delete"))
        model.setBotsForTesting([archived])
        model.select(threadID: "t", refreshHistory: false)
        model.editingBotID = "b"
        model.drafts["t"] = "Draft"
        stub.rejectDelete = true
        let rejected = await model.deleteBot(archived, confirmName: "Launch")
        XCTAssertFalse(rejected)
        XCTAssertNotNil(model.botError)
        XCTAssertEqual(model.bots.map(\.id), ["b"])
        XCTAssertEqual(model.selectedThreadID, "t")
        XCTAssertEqual(model.drafts["t"], "Draft")
        stub.rejectDelete = false
        let deleted = await model.deleteBot(archived, confirmName: "Launch")
        XCTAssertTrue(deleted)
        XCTAssertEqual(stub.body("bot_delete")?["confirm_name"] as? String, "Launch")
        XCTAssertEqual(stub.body("bot_delete")?["bot_id"] as? String, "b")
        XCTAssertTrue(model.bots.isEmpty)
        XCTAssertNil(model.selectedThreadID)
        XCTAssertNil(model.editingBotID)
        XCTAssertNil(model.drafts["t"])
    }

    func testListSendsIncludeArchivedAndDeleteRequiresAcknowledgement() async throws {
        let stub = BotVisibilityStub()
        let client = try stub.client(self)
        _ = try await client.botList(includeArchived: true)
        XCTAssertEqual(stub.body("bot_list")?["include_archived"] as? Bool, true)
        _ = try await client.botList()
        XCTAssertEqual(stub.body("bot_list")?["include_archived"] as? Bool, false)
        stub.rejectDelete = true
        do {
            try await client.botDelete(id: "b", confirmName: "Launch")
            XCTFail("A false acknowledgement must not remove the local bot")
        } catch {
            XCTAssertEqual(error as? SwarmaTeamsClient.Failure, .service(.badResponse))
        }
    }
}
