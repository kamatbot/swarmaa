import XCTest
import Foundation

extension AppTests {
    func testHiddenFilterAndShortcut() {
        let visible = Bot(raw: .object(["id": .string("visible")]))
        let hidden = Bot(raw: .object(["id": .string("hidden"), "archived": .bool(true), "starred": .bool(true)]))
        let model = AppModel()
        model.bots = [hidden, visible]
        XCTAssertEqual(model.sortedBots.map(\.id), ["visible"])
        model.showHidden = true
        XCTAssertEqual(Set(model.sortedBots.map(\.id)), Set(["visible", "hidden"]))
        XCTAssertNil(model.starred)
    }

    func testArchiveUnarchiveDeleteCallsAndState() async throws {
        let (service, socket) = service()
        let model = AppModel()
        model.service = service
        await model.refresh()
        let bot = try XCTUnwrap(model.bots.first)
        model.openBot = bot
        try await model.archive(bot)
        XCTAssertNil(model.openBot)
        XCTAssertTrue(model.sortedBots.isEmpty)
        model.showHidden = true
        var hidden = try XCTUnwrap(model.sortedBots.first)
        XCTAssertTrue(hidden.archived)
        XCTAssertFalse(hidden.starred)
        try await model.unarchive(hidden)
        XCTAssertFalse(try XCTUnwrap(model.bots.first).archived)
        try await model.archive(bot)
        hidden = try XCTUnwrap(model.bots.first)
        do { try await model.delete(hidden, confirmName: "launch"); XCTFail("Accepted wrong case") } catch {}
        do { try await model.delete(bot, confirmName: bot.name); XCTFail("Accepted visible bot") } catch {}
        let rejected = await socket.calls("bot_delete")
        XCTAssertTrue(rejected.isEmpty)
        model.openBot = hidden
        try await model.delete(hidden, confirmName: hidden.name)
        XCTAssertTrue(model.bots.isEmpty)
        XCTAssertNil(model.openBot)
        let archives = await socket.calls("bot_archive")
        let unarchives = await socket.calls("bot_unarchive")
        let deletes = await socket.calls("bot_delete")
        let lists = await socket.calls("bot_list")
        XCTAssertEqual(archives.first, .object(["bot_id": .string(bot.id)]))
        XCTAssertEqual(unarchives.first, .object(["bot_id": .string(bot.id)]))
        XCTAssertEqual(deletes, [.object(["bot_id": .string(bot.id), "confirm_name": .string(bot.name)])])
        XCTAssertEqual(lists.first?["include_archived"], .bool(true))
        await service.transport.disconnect()
    }

    func testDeletedEventClosesOpenThreadWithoutReadingIt() async throws {
        let (service, socket) = service()
        let model = AppModel()
        model.service = service
        await model.refresh()
        model.openBot = model.bots.first
        model.error = "Old thread error"
        try await model.handle(.object(["name": .string("bot.updated"), "subject_id": .string("b"),
                                       "payload": .object(["reason": .string("deleted")])]))
        XCTAssertNil(model.openBot)
        XCTAssertNil(model.error)
        XCTAssertTrue(model.bots.isEmpty)
        XCTAssertTrue(model.messages.isEmpty)
        let reads = await socket.calls("thread_read")
        XCTAssertTrue(reads.isEmpty)
        await service.transport.disconnect()
    }

    func testMissingThreadChecksCompleteListBeforeClosing() async throws {
        @MainActor final class MissingThread: HostService {
            var exists = false
            func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON {
                if tool == "thread_read" { throw AppFailure.service(404) }
                XCTAssertEqual(input["include_archived"], .bool(true))
                return .object(["bots": .array(exists ? [.object(["id": .string("b")])] : [])])
            }
            func events(after: String) -> AsyncThrowingStream<Data, Error> { AsyncThrowingStream { $0.finish() } }
        }
        let service = MissingThread()
        let model = AppModel()
        model.service = service
        let bot = Bot(raw: .object(["id": .string("b"), "thread_id": .string("t")]))
        service.exists = true
        await model.open(bot)
        XCTAssertNotNil(model.openBot)
        XCTAssertNotNil(model.error)
        service.exists = false
        await model.open(bot)
        XCTAssertNil(model.openBot)
        XCTAssertNil(model.error)
    }
}
