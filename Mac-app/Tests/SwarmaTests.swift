import XCTest
@testable import Codenotch

/// Swarma agents and swarms as cells: the wire shape, how it reads as a
/// reading, and what the notch says when the service is not there. Nothing
/// here touches the network — the client gets a stub transport — and the only
/// token is a made-up one in a temporary file.
final class SwarmaTests: XCTestCase {
    // MARK: Fixtures

    private let statusJSON = """
    {"result":{
     "workers":[
       {"name":"worker-claude","last_seen_at":"2026-10-22T01:00:00Z","live":true,
        "running":[{"task_id":"11111111-1111-1111-1111-111111111111","scope":"project:demo"}],
        "providers":["claude"]},
       {"name":"worker-codex","last_seen_at":"2026-10-22T00:00:00.250Z","live":false,
        "running":[],"providers":["codex"]}],
     "usage":[
       {"provider":"claude","ok":true,"headroom":62.5,
        "windows":[{"name":"5h","used_percent":37.5,"resets_at":"2026-10-22T04:00:00Z"},
                   {"name":"7d","used_percent":10,"resets_at":"2026-10-25T04:00:00Z"}],
        "plan":null,"error":null,"fetched_at":"2026-10-22T01:00:00Z"},
       {"provider":"codex","ok":false,"headroom":null,"windows":[],"plan":null,
        "error":"no login","fetched_at":"2026-10-22T01:00:00Z"}],
     "scopes":[{"scope":"project:demo","queued":1,"running":1,"blocked":0,
                "completed_24h":3,"failed_24h":0}],
     "recent":[{"id":"11111111-1111-1111-1111-111111111111","scope":"project:demo",
                "kind":"review","status":"running","version":3,
                "objective":"Review the diff","required_capability":"auto.read",
                "updated_at":"2026-10-22T01:00:00Z","worker":"worker-claude"}],
     "generated_at":"2026-10-22T01:00:05Z"}}
    """

    private func status() throws -> SwarmaStatus {
        struct Envelope: Decodable { let result: SwarmaStatus }
        return try SwarmaClient.decoder.decode(Envelope.self, from: Data(statusJSON.utf8)).result
    }

    /// A token file in a temporary directory, holding a made-up token.
    private func tokenFile(_ token: String = "cn_fake") throws -> String {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("swarma-\(UUID().uuidString).json").path
        try Data("{\"token\":\"\(token)\"}".utf8).write(to: URL(fileURLWithPath: path))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        return path
    }

    /// Records what was sent and answers with `respond`.
    private final class Stub: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [URLRequest] = []
        var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
        var respond: @Sendable (URLRequest) throws -> (Int, Data)

        init(_ respond: @escaping @Sendable (URLRequest) throws -> (Int, Data)) { self.respond = respond }

