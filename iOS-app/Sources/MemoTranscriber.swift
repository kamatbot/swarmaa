import Foundation
import Speech

/// On-device transcription of a Watch memo. Always yields a string; failures and missing permission give "".
enum MemoTranscriber {
    static func transcribe(_ url: URL) async -> String {
        let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard status == .authorized, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return "" }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        let text: String = await withCheckedContinuation { c in
            var done = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !done, result?.isFinal == true || error != nil else { return }
                done = true
                c.resume(returning: result?.bestTranscription.formattedString ?? "")
            }
        }
        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8000))
    }
}
