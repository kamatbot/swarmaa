import XCTest
@testable import Codenotch

final class SwarmMapTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func status(_ running: [String: [String]] = [:], recent: [String: String] = [:]) -> SwarmaStatus {
        let providers = ["claude", "codex"]
        let workers = providers.map { p in
            SwarmaStatus.Worker(name: "worker-\(p)", lastSeenAt: nil, live: true,
                                running: (running[p] ?? []).map { .init(taskId: $0, scope: nil, objective: "do \($0)", startedAt: t0) },
                                providers: [p])
        }
        let rows = recent.map { SwarmaStatus.TaskRow(id: $0.key, scope: nil, kind: nil, status: $0.value, version: nil,
                                                     objective: nil, requiredCapability: nil, updatedAt: nil, worker: nil) }
        return SwarmaStatus(workers: workers, recent: rows)
    }

    func testFirstIngestShowsRunningWithoutPulses() {
        var s = SwarmMapState()
        s.ingest(status(["claude": ["a"]]), at: t0)
        XCTAssertTrue(s.pulses.isEmpty)
        XCTAssertEqual(s.running["claude"]?.count, 1)
    }

    func testNewTaskPulsesOut() {
        var s = SwarmMapState()
        s.ingest(status(), at: t0)
        s.ingest(status(["codex": ["a"]]), at: t0 + 1)
        XCTAssertEqual(s.pulses.map(\.kind), [.out])
        XCTAssertEqual(s.pulses.first?.to, "codex")
    }

    func testFailedTask() {
        var s = SwarmMapState()
        s.ingest(status(["claude": ["a"]]), at: t0)
        s.ingest(status(recent: ["a": "failed"]), at: t0 + 1)
        XCTAssertEqual(s.pulses.map(\.kind), [.failed])
        XCTAssertEqual(s.failures["claude"], 1)
        XCTAssertEqual(s.feed.first?.kind, .failed)
    }

    func testHandoff() {
        var s = SwarmMapState()
        s.ingest(status(["claude": ["a"]]), at: t0)
        s.ingest(status(["codex": ["a"]]), at: t0 + 1)
        XCTAssertEqual(s.pulses.map(\.kind), [.handoff])
        XCTAssertEqual(s.pulses.first?.from, "claude")
        XCTAssertEqual(s.pulses.first?.to, "codex")
    }

    func testFinishedCountsUp() {
        var s = SwarmMapState()
        s.ingest(status(["claude": ["a"]]), at: t0)
        s.ingest(status(recent: ["a": "completed"]), at: t0 + 1)
        XCTAssertEqual(s.finished["claude"], 1)
        XCTAssertEqual(s.pulses.map(\.kind), [.back])
    }

    func testFeedCappedAt16() {
        var s = SwarmMapState()
        s.ingest(status(), at: t0)
        s.ingest(status(["claude": (0..<20).map { "t\($0)" }]), at: t0 + 1)
        XCTAssertEqual(s.feed.count, 16)
    }

    func testFinishedTaskIsPricedOnce() {
        var s = SwarmMapState()
        s.ingest(status(["claude": ["a"]]), at: t0)
        s.ingest(status(recent: ["a": "completed"]), at: t0 + 1)
        XCTAssertEqual(s.unpriced.map(\.id), ["a"])
        s.addTokens(1200, provider: "claude", task: "a")
        s.addTokens(1200, provider: "claude", task: "a")
        XCTAssertEqual(s.tokens["claude"], 1200)
    }
}
