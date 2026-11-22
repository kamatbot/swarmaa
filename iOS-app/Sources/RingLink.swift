import Foundation
import SwiftUI
import UserNotifications
import UIKit
import AVFoundation
@preconcurrency import CoreBluetooth

/// Keeps a background Bluetooth link to an SR116 ring and turns each finished
/// ring recording into a phone memo for the chosen bot:
/// ring stops recording (0x2F push) → count (0x3D) → download (0x40, 0x34…0x36)
/// → decode Opus → save + verify M4A → delete-ack (0x36) → transcribe → upload.
/// The ring's copy is deleted only after the decoded file is saved and re-read;
/// delivery to the Mac then retries from the iPhone copy like a Watch memo.
@MainActor @Observable final class RingLink: NSObject {
    static let shared = RingLink()
    static let restoreID = "app.swarmaa.ring.v1"
    private let defaults = UserDefaults.standard

    struct Candidate: Identifiable { let id: UUID; let name: String }
    private(set) var candidates: [Candidate] = []
    private(set) var status = "Not connected." { didSet { if status != oldValue { note(status) } } }
    /// Recent ring events with time and app state, so background behaviour can be checked afterwards.
    private(set) var log: [String] = UserDefaults.standard.stringArray(forKey: "ring.log") ?? []
    func note(_ event: String) {
        let state = switch UIApplication.shared.applicationState { case .active: "fg"; case .inactive: "inactive"; default: "bg" }
        log.append("\(Date().formatted(date: .omitted, time: .standard)) [\(state)] \(event)")
        if log.count > 80 { log.removeFirst(log.count - 80) }
        defaults.set(log, forKey: "ring.log")
    }
    private(set) var connected = false
    private(set) var busy = false
    private(set) var lastMemo: Date?
    var pairedID: UUID? {
        get { defaults.string(forKey: "ring.peripheral").flatMap(UUID.init(uuidString:)) }
        set { defaults.set(newValue?.uuidString, forKey: "ring.peripheral") }
    }
    var pairedName: String? { defaults.string(forKey: "ring.name") }
    /// Thread that receives ring memos. Empty = first "Assistant", starred, or first bot.
    var threadID: String {
        get { defaults.string(forKey: "ring.thread") ?? "" }
        set { defaults.set(newValue, forKey: "ring.thread") }
    }

    @ObservationIgnored private var central: CBCentralManager?
    @ObservationIgnored private var peripheral: CBPeripheral?
    @ObservationIgnored private var write: CBCharacteristic?
    @ObservationIgnored private var notify: CBCharacteristic?
    @ObservationIgnored private var assembler: SR116Protocol.RecordingAssembler?
    @ObservationIgnored private var deadline: Task<Void, Never>?
    @ObservationIgnored private var wasRecording = false
    @ObservationIgnored private var background: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var uploading = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var pending: [URL] = []
    /// Count replies are broadcast to every app on the link; act only on ours.
    @ObservationIgnored private var countRequestedAt: Date?

    private override init() { super.init() }

