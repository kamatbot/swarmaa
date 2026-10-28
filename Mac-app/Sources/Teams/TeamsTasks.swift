import Foundation
import SwiftUI

private extension KeyedDecodingContainer {
    func opt<T: Decodable>(_ type: T.Type, _ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
}

/// One `attention_list` item, as the live service sends it
/// (docs/briefs/teams-shapes/attention_list.json).
struct TeamsAttentionItem: Decodable, Equatable, Identifiable {
    /// `question`, `task` or `swarm`.
    var kind: String
    var id: String
    /// Already one line.
    var title: String
    var state: String
    /// "Ready for review · branch swarmaa/claude/aa96efb9 · 12 files".
    var nextStep: String
    var at: Date?
    var threadID: String?

    private enum CodingKeys: String, CodingKey { case kind, id, title, state, at, nextStep = "next_step", threadID = "thread_id" }

    init(kind: String, id: String, title: String, state: String, nextStep: String, at: Date? = nil, threadID: String? = nil) {
        self.kind = kind; self.id = id; self.title = title; self.state = state
        self.nextStep = nextStep; self.at = at; self.threadID = threadID
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = c.opt(String.self, .kind) ?? "task"
        title = c.opt(String.self, .title) ?? ""
        state = c.opt(String.self, .state) ?? ""
        nextStep = c.opt(String.self, .nextStep) ?? ""
        at = c.opt(Date.self, .at); threadID = c.opt(String.self, .threadID)
    }

    /// The `branch …` part of `next_step`, when a review has one.
    var branch: String? {
        nextStep.components(separatedBy: " · ").first { $0.hasPrefix("branch ") }.map { String($0.dropFirst("branch ".count)) }
    }
}

/// A task from `task_get` or `task_list`. No shape file covers these, so only
/// the fields the Tasks tab needs, leniently.
struct TeamsTask: Decodable, Equatable, Identifiable {
    var id: String
    var objective: String
    var status: String
    var version: Int?
    var scope: String?
    var updatedAt: Date?

    private enum CodingKeys: String, CodingKey { case id, objective, status, version, scope, updatedAt = "updated_at" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        objective = c.opt(String.self, .objective) ?? ""
        status = c.opt(String.self, .status) ?? ""
        version = c.opt(Int.self, .version); scope = c.opt(String.self, .scope)
        updatedAt = c.opt(Date.self, .updatedAt)
    }
}

/// The Tasks tab's sections, in the order they are shown.
enum TeamsTaskSection: Int, CaseIterable, Comparable {
    case needsInput, review, working, failed, resolved

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    var title: String {
        switch self {
        case .needsInput: return L10n.t("Needs input")
        case .review: return L10n.t("Ready for review")
        case .working: return L10n.t("Working")
        case .failed: return L10n.t("Failed")
        case .resolved: return L10n.t("Resolved")
        }
    }

    /// Green for review, orange for input, blue for working, red for failed.
    var color: Color {
        switch self {
        case .needsInput: return .orange
        case .review: return .green
        case .working: return .blue
        case .failed: return .red
        case .resolved: return .secondary
        }
    }

    /// From the `next_step` word the service leads with, else from the state.
    static func of(_ item: TeamsAttentionItem) -> TeamsTaskSection {
        switch TeamsTaskRow.split(item.nextStep).word.lowercased() {
        case "needs input": return .needsInput
        case "ready for review": return .review
        case "failed": return .failed
        case "working", "running": return .working
        default: break
        }
        if item.kind == "question" { return .needsInput }
        switch item.state {
        case "open", "waiting_on_you": return .needsInput
        case "completed", "done": return .review
        case "failed", "blocked", "cancelled": return .failed
        default: return .working
        }
    }
}

/// One Tasks row, from an attention item or a listed task.
struct TeamsTaskRow: Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let section: TeamsTaskSection
    /// The coloured word: "Ready for review".
    let word: String
    /// What follows it: "branch swarmaa/claude/aa96efb9 · 12 files".
    let detail: String
    let at: Date?
    let threadID: String?
    let branch: String?

    /// Only tasks resolve; questions and swarms close themselves.
    var resolvable: Bool { kind == "task" }

    static func split(_ nextStep: String) -> (word: String, rest: String) {
        guard let r = nextStep.range(of: " · ") else { return (nextStep, "") }
        return (String(nextStep[..<r.lowerBound]), String(nextStep[r.upperBound...]))
    }

    init(_ item: TeamsAttentionItem) {
        let (word, rest) = Self.split(item.nextStep)
        let section = TeamsTaskSection.of(item)
        self.init(id: item.id, kind: item.kind, title: item.title, section: section,
                  word: word.isEmpty ? section.title : word, detail: rest, at: item.at,
                  threadID: item.threadID, branch: item.branch)
    }

    init(_ task: TeamsTask, section: TeamsTaskSection) {
        self.init(id: task.id, kind: "task", title: task.objective, section: section, word: section.title,
                  detail: task.scope.map(SwarmaCells.scopeLabel) ?? "", at: task.updatedAt, threadID: nil, branch: nil)
    }

    init(id: String, kind: String, title: String, section: TeamsTaskSection, word: String, detail: String,
         at: Date?, threadID: String?, branch: String?) {
        self.id = id; self.kind = kind; self.title = title; self.section = section; self.word = word
        self.detail = detail; self.at = at; self.threadID = threadID; self.branch = branch
    }
}

enum TeamsTaskSort: String, CaseIterable { case newest, state }

