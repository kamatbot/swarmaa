import Foundation
import CryptoKit
import Network
import Security

// Sign-in to a Swarmaa service on another machine: OAuth 2.1 authorization
// code + PKCE (S256) with dynamic client registration and a loopback redirect,
// the way the service's /oauth endpoints expect (src/oauth.ts). The REST
// endpoint /api/tools does not accept OAuth tokens, so SwarmaClient talks MCP
// over /mcp when signed in this way.

enum SwarmaAuthMode: Equatable { case tokenFile, oauth }

struct SwarmaOAuthTokens: Codable, Equatable {
    var clientId: String
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
}

enum SwarmaOAuthError: Error, Equatable, LocalizedError {
    case badAddress, registrationFailed, denied(String), stateMismatch, missingCode, tokenFailed, timeout, cancelled, notSignedIn

    var errorDescription: String? {
        switch self {
        case .badAddress: return "That isn't a valid Swarmaa address. Use https://… (http only for this Mac)."
        case .registrationFailed: return "The service did not accept this app's registration."
        case .denied(let why): return "Sign-in was not approved (\(why))."
        case .stateMismatch: return "The sign-in response did not match this request."
        case .missingCode: return "The sign-in response had no authorization code."
        case .tokenFailed: return "The service did not issue tokens."
        case .timeout: return "Sign-in timed out. Try again."
        case .cancelled: return "Sign-in was cancelled."
        case .notSignedIn: return "Not signed in to Swarmaa."
        }
    }
}

/// The pure pieces of the flow: everything that builds or reads a request.
enum SwarmaOAuth {
    // MARK: PKCE

    struct PKCE: Equatable {
        let verifier: String
        let challenge: String

        /// `random` is injectable for tests; 32 bytes gives a 43 character verifier.
        static func generate(random: () -> [UInt8] = { (0..<32).map { _ in UInt8.random(in: 0...255) } }) -> PKCE {
            let verifier = base64url(Data(random()))
            return PKCE(verifier: verifier, challenge: challenge(for: verifier))
        }

        static func challenge(for verifier: String) -> String {
            base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        }
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    // MARK: Addresses

    /// The service origin, https only (plain http just for this Mac), no path.
    static func origin(_ address: String) throws -> URL {
        guard var c = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = c.host?.lowercased(), !host.isEmpty else { throw SwarmaOAuthError.badAddress }
        if scheme == "http", !["127.0.0.1", "localhost", "::1", "[::1]"].contains(host) { throw SwarmaOAuthError.badAddress }
        c.user = nil; c.password = nil; c.query = nil; c.fragment = nil; c.path = ""
        guard let url = c.url else { throw SwarmaOAuthError.badAddress }
        return url
    }

    /// `<origin>/mcp`, the OAuth resource the service binds tokens to.
    static func resource(_ origin: URL) -> String { origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/mcp" }

    static func redirectURI(port: UInt16) -> String { "http://127.0.0.1:\(port)/callback" }

    // MARK: Requests

    private static func endpoint(_ origin: URL, _ path: String) -> URL { origin.appendingPathComponent(path) }

    static func registrationRequest(origin: URL, redirectURI: String) throws -> URLRequest {
        var r = URLRequest(url: endpoint(origin, "oauth/register"))
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: [
            "client_name": "Swarmaa for Mac",
            "redirect_uris": [redirectURI],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": "mcp",
        ] as [String: Any])
        return r
    }

    static func parseRegistration(_ data: Data) throws -> String {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = o["client_id"] as? String, !id.isEmpty else { throw SwarmaOAuthError.registrationFailed }
        return id
    }

