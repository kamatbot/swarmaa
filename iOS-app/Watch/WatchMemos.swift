import SwiftUI
import AVFoundation
import WatchConnectivity

@MainActor @Observable final class WatchMemos: NSObject, AVAudioRecorderDelegate {
    static let shared = WatchMemos()
    struct Memo: Codable, Identifiable {
        let id, generation: String
        let created: Date
        var hash: String
        var bytes: Int
        var state: String
        var threadID: String? = nil
    }
    var memos: [Memo] = []
    var error: String?
    var recording = false
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var activeID: String?
    private var currentGeneration: String?
    private var permissionPending = false
    private let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("watch-memos", isDirectory: true)
    private var manifest: URL { directory.appendingPathComponent("manifest.json") }
    private func audio(_ id: String) -> URL { directory.appendingPathComponent(id + ".m4a") }
    private override init() {
        super.init()
        if let data = try? Data(contentsOf: manifest), let saved = try? JSONDecoder().decode([Memo].self, from: data) { memos = saved }
        for item in memos where item.state == "recording" { finalize(item.id) }
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted), name: AVAudioSession.interruptionNotification, object: nil)
    }
    @discardableResult private func save() -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(memos).write(to: manifest, options: .atomic)
            return true
        } catch { self.error = "Could not save memo details on Watch."; return false }
    }
    func setGeneration(_ generation: String?) {
        if currentGeneration != generation {
            stop()
            currentGeneration = generation
            for transfer in WCSession.default.outstandingFileTransfers {
                if (transfer.file.metadata?["generation"] as? String) != generation { transfer.cancel() }
            }
        }
        retryPending()
    }
    func start(generation: String, threadID: String) {
        guard !recording, !permissionPending, currentGeneration == generation else { return }
        guard memos.count < MemoLimits.count else { error = "Watch memo storage is full. Delete a saved copy first."; return }
        permissionPending = true
        // The async API resumes on the main actor; a closure here would inherit main-actor isolation and
        // trap under Swift 6 when the system calls it on a background queue.
        Task {
            let allowed = await AVAudioApplication.requestRecordPermission()
            permissionPending = false
            guard allowed else { error = "Allow microphone access in Watch settings to record."; return }
            guard currentGeneration == generation else { return }
            begin(generation: generation, threadID: threadID)
        }
    }
    private func begin(generation: String, threadID: String) {
        let id = UUID().uuidString
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            let settings: [String: Any] = [AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000]
            let recorder = try AVAudioRecorder(url: audio(id), settings: settings)
            memos.append(Memo(id: id, generation: generation, created: Date(), hash: "", bytes: 0, state: "recording", threadID: threadID))
            guard save() else { memos.removeLast(); return }
            recorder.delegate = self
            guard recorder.record(forDuration: MemoLimits.seconds) else { finalize(id); error = "Recording could not start."; return }
            self.recorder = recorder; activeID = id; recording = true; error = nil
        } catch { self.error = "Could not start recording on Watch." }
    }
    func stop() {
        guard let id = activeID else { return }
        activeID = nil; recording = false
        recorder?.stop(); recorder = nil
        finalize(id)
        try? AVAudioSession.sharedInstance().setActive(false)
    }
    @objc nonisolated private func interrupted(_ notification: Notification) {
        let value = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        if value == AVAudioSession.InterruptionType.began.rawValue {
            Task { @MainActor in self.stop(); self.error = "Recording was interrupted and saved as a partial memo." }
        }
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let id = recorder.url.deletingPathExtension().lastPathComponent
        Task { @MainActor in guard self.activeID == id else { return }; self.stop() }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let id = recorder.url.deletingPathExtension().lastPathComponent
        Task { @MainActor in
            guard self.activeID == id else { return }
            self.stop(); self.error = "Recording stopped. Check the saved partial memo."
        }
    }
    private func finalize(_ id: String) {
        guard let index = memos.firstIndex(where: { $0.id == id }), memos[index].state == "recording" else { return }
        do {
            let url = audio(id)
            let bytes = (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
            guard bytes > 0, bytes <= MemoLimits.bytes else { memos[index].state = "unconfirmed"; _ = save(); error = "Memo is empty or exceeds 20 MiB; it remains on Watch."; return }
            memos[index].hash = try MemoLimits.hash(url); memos[index].bytes = bytes; memos[index].state = "pending"
            guard save() else { return }
            transfer(memos[index])
        } catch { memos[index].state = "unconfirmed"; _ = save(); self.error = "Could not finish the memo. It remains on Watch." }
    }
    func transfer(_ item: Memo) {
        guard item.generation == currentGeneration, item.state != "phone", item.bytes > 0,
              WCSession.default.activationState == .activated else { return }
        let envelope = MemoEnvelope(id: item.id, generation: item.generation, hash: item.hash, bytes: item.bytes, threadID: item.threadID, capturedAt: ISO8601DateFormatter().string(from: item.created))
        guard envelope.valid else { return }
        let already = WCSession.default.outstandingFileTransfers.contains { ($0.file.metadata?["id"] as? String) == item.id && ($0.file.metadata?["generation"] as? String) == item.generation }
        var metadata: [String: Any] = ["id": item.id, "generation": item.generation, "hash": item.hash, "bytes": item.bytes, "capturedAt": envelope.capturedAt ?? ""]
        if let threadID = item.threadID { metadata["threadID"] = threadID }
        if !already { WCSession.default.transferFile(audio(item.id), metadata: metadata) }
    }
    func retryPending() { for memo in memos where memo.generation == currentGeneration && memo.state == "pending" { transfer(memo) } }
    func receipt(id: String, generation: String, hash: String, status: String) {
        guard generation == currentGeneration, let index = memos.firstIndex(where: { $0.id == id && $0.generation == generation && $0.hash == hash }), memos[index].state != "mac" else { return }
        if memos[index].state == "phone" && status != "mac" { return }
        memos[index].state = status == "mac" ? "mac" : status == "phone" ? "phone" : "unconfirmed"
        _ = save()
    }
    func retry(_ item: Memo) {
        guard let index = memos.firstIndex(where: { $0.id == item.id }), item.generation == currentGeneration else { return }
        if item.bytes == 0 {
            memos[index].state = "recording"
            if save() { finalize(item.id) }
        } else {
            memos[index].state = "pending"
            if save() { transfer(memos[index]) }
        }
    }
    func play(_ item: Memo) {
        do { try AVAudioSession.sharedInstance().setCategory(.playback); try AVAudioSession.sharedInstance().setActive(true); player = try AVAudioPlayer(contentsOf: audio(item.id)); player?.play() }
        catch { self.error = "Could not play this memo." }
    }
    func transferFailed(id: String, generation: String) {
        guard let index = memos.firstIndex(where: { $0.id == id && $0.generation == generation && $0.state == "pending" }) else { return }
        memos[index].state = "unconfirmed"; _ = save()
    }
    func deletePrevious(generation: String) {
        for item in memos.filter({ $0.generation != generation }) { delete(item) }
    }
    func delete(_ item: Memo) {
        guard item.state != "recording", let index = memos.firstIndex(where: { $0.id == item.id }) else { return }
        do {
            for transfer in WCSession.default.outstandingFileTransfers where (transfer.file.metadata?["id"] as? String) == item.id { transfer.cancel() }
            if FileManager.default.fileExists(atPath: audio(item.id).path) { try FileManager.default.removeItem(at: audio(item.id)) }
            memos.remove(at: index); _ = save()
        }
        catch { self.error = "Could not delete the Watch copy." }
    }
}
struct WatchMemosView: View {
    let store: WatchStore
    private let memos = WatchMemos.shared
    @State private var deleteCandidate: WatchMemos.Memo?
    @State private var confirmPrevious = false
    @State private var selectedThread = ""
    var body: some View {
        List {
            if let generation = store.snapshot?.generation, store.snapshot?.signedIn == true {
                Picker("Memo bot", selection: $selectedThread) { ForEach(store.snapshot?.bots ?? []) { bot in Text(bot.name).tag(bot.threadID) } }.disabled(memos.recording)
                if memos.recording { Button("Stop recording") { memos.stop() } }
                else { Button("Record memo") { memos.start(generation: generation, threadID: selectedThread) }.disabled(selectedThread.isEmpty) }
                Text("Up to 15 minutes. Transfers to iPhone and then Mac when available.").font(.caption).foregroundStyle(.secondary)
                ForEach(memos.memos.filter { $0.generation == generation }) { memo in
                    VStack(alignment: .leading) {
                        Text(memo.created, style: .date)
                        if let thread = memo.threadID { Text("Bot: " + (store.snapshot?.bots.first(where: { $0.threadID == thread })?.name ?? thread)).font(.caption) }
                        Text(memo.state == "mac" ? "Saved on Mac" : memo.state == "phone" ? "Saved on iPhone; waiting for Mac" : memo.state == "recording" ? "Recording" : memo.state == "pending" ? "Waiting for iPhone" : "Delivery unconfirmed").font(.caption)
                        if memo.bytes > 0 { Button("Play") { memos.play(memo) }.disabled(memos.recording) }
                        if memo.state == "unconfirmed" || memo.state == "pending" { Button("Retry") { memos.retry(memo) } }
                        if memo.state != "recording" { Button("Delete Watch copy", role: .destructive) { deleteCandidate = memo } }
                    }
                }
                if memos.memos.contains(where: { $0.generation != generation }) {
                    Button("Delete previous connection memos", role: .destructive) { confirmPrevious = true }
                }
            } else { Text("Open Swarmaa on iPhone to connect before recording.") }
            if let error = memos.error { Text(error).font(.caption) }
        }.navigationTitle("Memos").onAppear {
            if selectedThread.isEmpty, let bots = store.snapshot?.bots { selectedThread = (bots.first(where: { $0.starred }) ?? bots.first)?.threadID ?? "" }
        }
            .alert("Delete previous connection memos?", isPresented: $confirmPrevious) {
                Button("Delete", role: .destructive) { if let generation = store.snapshot?.generation { memos.deletePrevious(generation: generation) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Some memos may not have reached the iPhone. This cannot be undone.") }
            .alert("Delete Watch copy?", isPresented: Binding(get: { deleteCandidate != nil }, set: { if !$0 { deleteCandidate = nil } })) {
                Button("Delete", role: .destructive) { if let memo = deleteCandidate { memos.delete(memo) }; deleteCandidate = nil }
                Button("Cancel", role: .cancel) { deleteCandidate = nil }
            } message: { Text(["phone", "mac"].contains(deleteCandidate?.state ?? "") ? "The iPhone copy remains." : "This memo may not have reached your iPhone.") }
    }
}
