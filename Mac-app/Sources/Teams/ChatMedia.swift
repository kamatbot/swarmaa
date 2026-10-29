import Foundation
import Combine
import ImageIO
import UniformTypeIdentifiers
import AVFoundation
import Speech

struct ChatPhoto: Identifiable, Sendable, Equatable {
    let id: UUID
    let name: String
    let data: Data

    static func prepare(data: Data, name: String) async throws -> ChatPhoto {
        try await Task.detached(priority: .userInitiated) {
            guard data.count <= 25 * 1024 * 1024,
                  let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw MediaError.invalidImage }
            var dimension = 1600
            while dimension >= 200 {
                let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: dimension,
                    kCGImageSourceShouldCacheImmediately: true]
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw MediaError.invalidImage }
                for quality in [0.8, 0.65, 0.5, 0.35] {
                    let output = NSMutableData()
                    guard let dest = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { throw MediaError.invalidImage }
                    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                    guard CGImageDestinationFinalize(dest) else { throw MediaError.invalidImage }
                    if output.length <= 160 * 1024 {
                        let stem = URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent
                        return ChatPhoto(id: UUID(), name: String((stem.isEmpty ? "Photo" : stem).prefix(100)) + ".jpg", data: output as Data)
                    }
                }
                dimension = dimension * 3 / 4
            }
            throw MediaError.tooLarge
        }.value
    }
    enum MediaError: LocalizedError {
        case invalidImage, tooLarge
        var errorDescription: String? { self == .invalidImage ? "Could not read this image." : "This image could not be reduced to the photo size limit." }
    }
}

@MainActor final class ChatDictation: ObservableObject {
    @Published private(set) var isRecording = false
    @Published var error: String?
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var timeout: Task<Void, Never>?
    private var generation = UUID()
    private var tapInstalled = false

    func start(onUpdate: @escaping @MainActor (String) -> Void) async {
        stop()
        let token = UUID(); generation = token; error = nil
        let speech = await Self.speechAuthorization()
        guard token == generation else { return }
        guard speech == .authorized else { error = "Speech recognition permission is required."; return }
        let mic = await Self.microphoneAccess()
        guard token == generation else { return }
        guard mic else { error = "Microphone permission is required."; return }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { error = "Speech recognition is unavailable."; return }
        do {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.record, mode: .measurement, options: .duckOthers)
            try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
            #endif
            let request = SFSpeechAudioBufferRecognitionRequest(); request.shouldReportPartialResults = true
            self.request = request
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                error = "No microphone is available. Check your input device and try again."
                stop()
                return
            }
            Self.installTap(input, format: format, request: request)
            tapInstalled = true
            engine.prepare(); try engine.start(); isRecording = true
            recognition = Self.recognize(recognizer, request: request) { [weak self] transcript, final, failed in
                guard let self, self.generation == token else { return }
                if let transcript { onUpdate(transcript) }
                if failed || final { if failed { self.error = "Dictation stopped. Please try again." }; self.stop() }
            }
            timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard !Task.isCancelled, let self, self.generation == token else { return }
                self.stop()
            }
        } catch { self.error = "Could not start the microphone."; stop() }
    }
    // Apple calls these back on background queues. Closures formed inside this @MainActor class
    // inherit main-actor isolation and trap under Swift 6, so they are built in nonisolated helpers.
    nonisolated private static func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
    }
    nonisolated private static func microphoneAccess() async -> Bool {
        await withCheckedContinuation { continuation in AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) } }
    }
    nonisolated private static func installTap(_ input: AVAudioInputNode, format: AVAudioFormat, request: SFSpeechAudioBufferRecognitionRequest) {
        nonisolated(unsafe) let request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    }
    nonisolated private static func recognize(_ recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest, update: @escaping @MainActor (String?, Bool, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, failure in
            let transcript = result?.bestTranscription.formattedString, final = result?.isFinal == true, failed = failure != nil
            Task { @MainActor in update(transcript, final, failed) }
        }
    }
    func stop() {
        generation = UUID(); timeout?.cancel(); timeout = nil
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio(); request = nil; recognition?.cancel(); recognition = nil; isRecording = false
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