enum TeamsTaskGrouping {
    /// Attention items first (they carry the service's own line), then the
    /// running and resolved tasks it leaves out. A resolved id always lands in
    /// Resolved, whatever else listed it.
    static func rows(attention: [TeamsAttentionItem], working: [TeamsTask], resolved: [TeamsTask]) -> [TeamsTaskRow] {
        let resolvedIDs = Set(resolved.map(\.id))
        var seen = Set<String>(), rows: [TeamsTaskRow] = []
        for item in attention where !resolvedIDs.contains(item.id) && seen.insert(item.id).inserted { rows.append(TeamsTaskRow(item)) }
        for task in working where seen.insert(task.id).inserted { rows.append(TeamsTaskRow(task, section: .working)) }
        for task in resolved where seen.insert(task.id).inserted { rows.append(TeamsTaskRow(task, section: .resolved)) }
        return rows
    }

    /// Searched and sorted, then split into the five sections (empty ones dropped).
    static func sections(_ rows: [TeamsTaskRow], search: String = "", sort: TeamsTaskSort = .newest)
        -> [(section: TeamsTaskSection, rows: [TeamsTaskRow])] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let hits = rows.filter { q.isEmpty || $0.title.lowercased().contains(q) || $0.detail.lowercased().contains(q) }
        let newest: (TeamsTaskRow, TeamsTaskRow) -> Bool = { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
        let sorted = sort == .newest ? hits.sorted(by: newest)
            : hits.sorted { $0.section != $1.section ? $0.section < $1.section : newest($0, $1) }
        return TeamsTaskSection.allCases.compactMap { s in
            let r = sorted.filter { $0.section == s }
            return r.isEmpty ? nil : (s, r)
        }
    }
}

// MARK: - Setup checklist

struct TeamsSetupRow: Identifiable, Equatable {
    enum State: Equatable { case ready, notChecked, needsSetup }
    let id: String
    let title: String
    var state: State
    /// The one-line fix, shown unless the row is ready.
    var fix: String
}

enum TeamsSetup {
    static let grantCommand = "npm run admin -- grant --name notchtrader --permission answer_questions"

    /// `question_answer` with a made-up id: 404 means the call was allowed
    /// and found nothing; 403 `owner_required` means it was refused.
    static func answerProbe(_ error: Error?) -> TeamsSetupRow.State {
        switch error.map(SwarmaTeamsClient.Failure.map) {
        case .serviceTooOld?: return .ready   // `map` reads every 404 as this
        case .service(.forbidden)?: return .needsSetup
        default: return .notChecked   // success can't happen for a made-up id; anything else proves nothing
        }
    }

    /// The providers routing names, each ready while some live worker serves it.
    static func providerRows(_ status: SwarmaStatus) -> [TeamsSetupRow] {
        let routed = status.routing?.providers.map(\.provider) ?? []
        let names = routed.isEmpty ? Array(Set(status.workers.flatMap(\.providers))).sorted() : routed
        return names.map { p in
            let live = status.workers.contains { $0.live && $0.providers.contains(p) }
            return TeamsSetupRow(id: "provider:" + p, title: L10n.t("\(SwarmaCells.vendorName(p)) has a live worker"),
                                 state: live ? .ready : .needsSetup,
                                 fix: L10n.t("Start a Swarmaa worker that runs \(SwarmaCells.vendorName(p))."))
        }
    }

    /// Runs every probe; each row reads Not checked until its probe proves it.
    static func check(client: SwarmaTeamsClient = .shared, base: SwarmaClient = .shared) async -> [TeamsSetupRow] {
        var reach = TeamsSetupRow(id: "reachable", title: L10n.t("The service is reachable"), state: .notChecked,
                                  fix: L10n.t("Start the Swarmaa service, or check the service URL in Settings → Swarmaa."))
        var token = TeamsSetupRow(id: "token", title: L10n.t("The token is valid"), state: .notChecked,
                                  fix: L10n.t("Choose Change connection… in Settings → Swarmaa to sign in again."))
        var tools = TeamsSetupRow(id: "teams", title: L10n.t("Teams tools exist"), state: .notChecked,
                                  fix: L10n.t("Update the Swarmaa service to use teams"))
        var stream = TeamsSetupRow(id: "stream", title: L10n.t("The live stream connects"), state: .notChecked,
                                   fix: L10n.t("Update the service so it serves /api/stream."))
        var answer = TeamsSetupRow(id: "answer", title: L10n.t("Answering questions is allowed"), state: .notChecked,
                                   fix: L10n.t("Ask the owner to allow answering questions from this Mac: \(grantCommand)"))
        var providers: [TeamsSetupRow] = []

        do {
            let status = try await base.status()
            reach.state = .ready; token.state = .ready
            providers = providerRows(status)
        } catch let failure as SwarmaClient.Failure {
            switch failure {
            case .unauthorized, .noToken: reach.state = .ready; token.state = .needsSetup
            default: reach.state = .needsSetup
            }
        } catch { reach.state = .needsSetup }

        if token.state == .ready {
            do { _ = try await client.agentList(); tools.state = .ready }
            catch { tools.state = SwarmaTeamsClient.Failure.map(error) == .serviceTooOld ? .needsSetup : .notChecked }
        }
        if tools.state == .ready {
            stream.state = await streamConnects(client) ? .ready : .needsSetup
            do {
                try await client.questionAnswer(id: UUID().uuidString.lowercased(), choices: ["probe"], text: nil)
                answer.state = answerProbe(nil)
            } catch { answer.state = answerProbe(error) }
        }
        return [reach, token, tools] + providers + [stream, answer]
    }

    /// The stream's first frame (`event: cursor`) within five seconds.
    private static func streamConnects(_ client: SwarmaTeamsClient) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                do { for try await _ in client.stream() { return true } } catch {}
                return false
            }
            group.addTask { try? await Task.sleep(for: .seconds(5)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }
}