    /// Call at launch: recreating the restorable manager lets iOS relaunch
    /// Swarmaa in the background when the ring sends a notification.
    func start() {
        guard central == nil, pairedID != nil else { return }
        note("Launch (\(UIApplication.shared.applicationState == .background ? "woken in background" : "opened"))")
        makeCentral()
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { RingLink.shared.becameActive() }
        }
    }
    /// Foreground catch-up: anything recorded or saved while Swarmaa couldn't finish in the background.
    private func becameActive() {
        if connected { checkNow() } else { connect() }
        guard let generation = WatchBridge.shared.memoGeneration else { return }
        let waiting = deferred
        deferred = []
        Task {
            for url in waiting where FileManager.default.fileExists(atPath: url.path) { await self.deliver(url, generation: generation) }
            await self.upload(generation: generation)
        }
    }
    /// Memos saved in the background whose on-device transcription could not run there.
    private var deferred: [URL] {
        get { (defaults.stringArray(forKey: "ring.deferred") ?? []).map { URL(fileURLWithPath: $0) } }
        set { defaults.set(newValue.map(\.path), forKey: "ring.deferred") }
    }
    private func makeCentral() {
        central = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionRestoreIdentifierKey: Self.restoreID,
            CBCentralManagerOptionShowPowerAlertKey: false
        ])
    }

    // MARK: Pairing

    /// The ring stays connected to iOS, so it is found among connected
    /// peripherals exposing 56FF rather than by scanning advertisements.
    func findRings() {
        if central == nil { makeCentral() }
        guard let central, central.state == .poweredOn else { status = "Waiting for Bluetooth…"; return }
        candidates = central.retrieveConnectedPeripherals(withServices: [CBUUID(string: SR116Protocol.service)])
            .map { Candidate(id: $0.identifier, name: $0.name ?? "Unnamed ring") }
        status = candidates.isEmpty ? "No ring found. Pair the ring in iOS Bluetooth settings, keep it close, then try again." : "Choose your ring."
    }
    func pair(_ candidate: Candidate) {
        pairedID = candidate.id
        defaults.set(candidate.name, forKey: "ring.name")
        candidates = []
        connect()
    }
    func forget() {
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        pairedID = nil; defaults.removeObject(forKey: "ring.name")
        reset(); peripheral = nil; connected = false
        status = "Ring removed. Recordings already on the ring stay there."
    }

    private func connect() {
        guard let central, central.state == .poweredOn, let id = pairedID,
              let p = peripheral ?? central.retrievePeripherals(withIdentifiers: [id]).first else { return }
        peripheral = p; p.delegate = self
        if p.state == .connected { p.discoverServices([CBUUID(string: SR116Protocol.service)]) }
        else { central.connect(p, options: nil) } // pending connects never time out; iOS reconnects in range
        status = "Connecting to \(pairedName ?? "ring")…"
    }

    // MARK: Recording transfer

    func checkNow() {
        guard assembler == nil else { return }
        countRequestedAt = Date()
        send(SR116Protocol.encode(.recordingCount))
    }

    private func send(_ data: Data) {
        guard let p = peripheral, p.state == .connected, let write else { return }
        let type: CBCharacteristicWriteType = write.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        p.writeValue(data, for: write, type: type)
    }

    private func beginDownload() {
        guard assembler == nil else { return }
        guard WatchBridge.shared.memoGeneration != nil else { status = "Sign in to a host to receive ring memos."; return }
        hold()
        busy = true; status = "Downloading recording…"
        assembler = .init()
        send(SR116Protocol.encode(.stop)) // clear any stale transfer first, as the vendor app does
        arm(seconds: 20)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let self, self.assembler != nil else { return }
            self.send(SR116Protocol.encode(.requestNext))
        }
    }

    private func arm(seconds: UInt64) {
        deadline?.cancel()
        deadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            guard !Task.isCancelled, let self, self.assembler != nil else { return }
            self.abort("The ring stopped sending. The recording is still on the ring; it will be retried.")
        }
    }

    /// Never acks: the recording stays on the ring and is fetched again later.
    private func abort(_ message: String) {
        send(SR116Protocol.encode(.stop))
        reset()
        status = message
        release()
    }
    private func reset() { deadline?.cancel(); deadline = nil; assembler = nil; busy = false }

    private func received(_ frame: SR116Protocol.Frame) {
        if let recording = SR116Protocol.isRecording(frame) {
            note("Ring state push: \(recording ? "recording" : "idle")")
            if recording { status = "Ring is recording…" }
            // Finished recording: the ring flips 0x50 → 0x40.
            // Finished (or woke us after a relaunch, when the earlier 'recording' push was missed).
            if !recording { scheduleCheck(after: 1) }
            wasRecording = recording
            return
        }
        if let count = SR116Protocol.recordingCount(frame) {
            guard let asked = countRequestedAt, Date().timeIntervalSince(asked) < 5 else { return }
            countRequestedAt = nil
            if count > 0 && assembler == nil { beginDownload() }
            else if count == 0 && assembler == nil { status = "Connected. Ring has no new recordings."; release() }
            return
        }
        guard assembler != nil else { return }
        if frame.command == SR116Protocol.Transfer.requestNext.rawValue {
            do {
                _ = try assembler?.accept(frame)
                arm(seconds: 20)
                if let a = assembler, a.totalPackets > 0 { status = "Downloading recording… \(a.receivedPackets * 100 / a.totalPackets)%" }
            } catch { abort("Recording transfer was out of order. It stays on the ring and will be retried.") }
            return
        }
        if let remaining = SR116Protocol.remaining(frame) {
            guard let a = assembler, a.isComplete, !a.opus.isEmpty else {
                abort("Recording arrived incomplete. It stays on the ring and will be retried."); return
            }
            finish(a, remaining: remaining)
        }
    }

    private func scheduleCheck(after seconds: UInt64) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            self?.checkNow()
        }
    }

    private func finish(_ recording: SR116Protocol.RecordingAssembler, remaining: UInt16) {
        deadline?.cancel(); deadline = nil
        do {
            guard let generation = WatchBridge.shared.memoGeneration else { throw RingFailure.signedOut }
            let captured = recording.firstDeviceSeconds.map { SR116Protocol.date(fromDeviceSeconds: $0) } ?? Date()
            let item = try RingMemoFile.save(opus: recording.opus, generation: generation, captured: captured)
            // Saved and re-read: only now may the ring delete its copy.
            send(SR116Protocol.deleteAck(remaining: remaining))
            reset()
            lastMemo = Date()
            status = "Recording saved (\(Int(recording.seconds.rounded())) s). Sending to your bot…"
            Task { await self.deliver(item, generation: generation) }
            scheduleCheck(after: 2) // more recordings queued on the ring?
        } catch {
            abort("Couldn't save the recording (\(error.localizedDescription)). It stays on the ring.")
        }
    }

    // MARK: Delivery (same pipeline as Watch memos)

    private func deliver(_ item: URL, generation: String) async {
        hold()
        defer { release() }
        note("Transcribing…")
        let started = Date()
        let text = await Self.transcribe(item, timeout: 25)
        note("Transcript: \(text.map { "\($0.count) chars" } ?? "timed out") after \(Int(Date().timeIntervalSince(started))) s")
        guard text?.isEmpty == false || UIApplication.shared.applicationState == .active else {
            // iOS may not run speech recognition in the background. Keep the memo and finish when Swarmaa opens.
            deferred = deferred + [item]
            status = "Recording saved. Open Swarmaa to transcribe and send it."
            Self.remind()
            return
        }
        try? (text ?? "").write(to: item.deletingPathExtension().appendingPathExtension("txt"), atomically: true, encoding: .utf8)
        await upload(generation: generation, assign: item)
    }

    /// Assigns any new ring memo to the ring's bot and flushes pending deliveries.
    func upload(generation: String, assign file: URL? = nil) async {
        if let file { pending.append(file) }
        guard !uploading else { again = true; return }
        uploading = true; defer { uploading = false }
        repeat { again = false; await uploadOnce(generation: generation) } while again
    }

    private func uploadOnce(generation: String) async {
        guard let connection = try? ConnectionKeychain().load() else { status = "Sign in to a host to deliver ring memos."; return }
        let candidate = Runtime.model.connected ? Runtime.model.service as? RelayService : nil
        let shared: RelayService? = candidate?.connection.hostID == connection.hostID && candidate?.connection.relay == connection.relay
            && candidate?.connection.token == connection.token ? candidate : nil
        let owned = shared == nil ? RelayService(connection: connection) : nil
        let service: any HostService = shared ?? owned!
        defer { if let owned { Task { await owned.transport.disconnect() } } }
        do {
            let list = try await service.call("bot_list", ["limit": .number(100)])
            let bots = list["bots"].array.map { Bot(raw: $0) }.filter { !$0.archived && UUID(uuidString: $0.threadID) != nil }
            let allowed = Set(bots.map(\.threadID))
            let target = allowed.contains(threadID) ? threadID
                : (bots.first { $0.name.caseInsensitiveCompare("Assistant") == .orderedSame } ?? bots.first { $0.starred } ?? Bot.sorted(bots).first)?.threadID
            guard let target else { status = "Recording saved on iPhone. Create a bot to receive ring memos."; return }
            let memos = PhoneMemos.shared
            memos.refresh(generation: generation)
            for file in pending {
                if let item = memos.items.first(where: { $0.url.standardizedFileURL == file.standardizedFileURL }), item.delivery == nil {
                    memos.assign(item, generation: generation, threadID: target)
                }
            }
            pending = []
            for _ in 0..<8 {
                let more = await memos.flush(service: service, generation: generation, allowedThreads: allowed, valid: { true }) { _ in }
                if !more { break }
            }
            if let error = memos.error { status = error; memos.error = nil }
            else { status = "Ring memo sent to \(bots.first { $0.threadID == target }?.name ?? "your bot")." }
        } catch {
            status = "Recording saved on iPhone. Delivery will retry: \(error.localizedDescription)"
        }
    }

    // Background time while a transfer or upload is in flight.
    private func hold() {
        guard background == .invalid else { return }
        background = UIApplication.shared.beginBackgroundTask(withName: "ring-memo") { [weak self] in
            // Must always end the task here, or iOS terminates the app.
            MainActor.assumeIsolated {
                guard let self, self.background != .invalid else { return }
                self.note("Background time ran out")
                UIApplication.shared.endBackgroundTask(self.background); self.background = .invalid
            }
        }
    }

    @MainActor private final class Once { var done = false }
    /// On-device transcription with a deadline; nil when it doesn't finish in time.
    private static func transcribe(_ url: URL, timeout: UInt64) async -> String? {
        let once = Once()
        return await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            Task { @MainActor in
                let text = await MemoTranscriber.transcribe(url)
                if !once.done { once.done = true; c.resume(returning: text) }
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: timeout * 1_000_000_000)
                if !once.done { once.done = true; c.resume(returning: nil) }
            }
        }
    }
    private static func remind() {
        let content = UNMutableNotificationContent()
        content.title = "Ring memo saved"
        content.body = "Open Swarmaa to send it to your bot."
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "ring-memo-deferred", content: content, trigger: nil))
    }
    private func release() {
        guard background != .invalid, assembler == nil, !uploading else { return }
        UIApplication.shared.endBackgroundTask(background); background = .invalid
    }

    enum RingFailure: LocalizedError {
        case signedOut, full, empty
        var errorDescription: String? {
            switch self {
            case .signedOut: "not signed in to a host"
            case .full: "too many memos saved on this iPhone"
            case .empty: "decoded audio is empty"
            }
        }
    }
}

