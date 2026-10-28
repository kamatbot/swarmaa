import Foundation

// The contract with the Swarmaa service's Node setup script
// (`scripts/setup.ts --detect-json` / `--run-json`). Everything here is plain
// data plus one blocking process call, so it can be tested with a stub runner.

/// Harness keys, exactly as the engine spells them.
enum SetupHarness: String, CaseIterable {
    case claude, codex, agy, grok, dot, notchtrader
}

// MARK: - Detect

struct SetupDetection: Decodable, Equatable {
    struct Postgres: Decodable, Equatable { var found = false; var reachable = false }
    struct Project: Decodable, Equatable { let scope: String; let root: String }
    struct Remote: Decodable, Equatable { let hostname: String? }
    struct State: Decodable, Equatable {
        var folders: [String] = []
        var projects: [Project] = []
        var agents: [String] = []
        var workers: [String] = []
        var sharing: [String] = []
        var autostart: Bool?
        var remote: Remote?

        init() {}
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            folders = (try? c.decodeIfPresent([String].self, forKey: .folders)) ?? []
            projects = (try? c.decodeIfPresent([Project].self, forKey: .projects)) ?? []
            agents = (try? c.decodeIfPresent([String].self, forKey: .agents)) ?? []
            workers = (try? c.decodeIfPresent([String].self, forKey: .workers)) ?? []
            sharing = (try? c.decodeIfPresent([String].self, forKey: .sharing)) ?? []
            autostart = try? c.decodeIfPresent(Bool.self, forKey: .autostart)
            remote = try? c.decodeIfPresent(Remote.self, forKey: .remote)
        }
        private enum Keys: String, CodingKey { case folders, projects, agents, workers, sharing, autostart, remote }
    }

    var clis: [String: String] = [:]
    var notchtrader = false
    var postgres: Postgres?
    var envExists = false
    var state: State?

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        clis = (try? c.decodeIfPresent([String: String].self, forKey: .clis)) ?? [:]
        notchtrader = (try? c.decodeIfPresent(Bool.self, forKey: .notchtrader)) ?? false
        postgres = try? c.decodeIfPresent(Postgres.self, forKey: .postgres)
        envExists = (try? c.decodeIfPresent(Bool.self, forKey: .envExists)) ?? false
        state = try? c.decodeIfPresent(State.self, forKey: .state)
    }
    private enum Keys: String, CodingKey { case clis, notchtrader, postgres, envExists, state }

    func isInstalled(_ harness: SetupHarness) -> Bool { clis[harness.rawValue] != nil }
}

// MARK: - Plan (stdin of --run-json)

struct SetupPlan: Encodable, Equatable {
    struct Harness: Encodable, Equatable {
        var connect: Bool
        var worker: Bool
        var share: Bool
    }
    struct Remote: Encodable, Equatable { var hostname: String }

    var harnesses: [String: Harness]
    var folders: [String]
    /// Omitted from the JSON when nil, i.e. "not set up now".
    var remote: Remote?
    var autostart: Bool

    func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

// MARK: - Events (NDJSON stdout of --run-json)

struct SetupStep: Decodable, Equatable, Identifiable {
    enum Status: String, Decodable { case running, ok, skipped, failed }
    let id: String
    let label: String
    let status: Status
    let note: String?
}

struct SetupSummary: Decodable, Equatable {
    struct Project: Decodable, Equatable { let scope: String; let root: String }
    struct Remote: Decodable, Equatable { let hostname: String?; let ok: Bool? }

