import XCTest
import SwiftUI
@testable import Codenotch

final class SwarmaUpdatesTests: XCTestCase {
    private func status(running: [(String, String)] = [], recent: [(String, String)] = []) throws -> SwarmaStatus {
        let run = running.map { #"{"task_id":"\#($0.0)","scope":"project:demo","kind":"patch","objective":"\#($0.1)"}"# }.joined(separator: ",")
        let rec = recent.map { #"{"id":"\#($0.0)","scope":"project:demo","kind":"patch","status":"\#($0.1)","objective":"Obj \#($0.0)","provider":"claude","branch":"swarm/x"}"# }.joined(separator: ",")
        let json = #"{"workers":[{"name":"w","live":true,"providers":["claude"],"running":[\#(run)]}],"recent":[\#(rec)]}"#
        return try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(json.utf8))
    }

    func testBaselineFiresNothingAndDoesNotRepeat() throws {
        var seen = Set<String>()
        let base = try status(running: [("a", "Run A")], recent: [("z", "completed")])
        XCTAssertTrue(SwarmaUpdates.diff(previous: nil, current: base, announced: &seen).isEmpty)
        XCTAssertTrue(SwarmaUpdates.diff(previous: base, current: base, announced: &seen).isEmpty)
    }

    func testStartedThenFinishedOnce() throws {
        var seen = Set<String>()
        let base = try status()
        _ = SwarmaUpdates.diff(previous: nil, current: base, announced: &seen)
        let running = try status(running: [("a", "Run A")], recent: [("a", "running")])
        let started = SwarmaUpdates.diff(previous: base, current: running, announced: &seen)
        XCTAssertEqual(started.map(\.kind), [.started])
        XCTAssertEqual(started[0].objective, "Run A")
        XCTAssertEqual(started[0].provider, "claude")
        let done = try status(recent: [("a", "completed")])
        let finished = SwarmaUpdates.diff(previous: running, current: done, announced: &seen)
        XCTAssertEqual(finished.map(\.kind), [.finished])
        XCTAssertEqual(finished[0].branch, "swarm/x")
        XCTAssertTrue(SwarmaUpdates.diff(previous: done, current: done, announced: &seen).isEmpty)
    }

    func testFailedBlockedAndFastTask() throws {
        var seen = Set<String>()
        let base = try status()
        _ = SwarmaUpdates.diff(previous: nil, current: base, announced: &seen)
        let now = try status(recent: [("f", "failed"), ("b", "blocked"), ("q", "completed")])
        let kinds = SwarmaUpdates.diff(previous: base, current: now, announced: &seen).map(\.kind)
        XCTAssertEqual(kinds, [.failed, .blocked, .finished])
    }

    func testExcerptStripsMarkdownAndTruncates() {
        XCTAssertEqual(SwarmaUpdates.excerpt("## Result\n**Fixed** the [bug](http://x) in `foo`."), "Fixed the bug in foo.")
        XCTAssertEqual(SwarmaUpdates.excerpt("```\ncode\n```\n- item"), "item")
        let long = SwarmaUpdates.excerpt(String(repeating: "word ", count: 100))
        XCTAssertLessThanOrEqual(long.count, 160)
        XCTAssertTrue(long.hasSuffix("…"))
    }

    func testDetailParsingFindsNestedKeys() {
        let d = SwarmaTaskDetail.parse(["task": ["status": "failed"], "result": ["answer": "ok", "reason_code": "timeout"]])
        XCTAssertEqual(d, SwarmaTaskDetail(answer: "ok", reason: "timeout"))
    }

}