extension RingLink: @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: connect()
        case .unauthorized: status = "Allow Bluetooth for Swarmaa in Settings to use the ring."
        case .poweredOff: status = "Bluetooth is off."
        default: break
        }
    }
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        if let p = restored.first(where: { $0.identifier == pairedID }) { peripheral = p; p.delegate = self }
    }
    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        guard p.identifier == pairedID else { return }
        p.discoverServices([CBUUID(string: SR116Protocol.service)])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard p.identifier == pairedID else { return }
        connected = false; central.connect(p, options: nil)
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard p.identifier == pairedID else { return }
        connected = false; write = nil; notify = nil
        if assembler != nil { reset(); release() } // incomplete: not acked, retried after reconnect
        status = "Ring out of range. Swarmaa reconnects automatically."
        central.connect(p, options: nil)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = p.services?.first(where: { $0.uuid == CBUUID(string: SR116Protocol.service) }) else {
            status = "This device isn't an SR116 ring."; return
        }
        p.discoverCharacteristics([CBUUID(string: SR116Protocol.writeCharacteristic), CBUUID(string: SR116Protocol.notifyCharacteristic)], for: service)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        write = service.characteristics?.first { $0.uuid == CBUUID(string: SR116Protocol.writeCharacteristic) }
        notify = service.characteristics?.first { $0.uuid == CBUUID(string: SR116Protocol.notifyCharacteristic) }
        guard write != nil, let notify else { status = "Ring command channel missing."; return }
        p.setNotifyValue(true, for: notify)
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic === notify, characteristic.isNotifying else { return }
        connected = true
        status = "Connected to \(pairedName ?? "ring")."
        scheduleCheck(after: 1) // pick up anything recorded while disconnected
        if let generation = WatchBridge.shared.memoGeneration { Task { await upload(generation: generation) } }
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic === notify, error == nil, let value = characteristic.value,
              let frame = try? SR116Protocol.decode(value) else { return } // unframed side notifications are ignored
        received(frame)
    }
}

