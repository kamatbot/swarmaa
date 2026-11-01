import XCTest
@testable import Codenotch

final class HandoverStatusTests: XCTestCase {
    /// A diamond: a → b, a → c, (b, c) → d.
    static func swarm(_ statuses: [String: String] = [:], owners: [String: String] = ["a": "s", "b": "f", "c": "l", "d": "s"]) throws -> TeamsSwarm {
        let steps: [[String: Any]] = [("a", "Read the brief", [String]()), ("b", "Draft the banner", ["a"]), ("c", "Pick channels", ["a"]), ("d", "Schedule posts", ["b", "c"])]
            .map { id, title, needs in
                ["id": id, "title": title, "needs": needs, "status": statuses[id] ?? "pending",
                 "assignee_agent_id": (owners[id] as Any?) ?? NSNull(), "check": "posts are queued"]
            }
        let json: [String: Any] = ["id": "s1", "title": "Launch", "status": "running", "steps": steps, "progress": ["done": 0, "total": 4]]
        return try SwarmaClient.decoder.decode(TeamsSwarm.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private let names: (String?) -> String = { ["s": "Scout", "f": "Forge"][$0 ?? ""] ?? "A crew member" }

    func testWaitingOnYou() throws {
        let s = try Self.swarm(["a": "done", "b": "running", "c": "waiting_on_you"])
        XCTAssertEqual(HandoverStatus.lines(for: s, name: names)["c"], "A crew member is waiting on you")
        XCTAssertEqual(HandoverStatus.headline(for: s, name: names), "A crew member is waiting on you")
    }

    func testWaitingOnPendingNeed() throws {
        let s = try Self.swarm(["a": "done", "b": "running", "c": "done"])
        XCTAssertEqual(HandoverStatus.lines(for: s, name: names)["d"], "Scout is waiting on Forge · Draft the banner")
        XCTAssertEqual(HandoverStatus.headline(for: s, name: names), "Scout is waiting on Forge · Draft the banner")
    }

    func testBlockedByFailedNeed() throws {
        let s = try Self.swarm(["a": "done", "b": "done", "c": "failed"])
        XCTAssertEqual(HandoverStatus.lines(for: s, name: names)["d"], "Scout is blocked: Pick channels failed")
        XCTAssertNil(HandoverStatus.headline(for: s, name: names))
    }

    func testNoLineWhenNeedsAreDone() throws {
        let s = try Self.swarm(["a": "done", "b": "done", "c": "done"])
        XCTAssertNil(HandoverStatus.lines(for: s, name: names)["d"])
        XCTAssertNil(HandoverStatus.lines(for: s, name: names)["a"])
    }

    func testDiamondColumns() throws {
        let s = try Self.swarm()
        XCTAssertEqual(HandoverStatus.columns(for: s), ["a": 0, "b": 1, "c": 1, "d": 2])
        let crew = HandoverStatus.crew(for: s)
        XCTAssertEqual(crew.members.map(\.id), ["s", "f", "l"])
        XCTAssertEqual(crew.members.map(\.column), [0, 1, 1])
        XCTAssertEqual(crew.edges.map { $0.from + ">" + $0.to }, ["s>f", "s>l", "f>s", "l>s"])
    }
}
