import XCTest
@testable import Codenotch

/// Routing rules: wire shapes, the exact routing_set body, reorder, validation,
/// the 403/400 mapping, dirty/Save state and the slider marker. No network.
final class RoutingSettingsTests: XCTestCase {
    private let policyJSON = """
    {"providers":[
      {"provider":"claude","enabled":true,"max_five_hour_pct":90,"max_weekly_pct":85,"kinds":["review","research"]},
      {"provider":"codex","enabled":true,"max_five_hour_pct":100,"max_weekly_pct":100,"kinds":["review","research","patch"]},
      {"provider":"antigravity","enabled":false,"max_five_hour_pct":50,"max_weekly_pct":60,"kinds":["review"]}],
     "fallback":"none"}
    """

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try SwarmaClient.decoder.decode(type, from: Data(text.utf8))
    }

    private func policy() throws -> RoutingPolicy { try decode(RoutingPolicy.self, policyJSON) }

    // MARK: Stub client

    private func tokenFile() throws -> String {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("routing-\(UUID().uuidString).json").path
        try Data("{\"token\":\"cn_fake\"}".utf8).write(to: URL(fileURLWithPath: path))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: path) }
        return path
    }

    private final class Stub: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [URLRequest] = []
        var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
        let code: Int, body: String
        init(_ code: Int, _ body: String) { self.code = code; self.body = body }
        init(_ body: String) { code = 200; self.body = body }
        var transport: SwarmaClient.Transport {
            { [self] request in
                lock.lock(); seen.append(request); lock.unlock()
                return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
            }
        }
    }

    private func client(_ stub: Stub) throws -> SwarmaClient {
        let path = try tokenFile()
        return SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { path }, transport: stub.transport)
    }

    // MARK: Decoding

    func testDecodesPolicy() throws {
        let p = try policy()
        XCTAssertEqual(p.providers.map(\.provider), ["claude", "codex", "antigravity"])
        XCTAssertEqual(p.providers[0].maxWeeklyPct, 85)
        XCTAssertFalse(p.providers[2].enabled)
        XCTAssertEqual(p.providers[2].kinds, ["review"])
        XCTAssertEqual(p.fallback, "none")
    }

    func testPolicyDefaultsMissingFields() throws {
        let p = try decode(RoutingPolicy.self, #"{"providers":[{"provider":"claude"}]}"#)
        XCTAssertEqual(p.providers[0], RoutingPolicy.Rule(provider: "claude"))
        XCTAssertEqual(p.fallback, "most_headroom")
    }

    func testRoutingGetAndSetResponses() throws {
        let get = try decode(RoutingGetResult.self, "{\"policy\":\(policyJSON),\"is_default\":true,\"updated_at\":null}")
        XCTAssertTrue(get.isDefault)
        XCTAssertNil(get.updatedAt)
        let set = try decode(RoutingSetResult.self, "{\"policy\":\(policyJSON),\"updated_at\":\"2026-10-22T01:00:00Z\"}")
        XCTAssertNotNil(set.updatedAt)
        XCTAssertEqual(set.policy.providers.count, 3)
        let bare = try decode(RoutingGetResult.self, "{\"policy\":\(policyJSON)}")
        XCTAssertFalse(bare.isDefault)
    }

    func testStatusRoutingByKindWithAndWithout() throws {
        let with = try decode(SwarmaStatus.self, """
        {"routing":{"recommended":"claude","reason":"r","providers":[],"policy":\(policyJSON),"is_default":false,
         "by_kind":{"review":{"provider":"claude","reason":"5-hour 42% used"},"research":{"provider":null,"reason":"none"}}},
         "usage":[{"provider":"claude","ok":true,"windows":[{"name":"5h","used_percent":42},{"name":"weekly","used_percent":91}]}]}
        """)
        let routing = try XCTUnwrap(with.routing)
        XCTAssertEqual(routing.byKind["review"], .init(provider: "claude", reason: "5-hour 42% used"))
        XCTAssertNil(routing.byKind["research"]?.provider)
        XCTAssertEqual(routing.policy?.fallback, "none")
        let old = try decode(SwarmaStatus.self, #"{"routing":{"recommended":"codex","reason":"x","providers":[]}}"#)
        XCTAssertEqual(old.routing?.byKind, [:])
        XCTAssertNil(old.routing?.policy)
        XCTAssertFalse(old.routing?.isDefault ?? true)
    }

    // MARK: Requests

    func testRoutingSetBodyHasExactKeys() async throws {
        let stub = Stub(#"{"result":{"policy":{"providers":[],"fallback":"none"},"updated_at":"2026-10-22T01:00:00Z"}}"#)
        _ = try await client(stub).routingSet(policy())
        let request = try XCTUnwrap(stub.requests.last)
        XCTAssertTrue(request.url!.path.hasSuffix("/api/tools/routing_set"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(Set(root.keys), ["policy"])
        let policy = try XCTUnwrap(root["policy"] as? [String: Any])
        XCTAssertEqual(Set(policy.keys), ["providers", "fallback"])
        let first = try XCTUnwrap((policy["providers"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(first.keys), ["provider", "enabled", "max_five_hour_pct", "max_weekly_pct", "kinds"])
        XCTAssertEqual(first["max_five_hour_pct"] as? Int, 90)
        XCTAssertEqual(first["kinds"] as? [String], ["review", "research"])
    }

    func testForbiddenAndInvalidPolicyMap() async throws {
        let forbidden = try client(Stub(403, "{}"))
        let e_forbidden = await thrown { _ = try await forbidden.routingSet(.standard) }
        XCTAssertEqual(e_forbidden as? SwarmaClient.Failure, SwarmaClient.Failure.forbidden)
        let invalid = try client(Stub(400, #"{"error":{"code":"invalid_policy","message":"No service left for review"}}"#))
        let e_invalid = await thrown { _ = try await invalid.routingSet(.standard) }
        XCTAssertEqual(e_invalid as? SwarmaClient.Failure, SwarmaClient.Failure.invalidPolicy("No service left for review"))
        let other = try client(Stub(400, "{}"))
        let e_other = await thrown { _ = try await other.routingSet(.standard) }
        XCTAssertEqual(e_other as? SwarmaClient.Failure, SwarmaClient.Failure.http(400))
    }

    func testMCPInvalidPolicyMaps() {
        let text = #"{"error":{"code":"invalid_policy","message":"Duplicate provider"}}"#
        let body = try! JSONSerialization.data(withJSONObject: ["result": ["isError": true, "content": [["type": "text", "text": text]]]])
        XCTAssertThrowsError(try SwarmaClient.unwrapMCP(body)) {
            XCTAssertEqual($0 as? SwarmaClient.Failure, .invalidPolicy("Duplicate provider"))
        }
    }

    // MARK: Editing

    func testReorder() throws {
        var p = try policy()
        p.move(fromOffsets: IndexSet(integer: 2), toOffset: 0)
        XCTAssertEqual(p.providers.map(\.provider), ["antigravity", "claude", "codex"])
        p.move(0, by: 1)
        XCTAssertEqual(p.providers.map(\.provider), ["claude", "antigravity", "codex"])
        p.move(0, by: -1)   // at the top: no-op
        p.move(2, by: 1)    // at the bottom: no-op
        XCTAssertEqual(p.providers.map(\.provider), ["claude", "antigravity", "codex"])
    }

    func testValidationNeedsAnEnabledProviderPerKind() throws {
        var p = try policy()
        XCTAssertNil(p.problem)
        p.providers[0].enabled = false
        p.providers[1].kinds = ["review"]
        XCTAssertNotNil(p.problem)               // research has nobody
        p.providers[2].enabled = true            // antigravity: review only
        XCTAssertNotNil(p.problem)
        p.providers[1].kinds = ["review", "research", "patch"]
        XCTAssertNil(p.problem)
    }

    // MARK: Model

    private final class FakeService: RoutingService, @unchecked Sendable {
        var get: Result<RoutingGetResult, Error>
        var set: Result<RoutingSetResult, Error>
        var sent: [RoutingPolicy] = []
        init(get: Result<RoutingGetResult, Error>, set: Result<RoutingSetResult, Error> = .failure(SwarmaClient.Failure.unreachable)) {
            self.get = get; self.set = set
        }
        func routingGet() async throws -> RoutingGetResult { try get.get() }
        func routingSet(_ policy: RoutingPolicy) async throws -> RoutingSetResult { sent.append(policy); return try set.get() }
        func status() async throws -> SwarmaStatus { SwarmaStatus() }
    }

    @MainActor func testDirtyStateAndSaveEnabling() async throws {
        let p = try policy()
        let service = FakeService(get: .success(.init(policy: p)), set: .success(.init(policy: p)))
        let model = RoutingEditorModel(service: service)
        await model.load()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertFalse(model.isDirty)
        XCTAssertFalse(model.canSave)
        model.draft.providers[0].maxFiveHourPct = 70
        XCTAssertTrue(model.canSave)
        model.draft.providers[0].maxFiveHourPct = 90
        XCTAssertFalse(model.canSave)            // back to saved: clean again
        model.draft.providers[0].enabled = false
        model.draft.providers[1].enabled = false
        XCTAssertTrue(model.isDirty)
        XCTAssertFalse(model.canSave)            // research has nobody
        model.resetToDefaults()
        XCTAssertEqual(model.draft, .standard)
        await model.save()
        XCTAssertEqual(service.sent, [.standard])
        XCTAssertFalse(model.isDirty)
    }

    @MainActor func testForbiddenSaveGoesReadOnlyWithMessage() async throws {
        let p = try policy()
        let service = FakeService(get: .success(.init(policy: p)), set: .failure(SwarmaClient.Failure.forbidden))
        let model = RoutingEditorModel(service: service)
        await model.load()
        model.draft.fallback = "most_headroom"
        await model.save()
        XCTAssertEqual(model.phase, .readOnly)
        XCTAssertEqual(model.message, "This Mac's Swarmaa connection can't change routing")
        XCTAssertFalse(model.canEdit)
    }

    @MainActor func testInvalidPolicyShowsServiceMessage() async throws {
        let p = try policy()
        let service = FakeService(get: .success(.init(policy: p)), set: .failure(SwarmaClient.Failure.invalidPolicy("Nope")))
        let model = RoutingEditorModel(service: service)
        await model.load()
        model.draft.fallback = "most_headroom"
        await model.save()
        XCTAssertEqual(model.message, "Nope")
        XCTAssertEqual(model.phase, .ready)
        XCTAssertTrue(model.isDirty)
    }

    func testPhaseMapping() {
        XCTAssertEqual(RoutingEditorModel.phase(for: SwarmaClient.Failure.forbidden), .readOnly)
        XCTAssertEqual(RoutingEditorModel.phase(for: SwarmaClient.Failure.http(404)), .unsupported)
        XCTAssertEqual(RoutingEditorModel.phase(for: SwarmaClient.Failure.unreachable),
                       .offline(SwarmaClient.Failure.unreachable.message))
    }

    // MARK: Slider marker

    func testMarkerValueMapping() throws {
        let status = try decode(SwarmaStatus.self, """
        {"usage":[{"provider":"claude","ok":true,"windows":[{"name":"5h","used_percent":42},{"name":"weekly","used_percent":140}]},
                  {"provider":"codex","ok":true,"windows":[]}]}
        """)
        XCTAssertEqual(status.usedPercent(provider: "claude", window: .fiveHour), 42)
        XCTAssertEqual(status.usedPercent(provider: "claude", window: .weekly), 100)   // clamped
        XCTAssertNil(status.usedPercent(provider: "codex", window: .fiveHour))          // unknown: hidden
        XCTAssertNil(status.usedPercent(provider: "antigravity", window: .weekly))
        XCTAssertEqual(RoutingSlider.fraction(5), 0)
        XCTAssertEqual(RoutingSlider.fraction(100), 1)
        XCTAssertEqual(RoutingSlider.fraction(0), 0)
        XCTAssertEqual(RoutingSlider.fraction(52.5), 0.5, accuracy: 0.0001)
    }
}

/// The error `work` throws, or nil.
private func thrown(_ work: () async throws -> Void) async -> Error? {
    do { try await work(); return nil } catch { return error }
}
