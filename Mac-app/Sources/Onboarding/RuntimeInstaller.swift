import Foundation

/// The self-contained Swarmaa runtime (compiled service, Node, PostgreSQL)
/// that ships in the app at Contents/Resources/runtime, and its install into
/// ~/Library/Application Support/Swarmaa/runtime. The install dir also holds the
/// user's `.env` and `.local` (database, tokens), so an update replaces only the
/// payload entries and never touches those.
struct RuntimeInstaller {
    static let payload = ["dist", "db", "clients", "scripts", "node_modules", "node", "pg", "package.json"]
    static let stampFile = "RUNTIME_VERSION"

    var fileManager: FileManager = .default

    static var bundledRuntime: URL? {
        let url = Bundle.main.resourceURL?.appendingPathComponent("runtime")
        return url.flatMap { FileManager.default.fileExists(atPath: $0.appendingPathComponent(stampFile).path) ? $0 : nil }
    }

    static var defaultInstallDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Swarmaa/runtime", isDirectory: true)
    }

    /// Stamps are `yyyymmddHHMMSS-<commit>`; a plain string comparison orders them by build time.
    func stamp(of dir: URL) -> String? {
        (try? String(contentsOf: dir.appendingPathComponent(Self.stampFile), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func needsInstall(from bundled: URL, to dest: URL) -> Bool {
        guard let new = stamp(of: bundled) else { return false }
        guard let old = stamp(of: dest) else { return true }
        return new > old
    }

    /// Copies the bundled runtime when the install is missing or older. Returns whether it copied.
    /// The stamp is written last, so an interrupted copy is retried on the next run.
    @discardableResult
    func install(from bundled: URL, to dest: URL) throws -> Bool {
        guard needsInstall(from: bundled, to: dest) else { return false }
        try fileManager.createDirectory(at: dest, withIntermediateDirectories: true)
        try? fileManager.removeItem(at: dest.appendingPathComponent(Self.stampFile))
        for name in Self.payload {
            let src = bundled.appendingPathComponent(name), dst = dest.appendingPathComponent(name)
            guard fileManager.fileExists(atPath: src.path) else { continue }
            try? fileManager.removeItem(at: dst)
            try fileManager.copyItem(at: src, to: dst)   // keeps symlinks (libpq.dylib -> libpq.5.dylib)
        }
        try fileManager.copyItem(at: bundled.appendingPathComponent(Self.stampFile), to: dest.appendingPathComponent(Self.stampFile))
        return true
    }

    /// A root that carries its own Node and compiled scripts.
    static func isBundledLayout(_ root: URL, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
        exists(root.appendingPathComponent("node").path) && exists(root.appendingPathComponent("dist/scripts/setup.js").path)
    }
}
