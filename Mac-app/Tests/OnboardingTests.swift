import XCTest
@testable import Codenotch

/// Stub for the Node process: replays canned stdout/stderr, records arguments and stdin.
private final class StubRunner: SetupProcessRunning {
    var stdout: [String] = []
    var stderr: [String] = []
    var status: Int32 = 0
    private(set) var arguments: [String] = []
    private(set) var stdin: Data?
    func run(arguments: [String], root: URL, stdin: Data?,
             onStdout: @escaping (String) -> Void, onStderr: @escaping (String) -> Void) throws -> Int32 {
        self.arguments = arguments
        self.stdin = stdin
        stdout.forEach(onStdout)
        stderr.forEach(onStderr)
        return status
    }
}

@MainActor
final class OnboardingTests: XCTestCase {
    private func suite() -> UserDefaults {
        let name = "OnboardingTests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    // MARK: Plan encoding

    func testPlanEncodesExactKeys() throws {
        let plan = SetupPlan(
            harnesses: ["claude": .init(connect: true, worker: true, share: false)],
            folders: ["demo=/tmp/demo"], remote: .init(hostname: "api.swarmaa.com"), autostart: true)
        let json = try JSONSerialization.jsonObject(with: plan.json()) as! [String: Any]
        XCTAssertEqual(Set(json.keys), ["harnesses", "folders", "remote", "autostart"])
        let claude = (json["harnesses"] as! [String: Any])["claude"] as! [String: Bool]
        XCTAssertEqual(claude, ["connect": true, "worker": true, "share": false])
        XCTAssertEqual((json["remote"] as! [String: String]), ["hostname": "api.swarmaa.com"])
        XCTAssertEqual(json["folders"] as! [String], ["demo=/tmp/demo"])
    }

    func testPlanOmitsRemoteWhenNil() throws {
        let plan = SetupPlan(harnesses: [:], folders: [], remote: nil, autostart: false)
        let json = try JSONSerialization.jsonObject(with: plan.json()) as! [String: Any]
        XCTAssertNil(json["remote"])
    }

    func testModelPlanUsesTheSixHarnessKeys() {
        let model = OnboardingModel(defaults: suite(), engine: SetupEngine(runner: StubRunner()), runOffMain: { $0() })
        let plan = model.makePlan()
        XCTAssertEqual(Set(plan.harnesses.keys), ["claude", "codex", "agy", "grok", "dot", "notchtrader"])
        XCTAssertEqual(plan.harnesses["notchtrader"], .init(connect: true, worker: false, share: false))
        XCTAssertNil(plan.remote)
    }

    // MARK: NDJSON

    func testParsesEvents() {
        XCTAssertEqual(SetupEvent.parse(line: #"{"type":"step","step":{"id":"db","label":"Database","status":"running","note":"x"}}"#),
                       .step(SetupStep(id: "db", label: "Database", status: .running, note: "x")))
        XCTAssertEqual(SetupEvent.parse(line: #"{"type":"log","line":"hi"}"#), .log("hi"))
        XCTAssertEqual(SetupEvent.parse(line: #"{"type":"error","errors":["bad"]}"#), .error(["bad"]))
        guard case .summary(let s)? = SetupEvent.parse(line: #"{"type":"summary","summary":{"dry":false,"ok":true,"agents":["claude"],"mcpUrl":"https://x/mcp","projects":[{"scope":"project:x","root":"/r"}]}}"#)
        else { return XCTFail("no summary") }
        XCTAssertTrue(s.ok)
        XCTAssertEqual(s.agents, ["claude"])
        XCTAssertEqual(s.mcpUrl, "https://x/mcp")
        XCTAssertEqual(s.projects.first?.scope, "project:x")
        XCTAssertTrue(s.warnings.isEmpty)
    }

    func testMalformedLinesAreNotEvents() {
        XCTAssertNil(SetupEvent.parse(line: "npm warn something"))
        XCTAssertNil(SetupEvent.parse(line: ""))
        XCTAssertNil(SetupEvent.parse(line: #"{"type":"mystery"}"#))
    }

    func testLineBufferHandlesPartialLines() {
        var buffer = LineBuffer()
        XCTAssertEqual(buffer.append(Data("{\"a\":".utf8)), [])
        XCTAssertEqual(buffer.append(Data("1}\n{\"b\":2}\n{\"c".utf8)), ["{\"a\":1}", "{\"b\":2}"])
        XCTAssertEqual(buffer.append(Data("\":3}".utf8)), [])
        XCTAssertEqual(buffer.flush(), ["{\"c\":3}"])
        XCTAssertEqual(buffer.flush(), [])
    }

    // MARK: Engine with a stub

    func testDetectDecodes() throws {
        let stub = StubRunner()
        stub.stdout = [#"{"clis":{"claude":"/bin/claude"},"notchtrader":true,"postgres":{"found":true,"reachable":false},"envExists":true,"state":{"folders":["a=/x"],"agents":["claude"],"autostart":true,"remote":{"hostname":"h.example"}}}"#]
        let d = try SetupEngine(runner: stub).detect(root: URL(fileURLWithPath: "/tmp"))
        XCTAssertEqual(stub.arguments, ["--import", "tsx", "scripts/setup.ts", "--detect-json"])
        XCTAssertTrue(d.isInstalled(.claude))
        XCTAssertFalse(d.isInstalled(.codex))
        XCTAssertEqual(d.postgres, .init(found: true, reachable: false))
        XCTAssertEqual(d.state?.folders, ["a=/x"])
        XCTAssertEqual(d.state?.remote?.hostname, "h.example")
    }

    func testDetectWithoutStateDecodes() throws {
        let stub = StubRunner()
        stub.stdout = [#"{"clis":{}}"#]
        let d = try SetupEngine(runner: stub).detect(root: URL(fileURLWithPath: "/tmp"))
        XCTAssertNil(d.state)
        XCTAssertTrue(d.clis.isEmpty)
    }

    func testRunStreamsEventsAndPassesDryRun() throws {
        let stub = StubRunner()
        stub.stdout = [#"{"type":"step","step":{"id":"db","label":"Database","status":"ok"}}"#, "junk",
                       #"{"type":"summary","summary":{"dry":true,"ok":true}}"#]
        stub.stderr = ["warn"]
        var events: [SetupEvent] = [], raw: [String] = []
        let plan = SetupPlan(harnesses: [:], folders: [], remote: nil, autostart: false)
        let summary = try SetupEngine(runner: stub).run(plan: plan, dry: true, root: URL(fileURLWithPath: "/tmp"),
                                                        onEvent: { events.append($0) }, onRaw: { raw.append($0) })
        XCTAssertTrue(summary.dry)
        XCTAssertEqual(stub.arguments.suffix(2), ["--run-json", "--dry-run"])
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(raw, ["junk", "warn"])
        XCTAssertNotNil(stub.stdin)
    }

    func testValidationErrorSurfaces() {
        let stub = StubRunner()
        stub.status = 1
        stub.stdout = [#"{"type":"error","errors":["folders[0] bad"]}"#]
        let plan = SetupPlan(harnesses: [:], folders: [], remote: nil, autostart: false)
        XCTAssertThrowsError(try SetupEngine(runner: stub).run(plan: plan, dry: false, root: URL(fileURLWithPath: "/tmp"), onEvent: { _ in })) {
            XCTAssertEqual($0 as? SetupEngineError, .invalidPlan(["folders[0] bad"]))
        }
    }

    func testNodeLookupOrder() {
        XCTAssertEqual(NodeProcessRunner.nodeInvocation(exists: { $0 == "/usr/local/bin/node" }).executable, "/usr/local/bin/node")
        XCTAssertEqual(NodeProcessRunner.nodeInvocation(exists: { _ in false }).executable, "/usr/bin/env")
    }

    // MARK: Gating

    func testFreshInstallNeedsOnboarding() {
        XCTAssertTrue(OnboardingGate.needsOnboarding(defaults: suite(), fileExists: { _ in false }))
    }

    func testConfiguredInstallIsTreatedAsComplete() {
        let d = suite()
        d.set(true, forKey: "swarmaEnabled")
        XCTAssertFalse(OnboardingGate.needsOnboarding(defaults: d, fileExists: { _ in true }))
        XCTAssertTrue(d.bool(forKey: Preferences.onboardingCompleteKey), "remembered, so a later missing token does not re-trigger")
        XCTAssertFalse(OnboardingGate.needsOnboarding(defaults: d, fileExists: { _ in false }))
    }

    func testEnabledWithoutTokenStillNeedsOnboarding() {
        let d = suite()
        d.set(true, forKey: "swarmaEnabled")
        XCTAssertTrue(OnboardingGate.needsOnboarding(defaults: d, fileExists: { _ in false }))
    }

    func testCompleteFlagWins() {
        let d = suite()
        d.set(true, forKey: Preferences.onboardingCompleteKey)
        XCTAssertFalse(OnboardingGate.needsOnboarding(defaults: d, fileExists: { _ in false }))
    }

    // MARK: Flow

    func testRemotePageOnlyWhenGrokOrDotConnected() {
        XCTAssertEqual(OnboardingModel.next(after: .projects, needsRemote: false), .review)
        XCTAssertEqual(OnboardingModel.next(after: .projects, needsRemote: true), .remote)
        XCTAssertEqual(OnboardingModel.previous(before: .review, needsRemote: false), .projects)
        XCTAssertEqual(OnboardingModel.previous(before: .review, needsRemote: true), .remote)
    }

    func testProjectDefaultsAndValidation() {
        XCTAssertEqual(OnboardingProject.defaultName(for: "/Users/x/My App"), "my-app")
        let model = OnboardingModel(defaults: suite(), engine: SetupEngine(runner: StubRunner()), runOffMain: { $0() })
        model.projects = [.init(name: "a", path: "/a"), .init(name: "a", path: "/b")]
        XCTAssertNotNil(model.projectsProblem)
        model.projects[1].name = "b"
        XCTAssertNil(model.projectsProblem)
        XCTAssertEqual(model.makePlan().folders, ["a=/a", "b=/b"])
    }

    // MARK: Defaults migration

    func testMigratesFromCodenotchOnce() {
        let oldName = "OnboardingTests.old.\(UUID().uuidString)"
        let old = UserDefaults(suiteName: oldName)!
        old.set("alwaysShow", forKey: "notchVisibility")
        old.set(true, forKey: "swarmaEnabled")
        old.synchronize()
        let fresh = suite()
        fresh.set("kept", forKey: "swarmaServiceURL")

        Preferences.migrateFromCodenotch(into: fresh, from: oldName)
        XCTAssertEqual(fresh.string(forKey: "notchVisibility"), "alwaysShow")
        XCTAssertTrue(fresh.bool(forKey: "swarmaEnabled"))
        XCTAssertEqual(fresh.string(forKey: "swarmaServiceURL"), "kept", "existing keys are not overwritten")
        XCTAssertTrue(fresh.bool(forKey: Preferences.migratedFromCodenotchKey))

        old.set("hidden", forKey: "notchVisibility"); old.synchronize()
        fresh.set("onHover", forKey: "notchVisibility")
        Preferences.migrateFromCodenotch(into: fresh, from: oldName)
        XCTAssertEqual(fresh.string(forKey: "notchVisibility"), "onHover", "runs once")
        old.removePersistentDomain(forName: oldName)
    }
}
