import XCTest
@testable import Codenotch

private final class MemoryStore: SwarmaTokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: SwarmaOAuthTokens?
    init(_ t: SwarmaOAuthTokens? = nil) { tokens = t }
    func load() -> SwarmaOAuthTokens? { lock.lock(); defer { lock.unlock() }; return tokens }
    func save(_ t: SwarmaOAuthTokens) { lock.lock(); tokens = t; lock.unlock() }
    func clear() { lock.lock(); tokens = nil; lock.unlock() }
}

/// Replays canned responses in order and records the requests.
private final class StubTransport: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [(Int, String)]
    private(set) var requests: [URLRequest] = []
    init(_ responses: [(Int, String)]) { queue = responses }
    var transport: @Sendable (URLRequest) async throws -> (Data, URLResponse) {
        { [self] request in
            lock.lock(); defer { lock.unlock() }
            requests.append(request)
            let (status, body) = queue.isEmpty ? (500, "") : queue.removeFirst()
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }
    func body(_ i: Int) -> String { String(decoding: requests[i].httpBody ?? Data(), as: UTF8.self) }
}

private final class FakeServer: LoopbackCallbackServer, @unchecked Sendable {
    var callback: (_ state: String) -> String
    var responded: String?
    private(set) var stopped = false
    var lastAuthorizeState = ""
    init(callback: @escaping (String) -> String) { self.callback = callback }
    func start() async throws -> UInt16 { 4242 }
    func waitForRequest(timeout: TimeInterval) async throws -> String { callback(lastAuthorizeState) }
    func respond(html: String) { responded = html }
    func stop() { stopped = true }
}

final class RuntimeAndOAuthTests: XCTestCase {
    private let origin = URL(string: "https://api.swarmaa.com")!

    // MARK: Runtime install

