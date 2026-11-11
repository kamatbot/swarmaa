import Foundation

/// The Swarm map's brain: diffs one status snapshot against the last and keeps
/// what the panel draws. Pure value type; the view only reads it.
struct SwarmMapState {
    struct Run: Equatable {
        let id: String
        let provider: String
        let objective: String?
        let startedAt: Date?
    }
    enum PulseKind: Equatable { case out, back, failed, handoff }
    struct Pulse: Equatable {
        let id: String
        let kind: PulseKind
        /// "hub" or a provider.
        let from: String
        let to: String
        let startedAt: Date
    }
    enum FeedKind: Equatable { case running, done, failed, handoff }
    struct FeedRow: Equatable, Identifiable {
        let id: String
        var kind: FeedKind
        let provider: String
        /// Handoff only: where it came from.
        var from: String? = nil
        let objective: String?
        let at: Date
        var startedAt: Date?
        var duration: TimeInterval?
    }

    static let pulseLife: TimeInterval = 1
    static let feedLimit = 16

    private(set) var stations: [String] = []
    private(set) var offline: Set<String> = []
    private(set) var running: [String: [Run]] = [:]
    private(set) var finished: [String: Int] = [:]
    private(set) var failures: [String: Int] = [:]
    /// Tokens used per provider by tasks that finished while the map was open, plus the recent ones it started with.
    private(set) var tokens: [String: Int] = [:]
    /// Finished tasks (id, provider) whose token use is still to be looked up; the store drains it.
    var unpriced: [(id: String, provider: String)] = []
    private var priced = Set<String>()

    mutating func addTokens(_ n: Int, provider: String, task: String) {
        guard priced.insert(task).inserted else { return }
        tokens[provider, default: 0] += n
    }
    private(set) var queued = 0
    private(set) var pulses: [Pulse] = []
    /// Newest first.
    private(set) var feed: [FeedRow] = []
    private var previous: [String: Run]?

    var runningCount: Int { running.values.reduce(0) { $0 + $1.count } }

    mutating func ingest(_ status: SwarmaStatus, at now: Date) {
        var current: [String: Run] = [:]
        var seen = Set(stations), live = Set<String>()
        for w in status.workers {
            for p in w.providers { seen.insert(p); if w.live { live.insert(p) } }
            guard let provider = w.providers.first else { continue }
            for r in w.running {
                current[r.taskId] = Run(id: r.taskId, provider: provider, objective: r.objective, startedAt: r.startedAt)
            }
        }
        stations = seen.sorted()
        offline = seen.subtracting(live)
        queued = status.scopes.reduce(0) { $0 + $1.queued }
        running = Dictionary(grouping: current.values, by: \.provider).mapValues { $0.sorted { $0.id < $1.id } }

        if let previous {
            for run in current.values.sorted(by: { $0.id < $1.id }) {
                if let old = previous[run.id] {
                    guard old.provider != run.provider else { continue }
                    pulses.append(Pulse(id: run.id + "-handoff", kind: .handoff, from: old.provider, to: run.provider, startedAt: now))
                    push(FeedRow(id: run.id + "-handoff", kind: .handoff, provider: run.provider, from: old.provider,
                                 objective: run.objective, at: now, startedAt: nil, duration: nil))
                    markRunning(run, at: now)
                } else {
                    pulses.append(Pulse(id: run.id + "-out", kind: .out, from: "hub", to: run.provider, startedAt: now))
                    markRunning(run, at: now)
                }
            }
            for old in previous.values.sorted(by: { $0.id < $1.id }) where current[old.id] == nil {
                let state = status.recent.first { $0.id == old.id }?.status
                if state == "queued" { feed.removeAll { $0.id == old.id }; continue }  // requeued, not finished
                let failed = state == "failed"
                let took = old.startedAt.map { now.timeIntervalSince($0) }
                pulses.append(Pulse(id: old.id + (failed ? "-failed" : "-back"), kind: failed ? .failed : .back,
                                    from: old.provider, to: "hub", startedAt: now))
                if failed { failures[old.provider, default: 0] += 1 } else { finished[old.provider, default: 0] += 1 }
                unpriced.append((old.id, old.provider))
                let row = FeedRow(id: old.id, kind: failed ? .failed : .done, provider: old.provider,
                                  objective: old.objective, at: now, startedAt: old.startedAt, duration: took)
                if let i = feed.firstIndex(where: { $0.id == old.id }) { feed[i] = row } else { push(row) }
            }
        } else {
            for run in current.values.sorted(by: { $0.id < $1.id }) { markRunning(run, at: now) }
            // Seed token totals from the recent finished tasks, so the map is not empty on open.
            for row in status.recent where ["completed", "failed"].contains(row.status ?? "") {
                if let p = row.provider { unpriced.append((row.id, p)) }
            }
        }
        previous = current
        pulses.removeAll { now.timeIntervalSince($0.startedAt) > Self.pulseLife }
    }

    private mutating func markRunning(_ run: Run, at now: Date) {
        let row = FeedRow(id: run.id, kind: .running, provider: run.provider, objective: run.objective,
                          at: now, startedAt: run.startedAt, duration: nil)
        if let i = feed.firstIndex(where: { $0.id == run.id }) { feed[i] = row } else { push(row) }
    }

    private mutating func push(_ row: FeedRow) {
        feed.insert(row, at: 0)
        if feed.count > Self.feedLimit { feed.removeLast(feed.count - Self.feedLimit) }
    }

    var accessibilitySummary: String {
        stations.map { p in
            let n = running[p]?.count ?? 0
            return SwarmaCells.vendorName(p) + (n > 0 ? " \(n) running" : offline.contains(p) ? " offline" : " idle")
        }.joined(separator: ", ")
    }
}
