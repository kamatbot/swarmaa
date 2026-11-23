import Foundation
import AVFoundation
import Speech

/// Live transcription of a ring recording while it downloads (docs/RING-AGENT.md §6.2 cut 5, §6.3):
/// one long-lived Opus → PCM converter fed packet by packet into an on-device buffer recognizer.
/// Created when the download starts so the recognizer warms up while the ring is still being asked for audio.
/// Any failure yields nil from `finish`, and the caller may fall back to `MemoTranscriber` on the saved M4A.
/// This never touches the saved file or the ring's delete-ack rule.
@MainActor final class RingAudioStream {
    private let input: AVAudioFormat
    private let output: AVAudioFormat
    private let converter: AVAudioConverter
    private let recognizer: SFSpeechRecognizer
    private let request: SFSpeechAudioBufferRecognitionRequest
    /// Reused for every converter input call; the converter consumes it before asking for the next one.
    private let compressed: AVAudioCompressedBuffer
    private var task: SFSpeechRecognitionTask?
    /// Undecoded 40-byte Opus packets back to back; `head` bytes at the front are already consumed.
    private var queue = Data()
    private var head = 0
    private var ended = false
    private var done = false
    private var text: String?
    private var waiters: [CheckedContinuation<String?, Never>] = []
    private var timer: Task<Void, Never>?
    private(set) var failure: String?
    /// True when the recognizer itself reported an error after audio was fed (not a timeout, not our own decode
    /// failure). The whole-file recognizer would most likely fail the same way.
    private(set) var recognizerFailed = false
    private(set) var frames: Int = 0
    /// The recognizer answered or the stream was cancelled; no more audio is accepted.
    var isFinished: Bool { done }

    private static let packetsPerInput = 50

    /// nil when on-device recognition isn't authorized or available; the caller then uses the whole-file path.
    init?() {
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              let recognizer = SFSpeechRecognizer(), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else { return nil }
        var asbd = AudioStreamBasicDescription(mSampleRate: SR116Protocol.opusSampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
                                               mBytesPerPacket: 0, mFramesPerPacket: UInt32(SR116Protocol.opusFramesPerPacket),
                                               mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard let input = AVAudioFormat(streamDescription: &asbd),
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SR116Protocol.opusSampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: input, to: output) else { return nil }
        self.input = input
        self.output = output
        self.converter = converter
        self.recognizer = recognizer
        self.compressed = AVAudioCompressedBuffer(format: input, packetCapacity: AVAudioPacketCount(Self.packetsPerInput),
                                                  maximumPacketSize: SR116Protocol.opusPacketBytes)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        self.request = request
        // Strong capture: the recognition task drops its handler once it reports final, errs or is cancelled.
        task = Self.startTask(recognizer, request) { text, error in
            Task { @MainActor in self.answered(text, error: error) }
        }
    }

    /// Builds the recognition callback outside the main actor's isolation: Speech may call it on its own queue.
    nonisolated private static func startTask(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechAudioBufferRecognitionRequest,
                                              _ report: @escaping @Sendable (String?, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            if error != nil { report(text, true) }
            else if result?.isFinal == true { report(text, false) }
        }
    }

    private func answered(_ value: String?, error: Bool) {
        guard !done else { return }
        done = true
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        text = trimmed.isEmpty ? nil : String(trimmed.prefix(8000))
        if text == nil && failure == nil {
            failure = error ? "recognizer error" : "no speech recognized"
            // An error before any audio was fed is a warm-up problem, not a verdict on this recording.
            recognizerFailed = error && frames > 0
        }
        complete()
    }

    /// Decodes newly arrived 40-byte Opus packets (a whole number of them) and appends the PCM to the recognizer.
    func append(_ packets: Data) {
        guard !ended, !done, failure == nil, !packets.isEmpty else { return }
        queue.append(contentsOf: packets)
        drain(end: false)
    }

    private func drain(end: Bool) {
        let size = SR116Protocol.opusPacketBytes
        let buffer = compressed
        defer {
            // One move per drain instead of one per packet.
            if head > 0 { queue.removeSubrange(queue.startIndex ..< queue.startIndex + head); head = 0 }
        }
        while failure == nil {
            let available = (queue.count - head) / size
            guard available > 0 || end else { return }
            let capacity = AVAudioFrameCount(max(min(available, Self.packetsPerInput), 10) * SR116Protocol.opusFramesPerPacket)
            // A fresh PCM buffer each time: the recognizer may keep the one it was handed.
            guard let pcm = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { failure = "no PCM buffer"; return }
            let bytes = queue
            var cursor = head
            var error: NSError?
            let status = converter.convert(to: pcm, error: &error) { requested, inputStatus in
                let left = (bytes.count - cursor) / size
                guard left > 0 else {
                    inputStatus.pointee = end ? .endOfStream : .noDataNow
                    return nil
                }
                let n = max(1, min(Int(requested), Int(buffer.packetCapacity), left))
                bytes.withUnsafeBytes { raw in
                    if let base = raw.baseAddress { buffer.data.copyMemory(from: base.advanced(by: cursor), byteCount: n * size) }
                }
                if let descriptions = buffer.packetDescriptions {
                    for i in 0..<n {
                        descriptions[i] = AudioStreamPacketDescription(mStartOffset: Int64(i * size), mVariableFramesInPacket: 0, mDataByteSize: UInt32(size))
                    }
                }
                buffer.packetCount = AVAudioPacketCount(n)
                buffer.byteLength = UInt32(n * size)
                cursor += n * size
                inputStatus.pointee = .haveData
                return buffer
            }
            head = cursor
            if status == .error { failure = "decode failed (\(error?.code ?? 0))"; return }
            if pcm.frameLength > 0 {
                frames += Int(pcm.frameLength)
                request.append(pcm)
            }
            // haveData: the output filled up and more may be waiting; otherwise input ran dry or ended.
            guard status == .haveData else { return }
        }
    }

    /// Ends the audio as soon as the last packet is in, so the recognizer finalises while the file is saved.
    /// Idempotent; `finish` calls it too.
    func end() {
        guard !ended else { return }
        ended = true
        guard !done else { return }
        if failure == nil { drain(end: true) }
        if failure != nil || frames == 0 {
            if failure == nil { failure = "no audio decoded" }
            cancel(); return
        }
        request.endAudio()
    }

    /// Ends the audio and waits for the final transcript; nil on failure, silence or timeout.
    func finish(timeout seconds: Double) async -> String? {
        end()
        if done { return text }
        return await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            waiters.append(c)
            guard timer == nil else { return }
            let nanos = UInt64(max(0.5, seconds) * 1_000_000_000)
            timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: nanos)
                guard !Task.isCancelled, let self, !self.done else { return }
                self.failure = "timed out"
                self.cancel()
            }
        }
    }

    func cancel() {
        ended = true
        task?.cancel(); task = nil
        if !done { done = true }
        complete()
    }

    /// Resumes every waiter exactly once (the list is emptied first).
    private func complete() {
        timer?.cancel(); timer = nil
        let pending = waiters
        waiters = []
        for c in pending { c.resume(returning: text) }
    }
}
