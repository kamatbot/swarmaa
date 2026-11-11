import SwiftUI
import AVFoundation

@MainActor @Observable final class PhoneMemos {
    static let shared = PhoneMemos()
    struct Item: Identifiable { let id: String; let url: URL; let date: Date }
    var items: [Item] = []
    var error: String?
    private var player: AVAudioPlayer?
    static var root: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Watch Memos", isDirectory: true) }
    func refresh(generation: String?) {
        guard let generation, UUID(uuidString: generation) != nil else { items = []; return }
        let folder = Self.root.appendingPathComponent(generation, isDirectory: true)
        items = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey])) ?? []).filter { $0.pathExtension == "m4a" && UUID(uuidString: $0.deletingPathExtension().lastPathComponent) != nil }.map {
            Item(id: $0.deletingPathExtension().lastPathComponent, url: $0, date: (try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast)
        }.sorted { $0.date > $1.date }
    }
    // Input was copied synchronously from the transient WCSessionFile URL before its callback returned.
    func retain(_ source: URL, envelope: MemoEnvelope) throws {
        defer { try? FileManager.default.removeItem(at: source) }
        let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, values.fileSize == envelope.bytes, try MemoLimits.hash(source) == envelope.hash else { throw MemoFailure.invalid }
        let manager = FileManager.default
        let folder = Self.root.appendingPathComponent(envelope.generation, isDirectory: true)
        let target = folder.appendingPathComponent(envelope.id + ".m4a")
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        if manager.fileExists(atPath: target.path) {
            guard try MemoLimits.hash(target) == envelope.hash else { throw MemoFailure.invalid }
            return
        }
        let enumerator = manager.enumerator(at: Self.root, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles])
        var count = 0
        while let url = enumerator?.nextObject() as? URL { if url.pathExtension == "m4a" { count += 1 } }
        guard count < MemoLimits.count else { throw MemoFailure.full }
        // Copy to a temporary file in the destination directory and rename atomically on that volume.
        let staged = folder.appendingPathComponent("." + UUID().uuidString + ".tmp")
        defer { try? manager.removeItem(at: staged) }
        try manager.copyItem(at: source, to: staged)
        try manager.moveItem(at: staged, to: target)
    }
    func play(_ item: Item) {
        do { try AVAudioSession.sharedInstance().setCategory(.playback); try AVAudioSession.sharedInstance().setActive(true); player = try AVAudioPlayer(contentsOf: item.url); player?.play() }
        catch { self.error = "Could not play this memo." }
    }
    func delete(_ item: Item, generation: String?) {
        do { try FileManager.default.removeItem(at: item.url); refresh(generation: generation) }
        catch { self.error = "Could not delete the iPhone copy." }
    }
    enum MemoFailure: Error { case invalid, full }
}
struct PhoneMemosView: View {
    let close: () -> Void
    private let store = PhoneMemos.shared
    private var generation: String? {
        guard !ProcessInfo.processInfo.arguments.contains("-demo") else { return nil }
        return WatchBridge.shared.memoGeneration
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { CloseButton(action: close); Text("WATCH MEMOS.").font(KS.display(28)) }
            Text("Saved on this iPhone. Mac sync is not available yet.").font(KS.body(14))
            if store.items.isEmpty { Text("No Watch memos saved on this iPhone.") }
            ScrollView {
                ForEach(store.items) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.date, style: .date)
                        HStack { Button("Play") { store.play(item) }; ShareLink(item: item.url) { Text("Share") }; Button("Delete", role: .destructive) { store.delete(item, generation: generation) } }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                }
            }
            if let error = store.error { Text(error).font(KS.body(14)) }
        }.onAppear { store.refresh(generation: generation) }
    }
}
