import Foundation

private extension KeyedDecodingContainer {
    func opt<T: Decodable>(_ type: T.Type, _ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
    func list<T: Decodable>(_ key: Key) -> [T] { opt([T].self, key) ?? [] }
}

/// A bot: a persistent, configured swarm (docs/BOTS.md). One thread, a crew
/// led by one agent, and routing and rules that apply to every task it starts.
struct TeamsBot: Decodable, Equatable, Identifiable {
    struct Badges: Decodable, Equatable {
        struct Latest: Decodable, Equatable {
            var kind: String?
            var line: String
            var at: Date?
        }
        var unread = 0
        var needsYou = 0
        var latest: Latest?
        private enum CodingKeys: String, CodingKey { case unread, latest, needsYou = "needs_you" }
        init(unread: Int = 0, needsYou: Int = 0, latest: Latest? = nil) { self.unread = unread; self.needsYou = needsYou; self.latest = latest }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            unread = c.opt(Int.self, .unread) ?? 0; needsYou = c.opt(Int.self, .needsYou) ?? 0
            latest = c.opt(Latest.self, .latest)
        }
    }

    let id: String
    var scope: String
    var name: String
    var job: String
    var avatar: String?
    var threadID: String
    var leadAgentID: String
    var memberAgentIDs: [String]
    var routing: TeamsBotRouting
    var rules: TeamsBotRules
    var schedule: String?
    var archived: Bool
    var version: Int?
    var updatedAt: Date?
    var badges: Badges
    var routingNow: [String: TeamsRoutingNow]
    /// Synthesised from a lone agent while the service has no bots yet.
    var isLegacyAgent = false

    var hasUpdates: Bool { badges.needsYou > 0 || badges.unread > 0 }
    var crewIDs: [String] { [leadAgentID] + memberAgentIDs.filter { $0 != leadAgentID } }

    private enum CodingKeys: String, CodingKey {
        case id, scope, name, job, avatar, routing, rules, schedule, archived, version, badges
        case threadID = "thread_id", leadAgentID = "lead_agent_id", memberAgentIDs = "member_agent_ids"
        case updatedAt = "updated_at", routingNow = "routing_now"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scope = c.opt(String.self, .scope) ?? ""
        name = c.opt(String.self, .name) ?? ""
        job = c.opt(String.self, .job) ?? ""
        avatar = c.opt(String.self, .avatar)
        threadID = try c.decode(String.self, forKey: .threadID)
        leadAgentID = c.opt(String.self, .leadAgentID) ?? ""
        memberAgentIDs = c.list(.memberAgentIDs)
        routing = c.opt(TeamsBotRouting.self, .routing) ?? TeamsBotRouting()
        rules = c.opt(TeamsBotRules.self, .rules) ?? TeamsBotRules()
        schedule = c.opt(String.self, .schedule)
        archived = c.opt(Bool.self, .archived) ?? false
        version = c.opt(Int.self, .version)
        updatedAt = c.opt(Date.self, .updatedAt)
        badges = c.opt(Badges.self, .badges) ?? Badges()
        routingNow = c.opt([String: TeamsRoutingNow].self, .routingNow) ?? [:]
    }

    /// A service without bots: each agent stands in as a one-member bot on its main thread.
    init(legacy agent: TeamsAgent, unread: Int, preview: TeamsPreview?) {
        id = "agent:" + agent.id
        scope = agent.scope ?? ""
        name = agent.name
        job = agent.instructions ?? ""
        avatar = agent.avatar
        threadID = agent.mainThreadID ?? ""
        leadAgentID = agent.id
        memberAgentIDs = []
        routing = TeamsBotRouting(summary: agent.runner)
        rules = TeamsBotRules()
        schedule = nil
        archived = agent.archived
        version = agent.version
        updatedAt = preview?.createdAt
        badges = Badges(unread: unread, needsYou: agent.status == "waiting_on_you" ? 1 : 0,
                        latest: preview.map { Badges.Latest(kind: nil, line: $0.body ?? "", at: $0.createdAt) })
        routingNow = [:]
        isLegacyAgent = true
    }
}

/// Per-kind runners. `nil` means auto. Review may also be "a different service than the author".
struct TeamsBotRouting: Codable, Equatable {
    enum Kind: String, CaseIterable, Identifiable {
        case research, patch, review, summary
        var id: String { rawValue }
        var title: String {
            switch self {
            case .research: return L10n.t("Research and reading")
            case .patch: return L10n.t("Edits")
            case .review: return L10n.t("Reviews")
            case .summary: return L10n.t("Summaries and chat")
            }
        }
        var detail: String {
            switch self {
            case .research: return L10n.t("Briefs, web, the codebase")
            case .patch: return L10n.t("Code and asset changes, in a branch")
            case .review: return L10n.t("Checks every edit before it reaches you")
            case .summary: return L10n.t("The lead's replies to you")
            }
        }
    }

