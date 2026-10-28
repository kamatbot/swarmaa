import Foundation

/// What the review window needs from the service. `SwarmaClient` is the real
/// one; tests pass a stub.
protocol LessonService: Sendable {
    func lessons(limit: Int) async throws -> [SwarmaLesson]
    func review(id: String, action: SwarmaLesson.Action, reason: String?,
                edits: SwarmaLesson.Edits?) async throws -> SwarmaLesson
    func session(id: String) async throws -> SwarmaSessionDetail
}

extension SwarmaClient: LessonService {}

@MainActor
final class LessonReviewModel: ObservableObject {
    enum Evidence: Equatable {
        case loading
        case loaded(SwarmaSessionDetail)
        case failed(String)
    }

    @Published private(set) var lessons: [SwarmaLesson] = []
    @Published var selectedID: String? { didSet { if selectedID != oldValue { resetDraft() } } }
    @Published private(set) var isLoading = false
    @Published private(set) var isBusy = false
    /// A line for the window; nil when all is well.
    @Published private(set) var message: String?
    @Published var isEditing = false
    @Published var title = ""
    @Published var applicability = ""
    @Published var body = ""
    @Published private(set) var evidence: [String: Evidence] = [:]

    private let service: LessonService
    private let onChanged: () -> Void

    /// `onChanged` runs after a review went through, so the notch count follows.
    init(service: LessonService, onChanged: @escaping () -> Void = {}) {
        self.service = service
        self.onChanged = onChanged
    }

    var selected: SwarmaLesson? { lessons.first { $0.id == selectedID } }

    /// What the reviewer changed; nil where the draft matches the lesson.
    var edits: SwarmaLesson.Edits? {
        guard isEditing, let lesson = selected else { return nil }
        let edits = SwarmaLesson.Edits(title: title == lesson.title ? nil : title,
                                       applicability: applicability == lesson.applicability ? nil : applicability,
                                       body: body == lesson.body ? nil : body)
        return edits.isEmpty ? nil : edits
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let fetched = try await service.lessons(limit: 50)
            lessons = fetched
            message = nil
            if selected == nil { selectedID = fetched.first?.id } else if !isEditing { resetDraft() }
        } catch {
            message = Self.describe(error)
        }
    }

    func approve() async { await review(.approve, reason: nil) }
    func reject(reason: String) async { await review(.reject, reason: reason) }

    private func review(_ action: SwarmaLesson.Action, reason: String?) async {
        guard let lesson = selected, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            // Edits ride along with an approval only; a rejected draft is gone anyway.
            _ = try await service.review(id: lesson.id, action: action, reason: reason,
                                         edits: action == .approve ? edits : nil)
            message = nil
            if let index = lessons.firstIndex(where: { $0.id == lesson.id }) {
                lessons.remove(at: index)
                selectedID = lessons.indices.contains(index) ? lessons[index].id : lessons.last?.id
            }
            onChanged()
            await refresh()
        } catch {
            message = Self.describe(error)
        }
    }

    func loadEvidence(sessionID: String) async {
        guard !sessionID.isEmpty else { return }
        if case .loaded = evidence[sessionID] { return }
        evidence[sessionID] = .loading
        do {
            evidence[sessionID] = .loaded(try await service.session(id: sessionID))
        } catch {
            evidence[sessionID] = .failed(Self.describe(error))
        }
    }

    nonisolated static func describe(_ error: Error) -> String {
        (error as? SwarmaClient.Failure)?.message ?? SwarmaClient.Failure.unreachable.message
    }

    private func resetDraft() {
        isEditing = false
        title = selected?.title ?? ""
        applicability = selected?.applicability ?? ""
        body = selected?.body ?? ""
    }
}
