import Foundation

/// One thing worth telling the user about a Swarmaa task, worded like an agent
/// chatting: it started, finished, failed or needs them.
struct SwarmaUpdate: Equatable {
    enum Kind: Equatable { case started, finished, failed, blocked }
    let kind: Kind
    let taskID: String
    let provider: String?
    let objective: String
    let scope: String?
    let taskKind: String?
    let branch: String?
}

/// Pure diff of two consecutive statuses into updates. `previous == nil` is the
/// baseline (first status after launch or re-enabling): it fires nothing.
/// Finishes are reported once per task id because `seen` carries ids already
/// announced; the caller keeps it.
enum SwarmaUpdates {
    static let terminal: Set<String> = ["completed", "failed", "blocked"]

    static func diff(previous: SwarmaStatus?, current: SwarmaStatus, announced: inout Set<String>) -> [SwarmaUpdate] {
        let finishedNow = current.recent.filter { terminal.contains($0.status ?? "") }
        guard let previous else {
            announced.formUnion(current.workers.flatMap { $0.running.map(\.taskId) })
            announced.formUnion(finishedNow.map { "done:" + $0.id })
            return []
        }
        var out: [SwarmaUpdate] = []
        let before = Set(previous.workers.flatMap { $0.running.map(\.taskId) })
        let objectives = Dictionary((previous.recent + current.recent).compactMap { r in r.objective.map { (r.id, $0) } },
                                    uniquingKeysWith: { $1 })
        for worker in current.workers {
            for run in worker.running where !before.contains(run.taskId) && announced.insert(run.taskId).inserted {
                out.append(SwarmaUpdate(kind: .started, taskID: run.taskId, provider: worker.providers.first,
                                        objective: run.objective ?? objectives[run.taskId] ?? run.kind ?? "task",
                                        scope: run.scope, taskKind: run.kind, branch: nil))
            }
        }
        // Finished: terminal in `recent` and not announced yet. A task that was never
        // seen running (fast) still counts, so long as it was not terminal before.
        let wasTerminal = Set(previous.recent.filter { terminal.contains($0.status ?? "") }.map(\.id))
        for row in finishedNow where !wasTerminal.contains(row.id) && announced.insert("done:" + row.id).inserted {
            let kind: SwarmaUpdate.Kind = row.status == "failed" ? .failed : row.status == "blocked" ? .blocked : .finished
            out.append(SwarmaUpdate(kind: kind, taskID: row.id, provider: row.provider ?? row.worker,
                                    objective: row.objective ?? objectives[row.id] ?? row.kind ?? "task",
                                    scope: row.scope, taskKind: row.kind, branch: row.branch))
        }
        return out
    }

    /// First sentence or heading text of an answer, markdown stripped, at most
    /// `limit` characters (two card lines).
    static func excerpt(_ answer: String, limit: Int = 160) -> String {
        var lines: [String] = []
        var inFence = false
        for raw in answer.split(separator: "\n", omittingEmptySubsequences: true) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") { inFence.toggle(); continue }
            if inFence || line.isEmpty { continue }
            if line.hasPrefix("#") { continue } // headings repeat the title; the first sentence says more
            while let f = line.first, "#>*-+ ".contains(f) { line.removeFirst() }
            line = line.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
                .replacingOccurrences(of: #"[*_`~]+"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { lines.append(line) }
            if lines.joined(separator: " ").count >= limit { break }
        }
        var text = lines.joined(separator: " ")
        if text.count > limit { text = String(text.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…" }
        return text
    }
}

/// What `task_get` adds beyond the status row: the answer and any reason code.
struct SwarmaTaskDetail: Equatable {
    var answer: String?
    var reason: String?

    /// The service's shape is not pinned down here, so look for the keys
    /// anywhere in the result rather than at one path.
    static func parse(_ json: Any) -> SwarmaTaskDetail {
        func find(_ keys: [String], _ node: Any) -> String? {
            if let d = node as? [String: Any] {
                for k in keys { if let s = d[k] as? String, !s.isEmpty { return s } }
                for v in d.values { if let s = find(keys, v) { return s } }
            } else if let a = node as? [Any] {
                for v in a { if let s = find(keys, v) { return s } }
            }
            return nil
        }
        return SwarmaTaskDetail(answer: find(["answer"], json),
                                reason: find(["code", "reason_code", "error_code", "reason", "block_reason"], json))
    }
}

extension SwarmaUpdates {
    /// The card for one update: provider glyph and name, "Started: …" line, project and time.
    static func notice(_ u: SwarmaUpdate, detail: SwarmaTaskDetail?, now: Date = Date()) -> UsageResetEvent {
        let name = u.provider.map(SwarmaCells.vendorName) ?? SwarmaCells.serviceName.capitalized
        var e = UsageResetEvent(providerID: SwarmaCells.agentPrefix + (u.provider ?? ""), providerName: name,
                                windowLabel: "", glyph: SwarmaCells.glyph(forProvider: u.provider),
                                previousFraction: 0, currentFraction: 0, resetsAt: nil)
        let verb: String
        switch u.kind {
        case .started: verb = L10n.t("Started")
        case .finished: verb = L10n.t("Finished")
        case .failed: verb = L10n.t("Failed")
        case .blocked: verb = L10n.t("Needs you")
        }
        var status = "\(verb): \(u.objective)"
        if u.kind == .failed || u.kind == .blocked, let reason = detail?.reason { status += " (\(reason))" }
        let time = now.formatted(date: .omitted, time: .shortened)
        e.noticeTitle = name
        e.noticeSubtitle = [u.scope.map(SwarmaCells.scopeLabel), time].compactMap { $0 }.joined(separator: " · ")
        e.noticeStatus = status
        e.noticeIsProblem = u.kind == .failed || u.kind == .blocked
        var lines: [String] = []
        if u.kind == .finished, let answer = detail?.answer { lines.append(excerpt(answer)) }
        if let branch = u.branch, u.kind == .finished { lines.append("→ \(branch)") }
        e.noticeDetail = lines.filter { !$0.isEmpty }.joined(separator: "\n")
        return e
    }
}

extension SwarmaClient {
    func taskDetail(id: String) async throws -> SwarmaTaskDetail {
        let body = try JSONSerialization.data(withJSONObject: ["task_id": id])
        let data = try await fetchRaw(tool: "task_get", body: body)
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let result = json["result"] else { throw Failure.badResponse }
        return SwarmaTaskDetail.parse(result)
    }
}