/// Decodes the ring's Opus packets into the Watch-memo folder as AAC M4A.
enum RingMemoFile {
    static func save(opus: [Data], generation: String, captured: Date) throws -> URL {
        let manager = FileManager.default
        let folder = PhoneMemos.root.appendingPathComponent(generation, isDirectory: true)
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let existing = (manager.enumerator(at: PhoneMemos.root, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "m4a" }
        guard existing.count < MemoLimits.count else { throw RingLink.RingFailure.full }
        let pcm = try decode(opus)
        guard pcm.frameLength > 0 else { throw RingLink.RingFailure.empty }
        let target = folder.appendingPathComponent(UUID().uuidString.lowercased() + ".m4a")
        let staged = folder.appendingPathComponent("." + UUID().uuidString + ".m4a")
        defer { try? manager.removeItem(at: staged) }
        do {
            let file = try AVAudioFile(forWriting: staged, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: SR116Protocol.opusSampleRate,
                                                                    AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000],
                                       commonFormat: .pcmFormatFloat32, interleaved: false)
            try file.write(from: pcm)
        } // closing the file finalizes the container
        // Re-read before the ring may delete its copy.
        let check = try AVAudioFile(forReading: staged)
        let bytes = try staged.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard check.length > 0, bytes > 0, bytes <= MemoLimits.bytes else { throw RingLink.RingFailure.empty }
        try manager.moveItem(at: staged, to: target)
        try manager.setAttributes([.creationDate: captured], ofItemAtPath: target.path)
        return target
    }

