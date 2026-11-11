import Foundation

/// The live readings the menu bar and the phone draw from: the store's
/// snapshots in display order, decorated with what each local runtime says
/// about its models, plus every agent's live sessions.
@MainActor
final class UsageBoard {
    nonisolated init() {}

    private(set) var snapshots: [ProviderSnapshot] = []
    /// Live agent sessions, keyed by the provider they belong to.
    private(set) var sessions: [String: [AgentSession]] = [:]
    private(set) var thinkingModels: [String: Date] = [:]
    /// Per source: the Ollama relay and each runtime's metrics replace their
    /// own readings wholesale, and a second runtime reporting must not erase
    /// the first one's.
    private var performances: [String: [String: LocalModelPerformance]] = [:]
    private var localActivities: [String: [String: LocalModelActivity]] = [:]
    private var ledgers: [String: LocalTokenLedger] = [:]
    private var localMetricsEnabled = false

    /// The Ollama relay's own id; its readings are keyed by model name.
    static let ollamaSource = "ollama-local"

    func setLocalMetricsEnabled(_ enabled: Bool) {
        localMetricsEnabled = enabled
        if !enabled { performances[Self.ollamaSource] = nil; thinkingModels = [:] }
        redecorate()
    }

    func setSnapshots(_ providerSnapshots: [ProviderSnapshot]) {
        snapshots = ProviderOrder.cells(from: providerSnapshots, keeping: snapshots).map(decorated)
    }

    func setThinkingModels(_ thinking: [String: Date]) { thinkingModels = thinking }

    func setPerformances(_ measurements: [String: LocalModelPerformance],
                         source: String = UsageBoard.ollamaSource) {
        performances[source] = measurements
        redecorate()
    }

    func setLocalActivities(_ activities: [String: LocalModelActivity],
                            source: String = LMStudioMetrics.providerID) {
        localActivities[source] = activities
    }

    /// Logged tokens per cell, read against now so "today" rolls over at midnight.
    func setLedger(_ ledger: LocalTokenLedger, source: String = LMStudioMetrics.providerID) {
        ledgers[source] = ledger
        redecorate()
    }

    func setSessions(providerID id: String, sessions live: [AgentSession]) {
        sessions[id] = live
    }

    private func redecorate() { snapshots = snapshots.map(decorated) }

    private func decorated(_ snapshot: ProviderSnapshot) -> ProviderSnapshot {
        guard let model = snapshot.localModel else { return snapshot }
        var snapshot = snapshot
        let shows = localMetricsEnabled || snapshot.localRuntimeMeasuresSpeed
        snapshot.showsLocalPerformance = shows
        snapshot.localPerformance = shows
            ? performances[snapshot.providerID]?[Self.performanceKey(for: snapshot, model: model)] : nil
        snapshot.localLedger = ledgers[snapshot.providerID]?.summary(for: snapshot.id, now: Date())
        snapshot.localContextFraction = snapshot.localLedger?.contextFraction(contextLength: model.contextLength)
        return snapshot
    }

    /// Ollama's relay knows a model by the name a client used, with Ollama's
    /// implicit `:latest`; everything else reports by cell id.
    static func performanceKey(for snapshot: ProviderSnapshot, model: LocalRuntimeReading.Model) -> String {
        snapshot.providerID == ollamaSource ? OllamaThinkingStream.modelKey(model.name) : snapshot.id
    }

    /// Cell ids carry their provider's prefix, so a plain union never lets one
    /// runtime's model shadow another's.
    private var mergedLocalActivities: [String: LocalModelActivity] {
        localActivities.values.reduce(into: [:]) { merged, activities in
            merged.merge(activities) { current, _ in current }
        }
    }

    /// A provider with no activity source gets none, rather than borrowing
    /// somebody else's.
    func activity(for snapshot: ProviderSnapshot) -> ActivitySummary? {
        guard let model = snapshot.localModel else { return activity(for: snapshot.providerID) }
        if let local = mergedLocalActivities[snapshot.id] {
            return ActivitySummary(sessions: [AgentSession(id: snapshot.id, name: local.label,
                detail: snapshot.displayName, state: .busy, waitingFor: nil, since: local.since)],
                queued: local.queued, note: local.note)
        }
        guard let since = thinkingModels[OllamaThinkingStream.modelKey(model.name)] else { return nil }
        return ActivitySummary(sessions: [AgentSession(id: snapshot.id, name: L10n.t("Thinking"),
            detail: snapshot.displayName, state: .busy, waitingFor: nil, since: since)])
    }

    func activity(for providerID: String) -> ActivitySummary? {
        ActivitySummary(sessions: sessions[providerID] ?? [])
    }
}