    static func authorizeURL(origin: URL, clientId: String, redirectURI: String, challenge: String, state: String) -> URL {
        var c = URLComponents(url: endpoint(origin, "oauth/authorize"), resolvingAgainstBaseURL: false)!
        c.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "scope", value: "mcp"),
            .init(name: "resource", value: resource(origin)),
            .init(name: "state", value: state),
        ]
        return c.url!
    }

    /// `target` is the request target of the browser's redirect, e.g. `/callback?code=…&state=…`.
    static func parseCallback(target: String, expectedState: String) throws -> String {
        guard let c = URLComponents(string: "http://127.0.0.1" + target), c.path == "/callback" else { throw SwarmaOAuthError.missingCode }
        let q = Dictionary(c.queryItems?.compactMap { i in i.value.map { (i.name, $0) } } ?? [], uniquingKeysWith: { a, _ in a })
        if let err = q["error"] { throw SwarmaOAuthError.denied(err) }
        guard q["state"] == expectedState else { throw SwarmaOAuthError.stateMismatch }
        guard let code = q["code"], !code.isEmpty else { throw SwarmaOAuthError.missingCode }
        return code
    }

    private static func form(_ url: URL, _ fields: KeyValuePairs<String, String>) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        r.httpBody = Data(fields.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&").utf8)
        return r
    }

    static func tokenRequest(origin: URL, clientId: String, code: String, verifier: String, redirectURI: String) -> URLRequest {
        form(endpoint(origin, "oauth/token"), [
            "grant_type": "authorization_code", "code": code, "client_id": clientId,
            "redirect_uri": redirectURI, "code_verifier": verifier, "resource": resource(origin),
        ])
    }

    static func refreshRequest(origin: URL, clientId: String, refreshToken: String) -> URLRequest {
        form(endpoint(origin, "oauth/token"), [
            "grant_type": "refresh_token", "refresh_token": refreshToken,
            "client_id": clientId, "resource": resource(origin),
        ])
    }

    static func parseTokens(_ data: Data, clientId: String, now: Date, previousRefresh: String? = nil) throws -> SwarmaOAuthTokens {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = o["access_token"] as? String, !access.isEmpty,
              let refresh = (o["refresh_token"] as? String) ?? previousRefresh else { throw SwarmaOAuthError.tokenFailed }
        let ttl = (o["expires_in"] as? Double) ?? 300
        return SwarmaOAuthTokens(clientId: clientId, accessToken: access, refreshToken: refresh, expiresAt: now.addingTimeInterval(ttl))
    }
}

// MARK: - Token storage

protocol SwarmaTokenStore: Sendable {
    func load() -> SwarmaOAuthTokens?
    func save(_ tokens: SwarmaOAuthTokens)
    func clear()
}

/// Keychain generic password under the app's bundle id.
struct KeychainTokenStore: SwarmaTokenStore {
    var service = "app.swarmaa.notch"
    var account = "swarmaa-oauth"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func load() -> SwarmaOAuthTokens? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(SwarmaOAuthTokens.self, from: data)
    }

    func save(_ tokens: SwarmaOAuthTokens) {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        if SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func clear() { SecItemDelete(query as CFDictionary) }
}

// MARK: - Session (access token, refreshed when it expires)

/// Hands out a live access token. Refresh tokens rotate (each is single use),
/// so concurrent callers share one refresh request.
actor SwarmaOAuthSession {
    static let shared = SwarmaOAuthSession()

    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let store: SwarmaTokenStore
    private let transport: Transport
    private let serviceURL: @Sendable () -> String
    private let now: @Sendable () -> Date
    private var refreshing: Task<SwarmaOAuthTokens, Error>?

    init(store: SwarmaTokenStore = KeychainTokenStore(),
         transport: @escaping Transport = { try await URLSession.shared.data(for: $0) },
         serviceURL: @escaping @Sendable () -> String = { Preferences.storedSwarmaServiceURL() },
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store; self.transport = transport; self.serviceURL = serviceURL; self.now = now
    }

    var isSignedIn: Bool { store.load() != nil }
    func signOut() { store.clear() }

    /// A token good for at least a minute; `forceRefresh` after the service said 401.
    func accessToken(forceRefresh: Bool = false) async throws -> String {
        guard let tokens = store.load() else { throw SwarmaOAuthError.notSignedIn }
        if !forceRefresh, tokens.expiresAt.timeIntervalSince(now()) > 60 { return tokens.accessToken }
        if let refreshing { return try await refreshing.value.accessToken }
        let origin = try SwarmaOAuth.origin(serviceURL())
        let (store, transport, now) = (self.store, self.transport, self.now)
        let task = Task { () throws -> SwarmaOAuthTokens in
            let (data, response) = try await transport(SwarmaOAuth.refreshRequest(origin: origin, clientId: tokens.clientId, refreshToken: tokens.refreshToken))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SwarmaOAuthError.notSignedIn }
            let fresh = try SwarmaOAuth.parseTokens(data, clientId: tokens.clientId, now: now(), previousRefresh: tokens.refreshToken)
            store.save(fresh)
            return fresh
        }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value.accessToken
    }
}

// MARK: - The interactive flow

/// Registers, opens the browser for the owner's passkey approval, waits for the
/// loopback redirect, exchanges the code and stores the tokens.
final class SwarmaOAuthFlow: @unchecked Sendable {
    typealias Transport = SwarmaOAuthSession.Transport

    private let transport: Transport
    private let store: SwarmaTokenStore
    private let open: @Sendable (URL) -> Void
    private let now: @Sendable () -> Date
    private let timeout: TimeInterval
    private let callbackServer: () -> LoopbackCallbackServer
    private var server: LoopbackCallbackServer?

