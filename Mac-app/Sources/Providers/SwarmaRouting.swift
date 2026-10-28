import Foundation

/// Which kind of work a rule may take.
enum RoutingKind: String, CaseIterable, Equatable {
    case review, research, patch
    var title: String {
        switch self {
        case .review: L10n.t("Review")
        case .research: L10n.t("Research")
        case .patch: L10n.t("Edit")
        }
    }
}

/// The routing policy the service keeps: array order is priority. Decoded
/// leniently (older or newer services may omit a field) and encoded with the
/// exact keys `routing_set` documents.
struct RoutingPolicy: Codable, Equatable {
    static let fallbackMostHeadroom = "most_headroom"
    static let fallbackNone = "none"

    struct Rule: Codable, Equatable, Identifiable {
        var provider: String
        var enabled = true
        var maxFiveHourPct = 100
        var maxWeeklyPct = 100
        var kinds: [String] = RoutingKind.allCases.map(\.rawValue)

        var id: String { provider }
        func allows(_ kind: RoutingKind) -> Bool { kinds.contains(kind.rawValue) }

        private enum CodingKeys: String, CodingKey {
            case provider, enabled, kinds
            case maxFiveHourPct = "max_five_hour_pct", maxWeeklyPct = "max_weekly_pct"
        }

        init(provider: String, enabled: Bool = true, maxFiveHourPct: Int = 100, maxWeeklyPct: Int = 100,
             kinds: [String] = RoutingKind.allCases.map(\.rawValue)) {
            self.provider = provider; self.enabled = enabled
            self.maxFiveHourPct = maxFiveHourPct; self.maxWeeklyPct = maxWeeklyPct; self.kinds = kinds
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            provider = try c.decode(String.self, forKey: .provider)
            enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
            maxFiveHourPct = (try? c.decodeIfPresent(Int.self, forKey: .maxFiveHourPct)) ?? 100
            maxWeeklyPct = (try? c.decodeIfPresent(Int.self, forKey: .maxWeeklyPct)) ?? 100
            kinds = ((try? c.decodeIfPresent([String].self, forKey: .kinds)) ?? nil)
                ?? RoutingKind.allCases.map(\.rawValue)
        }
    }

    var providers: [Rule]
    var fallback: String

    init(providers: [Rule], fallback: String = RoutingPolicy.fallbackMostHeadroom) {
        self.providers = providers; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case providers, fallback }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providers = try c.decode([Rule].self, forKey: .providers)
        fallback = (try? c.decodeIfPresent(String.self, forKey: .fallback)) ?? Self.fallbackMostHeadroom
    }

    /// "Reset to defaults" when the service doesn't send its `default_policy`
    /// (older services). Mirrors the service's built-in default.
    static let standard = RoutingPolicy(providers: [
        Rule(provider: "claude", maxFiveHourPct: 90, maxWeeklyPct: 90),
        Rule(provider: "codex", maxFiveHourPct: 95, maxWeeklyPct: 95),
        Rule(provider: "antigravity", maxFiveHourPct: 95, maxWeeklyPct: 95, kinds: [RoutingKind.review.rawValue, RoutingKind.patch.rawValue]),
    ])

    /// The exact `routing_set` arguments.
    func requestBody() throws -> Data {
        try JSONSerialization.data(withJSONObject: ["policy": JSONSerialization.jsonObject(with: JSONEncoder().encode(self))])
    }

    // MARK: Editing

    mutating func move(fromOffsets: IndexSet, toOffset: Int) {
        providers.move(fromOffsets: fromOffsets, toOffset: toOffset)
    }

    /// Up/Down buttons: swap with the neighbour; no-op at the ends.
    mutating func move(_ index: Int, by step: Int) {
        let target = index + step
        guard providers.indices.contains(index), providers.indices.contains(target) else { return }
        providers.swapAt(index, target)
    }

    /// Why this policy can't be saved, or nil. The service enforces the same
    /// rule; checking here saves a round trip and explains it in place.
    var problem: String? {
        for kind in RoutingKind.allCases
        where !providers.contains(where: { $0.enabled && $0.allows(kind) }) {
            return L10n.t("Turn on at least one service for \(kind.title.lowercased()) tasks.")
        }
        return nil
    }
}

struct RoutingGetResult: Decodable, Equatable {
    let policy: RoutingPolicy
    let isDefault: Bool
    let updatedAt: Date?
    /// The service's built-in default, used by "Reset to defaults" when present.
    let defaultPolicy: RoutingPolicy?
    private enum CodingKeys: String, CodingKey { case policy, isDefault = "is_default", updatedAt = "updated_at", defaultPolicy = "default_policy" }
    init(policy: RoutingPolicy, isDefault: Bool = false, updatedAt: Date? = nil, defaultPolicy: RoutingPolicy? = nil) {
        self.policy = policy; self.isDefault = isDefault; self.updatedAt = updatedAt; self.defaultPolicy = defaultPolicy
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        policy = try c.decode(RoutingPolicy.self, forKey: .policy)
        isDefault = (try? c.decodeIfPresent(Bool.self, forKey: .isDefault)) ?? false
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? nil
        defaultPolicy = (try? c.decodeIfPresent(RoutingPolicy.self, forKey: .defaultPolicy)) ?? nil
    }
}

struct RoutingSetResult: Decodable, Equatable {
    let policy: RoutingPolicy
    let updatedAt: Date?
    private enum CodingKeys: String, CodingKey { case policy, updatedAt = "updated_at" }
    init(policy: RoutingPolicy, updatedAt: Date? = nil) { self.policy = policy; self.updatedAt = updatedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        policy = try c.decode(RoutingPolicy.self, forKey: .policy)
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? nil
    }
}

enum RoutingWindow {
    case fiveHour, weekly
    var wireName: String { self == .fiveHour ? "5h" : "weekly" }
}

extension SwarmaStatus {
    /// How much of `provider`'s window is used, 0...100, for the marker on the
    /// slider. Nil when the service didn't report it (marker hidden).
    func usedPercent(provider: String, window: RoutingWindow) -> Double? {
        guard let usage = usage.first(where: { $0.provider.lowercased() == provider }),
              let value = usage.windows.first(where: { $0.name?.lowercased() == window.wireName })?.usedPercent
        else { return nil }
        return min(100, max(0, value))
    }
}