    static func decode(_ packets: [Data]) throws -> AVAudioPCMBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: SR116Protocol.opusSampleRate, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
                                               mBytesPerPacket: 0, mFramesPerPacket: UInt32(SR116Protocol.opusFramesPerPacket),
                                               mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
        guard !packets.isEmpty, let input = AVAudioFormat(streamDescription: &asbd),
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: SR116Protocol.opusSampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: input, to: output),
              let pcm = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(packets.count * SR116Protocol.opusFramesPerPacket))
        else { throw RingLink.RingFailure.empty }
        var index = 0
        var error: NSError?
        let status = converter.convert(to: pcm, error: &error) { requested, inputStatus in
            guard index < packets.count else { inputStatus.pointee = .endOfStream; return nil }
            let n = max(1, min(Int(requested), 50, packets.count - index))
            let buffer = AVAudioCompressedBuffer(format: input, packetCapacity: AVAudioPacketCount(n), maximumPacketSize: SR116Protocol.opusPacketBytes)
            var offset = 0
            for i in 0..<n {
                let packet = packets[index + i]
                packet.withUnsafeBytes { raw in buffer.data.advanced(by: offset).copyMemory(from: raw.baseAddress!, byteCount: packet.count) }
                buffer.packetDescriptions?[i] = AudioStreamPacketDescription(mStartOffset: Int64(offset), mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
                offset += packet.count
            }
            buffer.packetCount = AVAudioPacketCount(n)
            buffer.byteLength = UInt32(offset)
            index += n
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error { throw error ?? RingLink.RingFailure.empty }
        return pcm
    }
}

struct RingView: View {
    let close: () -> Void
    private let ring = RingLink.shared
    @State private var thread = RingLink.shared.threadID
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { CloseButton(action: close); Text("Ring").font(KS.title()).foregroundStyle(KS.strong) }
            Text("Tap your SR116 ring four times, speak, then tap four times again. Swarmaa downloads the recording, transcribes it on this iPhone and sends it to the bot below. The ring's copy is deleted once the iPhone copy is saved.")
                .font(KS.body()).foregroundStyle(KS.soft)
            StatusChip(ring.status)
            if let name = ring.pairedName {
                Text(name).font(KS.headline()).foregroundStyle(KS.strong)
                HStack(spacing: 8) {
                    Button("Check for recordings") { ring.checkNow() }.buttonStyle(Pill(fill: KS.signal, primary: true)).disabled(!ring.connected || ring.busy)
                    Button("Remove ring", role: .destructive) { ring.forget() }.buttonStyle(Pill(danger: true))
                }
                Eyebrow("Bot for ring memos")
                Picker("Bot for ring memos", selection: $thread) {
                    ForEach(Runtime.model.sortedBots) { bot in Text(bot.name).tag(bot.threadID) }
                }
                .pickerStyle(.menu).tint(KS.ink).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 4).card(KS.inset)
                .onChange(of: thread) { _, value in ring.threadID = value }
                Text("Keep Swarmaa running in the background. If you force-quit it, open it again so it can reconnect. Recordings made while the iPhone is away are picked up when the ring reconnects.")
                    .font(KS.body()).foregroundStyle(KS.muted)
            } else {
                Text("Pair the ring in iOS Settings › Bluetooth first. Don't keep another ring app open that downloads recordings.").font(KS.body()).foregroundStyle(KS.muted)
                Button("Find my ring") { ring.findRings() }.buttonStyle(Pill(fill: KS.signal, primary: true))
                ForEach(ring.candidates) { candidate in
                    Button(candidate.name) { ring.pair(candidate); MemoTranscriber.requestAccess() }.buttonStyle(Pill())
                }
            }
            if !ring.log.isEmpty {
                Eyebrow("Recent ring activity")
                ScrollView {
                    Text(ring.log.reversed().joined(separator: "\n")).font(.caption.monospaced()).foregroundStyle(KS.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                }.frame(maxHeight: 220)
                ShareLink(item: ring.log.joined(separator: "\n")) { Text("Share activity log") }.buttonStyle(Pill())
            }
            Spacer()
        }.onAppear {
            if thread.isEmpty { thread = (Runtime.model.sortedBots.first { $0.name.caseInsensitiveCompare("Assistant") == .orderedSame } ?? Runtime.model.starred ?? Runtime.model.sortedBots.first)?.threadID ?? "" }
        }
    }
}