    var dry = false
    var ok = false
    var error: String?
    var agents: [String] = []
    var workers: [String] = []
    var sharing: [String] = []
    var projects: [Project] = []
    var serviceUrl: String?
    var mcpUrl: String?
    var remote: Remote?
    var steps: [SetupStep] = []
    var warnings: [String] = []
    var nextSteps: [String] = []

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        dry = (try? c.decodeIfPresent(Bool.self, forKey: .dry)) ?? false
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        agents = (try? c.decodeIfPresent([String].self, forKey: .agents)) ?? []
        workers = (try? c.decodeIfPresent([String].self, forKey: .workers)) ?? []
        sharing = (try? c.decodeIfPresent([String].self, forKey: .sharing)) ?? []
        projects = (try? c.decodeIfPresent([Project].self, forKey: .projects)) ?? []
        serviceUrl = try? c.decodeIfPresent(String.self, forKey: .serviceUrl)
        mcpUrl = try? c.decodeIfPresent(String.self, forKey: .mcpUrl)
        remote = try? c.decodeIfPresent(Remote.self, forKey: .remote)
        steps = (try? c.decodeIfPresent([SetupStep].self, forKey: .steps)) ?? []
        warnings = (try? c.decodeIfPresent([String].self, forKey: .warnings)) ?? []
        nextSteps = (try? c.decodeIfPresent([String].self, forKey: .nextSteps)) ?? []
    }
    private enum Keys: String, CodingKey {
        case dry, ok, error, agents, workers, sharing, projects, serviceUrl, mcpUrl, remote, steps, warnings, nextSteps
    }
}

enum SetupEvent: Equatable {
    case step(SetupStep)
    case log(String)
    case summary(SetupSummary)
    case error([String])

    /// One NDJSON line. Nil for blank or unparseable lines; the caller shows
    /// those verbatim in the log rather than dropping them.
    static func parse(line: String) -> SetupEvent? {
        guard let data = line.data(using: .utf8), !line.trimmingCharacters(in: .whitespaces).isEmpty,
              let wire = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        switch wire.type {
        case "step": return wire.step.map { .step($0) }
        case "log": return wire.line.map { .log($0) }
        case "summary": return wire.summary.map { .summary($0) }
        case "error": return .error(wire.errors ?? [])
        default: return nil
        }
    }

    private struct Wire: Decodable {
        let type: String
        let step: SetupStep?
        let line: String?
        let summary: SetupSummary?
        let errors: [String]?
    }
}

/// Splits a byte stream into lines, holding back a trailing partial line until
/// the rest arrives (or `flush`).
struct LineBuffer {
    private var pending = Data()

    mutating func append(_ data: Data) -> [String] {
        pending.append(data)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            lines.append(String(decoding: pending[pending.startIndex..<newline], as: UTF8.self))
            pending = Data(pending[pending.index(after: newline)...])
        }
        return lines
    }

    mutating func flush() -> [String] {
        defer { pending = Data() }
        return pending.isEmpty ? [] : [String(decoding: pending, as: UTF8.self)]
    }
}

// MARK: - Process

protocol SetupProcessRunning {
    /// Blocks until the process exits. Lines arrive on arbitrary threads.
    func run(arguments: [String], root: URL, stdin: Data?,
             onStdout: @escaping (String) -> Void,
             onStderr: @escaping (String) -> Void) throws -> Int32
}

enum SetupEngineError: LocalizedError, Equatable {
    case invalidPlan([String])
    case failed(code: Int32, detail: String)
    case noOutput

    var errorDescription: String? {
        switch self {
        case .invalidPlan(let errors): return errors.joined(separator: "\n")
        case .failed(let code, let detail):
            return detail.isEmpty ? "The setup script exited with status \(code)." : detail
        case .noOutput: return "The setup script returned nothing."
        }
    }
}

