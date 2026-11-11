import XCTest

/// Mark resolved must update the thread's task card at once, and keep it resolved when a re-read
/// returns the card's stale snapshot (the Mac app's card lagged).
@MainActor final class ResolveTaskTests: XCTestCase {
    func testResolvePatchesCardAndSurvivesStaleReread() async throws {
        final class Service: HostService {
            var calls: [String] = []
            let card: JSON = .object(["id": .string("t1"), "status": .string("completed"), "resolved": .bool(false), "branch": .string("b1")])
            func call(_ tool: String, _ input: [String: JSON]) async throws -> JSON {
                calls.append(tool)
                switch tool {
                case "task_get": return .object(["task": .object(["id": .string("t1"), "version": .number(3)])])
                case "task_resolve":
                    XCTAssertEqual(input["expected_version"], .number(3)); XCTAssertEqual(input["resolved"], .bool(true))
                    return .object(["task": .object(["id": .string("t1"), "resolved": .bool(true)])])
                case "thread_read":  // The host's message still carries the unresolved snapshot.
                    return .object(["messages": .array([.object(["id": .string("m1"), "seq": .number(1), "kind": .string("task"), "task": card])])])
                case "thread_mark_read": return .object(["ok": .bool(true)])
                case "attention_list": return .object(["items": .array([])])
                default: XCTFail("Unexpected call: \(tool)"); throw AppFailure.invalidResponse
                }
            }
            func events(after: String) -> AsyncThrowingStream<Data, Error> { AsyncThrowingStream { $0.finish() } }
        }
        let service = Service(), model = AppModel()
        model.service = service
        let bot = Bot(raw: .object(["id": .string("b"), "thread_id": .string("t")]))
        model.openBot = bot
        try await model.readThread(bot)
        XCTAssertFalse(taskCards(model.messages)[0].card["resolved"].bool)

        try await model.resolve("t1")
        XCTAssertTrue(taskCards(model.messages)[0].card["resolved"].bool)
        try await model.readThread(bot)
        XCTAssertTrue(taskCards(model.messages)[0].card["resolved"].bool, "A stale re-read must not bring the card back")
        XCTAssertEqual(service.calls.filter { $0 == "task_resolve" }.count, 1)
    }

    func testFollowedSwarmPrefersOpenOne() {
        func swarm(_ id: String, _ status: String) -> Message {
            Message(raw: .object(["id": .string("m" + id), "kind": .string("swarm"), "swarm": .object(["id": .string(id), "status": .string(status)])]))
        }
        XCTAssertEqual(followedSwarm([swarm("a", "running"), swarm("b", "done")])?.swarm["id"], .string("a"))
        XCTAssertEqual(followedSwarm([swarm("a", "done"), swarm("b", "done")])?.swarm["id"], .string("b"))
        XCTAssertNil(followedSwarm([]))
    }
}