    private func makeRuntime(_ dir: URL, stamp: String, marker: String) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dir.appendingPathComponent("pg/lib"), withIntermediateDirectories: true)
        try marker.write(to: dir.appendingPathComponent("node"), atomically: true, encoding: .utf8)
        try marker.write(to: dir.appendingPathComponent("pg/lib/libpq.5.dylib"), atomically: true, encoding: .utf8)
        try fm.createSymbolicLink(atPath: dir.appendingPathComponent("pg/lib/libpq.dylib").path, withDestinationPath: "libpq.5.dylib")
        try stamp.write(to: dir.appendingPathComponent("RUNTIME_VERSION"), atomically: true, encoding: .utf8)
    }

    func testInstallCopiesOnlyWhenNewerAndKeepsUserData() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("rt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bundled = tmp.appendingPathComponent("bundled"), dest = tmp.appendingPathComponent("Application Support/Swarmaa/runtime")
        try makeRuntime(bundled, stamp: "20261022010000-aaa\n", marker: "v1")
        let installer = RuntimeInstaller()

        XCTAssertTrue(installer.needsInstall(from: bundled, to: dest))
        XCTAssertTrue(try installer.install(from: bundled, to: dest))
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("node")), "v1")
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: dest.appendingPathComponent("pg/lib/libpq.dylib").path), "libpq.5.dylib")

        // user data written by setup lives beside the payload
        try "SECRET=1".write(to: dest.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(at: dest.appendingPathComponent(".local/pg"), withIntermediateDirectories: true)

        // same stamp: nothing copied, even if the bundled files differ
        try "changed".write(to: bundled.appendingPathComponent("node"), atomically: true, encoding: .utf8)
        XCTAssertFalse(try installer.install(from: bundled, to: dest))
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("node")), "v1")

        // older bundled: still nothing
        try "20250101000000-old".write(to: bundled.appendingPathComponent("RUNTIME_VERSION"), atomically: true, encoding: .utf8)
        XCTAssertFalse(installer.needsInstall(from: bundled, to: dest))

        // newer: payload replaced, .env and .local untouched
        try "20271231235959-new".write(to: bundled.appendingPathComponent("RUNTIME_VERSION"), atomically: true, encoding: .utf8)
        XCTAssertTrue(try installer.install(from: bundled, to: dest))
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent("node")), "changed")
        XCTAssertEqual(installer.stamp(of: dest), "20271231235959-new")
        XCTAssertEqual(try String(contentsOf: dest.appendingPathComponent(".env")), "SECRET=1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent(".local/pg").path))
    }

    // MARK: Engine command selection

    func testEngineUsesBundledNodeAndCompiledScriptOnlyInRuntimeLayout() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("eng-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp.appendingPathComponent("dist/scripts"), withIntermediateDirectories: true)
        // dev checkout: no node, no compiled setup
        XCTAssertEqual(SetupEngine.base(root: tmp), ["--import", "tsx", "scripts/setup.ts"])
        XCTAssertNotEqual(NodeProcessRunner.nodeInvocation(root: tmp).executable, tmp.appendingPathComponent("node").path)
        // runtime layout
        FileManager.default.createFile(atPath: tmp.appendingPathComponent("dist/scripts/setup.js").path, contents: Data())
        FileManager.default.createFile(atPath: tmp.appendingPathComponent("node").path, contents: Data("#!/bin/sh\n".utf8),
                                       attributes: [.posixPermissions: 0o755])
        XCTAssertEqual(SetupEngine.base(root: tmp), ["dist/scripts/setup.js"])
        let inv = NodeProcessRunner.nodeInvocation(root: tmp)
        XCTAssertEqual(inv.executable, tmp.appendingPathComponent("node").path)
        XCTAssertEqual(inv.prefix, [])
    }

    // MARK: PKCE and request building

    func testPKCEMatchesRFC7636Vector() {
        XCTAssertEqual(SwarmaOAuth.PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let p = SwarmaOAuth.PKCE.generate(random: { Array(repeating: 7, count: 32) })
        XCTAssertEqual(p.verifier.count, 43)
        XCTAssertEqual(p.challenge, SwarmaOAuth.PKCE.challenge(for: p.verifier))
        XCTAssertFalse((p.verifier + p.challenge).contains { "+/=".contains($0) })
    }

    func testOriginValidation() throws {
        XCTAssertEqual(try SwarmaOAuth.origin(" https://api.swarmaa.com/ ").absoluteString, "https://api.swarmaa.com")
        XCTAssertEqual(try SwarmaOAuth.origin("http://127.0.0.1:8787/x?y=1").absoluteString, "http://127.0.0.1:8787")
        XCTAssertThrowsError(try SwarmaOAuth.origin("http://example.com"))
        XCTAssertThrowsError(try SwarmaOAuth.origin("api.swarmaa.com"))
        XCTAssertEqual(SwarmaOAuth.resource(origin), "https://api.swarmaa.com/mcp")
    }

    func testRegistrationAndAuthorizeURL() throws {
        let redirect = SwarmaOAuth.redirectURI(port: 5555)
        XCTAssertEqual(redirect, "http://127.0.0.1:5555/callback")
        let reg = try SwarmaOAuth.registrationRequest(origin: origin, redirectURI: redirect)
        XCTAssertEqual(reg.url?.absoluteString, "https://api.swarmaa.com/oauth/register")
        let body = try JSONSerialization.jsonObject(with: reg.httpBody!) as! [String: Any]
        XCTAssertEqual(body["redirect_uris"] as? [String], [redirect])
        XCTAssertEqual(body["token_endpoint_auth_method"] as? String, "none")
        XCTAssertEqual(try SwarmaOAuth.parseRegistration(Data(#"{"client_id":"abc"}"#.utf8)), "abc")
        XCTAssertThrowsError(try SwarmaOAuth.parseRegistration(Data("{}".utf8)))

        let url = SwarmaOAuth.authorizeURL(origin: origin, clientId: "abc", redirectURI: redirect, challenge: "CH", state: "ST")
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(c.path, "/oauth/authorize")
        let q = Dictionary(uniqueKeysWithValues: c.queryItems!.map { ($0.name, $0.value!) })
        XCTAssertEqual(q["response_type"], "code")
        XCTAssertEqual(q["client_id"], "abc")
        XCTAssertEqual(q["redirect_uri"], redirect)
        XCTAssertEqual(q["code_challenge"], "CH")
        XCTAssertEqual(q["code_challenge_method"], "S256")
        XCTAssertEqual(q["scope"], "mcp")
        XCTAssertEqual(q["resource"], "https://api.swarmaa.com/mcp")
        XCTAssertEqual(q["state"], "ST")
    }

    func testCallbackParsing() throws {
        XCTAssertEqual(try SwarmaOAuth.parseCallback(target: "/callback?code=XYZ&state=S", expectedState: "S"), "XYZ")
        XCTAssertThrowsError(try SwarmaOAuth.parseCallback(target: "/callback?code=XYZ&state=other", expectedState: "S")) {
            XCTAssertEqual($0 as? SwarmaOAuthError, .stateMismatch)
        }
        XCTAssertThrowsError(try SwarmaOAuth.parseCallback(target: "/callback?error=access_denied&state=S", expectedState: "S")) {
            XCTAssertEqual($0 as? SwarmaOAuthError, .denied("access_denied"))
        }
        XCTAssertThrowsError(try SwarmaOAuth.parseCallback(target: "/callback?state=S", expectedState: "S"))
        XCTAssertThrowsError(try SwarmaOAuth.parseCallback(target: "/other?code=1&state=S", expectedState: "S"))
    }

    func testTokenAndRefreshRequests() throws {
        let t = SwarmaOAuth.tokenRequest(origin: origin, clientId: "abc", code: "C D", verifier: "VER", redirectURI: "http://127.0.0.1:5/callback")
        XCTAssertEqual(t.url?.absoluteString, "https://api.swarmaa.com/oauth/token")
        XCTAssertEqual(t.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
        let body = String(decoding: t.httpBody!, as: UTF8.self)
        for part in ["grant_type=authorization_code", "code=C%20D", "client_id=abc", "code_verifier=VER",
                     "redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback", "resource=https%3A%2F%2Fapi.swarmaa.com%2Fmcp"] {
            XCTAssertTrue(body.contains(part), part)
        }
        let r = String(decoding: SwarmaOAuth.refreshRequest(origin: origin, clientId: "abc", refreshToken: "RT").httpBody!, as: UTF8.self)
        XCTAssertTrue(r.contains("grant_type=refresh_token") && r.contains("refresh_token=RT") && r.contains("client_id=abc"))

        let now = Date(timeIntervalSince1970: 1000)
        let tokens = try SwarmaOAuth.parseTokens(Data(#"{"access_token":"A","refresh_token":"R","expires_in":300}"#.utf8), clientId: "abc", now: now)
        XCTAssertEqual(tokens, SwarmaOAuthTokens(clientId: "abc", accessToken: "A", refreshToken: "R", expiresAt: now.addingTimeInterval(300)))
        XCTAssertThrowsError(try SwarmaOAuth.parseTokens(Data("{}".utf8), clientId: "abc", now: now))
    }

    // MARK: Flow and session

    func testFullFlowStoresTokens() async throws {
        let server = FakeServer { _ in "" }
        let store = MemoryStore()
        let stub = StubTransport([(201, #"{"client_id":"cid"}"#), (200, #"{"access_token":"A1","refresh_token":"R1","expires_in":300}"#)])
        var opened: URL?
        let flow = SwarmaOAuthFlow(store: store, transport: stub.transport, open: { opened = $0 }, callbackServer: { server })
        server.callback = { _ in
            let state = URLComponents(url: opened!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return "/callback?code=THECODE&state=\(state)"
        }
        try await flow.signIn(address: "https://api.swarmaa.com")
        XCTAssertEqual(store.load()?.accessToken, "A1")
        XCTAssertEqual(store.load()?.clientId, "cid")
        XCTAssertTrue(stub.body(0).replacingOccurrences(of: "\\/", with: "/").contains("http://127.0.0.1:4242/callback"))
        XCTAssertTrue(stub.body(1).contains("code=THECODE"))
        XCTAssertTrue(stub.body(1).contains("code_verifier="))
        XCTAssertNotNil(server.responded)
        XCTAssertTrue(server.stopped)
    }

    func testFlowRejectsWrongState() async {
        let store = MemoryStore()
        let stub = StubTransport([(201, #"{"client_id":"cid"}"#)])
        let server = FakeServer { _ in "/callback?code=C&state=forged" }
        let flow = SwarmaOAuthFlow(store: store, transport: stub.transport, open: { _ in }, callbackServer: { server })
        do { try await flow.signIn(address: "https://api.swarmaa.com"); XCTFail("should throw") }
        catch { XCTAssertEqual(error as? SwarmaOAuthError, .stateMismatch) }
        XCTAssertNil(store.load())
        XCTAssertEqual(stub.requests.count, 1)   // no token exchange
    }

    func testSessionRefreshesWhenExpiredAndRotatesRefreshToken() async throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let store = MemoryStore(.init(clientId: "cid", accessToken: "old", refreshToken: "R0", expiresAt: now.addingTimeInterval(10)))
        let stub = StubTransport([(200, #"{"access_token":"new","refresh_token":"R1","expires_in":300}"#)])
        let session = SwarmaOAuthSession(store: store, transport: stub.transport, serviceURL: { "https://api.swarmaa.com" }, now: { now })
        let token = try await session.accessToken()
        XCTAssertEqual(token, "new")
        XCTAssertEqual(store.load()?.refreshToken, "R1")
        XCTAssertTrue(stub.body(0).contains("refresh_token=R0"))
        // fresh now: no second request
        let again = try await session.accessToken()
        XCTAssertEqual(again, "new")
        XCTAssertEqual(stub.requests.count, 1)
    }

    // MARK: MCP mapping and client

    func testMCPRequestShape() throws {
        let body = Data(#"{"limit":5}"#.utf8)
        let r = try SwarmaClient.mcpRequest(serviceURL: "https://api.swarmaa.com", tool: "swarm_status", arguments: body, accessToken: "TOK")
        XCTAssertEqual(r.url?.absoluteString, "https://api.swarmaa.com/mcp")
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer TOK")
        XCTAssertEqual(r.value(forHTTPHeaderField: "MCP-Protocol-Version"), "2025-11-25")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Accept"), "application/json, text/event-stream")
        let json = try JSONSerialization.jsonObject(with: r.httpBody!) as! [String: Any]
        XCTAssertEqual(json["method"] as? String, "tools/call")
        let params = json["params"] as! [String: Any]
        XCTAssertEqual(params["name"] as? String, "swarm_status")
        XCTAssertEqual((params["arguments"] as! [String: Int])["limit"], 5)
    }

    func testUnwrapMCP() throws {
        let ok = Data(#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"workers":[]},"isError":false}}"#.utf8)
        let wrapped = try JSONSerialization.jsonObject(with: SwarmaClient.unwrapMCP(ok)) as! [String: Any]
        XCTAssertNotNil((wrapped["result"] as? [String: Any])?["workers"])
        // no structuredContent: the text block is parsed
        let textOnly = Data(#"{"result":{"content":[{"type":"text","text":"{\"a\":1}"}],"isError":false}}"#.utf8)
        XCTAssertEqual(((try JSONSerialization.jsonObject(with: SwarmaClient.unwrapMCP(textOnly)) as! [String: Any])["result"] as! [String: Int])["a"], 1)
        let forbidden = Data(#"{"result":{"content":[{"type":"text","text":"{\"error\":{\"code\":\"scope_forbidden\",\"message\":\"x\"}}"}],"isError":true}}"#.utf8)
        XCTAssertThrowsError(try SwarmaClient.unwrapMCP(forbidden)) { XCTAssertEqual($0 as? SwarmaClient.Failure, .forbidden) }
        XCTAssertThrowsError(try SwarmaClient.unwrapMCP(Data(#"{"error":{"code":-32600,"message":"x"}}"#.utf8))) {
            XCTAssertEqual($0 as? SwarmaClient.Failure, .badResponse)
        }
    }

    func testClientUsesMCPWithOAuthAndRefreshesOn401() async throws {
        let now = Date()
        let store = MemoryStore(.init(clientId: "cid", accessToken: "stale", refreshToken: "R0", expiresAt: now.addingTimeInterval(3600)))
        let refresh = StubTransport([(200, #"{"access_token":"fresh","refresh_token":"R1","expires_in":300}"#)])
        let session = SwarmaOAuthSession(store: store, transport: refresh.transport, serviceURL: { "https://api.swarmaa.com" })
        let api = StubTransport([
            (401, ""),
            (200, #"{"result":{"content":[],"structuredContent":{"workers":[{"name":"w1","live":true}],"usage":[],"scopes":[]},"isError":false}}"#),
        ])
        let client = SwarmaClient(serviceURL: { "https://api.swarmaa.com" }, tokenPath: { "/nonexistent/token.json" },
                                  transport: api.transport, cacheTTL: 0, authMode: { .oauth }, oauth: session)
        let status = try await client.status()
        XCTAssertEqual(status.workers.map(\.name), ["w1"])
        XCTAssertEqual(api.requests.map { $0.url?.path }, ["/mcp", "/mcp"])
        XCTAssertEqual(api.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer stale")
        XCTAssertEqual(api.requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer fresh")
        XCTAssertEqual(refresh.requests.count, 1)
    }

    func testClientKeepsRESTInTokenMode() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("tok-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try Data(#"{"token":"FILE"}"#.utf8).write(to: tmp)
        let api = StubTransport([(200, #"{"result":{"workers":[]}}"#)])
        let client = SwarmaClient(serviceURL: { "http://127.0.0.1:8787" }, tokenPath: { tmp.path },
                                  transport: api.transport, cacheTTL: 0, authMode: { .tokenFile })
        _ = try await client.status()
        XCTAssertEqual(api.requests[0].url?.path, "/api/tools/swarm_status")
        XCTAssertEqual(api.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer FILE")
    }
}

// MARK: - Welcome step

@MainActor
final class WelcomeActionsTests: XCTestCase {
    private func suite() -> UserDefaults {
        let name = "WelcomeActionsTests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    /// Every combination of build (runtime embedded or not), service folder (found or not) and choice leaves an enabled action.
    func testEveryWelcomeStateHasAnEnabledAction() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("wel-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        for bundled in [nil, tmp] as [URL?] {
            for folder in ["/nonexistent/swarma", tmp.path] {
                for address in ["", "not a url", "https://api.swarmaa.com"] {
                    for choice in WelcomeChoice.allCases {
                        let d = suite()
                        d.set(folder, forKey: Preferences.serviceRootKey)
                        let model = OnboardingModel(defaults: d, bundledRuntime: bundled, runOffMain: { _ in })
                        model.choice = choice
                        model.remoteAddress = address
                        XCTAssertFalse(model.welcomeActions.isEmpty, "\(String(describing: bundled)) \(folder) \(address) \(choice)")
                        XCTAssertTrue(model.welcomeActions.contains(.skip))
                    }
                }
            }
        }
    }

    func testContinueRequiresARealOptionAndSkipFinishesWithoutConnecting() {
        let d = suite()
        d.set("/nonexistent/swarma", forKey: Preferences.serviceRootKey)
        let model = OnboardingModel(defaults: d, bundledRuntime: nil, runOffMain: { _ in })
        XCTAssertEqual(model.choice, .setUpHere)
        XCTAssertEqual(model.welcomeActions, [.skip])          // no runtime, no service: only Skip
        model.choice = .connectRemote
        XCTAssertEqual(model.welcomeActions, [.skip, .continue])
        model.remoteAddress = "http://evil.example.com"
        XCTAssertEqual(model.welcomeActions, [.skip])
        model.skip()
        XCTAssertTrue(d.bool(forKey: Preferences.onboardingCompleteKey))
        XCTAssertNil(d.object(forKey: "swarmaEnabled"))
    }

    func testRemoteConnectedSwitchesClientToOAuth() {
        let d = suite()
        let model = OnboardingModel(defaults: d, bundledRuntime: nil, runOffMain: { _ in })
        model.remoteConnected(address: "https://api.swarmaa.com/")
        XCTAssertEqual(model.page, .connected)
        XCTAssertEqual(Preferences.storedSwarmaAuthMode(defaults: d), .oauth)
        XCTAssertEqual(d.string(forKey: "swarmaServiceURL"), "https://api.swarmaa.com")
        XCTAssertTrue(d.bool(forKey: "swarmaEnabled"))
    }

    func testSetUpHereInstallsThenMovesToServices() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("wi-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bundled = tmp.appendingPathComponent("b"), dest = tmp.appendingPathComponent("dest")
        try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        try "20261022000000-x".write(to: bundled.appendingPathComponent("RUNTIME_VERSION"), atomically: true, encoding: .utf8)
        let d = suite()
        d.set("/nonexistent/swarma", forKey: Preferences.serviceRootKey)
        let model = OnboardingModel(defaults: d, bundledRuntime: bundled, installDirectory: dest, runOffMain: { $0() })
        XCTAssertTrue(model.welcomeActions.contains(.continue))
        model.goNext()
        let done = expectation(description: "installed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { done.fulfill() }
        wait(for: [done], timeout: 2)
        XCTAssertEqual(model.page, .services)
        XCTAssertEqual(d.string(forKey: Preferences.serviceRootKey), dest.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent("RUNTIME_VERSION").path))
    }
}
