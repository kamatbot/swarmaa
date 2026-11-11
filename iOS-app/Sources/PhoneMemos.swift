import SwiftUI
import AVFoundation

@MainActor @Observable final class PhoneMemos {
    static let shared = PhoneMemos()
    struct Item: Identifiable { let id: String; let url: URL; let date: Date; var delivery: Delivery? }
    struct Delivery: Codable { let id, generation, threadID, hash, capturedAt: String; let bytes: Int; var state: String }
    private var deliveries: [Delivery] = []
    private let manifest = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("phone-memo-uploads.json")
    private init() { if let data = try? Data(contentsOf: manifest), let saved = try? JSONDecoder().decode([Delivery].self, from: data) { deliveries = saved } }
    private func save() -> Bool {
        do { try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true); try JSONEncoder().encode(deliveries).write(to: manifest, options: .atomic); return true }
        catch { self.error = "Could not save Mac delivery details."; return false }
    }
    var items: [Item] = []
    var error: String?
    private var player: AVAudioPlayer?
    static var root: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Watch Memos", isDirectory: true) }
    func refresh(generation: String?) {
        guard let generation, UUID(uuidString: generation) != nil else { items = []; return }
        let folder = Self.root.appendingPathComponent(generation, isDirectory: true)
        items = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.creationDateKey])) ?? []).filter { $0.pathExtension == "m4a" && UUID(uuidString: $0.deletingPathExtension().lastPathComponent) != nil }.map { url in
            let id = url.deletingPathExtension().lastPathComponent
            return Item(id: id, url: url, date: (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast, delivery: deliveries.first { $0.id == id && $0.generation == generation })
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
            try register(envelope)
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
        try register(envelope)
    }
    private func register(_ envelope: MemoEnvelope) throws {
        guard let thread = envelope.threadID, let captured = envelope.capturedAt, !captured.isEmpty else { return }
        if let existing = deliveries.first(where: { $0.id == envelope.id && $0.generation == envelope.generation }) {
            guard existing.hash == envelope.hash && existing.threadID == thread && existing.bytes == envelope.bytes && existing.capturedAt == captured else { throw MemoFailure.invalid }; return
        }
        deliveries.append(Delivery(id: envelope.id, generation: envelope.generation, threadID: thread, hash: envelope.hash, capturedAt: captured, bytes: envelope.bytes, state: "pending"))
        guard save() else { deliveries.removeLast(); throw MemoFailure.invalid }
    }
    func assign(_ item: Item, generation: String, threadID: String) {
        guard UUID(uuidString: threadID) != nil, item.delivery == nil else { return }
        do {
            let bytes = try item.url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            let envelope = MemoEnvelope(id: item.id, generation: generation, hash: try MemoLimits.hash(item.url), bytes: bytes, threadID: threadID, capturedAt: ISO8601DateFormatter().string(from: item.date))
            guard envelope.valid else { throw MemoFailure.invalid }; try register(envelope); refresh(generation: generation); WatchBridge.shared.changed()
        } catch { self.error = "Could not prepare this memo for Mac delivery." }
    }
    private func deliveryIndex(_ entry: Delivery) -> Int? {
        deliveries.firstIndex { $0.id == entry.id && $0.generation == entry.generation && $0.hash == entry.hash && $0.threadID == entry.threadID && $0.bytes == entry.bytes && $0.capturedAt == entry.capturedAt }
    }
    // A run sends at most eight bounded chunks; later contact resumes using the host's indices.
    func flush(service: any HostService, generation: String, allowedThreads: Set<String>, valid: () -> Bool, acknowledged: (Delivery) -> Void) async -> Bool {
        var more = false
        for entry in deliveries where entry.generation == generation {
            guard valid() else { return false }
            guard allowedThreads.contains(entry.threadID), let latest = deliveries.first(where: { $0.id == entry.id && $0.generation == entry.generation && $0.hash == entry.hash && $0.threadID == entry.threadID && $0.bytes == entry.bytes && $0.capturedAt == entry.capturedAt }) else { continue }
            if latest.state == "mac" { acknowledged(latest); continue }
            let url = Self.root.appendingPathComponent(generation).appendingPathComponent(entry.id + ".m4a")
            do {
                let hash = try await Task.detached { try MemoLimits.hash(url) }.value
                guard valid(), hash == entry.hash, deliveryIndex(entry) != nil else { continue }
                var received = Set<Int>()
                do {
                    let status = try await service.call("watch_memo_status", ["memo_id": .string(entry.id), "thread_id": .string(entry.threadID)])
                    guard valid() else { return false }
                    guard deliveryIndex(entry) != nil else { continue }
                    if status["status"].string == "stored" {
                        guard status["memo_id"].string.lowercased() == entry.id.lowercased(), status["sha256"].string == entry.hash, status["byte_length"].int == entry.bytes, status["stored_on"].string == "mac" else { throw MemoFailure.invalid }
                        if let index = deliveryIndex(entry) { deliveries[index].state = "mac"; if save() { acknowledged(deliveries[index]) } else { deliveries[index].state = "pending" } }
                        continue
                    }
                    guard status["status"].string == "uploading", status["memo_id"].string.lowercased() == entry.id.lowercased(), status["sha256"].string == entry.hash, status["byte_length"].int == entry.bytes else { throw MemoFailure.invalid }
                    received = Set(status["received_indices"].array.map(\.int))
                } catch AppFailure.service(404) { /* New memo: no chunks have been uploaded yet. */ }
                let total = (entry.bytes + 131_071) / 131_072
                let missing = (0..<total).filter { !received.contains($0) }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                for index in missing.prefix(8) {
                    guard valid(), deliveryIndex(entry) != nil else { return false }
                    try handle.seek(toOffset: UInt64(index * 131_072))
                    guard let chunk = try handle.read(upToCount: min(131_072, entry.bytes - index * 131_072)), !chunk.isEmpty else { throw MemoFailure.invalid }
                    let result = try await service.call("watch_memo_put", ["memo_id": .string(entry.id), "thread_id": .string(entry.threadID), "sha256": .string(entry.hash), "byte_length": .number(Double(entry.bytes)), "captured_at": .string(entry.capturedAt), "index": .number(Double(index)), "data_base64": .string(chunk.base64EncodedString())])
                    guard valid() else { return false }
                    guard deliveryIndex(entry) != nil else { break }
                    guard result["memo_id"].string.lowercased() == entry.id.lowercased(), result["sha256"].string == entry.hash, result["byte_length"].int == entry.bytes else { throw MemoFailure.invalid }
                    if result["status"].string == "stored" && result["stored_on"].string == "mac" {
                        if let j = deliveryIndex(entry) { deliveries[j].state = "mac"; if save() { acknowledged(deliveries[j]) } else { deliveries[j].state = "pending" } }
                        break
                    }
                    guard result["status"].string == "uploading" else { throw MemoFailure.invalid }
                }
                if missing.count > 8 { more = true }
            } catch { self.error = "Mac delivery is unconfirmed. Retry when the host is available." }
        }
        refresh(generation: generation)
        return more
    }
    func play(_ item: Item) {
        do { try AVAudioSession.sharedInstance().setCategory(.playback); try AVAudioSession.sharedInstance().setActive(true); player = try AVAudioPlayer(contentsOf: item.url); player?.play() }
        catch { self.error = "Could not play this memo." }
    }
    func delete(_ item: Item, generation: String?) {
        do { try FileManager.default.removeItem(at: item.url); deliveries.removeAll { $0.id == item.id && $0.generation == generation }; _ = save(); refresh(generation: generation) }
        catch { self.error = "Could not delete the iPhone copy." }
    }
    enum MemoFailure: Error { case invalid, full }
}
struct PhoneMemosView: View {
    let close: () -> Void
    private let store = PhoneMemos.shared
    @State private var selectedThread = ""
    @State private var deleteItem: PhoneMemos.Item?
    private var generation: String? {
        guard !ProcessInfo.processInfo.arguments.contains("-demo") else { return nil }
        return WatchBridge.shared.memoGeneration
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { CloseButton(action: close); Text("Watch memos").font(KS.title()).foregroundStyle(KS.strong) }
            Text("Memos stay on iPhone until you delete them. Mac delivery uses the selected bot.").font(KS.body()).foregroundStyle(KS.soft)
            if store.items.isEmpty { Text("Voice memos you record on Apple Watch will appear here.").font(KS.body()).foregroundStyle(KS.muted) }
            ScrollView {
                ForEach(store.items) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.date, style: .date).font(KS.headline()).foregroundStyle(KS.strong)
                        if let delivery = item.delivery { Text("Bot: " + (Runtime.model.bots.first(where: { $0.threadID == delivery.threadID })?.name ?? delivery.threadID)).font(KS.body()).foregroundStyle(KS.soft) }
                        StatusChip(item.delivery == nil ? "Choose a bot to send to Mac" : item.delivery?.state == "mac" ? "Saved on Mac" : "Mac delivery pending or unconfirmed")
                        HStack(spacing: 8) {
                            if item.delivery == nil { Button("Send to Mac") { if let generation { store.assign(item, generation: generation, threadID: selectedThread) } }.buttonStyle(Pill(fill: KS.signal)).disabled(selectedThread.isEmpty) }
                            else if item.delivery?.state != "mac" { Button("Retry Mac delivery") { WatchBridge.shared.changed() }.buttonStyle(Pill(fill: KS.signal)) }
                            Button("Play") { store.play(item) }.buttonStyle(Pill())
                            ShareLink(item: item.url) { Text("Share") }.buttonStyle(Pill())
                            Button("Delete", role: .destructive) { deleteItem = item }.buttonStyle(Pill(danger: true))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12).card()
                }
            }
            if let error = store.error { Text(error).font(KS.body()).foregroundStyle(KS.failedText) }
            // The bot choice is a control, so it sits at the bottom of the sheet.
            if !store.items.isEmpty {
                Eyebrow("Bot for older memos")
                Picker("Bot for older memos", selection: $selectedThread) { ForEach(Runtime.model.sortedBots) { bot in Text(bot.name).tag(bot.threadID) } }
                    .pickerStyle(.menu).tint(KS.ink).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 4).card(KS.inset)
            }
        }.onAppear {
            store.refresh(generation: generation)
            if selectedThread.isEmpty { selectedThread = (Runtime.model.starred ?? Runtime.model.sortedBots.first)?.threadID ?? "" }
        }.alert("Delete iPhone copy?", isPresented: Binding(get: { deleteItem != nil }, set: { if !$0 { deleteItem = nil } })) {
            Button("Delete", role: .destructive) { if let item = deleteItem { store.delete(item, generation: generation) }; deleteItem = nil }
            Button("Cancel", role: .cancel) { deleteItem = nil }
        } message: { Text(deleteItem?.delivery?.state == "mac" ? "The Mac copy remains." : "Mac delivery may be incomplete. This cannot be undone.") }
    }
}
