import AppIntents

/// Opens Swarmaa on the Watch and starts a memo for the Assistant. Shared by the Watch app (Siri, Shortcuts)
/// and its widget extension (the Control Center button); the system runs it in the app because it opens the app.
struct RecordVoiceMemoIntent: AppIntent {
    static let title: LocalizedStringResource = "Record a memo"
    static let description = IntentDescription("Opens Swarmaa and starts recording a voice memo for your Assistant.")
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult { RecordMemoAction.run(); return .result() }
}
