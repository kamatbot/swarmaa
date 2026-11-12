import Foundation
import Security

/// Secrets a bot asked for (question_ask with `credential`). The value goes to the login Keychain
/// (service `app.swarmaa.bot-secret`, account `<scope>/<NAME>`); only the name is listed in
/// ~/.swarma/bot-secrets.json so the local bridge knows which ones to pass to that project's bots.
/// Nothing here is ever sent to the Swarmaa service.
enum BotSecretStore {
    static let service = "app.swarmaa.bot-secret"
    static var indexURL: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".swarma/bot-secrets.json") }

    static func isValidName(_ name: String) -> Bool {
        name.range(of: #"^[A-Z][A-Z0-9_]{1,63}$"#, options: .regularExpression) != nil
            && !name.hasPrefix("COLLECTIVE_") && !name.hasPrefix("SWARMAA_")
    }

    /// Stores the value and lists the name for the scope. The bridge reads it with /usr/bin/security,
    /// so that tool is on the item's access list (no Keychain prompt on a headless bridge).
    static func save(scope: String, name: String, value: String) -> Bool {
        guard isValidName(name), !scope.isEmpty, !value.isEmpty, value.utf8.count <= 8192 else { return false }
        let account = "\(scope)/\(name)"
        let base: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        SecItemDelete(base as CFDictionary) // replace, so the access list is always the one below
        var add = base
        add[kSecValueData] = Data(value.utf8)
        add[kSecAttrLabel] = "Swarmaa bot secret \(name) (\(scope))"
        if let access = bridgeAccess(label: "Swarmaa bot secret \(name)") { add[kSecAttrAccess] = access }
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return false }
        return addToIndex(scope: scope, name: name)
    }

    static func has(scope: String, name: String) -> Bool {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service,
                                      kSecAttrAccount: "\(scope)/\(name)", kSecMatchLimit: kSecMatchLimitOne]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    /// This app plus /usr/bin/security. The file-based Keychain ACL APIs are deprecated but still the only way
    /// to pre-authorize a command-line reader; if they fail, the item is created with the default ACL instead.
    private static func bridgeAccess(label: String) -> SecAccess? {
        var me: SecTrustedApplication?, tool: SecTrustedApplication?
        guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess,
              SecTrustedApplicationCreateFromPath("/usr/bin/security", &tool) == errSecSuccess,
              let me, let tool else { return nil }
        var access: SecAccess?
        guard SecAccessCreate(label as CFString, [me, tool] as CFArray, &access) == errSecSuccess else { return nil }
        return access
    }

    private static func addToIndex(scope: String, name: String) -> Bool {
        let url = indexURL
        var index = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: [String]] ?? [:]
        var names = Set(index[scope] ?? [])
        names.insert(name)
        index[scope] = names.sorted()
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try JSONSerialization.data(withJSONObject: index, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return true
        } catch { return false }
    }
}
