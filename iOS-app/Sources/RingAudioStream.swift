import Foundation
import AVFoundation
import Speech

/// Live transcription of a ring recording while it downloads (docs/RING-AGENT.md §6.2 cut 5, §6.3):
/// one long-lived Opus → PCM converter fed packet by packet into an on-device buffer recognizer.
/// Any failure yields nil from `finish`, and the caller falls back to `MemoTranscriber` on the saved M4A.
/// This never touches the saved file or the ring's delete-ack rule.
@MainActor final class RingAudioStream {
    private let input: AVAudioFormat
    private let output: AVAudioFormat
    private let converter: AVAudioConverter
    private let recognizer: SFSpeechRecognizer
    private let request: SFSpeechAudioBufferRecognitionRequest
    private var task: SFSpeechRecognitionTask?
    private var queue: [Data] = []
    private var ended = false
    private var done = false
    private var text: String?
    private(set) var failure: String?
    private(set) var frames: Int = 0

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
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        self.request = request
        // Strong capture: the recognition task drops its handler once it reports final, errs or is cancelled.
        task = Self.startTask(recognizer, request) { text, final in
            Task { @MainActor in self.answered(text, final: final) }
        }
    }

    /// Builds the recognition callback outside the main actor's isolation: Speech may call it on its own queue.
    nonisolated private static func startTask(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechAudioBufferRecognitionRequest,
                                              _ report: @escaping @Sendable (String?, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            if error != nil { report(text, true) }
            else if result?.isFinal == true { report(text, true) }
        }
    }

    private func answered(_ value: String?, final: Bool) {
        guard final, !done else { return }
        done = true
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        text = trimmed.isEmpty ? nil : String(trimmed.prefix(8000))
        if text == nil && failure == nil { failure = "no speech recognized" }
    }

    /// Decodes newly arrived 40-byte Opus packets and appends the PCM to the recognizer.
    func append(_ packets: [Data]) {
        guard !ended, !done, failure == nil, !packets.isEmpty else { return }
        queue.append(contentsOf: packets)
        drain(end: false)
    }

    private func drain(end: Bool) {
        while failure == nil {
            let capacity = AVAudioFrameCount(max(queue.count, 10) * SR116Protocol.opusFramesPerPacket)
            guard let pcm = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { failure = "no PCM buffer"; return }
            let input = self.input
            var pending = queue
            queue = []
            var error: NSError?
            let status = converter.convert(to: pcm, error: &error) { requested, inputStatus in
                guard !pending.isEmpty else {
                    inputStatus.pointee = end ? .endOfStream : .noDataNow
                    return nil
                }
                let n = max(1, min(Int(requested), 50, pending.count))
                let buffer = AVAudioCompressedBuffer(format: input, packetCapacity: AVAudioPacketCount(n), maximumPacketSize: SR116Protocol.opusPacketBytes)
                var offset = 0
                for i in 0..<n {
                    let packet = pending[i]
                    packet.withUnsafeBytes { raw in
                        if let base = raw.baseAddress { buffer.data.advanced(by: offset).copyMemory(from: base, byteCount: packet.count) }
                    }
                    buffer.packetDescriptions?[i] = AudioStreamPacketDescription(mStartOffset: Int64(offset), mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
                    offset += packet.count
                }
                buffer.packetCount = AVAudioPacketCount(n)
                buffer.byteLength = UInt32(offset)
                pending.removeFirst(n)
                inputStatus.pointee = .haveData
                return buffer
            }
            queue = pending + queue
            if status == .error { failure = "decode failed (\(error?.code ?? 0))"; return }
            if pcm.frameLength > 0 {
                frames += Int(pcm.frameLength)
                request.append(pcm)
            }
            // haveData: the output filled up and more may be waiting; otherwise input ran dry or ended.
            guard status == .haveData else { return }
        }
    }

    /// Ends the audio and waits for the final transcript; nil on failure, silence or timeout.
    func finish(timeout seconds: Double) async -> String? {
        end()
        if done && text == nil { return nil }
        let deadline = Date().addingTimeInterval(max(1, seconds))
        while !done && Date() < deadline {
            try? await Task.sleep(nanoseconds: 30_000_000)
        }
        if !done { failure = "timed out"; cancel() }
        return text
    }

    /// Flushes the decoder and ends the audio so the recognizer can finalise; safe to call twice.
    func end() {
        guard !ended else { return }
        ended = true
        if failure == nil { drain(end: true) }
        if failure != nil || frames == 0 { cancel(); return }
        request.endAudio()
    }

    func cancel() {
        ended = true
        task?.cancel(); task = nil
        if !done { done = true }
    }
}