    var research: TeamsRunner?
    var patch: TeamsRunner?
    var review: TeamsRunner?
    var reviewDifferentFromAuthor = true
    var summary: TeamsRunner?

    init(research: TeamsRunner? = nil, patch: TeamsRunner? = nil, review: TeamsRunner? = nil,
         reviewDifferentFromAuthor: Bool = true, summary: TeamsRunner? = nil) {
        self.research = research; self.patch = patch; self.review = review
        self.reviewDifferentFromAuthor = reviewDifferentFromAuthor; self.summary = summary
    }

    subscript(kind: Kind) -> TeamsRunner? {
        get { switch kind { case .research: research; case .patch: patch; case .review: review; case .summary: summary } }
        set { switch kind { case .research: research = newValue; case .patch: patch = newValue; case .review: review = newValue; case .summary: summary = newValue } }
    }

    private struct Key: CodingKey {
        var stringValue: String; var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        func runner(_ k: String) -> TeamsRunner? {
            guard let r = try? c.decodeIfPresent(TeamsRunner.self, forKey: Key(k)), !r.isAuto else { return nil }
            return r
        }
        research = runner("research"); patch = runner("patch"); summary = runner("summary")
        struct Mode: Decodable { let mode: String? }
        let mode = (try? c.decodeIfPresent(Mode.self, forKey: Key("review")))??.mode
        review = runner("review")
        reviewDifferentFromAuthor = review == nil && (mode == nil || mode == "different_from_author")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        for kind in Kind.allCases {
            if kind == .review, self[kind] == nil {
                try c.encode(["mode": reviewDifferentFromAuthor ? "different_from_author" : "auto"], forKey: Key("review"))
            } else {
                try c.encode(self[kind] ?? .auto, forKey: Key(kind.rawValue))
            }
        }
    }
}

struct TeamsBotRules: Codable, Equatable {
    var quotaFloorPct = 0
    var approvePublic = true
    var reviewEdits = true
    var requireTests = false
    private enum CodingKeys: String, CodingKey {
        case quotaFloorPct = "quota_floor_pct", approvePublic = "approve_public"
        case reviewEdits = "review_edits", requireTests = "require_tests"
    }
    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        quotaFloorPct = c.opt(Int.self, .quotaFloorPct) ?? 0
        approvePublic = c.opt(Bool.self, .approvePublic) ?? true
        reviewEdits = c.opt(Bool.self, .reviewEdits) ?? true
        requireTests = c.opt(Bool.self, .requireTests) ?? false
    }
}

/// `routing_now[kind]`: what the router would pick right now, and why.
struct TeamsRoutingNow: Decodable, Equatable {
    var providerNow: String?
    var reason: String?
    private enum CodingKeys: String, CodingKey { case reason, providerNow = "provider_now" }
    init(providerNow: String?, reason: String?) { self.providerNow = providerNow; self.reason = reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providerNow = c.opt(String.self, .providerNow); reason = c.opt(String.self, .reason)
    }
}

/// The `task` embedded on a `kind: "task"` message in a bot thread.
struct TeamsTaskCard: Decodable, Equatable {
    struct Failure: Decodable, Equatable { var code: String?; var detail: String? }
    struct Check: Decodable, Equatable { var status: String? }
    struct Served: Decodable, Equatable { var provider: String?; var model: String? }
    var id: String
    var title: String?
    var kind: String?
    var status: String?
    var resolved: Bool
    var branch: String?
    var changedFiles: Int?
    var served: Served?
    var failure: Failure?
    var check: Check?
    private enum CodingKeys: String, CodingKey {
        case id, title, kind, status, resolved, branch, served, failure, check
        case changedFiles = "changed_files"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.opt(String.self, .title); kind = c.opt(String.self, .kind); status = c.opt(String.self, .status)
        resolved = c.opt(Bool.self, .resolved) ?? false
        branch = c.opt(String.self, .branch); changedFiles = c.opt(Int.self, .changedFiles)
        served = c.opt(Served.self, .served); failure = c.opt(Failure.self, .failure); check = c.opt(Check.self, .check)
    }

    var isFailed: Bool { status == "failed" || check?.status == "failed" }
    var readyForReview: Bool { status == "completed" && branch != nil && !resolved && check?.status != "failed" }
}
