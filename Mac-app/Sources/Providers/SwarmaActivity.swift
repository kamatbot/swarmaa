import Foundation

/// What the hover card for an agent or project cell shows: the running tasks,
/// the quota they draw on, where the next task goes and what just landed.
/// Pure, built from one `swarm_status` answer, so it is testable and the card
/// height can be worked out from it without laying anything out.
struct SwarmaActivity: Equatable {
    struct Run: Equatable {
        let id: String
        let provider: String
        let kind: String?
        let objective: String
        let startedAt: Date?
    }
    struct Quota: Equatable {
        let provider: String
        let fiveHourPct: Double?
        let weeklyPct: Double?
        /// The policy's `max_five_hour_pct`: past it the router stops sending work.
        let ceiling: Int
    }
    struct Route: Equatable {
        let kind: String
        let provider: String
    }
    struct Landed: Equatable {
        let branch: String
        let files: Int?
        let at: Date?
    }
    enum Pill: Equatable {
        case live, idle, offline
        case counts(running: Int, queued: Int)
    }

    static let maxRunning = 4
    static let maxLanded = 3

    let title: String
    let pill: Pill
    let isScope: Bool
    var running: [Run] = []
    var quotas: [Quota] = []
    var routes: [Route] = []
    var routeReason: String?
    var landed: [Landed] = []

    var shownRunning: [Run] { Array(running.prefix(Self.maxRunning)) }
    var hiddenRunning: Int { max(0, running.count - Self.maxRunning) }

    // MARK: Building

    static func agent(_ worker: SwarmaStatus.Worker, in status: SwarmaStatus) -> SwarmaActivity {
        let vendor = worker.providers.first
        let name = L10n.t("\(vendor.map(SwarmaCells.vendorName) ?? worker.name) worker")
        let pill: Pill = !worker.live ? .offline : worker.running.isEmpty ? .idle : .live
        return build(title: name, pill: pill, isScope: false, workers: [worker], providers: worker.providers,
                     landedWhere: { row in row.provider.map(worker.providers.contains) ?? false }, in: status)
    }

    static func scope(_ scope: SwarmaStatus.Scope, in status: SwarmaStatus) -> SwarmaActivity {
        build(title: SwarmaCells.scopeLabel(scope.scope), pill: .counts(running: scope.running, queued: scope.queued),
              isScope: true, workers: status.workers, providers: nil, scope: scope.scope,
              landedWhere: { $0.scope == scope.scope }, in: status)
    }

    private static func build(title: String, pill: Pill, isScope: Bool, workers: [SwarmaStatus.Worker],
                              providers: [String]?, scope: String? = nil,
                              landedWhere: (SwarmaStatus.TaskRow) -> Bool,
                              in status: SwarmaStatus) -> SwarmaActivity {
        var activity = SwarmaActivity(title: title, pill: pill, isScope: isScope)

        for worker in workers {
            for task in worker.running where scope == nil || task.scope == scope {
                let row = status.recent.first { $0.id == task.taskId }
                activity.running.append(Run(
                    id: task.taskId,
                    provider: provider(of: task, on: worker),
                    kind: task.kind ?? row?.kind,
                    objective: task.objective ?? row?.objective ?? task.taskId,
                    startedAt: task.startedAt))
            }
        }

        let policy = status.routing?.policy
        let order = ["claude", "codex", "antigravity"]
        let rank = { (p: String) in order.firstIndex(of: p) ?? order.count }
        for usage in status.usage.sorted(by: { rank($0.provider) < rank($1.provider) })
        where providers.map({ $0.contains(usage.provider) }) ?? true {
            guard !usage.windows.isEmpty else { continue }
            let five = usage.windows.first { $0.name?.lowercased().contains("5h") == true }?.usedPercent
                ?? usage.windows.compactMap(\.usedPercent).max()
            let week = usage.windows.first {
                let n = $0.name?.lowercased() ?? ""
                return n.contains("7d") || n.contains("week")
            }?.usedPercent
            let ceiling = policy?.providers.first { $0.provider == usage.provider }?.maxFiveHourPct
                ?? (usage.provider == "claude" ? 90 : 95)
            activity.quotas.append(Quota(provider: usage.provider, fiveHourPct: five, weeklyPct: week, ceiling: ceiling))
        }

        let byKind = status.routing?.byKind ?? [:]
        for kind in ["patch", "review", "research"] {
            if let p = byKind[kind]?.provider { activity.routes.append(Route(kind: kind, provider: p)) }
        }
        activity.routeReason = byKind["review"]?.reason.nilIfEmpty

        let done: Set<String> = ["completed", "complete", "done", "succeeded"]
        activity.landed = status.recent
            .filter { done.contains($0.status ?? "") && ($0.branch?.isEmpty == false) && landedWhere($0) }
            .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
            .prefix(maxLanded)
            .map { Landed(branch: $0.branch ?? "", files: $0.changedFiles, at: $0.updatedAt) }
        return activity
    }

    /// "codex.patch" is codex's; "auto.read" goes to whichever the worker serves.
    private static func provider(of task: SwarmaStatus.Worker.Running, on worker: SwarmaStatus.Worker) -> String {
        if let head = task.requiredCapability?.split(separator: ".").first.map(String.init), head != "auto" {
            return head
        }
        return worker.providers.first ?? "other"
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
