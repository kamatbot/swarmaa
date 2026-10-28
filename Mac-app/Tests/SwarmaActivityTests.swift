import XCTest
@testable import Codenotch

/// The agent/project hover card's model: new wire fields, the cells that carry
/// it, and the card height every sizing path must agree on.
enum SwarmaActivityFixture {
    static let json = """
    {"workers":[
      {"name":"worker-claude","live":true,"providers":["claude"],
       "running":[{"task_id":"t-review","scope":"project:demo","kind":"review","objective":"Review the diff for the routing change",
                   "required_capability":"auto.read","started_at":"2026-10-22T00:56:00Z"}]},
      {"name":"worker-codex","live":true,"providers":["codex"],
       "running":[{"task_id":"t-patch","scope":"project:demo","kind":"patch","objective":"Add the hover card",
                   "required_capability":"codex.patch","started_at":"2026-10-22T00:40:00Z"},
                  {"task_id":"t-other","scope":"project:other","kind":"research","objective":"Survey options",
                   "required_capability":"codex.read","started_at":"2026-10-22T00:59:00Z"}]},
      {"name":"worker-idle","live":true,"providers":["antigravity"],"running":[]},
      {"name":"worker-off","live":false,"providers":["grok"],"running":[]}],
     "usage":[
      {"provider":"codex","ok":true,"windows":[{"name":"5h","used_percent":93},{"name":"7d","used_percent":12}]},
      {"provider":"claude","ok":true,"windows":[{"name":"7d","used_percent":31},{"name":"session","used_percent":62}]},
      {"provider":"antigravity","ok":true,"windows":[{"name":"5h","used_percent":20}]}],
     "scopes":[{"scope":"project:demo","queued":2,"running":2,"completed_24h":3},
               {"scope":"project:other","queued":0,"running":1}],
     "recent":[
      {"id":"t-review","scope":"project:demo","kind":"review","status":"running","version":1,"objective":"Review the diff","worker":"worker-claude"},
      {"id":"d1","scope":"project:demo","kind":"patch","status":"completed","provider":"codex","branch":"swarm/hover-card","changed_files":4,"updated_at":"2026-10-22T00:50:00Z"},
      {"id":"d2","scope":"project:demo","kind":"patch","status":"completed","provider":"claude","branch":"swarm/docs","changed_files":1,"updated_at":"2026-10-22T00:30:00Z"},
      {"id":"d3","scope":"project:demo","kind":"patch","status":"completed","provider":"codex","branch":"swarm/tests","changed_files":7,"updated_at":"2026-10-22T00:10:00Z"},
      {"id":"d4","scope":"project:other","kind":"patch","status":"completed","provider":"codex","branch":"swarm/elsewhere","changed_files":2,"updated_at":"2026-10-22T00:55:00Z"},
      {"id":"d5","scope":"project:demo","kind":"review","status":"completed","provider":"claude","updated_at":"2026-10-22T00:58:00Z"}],
     "routing":{"recommended":"claude","reason":"r","providers":[],
      "policy":{"providers":[{"provider":"claude","max_five_hour_pct":90},{"provider":"codex","max_five_hour_pct":80}],"fallback":"none"},
      "by_kind":{"patch":{"provider":"codex","reason":"p"},"review":{"provider":"claude","reason":"5-hour 62% used"},"research":{"provider":null,"reason":"none"}}}}
    """

    static func status() throws -> SwarmaStatus {
        try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(json.utf8))
    }
}

