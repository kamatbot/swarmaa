import Foundation

/// What the Routing editor needs from the service; `SwarmaClient` is the real
/// one, tests pass a stub.
protocol RoutingService: Sendable {
    func routingGet() async throws -> RoutingGetResult
    func routingSet(_ policy: RoutingPolicy) async throws -> RoutingSetResult
    func status() async throws -> SwarmaStatus
}

extension SwarmaClient: RoutingService {}

@MainActor
final class RoutingEditorModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        /// The connection can read routing but not change it.
        case readOnly
        /// The service isn't reachable (or answered with something unusable).
        case offline(String)
        /// An older service without `routing_get`.
        case unsupported
    }

    @Published private(set) var phase: Phase = .loading
    @Published var draft = RoutingPolicy.standard
    @Published private(set) var saved = RoutingPolicy.standard
    @Published private(set) var isDefault = false
    @Published private(set) var status: SwarmaStatus?
    @Published private(set) var isSaving = false
    /// A line under the footer for a failed save; nil when all is well.
    @Published private(set) var message: String?

    private let service: RoutingService

    init(service: RoutingService) { self.service = service }

    static var forbiddenMessage: String { L10n.t("This Mac's Swarmaa connection can't change routing") }

    var isDirty: Bool { draft != saved }
    var canEdit: Bool { phase == .ready }
    var validationProblem: String? { draft.problem }
    var canSave: Bool { canEdit && isDirty && validationProblem == nil && !isSaving }

    func load() async {
        do {
            let result = try await service.routingGet()
            serviceDefault = result.defaultPolicy
            saved = result.policy
            draft = result.policy
            isDefault = result.isDefault
            phase = .ready
            message = nil
        } catch {
            phase = Self.phase(for: error)
        }
        await refreshStatus()
    }

    /// The preview strip; a failure leaves the last answer on screen.
    func refreshStatus() async {
        if let fresh = try? await service.status() { status = fresh }
    }

    func save() async {
        guard canSave else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let result = try await service.routingSet(draft)
            saved = result.policy
            draft = result.policy
            isDefault = false
            message = nil
            await refreshStatus()
        } catch SwarmaClient.Failure.forbidden {
            phase = .readOnly
            message = Self.forbiddenMessage
        } catch {
            message = Self.describe(error)
        }
    }

    /// The service's own default policy, when it reports one.
    private(set) var serviceDefault: RoutingPolicy?

    func resetToDefaults() {
        guard canEdit else { return }
        draft = serviceDefault ?? .standard
        message = nil
    }

    // MARK: Preview strip

    /// "Next review → Claude · 5-hour 42% used". Nil provider is "nobody".
    func preview(_ kind: RoutingKind) -> (provider: String?, reason: String)? {
        guard let choice = status?.routing?.byKind[kind.rawValue] else { return nil }
        return (choice.provider, choice.reason)
    }

    // MARK: Slider markers

    func usedPercent(_ provider: String, _ window: RoutingWindow) -> Double? {
        status?.usedPercent(provider: provider, window: window)
    }

    nonisolated static func phase(for error: Error) -> Phase {
        switch error as? SwarmaClient.Failure {
        case .forbidden: return .readOnly
        case .http(404), .badResponse: return .unsupported
        case let failure?: return .offline(failure.message)
        case nil: return .offline(SwarmaClient.Failure.unreachable.message)
        }
    }

    nonisolated static func describe(_ error: Error) -> String {
        (error as? SwarmaClient.Failure)?.message ?? SwarmaClient.Failure.unreachable.message
    }
}