        var transport: SwarmaClient.Transport {
            { [self] request in
                lock.lock(); seen.append(request); lock.unlock()
                let (code, body) = try respond(request)
                let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!
                return (body, response)
            }
        }
    }

    private func client(_ stub: Stub, token: String? = nil, url: String = "http://127.0.0.1:8787",
                        ttl: TimeInterval = 4, now: @escaping @Sendable () -> Date = { Date() }) throws -> SwarmaClient {
        let path = try token ?? tokenFile()
        return SwarmaClient(serviceURL: { url }, tokenPath: { path }, transport: stub.transport,
                            cacheTTL: ttl, now: now)
    }

    private var okStub: Stub { Stub { [statusJSON] _ in (200, Data(statusJSON.utf8)) } }

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var date = Date(timeIntervalSince1970: 1_800_000_000)
        func read() -> Date { lock.lock(); defer { lock.unlock() }; return date }
        func advance(_ seconds: TimeInterval) { lock.lock(); date += seconds; lock.unlock() }
    }

    // MARK: Decoding

    func testDecodesTheDocumentedShape() throws {
        let status = try status()
        XCTAssertEqual(status.workers.map(\.name), ["worker-claude", "worker-codex"])
        XCTAssertEqual(status.workers[0].running.first?.scope, "project:demo")
        XCTAssertEqual(status.workers[0].providers, ["claude"])
        XCTAssertTrue(status.workers[0].live)
        XCTAssertFalse(status.workers[1].live)
        XCTAssertEqual(status.usage[0].headroom, 62.5)
        XCTAssertEqual(status.usage[0].windows.count, 2)
        XCTAssertNil(status.usage[1].headroom)
        XCTAssertEqual(status.scopes[0].completed24h, 3)
        XCTAssertEqual(status.recent[0].version, 3)
        XCTAssertEqual(status.recent[0].requiredCapability, "auto.read")
        XCTAssertNotNil(status.generatedAt)
    }

    func testDatesWithAndWithoutFractionalSecondsBothDecode() throws {
        let status = try status()
        XCTAssertEqual(status.workers[0].lastSeenAt, ISO8601DateFormatter().date(from: "2026-10-22T01:00:00Z"))
        XCTAssertEqual(status.workers[1].lastSeenAt?.timeIntervalSince1970 ?? 0,
                       ISO8601DateFormatter().date(from: "2026-10-22T00:00:00Z")!.timeIntervalSince1970 + 0.25,
                       accuracy: 0.001)
    }

    func testMissingListsDecodeAsEmpty() throws {
        let status = try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(#"{"workers":[{"name":"w"}]}"#.utf8))
        XCTAssertEqual(status.workers.count, 1)
        XCTAssertEqual(status.workers[0].running, [])
        XCTAssertFalse(status.workers[0].live)
        XCTAssertEqual(status.scopes, [])
    }

    // MARK: Client

    func testStatusRequestShape() async throws {
        let stub = okStub
        let path = try tokenFile("cn_fake")
        let status = try await client(stub, token: path).status()
        XCTAssertEqual(status.workers.count, 2)

        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:8787/api/tools/swarm_status")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer cn_fake")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.httpBody, Data("{}".utf8))
        XCTAssertEqual(request.timeoutInterval, 5)
    }

    func testOneRequestFeedsEveryCellUntilTheAnswerExpires() async throws {
        let stub = okStub
        let clock = Clock()
        let client = try client(stub, ttl: 4, now: { clock.read() })

        async let a = client.status()
        async let b = client.status()
        _ = try await (a, b)
        _ = try await client.status()
        XCTAssertEqual(stub.requests.count, 1)

        clock.advance(5)
        _ = try await client.status()
        XCTAssertEqual(stub.requests.count, 2)
    }

    func testAFailureIsSharedToo() async throws {
        let stub = Stub { _ in throw URLError(.cannotConnectToHost) }
        let client = try client(stub)
        for _ in 0..<3 {
            do { _ = try await client.status(); XCTFail("expected a failure") }
            catch { XCTAssertEqual(error as? SwarmaClient.Failure, .unreachable) }
        }
        XCTAssertEqual(stub.requests.count, 1, "every cell waiting out its own 5 s timeout is what this avoids")
    }

    func testFailuresAreNamedNotThrownThrough() async throws {
        func failure(code: Int, body: String = "{}") async throws -> SwarmaClient.Failure? {
            let client = try client(Stub { _ in (code, Data(body.utf8)) })
            do { _ = try await client.status(); return nil } catch { return error as? SwarmaClient.Failure }
        }
        let unauthorized = try await failure(code: 401)
        let broken = try await failure(code: 500)
        let garbled = try await failure(code: 200, body: "not json")
        XCTAssertEqual(unauthorized, .unauthorized)
        XCTAssertEqual(broken, .http(500))
        XCTAssertEqual(garbled, .badResponse)
    }

    func testMissingOrEmptyTokenFileIsNamed() async throws {
        for path in ["/nonexistent/swarma.json", try tokenFile("")] {
            let stub = okStub
            let client = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path },
                                      transport: stub.transport)
            do { _ = try await client.status(); XCTFail("expected a failure") }
            catch { XCTAssertEqual(error as? SwarmaClient.Failure, .noToken) }
            XCTAssertTrue(stub.requests.isEmpty, "nothing is sent without a token")
        }
    }

    func testPlainHttpIsForThisMacOnly() throws {
        XCTAssertEqual(try SwarmaClient.endpoint("http://127.0.0.1:8787/", tool: "swarm_status").absoluteString,
                       "http://127.0.0.1:8787/api/tools/swarm_status")
        XCTAssertNoThrow(try SwarmaClient.endpoint("http://localhost:8787", tool: "x"))
        XCTAssertNoThrow(try SwarmaClient.endpoint("http://[::1]:8787", tool: "x"))
        XCTAssertEqual(try SwarmaClient.endpoint("https://swarma.example.com/base/", tool: "task_cancel").absoluteString,
                       "https://swarma.example.com/base/api/tools/task_cancel")
        XCTAssertThrowsError(try SwarmaClient.endpoint("http://192.168.1.20:8787", tool: "x")) {
            XCTAssertEqual($0 as? SwarmaClient.Failure, .insecureURL)
        }
        XCTAssertThrowsError(try SwarmaClient.endpoint("ftp://127.0.0.1", tool: "x")) {
            XCTAssertEqual($0 as? SwarmaClient.Failure, .badURL)
        }
        XCTAssertThrowsError(try SwarmaClient.endpoint("not a url", tool: "x"))
    }

    func testInsecureURLSendsNothing() async throws {
        let stub = okStub
        let client = try client(stub, url: "http://swarma.example.com")
        do { _ = try await client.status(); XCTFail("expected a failure") }
        catch { XCTAssertEqual(error as? SwarmaClient.Failure, .insecureURL) }
        XCTAssertTrue(stub.requests.isEmpty, "the token must not leave over plain http")
    }

    func testCancelSendsTheTaskAndItsVersion() async throws {
        let stub = Stub { _ in (200, Data(#"{"result":{"ok":true}}"#.utf8)) }
        try await client(stub).cancelTask(id: "abc", expectedVersion: 7)

        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.url?.path, "/api/tools/task_cancel")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer cn_fake")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["task_id"] as? String, "abc")
        XCTAssertEqual(json["expected_version"] as? Int, 7)
    }

    func testCancelRefusedByAStaleVersionThrows() async throws {
        let client = try client(Stub { _ in (409, Data("{}".utf8)) })
        do { try await client.cancelTask(id: "abc", expectedVersion: 1); XCTFail("expected a failure") }
        catch { XCTAssertEqual(error as? SwarmaClient.Failure, .http(409)) }
    }

    // MARK: Bands

    func testAgentBands() {
        XCTAssertEqual(SwarmaCells.agentBand(live: false), .critical)
        XCTAssertEqual(SwarmaCells.agentBand(live: true), .ample)
    }

    func testScopeBands() {
        func scope(queued: Int = 0, blocked: Int = 0, failed: Int = 0) -> SwarmaStatus.Scope {
            .init(scope: "project:x", queued: queued, running: 0, blocked: blocked, completed24h: 0, failed24h: failed)
        }
        XCTAssertEqual(SwarmaCells.scopeBand(scope(), hasLiveWorker: true), .ample)
        XCTAssertEqual(SwarmaCells.scopeBand(scope(failed: 1), hasLiveWorker: true), .critical)
        XCTAssertEqual(SwarmaCells.scopeBand(scope(blocked: 1), hasLiveWorker: true), .critical)
        XCTAssertEqual(SwarmaCells.scopeBand(scope(queued: 2), hasLiveWorker: true), .ample)
        XCTAssertEqual(SwarmaCells.scopeBand(scope(queued: 2), hasLiveWorker: false), .watch)
        XCTAssertEqual(SwarmaCells.scopeBand(scope(queued: 2, failed: 1), hasLiveWorker: false), .critical)
        XCTAssertEqual(SwarmaCells.scopeBand(scope(), hasLiveWorker: false), .ample, "nothing waiting, nothing to do")
    }

    // MARK: Cells

    func testBusyAgentCell() throws {
        let cell = SwarmaCells.agentSnapshot(name: "worker-claude", in: try status())
        XCTAssertEqual(cell.id, "swarm:agent:worker-claude")
        XCTAssertEqual(cell.kind, .swarm)
        XCTAssertEqual(cell.glyph, .claude)
        XCTAssertEqual(cell.status, .ok)

        let ring = try XCTUnwrap(cell.headline)
        XCTAssertEqual(cell.displayName, "Claude worker")
        XCTAssertNil(ring.usedFraction, "usage belongs to the native Claude cell")
        XCTAssertNil(ring.resetsAt)
        XCTAssertEqual(ring.usedText, "running")
        XCTAssertEqual(ring.detail, "Review the diff")
        XCTAssertEqual(ring.bandOverride, .ample)
        XCTAssertEqual(cell.headlineText, "running")
        XCTAssertEqual(cell.swarmTasks, [SwarmaCancelTarget(
            taskID: "11111111-1111-1111-1111-111111111111", version: 3, title: "Review the diff")])
    }

    func testIdleAgentSaysIdle() throws {
        var status = try status()
        status.workers[0] = .init(name: "worker-claude", lastSeenAt: nil, live: true, running: [], providers: ["claude"])
        let cell = SwarmaCells.agentSnapshot(name: "worker-claude", in: status)
        XCTAssertEqual(cell.headline?.detail, "idle")
        XCTAssertTrue(cell.swarmTasks.isEmpty)
    }

    func testOfflineAgentIsRedAndSaysSo() throws {
        let cell = SwarmaCells.agentSnapshot(name: "worker-codex", in: try status())
        XCTAssertEqual(cell.glyph, .openai)
        XCTAssertEqual(cell.headline?.detail, "offline")
        XCTAssertEqual(cell.headline?.usedText, "offline")
        XCTAssertEqual(cell.headline?.bandOverride, .critical)
        XCTAssertNil(cell.headline?.usedFraction)
        XCTAssertEqual(cell.displayName, "Codex worker")
    }

    func testLowQuotaDoesNotChangeAgentCell() throws {
        var status = try status()
        status.usage[0] = .init(provider: "claude", ok: true, headroom: 8, windows: [], plan: nil, error: nil, fetchedAt: nil)
        let cell = SwarmaCells.agentSnapshot(name: "worker-claude", in: status)
        XCTAssertEqual(cell.headline?.usedText, "running")
        XCTAssertEqual(cell.headline?.bandOverride, .ample)
        XCTAssertNil(cell.headline?.usedFraction)
        XCTAssertNil(cell.headline?.resetsAt)
    }

    func testAgentWithoutAKnownTaskVersionOffersNoCancel() throws {
        var status = try status()
        status.recent = []
        let cell = SwarmaCells.agentSnapshot(name: "worker-claude", in: status)
        XCTAssertTrue(cell.swarmTasks.isEmpty, "task_cancel needs the version; guessing it would cancel the wrong thing")
        XCTAssertEqual(cell.headline?.detail, "running in demo")
    }

    func testGlyphPerVendor() {
        XCTAssertEqual(SwarmaCells.glyph(forProvider: "claude"), .claude)
        XCTAssertEqual(SwarmaCells.glyph(forProvider: "codex"), .openai)
        XCTAssertEqual(SwarmaCells.glyph(forProvider: "antigravity"), .antigravity)
        XCTAssertEqual(SwarmaCells.glyph(forProvider: "grok"), .grok)
        XCTAssertEqual(SwarmaCells.glyph(forProvider: "dot"), .third)
        XCTAssertEqual(SwarmaCells.glyph(forProvider: nil), .third)
    }

    func testScopeCell() throws {
        let cell = SwarmaCells.scopeSnapshot(scope: "project:demo", in: try status())
        XCTAssertEqual(cell.id, "swarm:scope:project:demo")
        XCTAssertEqual(cell.displayName, "demo")
        XCTAssertEqual(cell.kind, .swarm)
        let head = try XCTUnwrap(cell.headline)
        XCTAssertNil(head.usedFraction, "a scope has no limit to ring")
        XCTAssertEqual(head.usedText, "demo")
        XCTAssertEqual(head.detail, "3 done today")
        XCTAssertEqual(head.bandOverride, .ample)
        XCTAssertEqual(cell.headlineText, "demo")
        XCTAssertEqual(SwarmaCells.ringName("retireodds"), "retireo…")
    }

    func testScopeCellMentionsFailures() throws {
        var status = try status()
        status.scopes[0] = .init(scope: "project:demo", queued: 0, running: 2, blocked: 0, completed24h: 3, failed24h: 2)
        let head = try XCTUnwrap(SwarmaCells.scopeSnapshot(scope: "project:demo", in: status).headline)
        XCTAssertEqual(head.detail, "3 done today · 2 failed")
        XCTAssertEqual(head.usedText, "demo")
        XCTAssertEqual(head.bandOverride, .critical)
    }

    func testScopeLabel() {
        XCTAssertEqual(SwarmaCells.scopeLabel("project:demo"), "demo")
        XCTAssertEqual(SwarmaCells.scopeLabel("global"), "global")
    }

    // MARK: Providers and the offline state

    func testProvidersAnswerFromTheSharedStatus() async throws {
        let stub = okStub
        let client = try client(stub)
        let agent = try await SwarmAgentProvider(name: "worker-claude", client: client).fetchSnapshot()
        let scope = try await SwarmScopeProvider(scope: "project:demo", client: client).fetchSnapshot()
        XCTAssertEqual(agent.headline?.usedText, "running")
        XCTAssertEqual(scope.headline?.detail, "3 done today")
        XCTAssertEqual(stub.requests.count, 1)
    }

    func testServiceDownShowsOfflineInsteadOfThrowing() async throws {
        let client = try client(Stub { _ in throw URLError(.cannotConnectToHost) })
        let agent = try await SwarmAgentProvider(name: "worker-claude", client: client).fetchSnapshot()
        let scope = try await SwarmScopeProvider(scope: "project:demo", client: client).fetchSnapshot()
        for cell in [agent, scope] {
            XCTAssertEqual(cell.status, .error("Swarmaa not running"))
            XCTAssertEqual(cell.headline?.usedText, "offline")
            XCTAssertEqual(cell.headline?.detail, "Swarmaa not running")
            XCTAssertEqual(cell.headline?.bandOverride, .critical)
            XCTAssertNil(cell.headline?.usedFraction)
            XCTAssertEqual(cell.kind, .swarm)
        }
        XCTAssertEqual(agent.id, "swarm:agent:worker-claude")
        XCTAssertEqual(scope.id, "swarm:scope:project:demo")
    }

    func testRejectedTokenShowsItsOwnMessage() async throws {
        let client = try client(Stub { _ in (401, Data("{}".utf8)) })
        let cell = try await SwarmAgentProvider(name: "w", client: client).fetchSnapshot()
        XCTAssertEqual(cell.headline?.detail, "Swarmaa rejected the token")
    }

    func testDirectoryDerivesOneProviderPerWorkerAndScope() throws {
        let client = SwarmaClient(serviceURL: { "http://127.0.0.1:1" }, tokenPath: { "" },
                                  transport: { _ in throw URLError(.cannotConnectToHost) })
        let providers = SwarmaDirectory.providers(for: try status(), client: client)
        XCTAssertEqual(providers.map(\.id), ["swarm:agent:worker-claude", "swarm:scope:project:demo"],
                       "the idle worker-codex gets no cell")
        XCTAssertTrue(providers.allSatisfy { $0.kind == .swarm })
    }

    func testOnlyActiveSwarmsGetACell() throws {
        let client = SwarmaClient(serviceURL: { "http://127.0.0.1:1" }, tokenPath: { "" },
                                  transport: { _ in throw URLError(.cannotConnectToHost) })
        let status = try SwarmaClient.decoder.decode(SwarmaStatus.self, from: Data(#"""
            {"scopes":[{"scope":"project:idle","queued":0,"running":0,"blocked":0,"completed_24h":0,"failed_24h":0},
                       {"scope":"project:busy","queued":1,"running":0,"blocked":0,"completed_24h":0,"failed_24h":0},
                       {"scope":"project:done","queued":0,"running":0,"blocked":0,"completed_24h":2,"failed_24h":0}]}
            """#.utf8))
        XCTAssertEqual(SwarmaDirectory.providers(for: status, client: client).map(\.id),
                       ["swarm:scope:project:busy"])
    }

    // MARK: Store

    @MainActor
    func testStoreShowsSwarmCellsAndDropsTheOnesThatLeave() async throws {
        let name = "SwarmaTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let store = UsageStore(providers: [], archive: UsageArchive(defaults: defaults))

        let client = try client(okStub)
        store.registerSwarmProviders([SwarmAgentProvider(name: "worker-claude", client: client),
                                      SwarmScopeProvider(scope: "project:demo", client: client)])
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(Set(store.notchSnapshots.map(\.id)), ["swarm:agent:worker-claude", "swarm:scope:project:demo"])
        XCTAssertEqual(store.notchSnapshots.first { $0.id == "swarm:agent:worker-claude" }?.headline?.usedText, "running")

        store.registerSwarmProviders([SwarmScopeProvider(scope: "project:demo", client: client)])
        XCTAssertEqual(store.notchSnapshots.map(\.id), ["swarm:scope:project:demo"])

        store.registerSwarmProviders([])
        XCTAssertTrue(store.notchSnapshots.isEmpty)
    }

    // MARK: Preferences

    func testSwarmaDefaultsFollowTheTokenFile() throws {
        let name = "SwarmaTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)

        XCTAssertEqual(Preferences.storedSwarmaServiceURL(defaults: defaults), "http://127.0.0.1:8787")
        XCTAssertEqual(Preferences.storedSwarmaTokenPath(defaults: defaults), "~/Projects/swarma/.local/notchtrader.json")

        defaults.set("/nonexistent/swarma.json", forKey: "swarmaTokenPath")
        XCTAssertFalse(Preferences.storedSwarmaEnabled(defaults: defaults), "off where there is no token file")

        defaults.set(try tokenFile(), forKey: "swarmaTokenPath")
        XCTAssertTrue(Preferences.storedSwarmaEnabled(defaults: defaults), "on where the token file exists")

        defaults.set(false, forKey: "swarmaEnabled")
        XCTAssertFalse(Preferences.storedSwarmaEnabled(defaults: defaults), "an explicit choice wins")
    }

    @MainActor
    func testSwarmaCellsAreAlwaysConnected() {
        let preferences = Preferences(defaults: UserDefaults(suiteName: "SwarmaTests.\(UUID().uuidString)")!)
        XCTAssertTrue(preferences.isConnected("swarm:agent:worker-claude"))
        XCTAssertTrue(preferences.isConnected("swarm:scope:project:demo"))
    }
}
