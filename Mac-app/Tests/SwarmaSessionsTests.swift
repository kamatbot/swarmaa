import XCTest
@testable import Codenotch

/// What Swarmaa's `sessions` and `routing` add to the notch: a cell per service
/// in use, and a marker on the agent that gets the next task. Both fields are
/// optional on the wire, so an older service must still decode.
final class SwarmaSessionsTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-22T01:10:00Z")!

    private func json(sessions: String? = nil, routing: String? = nil) -> String {
        var fields = [
            #""workers":[{"name":"worker-claude","live":true,"running":[],"providers":["claude"]},{"name":"worker-codex","live":true,"running":[],"providers":["codex"]}]"#,
            #""usage":[{"provider":"claude","ok":true,"headroom":5,"windows":[]},{"provider":"codex","ok":true,"headroom":98,"windows":[]}]"#]
        if let sessions { fields.append(#""sessions":"# + sessions) }
        if let routing { fields.append(#""routing":"# + routing) }
        return "{" + fields.joined(separator: ",") + "}"
    }

    private func decode(_ text: String) throws -> SwarmaStatus {
        try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(text.utf8))
    }

    private let sessionsJSON = """
    [{"id":"a","harness":"claude-code","title":"Fix login redirect","scope":"project:swarma","updated_at":"2026-10-22T01:08:00.250Z"},
     {"id":"b","harness":"claude-code","title":"Older chat","scope":"project:demo","updated_at":"2026-10-22T01:00:00Z"},
     {"id":"c","harness":"codex","title":"Write tests","scope":null,"updated_at":"2026-10-22T01:09:30Z"},
     {"id":"d","harness":"dot","title":"Plan the week","scope":"project:home","updated_at":"2026-10-22T01:05:00Z"}]
    """

    private let routingJSON = """
    {"recommended":"codex","reason":"Claude 5-hour window at 95%, resets 14:00; Codex has 98% weekly headroom",
     "providers":[{"provider":"claude","headroom":5,"live_worker":true,
                   "windows":[{"name":"5h","used_percent":95,"resets_at":"2026-10-22T14:00:00Z"}]},
                  {"provider":"codex","headroom":98,"live_worker":true,"windows":[]}]}
    """

    private func full() throws -> SwarmaStatus { try decode(json(sessions: sessionsJSON, routing: routingJSON)) }

    // MARK: Decoding

    func testDecodesSessionsAndRouting() throws {
        let status = try full()
        XCTAssertEqual(status.sessions.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(status.sessions[0].harness, "claude-code")
        XCTAssertEqual(status.sessions[0].scope, "project:swarma")
        XCTAssertEqual(status.sessions[0].updatedAt?.timeIntervalSince1970 ?? 0,
                       now.addingTimeInterval(-120).timeIntervalSince1970 + 0.25, accuracy: 0.001)
        XCTAssertNil(status.sessions[2].scope)
        XCTAssertEqual(status.routing?.recommended, "codex")
        XCTAssertEqual(status.routing?.providers.count, 2)
        XCTAssertEqual(status.routing?.providers[0].windows.first?.usedPercent, 95)
        XCTAssertTrue(status.routing?.providers[0].liveWorker ?? false)
    }

    func testOlderServiceWithoutTheNewFieldsStillDecodes() throws {
        let status = try decode(json())
        XCTAssertEqual(status.workers.count, 2)
        XCTAssertEqual(status.sessions, [])
        XCTAssertNil(status.routing)
    }

    func testNullRecommendationAndMalformedFieldsDegrade() throws {
        let none = try decode(json(routing: #"{"recommended":null,"reason":null}"#))
        XCTAssertNotNil(none.routing)
        XCTAssertNil(none.routing?.recommended)
        XCTAssertEqual(none.routing?.providers, [])

        let bad = try decode(json(sessions: #""nope""#, routing: "[1]"))
        XCTAssertEqual(bad.sessions, [])
        XCTAssertNil(bad.routing)
        XCTAssertEqual(bad.workers.count, 2, "a bad new field must not blank the old ones")
    }

    // MARK: Harness cells

    func testOneCellPerActiveHarness() throws {
        XCTAssertEqual(SwarmaCells.activeHarnesses(in: try full()), ["claude-code", "codex", "dot"])
        let providers = SwarmaDirectory.providers(for: try full(), client: SwarmaClient())
        XCTAssertEqual(providers.map(\.id), [
            "swarm:agent:worker-claude", "swarm:agent:worker-codex",
            "swarm:harness:claude-code", "swarm:harness:codex", "swarm:harness:dot"])
        XCTAssertTrue(providers.allSatisfy { $0.kind == .swarm })
    }

    func testShowActiveChatsOffDropsTheHarnessCells() throws {
        let providers = SwarmaDirectory.providers(for: try full(), client: SwarmaClient(), showsChats: false)
        XCTAssertEqual(providers.map(\.id), ["swarm:agent:worker-claude", "swarm:agent:worker-codex"])
    }

    func testHarnessGlyphsAndNames() {
        XCTAssertEqual(SwarmaCells.glyph(forHarness: "claude-code"), .claude)
        XCTAssertEqual(SwarmaCells.glyph(forHarness: "codex"), .openai)
        XCTAssertEqual(SwarmaCells.glyph(forHarness: "antigravity"), .antigravity)
        XCTAssertEqual(SwarmaCells.glyph(forHarness: "grok"), .grok)
        XCTAssertEqual(SwarmaCells.glyph(forHarness: "dot"), .third)
        XCTAssertEqual(SwarmaCells.glyph(forHarness: "other"), .third)
        XCTAssertEqual(["claude-code", "codex", "antigravity", "grok", "dot"].map(SwarmaCells.harnessName),
                       ["Claude Code", "Codex", "Antigravity", "Grok", "Dot"])
    }

    func testHarnessCellTextIsTheNewestChat() throws {
        let cell = SwarmaCells.harnessSnapshot(harness: "claude-code", in: try full(), now: now)
        XCTAssertEqual(cell.id, "swarm:harness:claude-code")
        XCTAssertEqual(cell.displayName, "Claude Code")
        XCTAssertEqual(cell.glyph, .claude)
        XCTAssertEqual(cell.kind, .swarm)
        XCTAssertEqual(cell.headline?.usedText, "2 chats")
        XCTAssertEqual(cell.headline?.detail, "Fix login redirect · swarma", "newest first, scope without project:")
        XCTAssertEqual(cell.headline?.bandOverride, .ample)
    }

    func testHarnessCellTooltipRowsListEachChat() throws {
        let cell = SwarmaCells.harnessSnapshot(harness: "claude-code", in: try full(), now: now)
        let rows = cell.windows.filter { $0.id.hasPrefix("session:") }
        XCTAssertEqual(rows.map(\.label), ["Fix login redirect", "Older chat"])
        XCTAssertEqual(rows.map(\.detail), ["swarma · 2 min ago", "demo · 10 min ago"])

        // No scope: just the age, no dangling separator.
        let codex = SwarmaCells.harnessSnapshot(harness: "codex", in: try full(), now: now)
        XCTAssertEqual(codex.headline?.usedText, "1 chat")
        XCTAssertEqual(codex.headline?.detail, "Write tests")
        XCTAssertEqual(codex.windows.last?.detail, "just now")
    }

    func testLongListsAreSummarised() {
        let many = (0..<8).map {
            SwarmaStatus.Session(id: "s\($0)", harness: "codex", title: "Chat \($0)", scope: nil,
                                 updatedAt: now.addingTimeInterval(-Double($0) * 60))
        }
        let cell = SwarmaCells.harnessSnapshot(harness: "codex", in: SwarmaStatus(sessions: many), now: now)
        XCTAssertEqual(cell.windows.filter { $0.id.hasPrefix("session:") }.count, SwarmaCells.maxSessionRows)
        XCTAssertEqual(cell.windows.last?.label, "3 more")
        XCTAssertEqual(cell.headline?.usedText, "8 chats")
    }

    /// The cells follow activity: a harness appears with its first chat and is
    /// gone with its last, through the same registration path as agents.
    @MainActor
    func testHarnessCellsAppearAndDisappearWithActivity() async throws {
        let defaults = UserDefaults(suiteName: "SwarmaSessionsTests.\(UUID().uuidString)")!
        let store = UsageStore(providers: [], archive: UsageArchive(defaults: defaults))
        let client = SwarmaClient()

        var status = try full()
        store.registerSwarmProviders(SwarmaDirectory.providers(for: status, client: client))
        XCTAssertTrue(store.notchSnapshots.map(\.id).contains("swarm:harness:dot"))

        status.sessions.removeAll { $0.harness == "dot" }
        store.registerSwarmProviders(SwarmaDirectory.providers(for: status, client: client))
        XCTAssertFalse(store.notchSnapshots.map(\.id).contains("swarm:harness:dot"))
        XCTAssertTrue(store.notchSnapshots.map(\.id).contains("swarm:harness:codex"))

        status.sessions = []
        store.registerSwarmProviders(SwarmaDirectory.providers(for: status, client: client))
        XCTAssertEqual(store.notchSnapshots.map(\.id).filter { $0.hasPrefix("swarm:harness:") }, [])
    }

    // MARK: Routing on agent cells

    func testRecommendedAgentSaysNextTasksWhileIdle() throws {
        let status = try full()
        let codex = SwarmaCells.agentSnapshot(name: "worker-codex", in: status)
        XCTAssertEqual(codex.headline?.detail, "Next tasks → here")
        let claude = SwarmaCells.agentSnapshot(name: "worker-claude", in: status)
        XCTAssertEqual(claude.headline?.detail, "idle")
    }

    func testBusyOrOfflineRecommendedAgentIsNotMarked() throws {
        var status = try full()
        status.workers[1] = SwarmaStatus.Worker(name: "worker-codex", lastSeenAt: nil, live: true,
                                                running: [.init(taskId: "t", scope: "project:demo")], providers: ["codex"])
        XCTAssertEqual(SwarmaCells.agentSnapshot(name: "worker-codex", in: status).headline?.detail, "running in demo")

        status.workers[1] = SwarmaStatus.Worker(name: "worker-codex", lastSeenAt: nil, live: false,
                                                running: [], providers: ["codex"])
        XCTAssertEqual(SwarmaCells.agentSnapshot(name: "worker-codex", in: status).headline?.detail, "offline")
    }

    func testRoutingReasonIsATooltipRowOnEveryAgent() throws {
        let status = try full()
        for name in ["worker-claude", "worker-codex"] {
            let row = SwarmaCells.agentSnapshot(name: name, in: status).windows.first { $0.id == "routing" }
            XCTAssertEqual(row?.detail, status.routing?.reason)
        }
        let old = try decode(json())
        XCTAssertNil(SwarmaCells.agentSnapshot(name: "worker-codex", in: old).windows.first { $0.id == "routing" })
        XCTAssertEqual(SwarmaCells.agentSnapshot(name: "worker-codex", in: old).headline?.detail, "idle")
    }

    // MARK: Notification

    @MainActor
    func testWatcherAnnouncesEachChangeOnce() throws {
        var changes: [SwarmaRoutingChange] = []
        let watcher = SwarmaRoutingWatcher { changes.append($0) }
        func routing(_ vendor: String?, _ reason: String = "why") -> SwarmaStatus.Routing {
            SwarmaStatus.Routing(recommended: vendor, reason: reason, providers: [])
        }

        watcher.observe(routing("claude"))
        XCTAssertEqual(changes, [], "the first answer only records")
        watcher.observe(routing("claude"))
        XCTAssertEqual(changes, [])

        watcher.observe(try full().routing)
        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(changes[0].from, "claude")
        XCTAssertEqual(changes[0].to, "codex")
        XCTAssertEqual(changes[0].title, "Swarmaa switched to Codex")
        XCTAssertEqual(changes[0].body, "Claude 5-hour window at 95%, resets 14:00; Codex has 98% weekly headroom")

        watcher.observe(try full().routing)
        XCTAssertEqual(changes.count, 1, "an unchanged answer says nothing")

        watcher.observe(nil)
        watcher.observe(routing(nil))
        XCTAssertEqual(changes.count, 1, "losing the recommendation is not a switch to anything")
        watcher.observe(routing("codex"))
        XCTAssertEqual(changes.count, 2, "but it coming back is")
    }

    /// The same, end to end through the directory's refresh, with a stubbed
    /// service and a stubbed notifier.
    @MainActor
    func testDirectoryNotifiesOnceWhenTheServiceChangesItsMind() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("swarma-\(UUID().uuidString).json").path
        try Data(#"{"token":"cn_fake"}"#.utf8).write(to: URL(fileURLWithPath: path))
        defer { try? FileManager.default.removeItem(atPath: path) }

        final class Box: @unchecked Sendable { var body = "" }
        let box = Box()
        box.body = #"{"result":"# + json(routing: #"{"recommended":"claude","reason":"r"}"#) + "}"
        let client = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path },
                                  transport: { request in
            (Data(box.body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, cacheTTL: 0)

        let defaults = UserDefaults(suiteName: "SwarmaSessionsTests.\(UUID().uuidString)")!
        let store = UsageStore(providers: [], archive: UsageArchive(defaults: defaults))
        let directory = SwarmaDirectory(client: client, store: store, interval: 3600)
        var titles: [String] = []
        directory.onRoutingChange = { titles.append($0.title) }

        directory.setEnabled(true)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(titles, [])

        box.body = #"{"result":"# + json(routing: #"{"recommended":"codex","reason":"r"}"#) + "}"
        directory.sync()
        try await Task.sleep(nanoseconds: 300_000_000)
        directory.sync()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(titles, ["Swarmaa switched to Codex"])
        directory.setEnabled(false)
    }

    // MARK: Preference

    func testShowActiveChatsDefaultsOn() {
        let defaults = UserDefaults(suiteName: "SwarmaSessionsTests.\(UUID().uuidString)")!
        XCTAssertTrue(Preferences.storedSwarmaShowsChats(defaults: defaults))
        defaults.set(false, forKey: "swarmaShowsChats")
        XCTAssertFalse(Preferences.storedSwarmaShowsChats(defaults: defaults))
    }
}
