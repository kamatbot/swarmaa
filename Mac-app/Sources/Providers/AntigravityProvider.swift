import Foundation
import os

/// Gemini, as Antigravity sees it.
///
/// Swarmaa does not scrape Antigravity OAuth tokens, spoof Antigravity client
/// headers against Google's private Cloud Code endpoints, read third-party
/// SQLite caches, or spawn Antigravity's private `language_server` binary.
///
/// Instead, this provider reports honest local activity derived from
/// Antigravity's own on-disk transcripts as a count (never a fabricated
/// percentage or synthetic 0% ring).
actor AntigravityProvider: UsageProvider {
    nonisolated let profile: AntigravityProfile
    nonisolated let id: String
    // The id stays `gemini` for the default profile: it keys the archive and the
    // user's connection choice, and changing it would silently discard both.
    nonisolated let displayName: String
    nonisolated let glyph = ProviderGlyph.antigravity

    private let activityRootsOverride: [URL]?

    init(profile: AntigravityProfile = .default(),
         activityRoots: [URL]? = nil) {
        self.profile = profile
        self.id = profile.id
        self.displayName = profile.displayName
        self.activityRootsOverride = activityRoots
    }

    nonisolated var signInRoute: SignInRoute {
        profile.signInRoute
    }

    /// Reached only from "Allow access…", clearing any recorded refusal.
    nonisolated func forgetCachedCredential() {
        AntigravityCredentials.forgetCached(for: profile)
        AntigravityCredentials.askAgain(for: profile)
    }

    nonisolated func account() -> ProviderAccount? {
        guard AntigravityCredentials.isSignedIn(for: profile) else { return nil }
        return ProviderAccount(
            label: nil,
            plan: L10n.t("Local"),
            source: profile.sourceName,
            manageURL: URL(string: "https://antigravity.google")
        )
    }

    func fetchSnapshot() async throws -> ProviderSnapshot {
        let roots = activityRootsOverride
            ?? (profile.slug == nil ? AntigravityActivity.transcriptRoots : [profile.brainDirectory])

        let activity = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(returning: AntigravityActivity.read(roots: roots))
            }
        }

        return ProviderSnapshot(
            id: id,
            displayName: displayName,
            glyph: glyph,
            // Ours, not Google's. The tooltip prefixes a `~` on the strength of
            // this, which is exactly the claim being made.
            fidelity: .derived,
            status: .ok,
            windows: [
                LimitWindow(id: "requests",
                            label: activity.label(),
                            used: activity.requestsToday)
            ],
            headlineID: "requests"
        )
    }

    /// Windows of the chosen model group. Gemini 4 Argon ("gemini-argon-…") is a separate
    /// quota group, so it must not stand in for the shared Gemini limit.
    private nonisolated func windows(_ windows: [LimitWindow], of model: AntigravityHeadlineModel) -> [LimitWindow] {
        windows.filter { $0.id.hasPrefix(model.rawValue) && !$0.id.hasPrefix("gemini-argon") }
    }

    nonisolated func resolveHeadlineID(
        for windows: [LimitWindow],
        preferredLimit: AntigravityHeadlineLimit = Preferences.storedAntigravityHeadlineLimit(),
        preferredModel: AntigravityHeadlineModel = Preferences.storedAntigravityHeadlineModel()
    ) -> String {
        let modelCandidates = self.windows(windows, of: preferredModel)
        let candidates = modelCandidates.isEmpty ? windows : modelCandidates

        if preferredLimit != .automatic {
            let limitCandidates = candidates.filter { matches($0, cadence: preferredLimit) }
            if let mostConstrained = limitCandidates.max(by: constrainedBefore) {
                return mostConstrained.id
            }
        }

        // An exhausted lane does not displace a usable lane unless every lane is exhausted.
        let fractional = candidates.filter { $0.usedFraction != nil }
        let usable = fractional.filter { ($0.usedFraction ?? 0) < 1 }
        return (usable.isEmpty ? fractional : usable).max(by: constrainedBefore)?.id
            ?? candidates.first?.id
            ?? "\(preferredModel.rawValue)-hourly"
    }

    private nonisolated func matches(_ window: LimitWindow, cadence: AntigravityHeadlineLimit) -> Bool {
        let value = "\(window.id) \(window.label)".lowercased()
        switch cadence {
        case .fiveHour:
            return window.duration == 5 * 3600 ||
                ["5h", "5-hour", "five hour", "five-hour", "hourly", "session"]
                    .contains(where: { value.contains($0) })
        case .weekly:
            return window.duration == 7 * 86400 || value.contains("weekly")
        case .automatic:
            return true
        }
    }

    private nonisolated func constrainedBefore(_ lhs: LimitWindow, _ rhs: LimitWindow) -> Bool {
        let left = lhs.usedFraction ?? 0
        let right = rhs.usedFraction ?? 0
        if left != right { return left < right }
        return lhs.id > rhs.id
    }

    nonisolated func resolveWeeklyID(
        for windows: [LimitWindow],
        preferredModel: AntigravityHeadlineModel = Preferences.storedAntigravityHeadlineModel()
    ) -> String? {
        let modelCandidates = self.windows(windows, of: preferredModel)
        let candidates = modelCandidates.isEmpty ? windows : modelCandidates
        let weekly = candidates.filter { window in
            window.duration == 7 * 86400 ||
                window.id.lowercased().hasSuffix("-weekly") ||
                window.label.lowercased().contains("weekly")
        }
        return weekly.max(by: constrainedBefore)?.id
    }

    /// Normalizes a quota summary payload into standard limit windows.
    nonisolated static func windows(in data: Data, now: Date = Date()) -> [LimitWindow] {
        AntigravityQuotaParser.parse(data, now: now)
    }
}
