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

    @MainActor
    func testUpdateCardsRender() throws {
        let started = SwarmaUpdates.notice(
            SwarmaUpdate(kind: .started, taskID: "1", provider: "claude", objective: "Add the hover card to worker cells",
                         scope: "project:demo", taskKind: "patch", branch: nil), detail: nil)
        let finished = SwarmaUpdates.notice(
            SwarmaUpdate(kind: .finished, taskID: "2", provider: "codex", objective: "Add the hover card",
                         scope: "project:demo", taskKind: "patch", branch: "swarm/hover-card"),
            detail: SwarmaTaskDetail(answer: "## Hover card\nAdded the activity card to the worker cells and wired its height through the layout.", reason: nil))
        for (name, event) in [("started", started), ("finished", finished)] {
            let view = UsageResetCard(event: event, direction: .trailing, onDismiss: {})
                .padding(20)
                .background(Color.black)
                .environment(\.colorScheme, .dark)
                .environment(\.notchCardSurfaceStyle, .solid)
                .environment(\.codenotchAccentColor, .blue)
                .environment(\.codenotchHeadlessGlass, true)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.nsImage)
            let tiff = try XCTUnwrap(image.tiffRepresentation)
            let png = try XCTUnwrap(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: "/tmp/swarm-update-\(name).png"))
        }
    }
}

final class SwarmaUpdateCardHeightTests: XCTestCase {
    func testDetailGrowsCardBeyondBaseAndCapsAtFourLines() {
        var e = SwarmaUpdates.notice(SwarmaUpdate(kind: .started, taskID: "1", provider: "claude", objective: "x",
                                                  scope: nil, taskKind: nil, branch: nil), detail: nil)
        XCTAssertEqual(UsageResetCard.height(for: e), UsageResetCard.cardHeight)
        e.noticeDetail = String(repeating: "word ", count: 200)
        XCTAssertEqual(UsageResetCard.height(for: e), UsageResetCard.cardHeight + 3 * NotchLayout.cardBodyLineHeight, accuracy: 0.01)
    }
}
