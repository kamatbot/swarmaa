import Foundation

/// A lesson the service drafted from finished chats, waiting for a person.
/// Decoded leniently: the service moves faster than this app. Every string in
/// it is untrusted text and is only ever shown as plain text.
struct SwarmaLesson: Decodable, Equatable, Identifiable {
    enum Action: String { case approve, reject }

    struct Evidence: Decodable, Equatable {
        let sessionId: String
        let turns: [Int]
        let summary: String
        private enum CodingKeys: String, CodingKey { case sessionId = "session_id", turns, summary }
        init(sessionId: String, turns: [Int], summary: String) {
            self.sessionId = sessionId; self.turns = turns; self.summary = summary
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
            turns = ((try? c.decodeIfPresent([Int].self, forKey: .turns)) ?? nil) ?? []
            summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        }
    }

    /// Fields of a lesson a reviewer may change. Nil means untouched and is
    /// left off the wire.
    struct Edits: Equatable, Encodable {
        var title: String?
        var applicability: String?
        var body: String?
        var kind: String?
        var tags: [String]?

        var isEmpty: Bool { title == nil && applicability == nil && body == nil && kind == nil && tags == nil }

        func json() throws -> Any {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(self))
        }
    }

    struct List: Decodable { let lessons: [SwarmaLesson] }
    struct Reviewed: Decodable { let lesson: SwarmaLesson }

    let id: String
    let scope: String
    let kind: String
    let title: String
    let applicability: String
    let body: String
    let tags: [String]
    let evidence: [Evidence]
    let state: String
    let source: String
    let flags: [String]
    let createdAt: Date?
    let reviewedAt: Date?
    let reviewReason: String?
    let supersededBy: String?

    private enum CodingKeys: String, CodingKey {
        case id, scope, kind, title, applicability, body, tags, evidence, state, source, flags
        case createdAt = "created_at", reviewedAt = "reviewed_at"
        case reviewReason = "review_reason", supersededBy = "superseded_by"
    }

    init(id: String, scope: String = "global", kind: String = "gotcha", title: String = "",
         applicability: String = "", body: String = "", tags: [String] = [], evidence: [Evidence] = [],
         state: String = "candidate", source: String = "distill", flags: [String] = []) {
        self.id = id; self.scope = scope; self.kind = kind; self.title = title
        self.applicability = applicability; self.body = body; self.tags = tags
        self.evidence = evidence; self.state = state; self.source = source; self.flags = flags
        createdAt = nil; reviewedAt = nil; reviewReason = nil; supersededBy = nil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        func text(_ key: CodingKeys, _ fallback: String = "") throws -> String {
            try c.decodeIfPresent(String.self, forKey: key) ?? fallback
        }
        scope = try text(.scope, "global")
        kind = try text(.kind, "gotcha")
        title = try text(.title)
        applicability = try text(.applicability)
        body = try text(.body)
        state = try text(.state, "candidate")
        source = try text(.source)
        tags = ((try? c.decodeIfPresent([String].self, forKey: .tags)) ?? nil) ?? []
        flags = ((try? c.decodeIfPresent([String].self, forKey: .flags)) ?? nil) ?? []
        evidence = ((try? c.decodeIfPresent([Evidence].self, forKey: .evidence)) ?? nil) ?? []
        createdAt = (try? c.decodeIfPresent(Date.self, forKey: .createdAt)) ?? nil
        reviewedAt = (try? c.decodeIfPresent(Date.self, forKey: .reviewedAt)) ?? nil
        reviewReason = try c.decodeIfPresent(String.self, forKey: .reviewReason)
        supersededBy = try c.decodeIfPresent(String.self, forKey: .supersededBy)
    }

    var scopeLabel: String { SwarmaCells.scopeLabel(scope) }

    /// The words a flag is shown under. Prompt-injection flags get the
    /// loud wording; anything else is shown as the service named it.
    static func warning(forFlag flag: String) -> String {
        flag.lowercased().hasPrefix("prompt-injection")
            ? L10n.t("Possible prompt injection — read carefully") + " (\(flag))"
            : flag
    }
}

/// `session_get`: just enough to show the turns a lesson cites.
struct SwarmaSessionDetail: Decodable, Equatable {
    struct Turn: Decodable, Equatable {
        let role: String
        let text: String
        private enum CodingKeys: String, CodingKey { case role, text }
        init(role: String, text: String) { self.role = role; self.text = text }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
            text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        }
    }
    struct Wrapper: Decodable { let session: SwarmaSessionDetail }

    let id: String
    let harness: String
    let title: String
    let scope: String?
    let turns: [Turn]

    private enum CodingKeys: String, CodingKey { case id, harness, title, scope, turns }
    init(id: String, harness: String = "other", title: String = "", scope: String? = nil, turns: [Turn] = []) {
        self.id = id; self.harness = harness; self.title = title; self.scope = scope; self.turns = turns
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        harness = try c.decodeIfPresent(String.self, forKey: .harness) ?? "other"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        scope = try c.decodeIfPresent(String.self, forKey: .scope)
        turns = ((try? c.decodeIfPresent([Turn].self, forKey: .turns)) ?? nil) ?? []
    }

    /// The cited turns, in citation order. Lessons cite turns 1-based (as the
    /// distill prompt numbers them); `index` stays that 1-based number for display.
    /// A number out of range is skipped.
    func cited(_ cited: [Int]) -> [(index: Int, turn: Turn)] {
        cited.compactMap { turns.indices.contains($0 - 1) ? ($0, turns[$0 - 1]) : nil }
    }
}