struct NodeProcessRunner: SetupProcessRunning {
    /// The bundled Node when the root is the app's runtime; else first of Homebrew, /usr/local, else whatever `env` finds.
    static func nodeInvocation(root: URL? = nil, exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) })
        -> (executable: String, prefix: [String]) {
        if let root, RuntimeInstaller.isBundledLayout(root) {
            return (root.appendingPathComponent("node").path, [])
        }
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where exists(path) {
            return (path, [])
        }
        return ("/usr/bin/env", ["node"])
    }

    func run(arguments: [String], root: URL, stdin: Data?,
             onStdout: @escaping (String) -> Void,
             onStderr: @escaping (String) -> Void) throws -> Int32 {
        let node = Self.nodeInvocation(root: root)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node.executable)
        process.arguments = node.prefix + arguments
        process.currentDirectoryURL = root
        // A Dock-launched app has a minimal PATH; the script spawns other tools.
        var environment = ProcessInfo.processInfo.environment
        let base = environment["PATH"] ?? ""
        environment["PATH"] = (["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            + base.split(separator: ":").map(String.init)).joined(separator: ":")
        if RuntimeInstaller.isBundledLayout(root) { environment["SWARMAA_PG_BIN"] = root.appendingPathComponent("pg/bin").path }
        process.environment = environment

        let out = Pipe(), err = Pipe(), input = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = input

        var outBuffer = LineBuffer(), errBuffer = LineBuffer()
        let lock = NSLock()
        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            lock.lock(); let lines = outBuffer.append(data); lock.unlock()
            lines.forEach(onStdout)
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            lock.lock(); let lines = errBuffer.append(data); lock.unlock()
            lines.forEach(onStderr)
        }

        try process.run()
        if let stdin { input.fileHandleForWriting.write(stdin) }
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()

        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        lock.lock()
        let rest = outBuffer.append(out.fileHandleForReading.readDataToEndOfFile()) + outBuffer.flush()
        let restErr = errBuffer.append(err.fileHandleForReading.readDataToEndOfFile()) + errBuffer.flush()
        lock.unlock()
        rest.forEach(onStdout)
        restErr.forEach(onStderr)
        return process.terminationStatus
    }
}

// MARK: - Engine

struct SetupEngine {
    var runner: SetupProcessRunning = NodeProcessRunner()

    /// `dist/scripts/setup.js` in the app's runtime, `--import tsx scripts/setup.ts` in a dev checkout.
    static func base(root: URL) -> [String] {
        RuntimeInstaller.isBundledLayout(root) ? ["dist/scripts/setup.js"] : ["--import", "tsx", "scripts/setup.ts"]
    }

    /// Blocking: call off the main thread.
    func detect(root: URL) throws -> SetupDetection {
        var stdout: [String] = [], stderr: [String] = []
        let lock = NSLock()
        let code = try runner.run(arguments: Self.base(root: root) + ["--detect-json"], root: root, stdin: nil,
                                  onStdout: { lock.lock(); stdout.append($0); lock.unlock() },
                                  onStderr: { lock.lock(); stderr.append($0); lock.unlock() })
        lock.lock(); defer { lock.unlock() }
        guard code == 0 else { throw SetupEngineError.failed(code: code, detail: stderr.suffix(5).joined(separator: "\n")) }
        // The object is one line; take the last that parses, ignoring any chatter before it.
        for line in stdout.reversed() {
            if let data = line.data(using: .utf8), let d = try? JSONDecoder().decode(SetupDetection.self, from: data) {
                return d
            }
        }
        throw SetupEngineError.noOutput
    }

    /// Blocking: call off the main thread. Events (and stderr lines as `.log`)
    /// are delivered on arbitrary threads. Returns the summary.
    func run(plan: SetupPlan, dry: Bool, root: URL,
             onEvent: @escaping (SetupEvent) -> Void,
             onRaw: @escaping (String) -> Void = { _ in }) throws -> SetupSummary {
        var summary: SetupSummary?
        var errors: [String] = []
        var stderr: [String] = []
        let lock = NSLock()
        let code = try runner.run(
            arguments: Self.base(root: root) + ["--run-json"] + (dry ? ["--dry-run"] : []),
            root: root, stdin: try plan.json(),
            onStdout: { line in
                if let event = SetupEvent.parse(line: line) {
                    lock.lock()
                    if case .summary(let s) = event { summary = s }
                    if case .error(let e) = event { errors = e }
                    lock.unlock()
                    onEvent(event)
                } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                    onRaw(line)
                }
            },
            onStderr: { line in
                lock.lock(); stderr.append(line); lock.unlock()
                onRaw(line)
            })
        lock.lock(); defer { lock.unlock() }
        if !errors.isEmpty { throw SetupEngineError.invalidPlan(errors) }
        if code != 0 { throw SetupEngineError.failed(code: code, detail: stderr.suffix(5).joined(separator: "\n")) }
        guard let summary else { throw SetupEngineError.noOutput }
        return summary
    }
}