    init(store: SwarmaTokenStore = KeychainTokenStore(),
         transport: @escaping Transport = { try await URLSession.shared.data(for: $0) },
         open: @escaping @Sendable (URL) -> Void,
         now: @escaping @Sendable () -> Date = { Date() },
         timeout: TimeInterval = 300,
         callbackServer: @escaping () -> LoopbackCallbackServer = { NWLoopbackCallbackServer() }) {
        self.store = store; self.transport = transport; self.open = open; self.now = now
        self.timeout = timeout; self.callbackServer = callbackServer
    }

    func cancel() { server?.stop() }

    func signIn(address: String) async throws {
        let origin = try SwarmaOAuth.origin(address)
        let server = callbackServer()
        self.server = server
        defer { server.stop() }
        let port = try await server.start()
        let redirect = SwarmaOAuth.redirectURI(port: port)

        let (regData, regResponse) = try await transport(SwarmaOAuth.registrationRequest(origin: origin, redirectURI: redirect))
        guard let code = (regResponse as? HTTPURLResponse)?.statusCode, (200..<300).contains(code) else { throw SwarmaOAuthError.registrationFailed }
        let clientId = try SwarmaOAuth.parseRegistration(regData)

        let pkce = SwarmaOAuth.PKCE.generate()
        let state = SwarmaOAuth.base64url(Data((0..<16).map { _ in UInt8.random(in: 0...255) }))
        open(SwarmaOAuth.authorizeURL(origin: origin, clientId: clientId, redirectURI: redirect, challenge: pkce.challenge, state: state))

        let target = try await server.waitForRequest(timeout: timeout)
        let authCode: String
        do { authCode = try SwarmaOAuth.parseCallback(target: target, expectedState: state) }
        catch { server.respond(html: "Sign-in failed. You can close this tab."); throw error }
        server.respond(html: "Swarmaa is connected. You can close this tab.")

        let (data, response) = try await transport(SwarmaOAuth.tokenRequest(origin: origin, clientId: clientId, code: authCode, verifier: pkce.verifier, redirectURI: redirect))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SwarmaOAuthError.tokenFailed }
        store.save(try SwarmaOAuth.parseTokens(data, clientId: clientId, now: now()))
    }
}

protocol LoopbackCallbackServer: AnyObject {
    /// Starts listening on 127.0.0.1 and returns the port.
    func start() async throws -> UInt16
    /// The request target (path and query) of the first GET /callback.
    func waitForRequest(timeout: TimeInterval) async throws -> String
    func respond(html: String)
    func stop()
}

/// A one-shot HTTP listener on the loopback interface.
final class NWLoopbackCallbackServer: LoopbackCallbackServer, @unchecked Sendable {
    private var listener: NWListener?
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<String, Error>?
    private var pending: Result<String, Error>?
    private let queue = DispatchQueue(label: "swarmaa.oauth.loopback")

    func start() async throws -> UInt16 {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        let listener = try NWListener(using: params, on: .any)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
            var done = false
            listener.stateUpdateHandler = { state in
                guard !done else { return }
                switch state {
                case .ready: done = true; cont.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let e): done = true; cont.resume(throwing: e)
                default: break
                }
            }
            listener.start(queue: queue)
        }
    }

    private func accept(_ c: NWConnection) {
        guard connection == nil else { c.cancel(); return }
        connection = c
        c.start(queue: queue)
        c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let text = String(data: data, encoding: .utf8) else { return }
            let parts = text.prefix(while: { $0 != "\r" && $0 != "\n" }).split(separator: " ")
            guard parts.count >= 2, parts[0] == "GET" else { self.finish(.failure(SwarmaOAuthError.missingCode)); return }
            self.finish(.success(String(parts[1])))
        }
    }

    private func finish(_ r: Result<String, Error>) {
        if let continuation { self.continuation = nil; continuation.resume(with: r) } else { pending = r }
    }

    func waitForRequest(timeout: TimeInterval) async throws -> String {
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish(.failure(SwarmaOAuthError.timeout)) }
        return try await withCheckedThrowingContinuation { cont in
            queue.async {
                if let p = self.pending { self.pending = nil; cont.resume(with: p) } else { self.continuation = cont }
            }
        }
    }

    func respond(html: String) {
        let body = "<!doctype html><meta charset=utf-8><title>Swarmaa</title><body style=\"font:16px -apple-system;margin:4em auto;max-width:28em\"><p>\(html)</p>"
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
        connection?.send(content: Data((head + body).utf8), completion: .contentProcessed { [weak self] _ in self?.connection?.cancel() })
    }

    func stop() {
        listener?.cancel()
        finish(.failure(SwarmaOAuthError.cancelled))
    }
}
