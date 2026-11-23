import Foundation
import Speech

/// On-device transcription of a Watch or ring memo file.
enum MemoTranscriber {
    /// Ask once in the foreground so background ring memos can be transcribed.
    static func requestAccess() { SFSpeechRecognizer.requestAuthorization { _ in } }

    /// Always yields a string; failures and missing permission give "".
    static func transcribe(_ url: URL) async -> String { await transcribe(url, timeout: nil) ?? "" }

    /// "" on failure or missing permission; nil when `timeout` seconds pass first. On timeout the recognition
    /// task is cancelled, so a late answer can't keep the recognizer busy for the next memo.
    static func transcribe(_ url: URL, timeout: Double?) async -> String? {
        let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard status == .authorized, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return "" }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        let run = FileRecognition()
        let text: String? = await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            run.start(c)
            let task = recognizer.recognitionTask(with: request) { result, error in
                guard result?.isFinal == true || error != nil else { return }
                run.finish(result?.bestTranscription.formattedString ?? "")
            }
            run.keep(task)
            if let timeout {
                run.arm(Task {
                    try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                    if !Task.isCancelled { run.expire() }
                })
            }
        }
        return text.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8000)) }
    }
}

/// One file recognition: resumes its continuation exactly once (answer or timeout) and keeps the task to cancel it.
/// Speech calls back on its own queue, so state is guarded by a lock.
private final class FileRecognition: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String?, Never>?
    private var task: SFSpeechRecognitionTask?
    private var done = false
    private var timerTask: Task<Void, Never>?

    func start(_ c: CheckedContinuation<String?, Never>) { lock.withLock { continuation = c } }
    func keep(_ t: SFSpeechRecognitionTask) { lock.withLock { if !done { task = t } } }
    func arm(_ timer: Task<Void, Never>) {
        let finished = lock.withLock { () -> Bool in if !done { timerTask = timer }; return done }
        if finished { timer.cancel() }
    }
    func finish(_ text: String) {
        let (c, timer) = lock.withLock { () -> (CheckedContinuation<String?, Never>?, Task<Void, Never>?) in
            guard !done else { return (nil, nil) }
            done = true; task = nil
            defer { continuation = nil; timerTask = nil }
            return (continuation, timerTask)
        }
        timer?.cancel()
        c?.resume(returning: text)
    }
    func expire() {
        let (c, t) = lock.withLock { () -> (CheckedContinuation<String?, Never>?, SFSpeechRecognitionTask?) in
            guard !done else { return (nil, nil) }
            done = true
            defer { continuation = nil; task = nil; timerTask = nil }
            return (continuation, task)
        }
        t?.cancel()
        c?.resume(returning: nil)
    }
}