final class SwarmaActivityTests: XCTestCase {
    func testNewFieldsDecodeAndOldOnesDecodeAsNil() throws {
        let status = try SwarmaActivityFixture.status()
        let run = status.workers[1].running[0]
        XCTAssertEqual(run.kind, "patch")
        XCTAssertEqual(run.objective, "Add the hover card")
        XCTAssertEqual(run.requiredCapability, "codex.patch")
        XCTAssertNotNil(run.startedAt)
        XCTAssertEqual(status.recent[1].branch, "swarm/hover-card")
        XCTAssertEqual(status.recent[1].changedFiles, 4)
        XCTAssertEqual(status.recent[1].provider, "codex")

        let old = try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(
            #"{"workers":[{"name":"w","running":[{"task_id":"a"}]}],"recent":[{"id":"a"}]}"#.utf8))
        XCTAssertNil(old.workers[0].running[0].kind)
        XCTAssertNil(old.workers[0].running[0].startedAt)
        XCTAssertNil(old.recent[0].branch)
        XCTAssertNil(old.recent[0].changedFiles)
        XCTAssertNil(old.recent[0].provider)
    }

    func testAgentCellListsItsRunningQuotaAndLanded() throws {
        let cell = SwarmaCells.agentSnapshot(name: "worker-codex", in: try SwarmaActivityFixture.status())
        let a = try XCTUnwrap(cell.swarmActivity)
        XCTAssertEqual(a.title, "Codex worker")
        XCTAssertEqual(a.pill, .live)
        XCTAssertEqual(a.running.map(\.id), ["t-patch", "t-other"])
        XCTAssertEqual(a.running.map(\.provider), ["codex", "codex"])
        XCTAssertEqual(a.running[0].kind, "patch")
        XCTAssertEqual(a.running[0].objective, "Add the hover card")
        XCTAssertEqual(a.quotas, [.init(provider: "codex", fiveHourPct: 93, weeklyPct: 12, ceiling: 80)])
        XCTAssertEqual(a.landed.map(\.branch), ["swarm/elsewhere", "swarm/hover-card", "swarm/tests"])
        XCTAssertEqual(a.landed[1].files, 4)
        XCTAssertEqual(a.routes, [.init(kind: "patch", provider: "codex"), .init(kind: "review", provider: "claude")])
        XCTAssertEqual(a.routeReason, "5-hour 62% used")
    }

    func testAutoCapabilityUsesTheWorkersProviderAndMaxWindowIsTheFallback() throws {
        let a = try XCTUnwrap(SwarmaCells.agentSnapshot(name: "worker-claude", in: try SwarmaActivityFixture.status()).swarmActivity)
        XCTAssertEqual(a.running.map(\.provider), ["claude"])
        XCTAssertEqual(a.quotas, [.init(provider: "claude", fiveHourPct: 62, weeklyPct: 31, ceiling: 90)])
        XCTAssertEqual(a.landed.map(\.branch), ["swarm/docs"], "claude's only branch; d5 has none")
    }

    func testIdleAndOfflineAgentsAndDefaultCeiling() throws {
        let status = try SwarmaActivityFixture.status()
        let idle = try XCTUnwrap(SwarmaCells.agentSnapshot(name: "worker-idle", in: status).swarmActivity)
        XCTAssertEqual(idle.pill, .idle)
        XCTAssertTrue(idle.running.isEmpty)
        XCTAssertEqual(idle.quotas.first?.ceiling, 95, "no rule for antigravity: the default")
        let off = try XCTUnwrap(SwarmaCells.agentSnapshot(name: "worker-off", in: status).swarmActivity)
        XCTAssertEqual(off.pill, .offline)
        XCTAssertTrue(off.quotas.isEmpty)
    }

    func testScopeCellAggregatesAcrossWorkers() throws {
        let cell = SwarmaCells.scopeSnapshot(scope: "project:demo", in: try SwarmaActivityFixture.status())
        let a = try XCTUnwrap(cell.swarmActivity)
        XCTAssertEqual(a.title, "demo")
        XCTAssertEqual(a.pill, .counts(running: 2, queued: 2))
        XCTAssertEqual(a.running.map(\.id), ["t-review", "t-patch"])
        XCTAssertEqual(a.quotas.map(\.provider), ["claude", "codex", "antigravity"])
        XCTAssertEqual(a.landed.map(\.branch), ["swarm/hover-card", "swarm/docs", "swarm/tests"])
        let empty = try XCTUnwrap(SwarmaCells.scopeSnapshot(scope: "project:none", in: try SwarmaActivityFixture.status()).swarmActivity)
        XCTAssertTrue(empty.running.isEmpty)
    }

    func testHarnessAndLessonsCellsHaveNoActivity() throws {
        XCTAssertNil(SwarmaCells.harnessSnapshot(harness: "codex", in: try SwarmaActivityFixture.status()).swarmActivity)
        XCTAssertNil(SwarmaCells.lessonsSnapshot(pending: 2).swarmActivity)
    }

    // MARK: Height

    private func many(_ n: Int) -> SwarmaActivity {
        var a = SwarmaActivity(title: "t", pill: .live, isScope: true)
        a.running = (0..<n).map { .init(id: "\($0)", provider: "claude", kind: "patch", objective: "o", startedAt: nil) }
        a.quotas = ["claude", "codex", "antigravity"].map { .init(provider: $0, fiveHourPct: 10, weeklyPct: 1, ceiling: 90) }
        a.routes = [.init(kind: "patch", provider: "codex")]
        a.routeReason = "why"
        a.landed = (0..<5).map { _ in .init(branch: "b", files: 1, at: nil) }
        return a
    }

    func testHeightGrowsWithRowsAndStaysWithinTheBudget() throws {
        let one = NotchLayout.activityCardHeight(many(1))
        XCTAssertGreaterThan(NotchLayout.activityCardHeight(many(3)), one)
        XCTAssertEqual(NotchLayout.activityCardHeight(many(40)), NotchLayout.activityCardHeight(many(5)) , accuracy: 0.001,
                       "past the cap only the '+N more' line is drawn")
        let worst = NotchLayout.activityCardHeight(many(40))
        XCTAssertLessThanOrEqual(worst, NotchLayout.defaultMaxCardHeight)
        XCTAssertEqual(NotchLayout.cardHeight(windowCount: 1, swarmActivity: many(2)), NotchLayout.activityCardHeight(many(2)))
    }

    @MainActor func testHoverRegionUsesTheActivityHeight() throws {
        struct Screen: ScreenDescribing {
            var frameValue = CGRect(x: -1920, y: 100, width: 1920, height: 1080)
            var visibleFrameValue: CGRect { frameValue }
            var hardwareNotch: HardwareNotch?
            var displayIdentifier: String? { "same-display" }
        }
        let activity = try XCTUnwrap(SwarmaCells.scopeSnapshot(scope: "project:demo", in: try SwarmaActivityFixture.status()).swarmActivity)
        let model = NotchViewModel()
        model.edge = .right
        model.snapshots = [SwarmaCells.scopeSnapshot(scope: "project:demo", in: try SwarmaActivityFixture.status())]
        model.adopt(screen: Screen())
        model.isExpanded = true
        let rect = try XCTUnwrap(CursorGeometry(model: model, placement: NotchPlacement(edge: .right, panelSize: model.panelSize))
            .tooltipRect(index: 0))
        XCTAssertEqual(rect.height, NotchLayout.activityCardHeight(activity), accuracy: 0.5)
        XCTAssertGreaterThanOrEqual(model.maxCardHeight(cellCount: 1), NotchLayout.activityCardHeight(activity))
    }
}
