import Foundation
import UIKit
import WatchConnectivity
import CryptoKit

// The phone owns credentials and validates every watch post against a fresh server bot list.
@MainActor final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()
    private let defaults = UserDefaults.standard
    private var busy = false
    private var requested = false
    private var generation = ""
    private var fingerprint = ""
    private var revision: Int { get { defaults.integer(forKey: "watch.revision") } set { defaults.set(newValue, forKey: "watch.revision") } }
    private struct Entry: Codable { var post: WatchPost; var delivered: Bool; var messageID: String? = nil }
    private var entries: [Entry] = []
    private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("watch-outbox.json")
    private override init() {
        super.init()
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([Entry].self, from: data) { entries = saved }
        synchronizeIdentity()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }
    private func save() -> Bool {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(entries).write(to: file, options: .atomic)
            return true
        } catch { return false }
    }
    private func currentFingerprint() -> String? {
        let connection: HostConnection?
        do { connection = try ConnectionKeychain().load() } catch { return nil }
        guard let connection else { return "" }
        let bytes = Data((connection.hostID + "\n" + connection.relay + "\n" + connection.token).utf8)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    @discardableResult private func synchronizeIdentity() -> Bool {
        guard let current = currentFingerprint() else { return false }
        let stored = defaults.string(forKey: "watch.fingerprint") ?? ""
        if current != stored || defaults.string(forKey: "watch.generation") == nil {
            generation = UUID().uuidString
            defaults.set(current, forKey: "watch.fingerprint")
            defaults.set(generation, forKey: "watch.generation")
            entries = []; _ = save()
        } else { generation = defaults.string(forKey: "watch.generation") ?? UUID().uuidString }
        fingerprint = current
        if entries.contains(where: { $0.post.generation != generation }) { entries.removeAll { $0.post.generation != generation }; _ = save() }
        return true
    }
    func changed() {
        guard synchronizeIdentity() else { return }
        if fingerprint.isEmpty { publish(bots: [], signedIn: false) }
        requestWork()
    }
    private var watchAvailable: Bool {
        WCSession.isSupported() && WCSession.default.activationState == .activated
            && WCSession.default.isPaired && WCSession.default.isWatchAppInstalled
    }
    private func requestWork() {
        guard watchAvailable else { return }
        requested = true
        guard !busy else { return }
        busy = true
        Task { await work() }
    }
    private func work() async {
        // The Watch may wake this app in the background; ask iOS for time to finish the server round trip.
        let background = UIApplication.shared.beginBackgroundTask(withName: "watch-sync")
        defer { busy = false; if background != .invalid { UIApplication.shared.endBackgroundTask(background) }; if requested { requestWork() } }
        requested = false
        guard watchAvailable, synchronizeIdentity() else { return }
        let expected = generation
        guard !fingerprint.isEmpty, let connection = try? ConnectionKeychain().load() else {
            publish(bots: [], signedIn: false); return
        }
        // Reuse the app's live connection when it is up; open (and close) a private one only otherwise.
        let shared = Runtime.model.connected ? Runtime.model.service : nil
        let owned = shared == nil ? RelayService(connection: connection) : nil
        let service: any HostService = shared ?? owned!
        defer { if let owned { Task { await owned.transport.disconnect() } } }
        do {
            let list = try await service.call("bot_list", ["limit": .number(100)])
            guard watchAvailable, expected == generation, currentFingerprint() == fingerprint else { changed(); return }
            let available = list["bots"].array.map { Bot(raw: $0) }.filter { !$0.archived && UUID(uuidString: $0.id) != nil && UUID(uuidString: $0.threadID) != nil }
            let bots = Array(Bot.sorted(available).sorted { $0.starred && !$1.starred }.prefix(WatchLimits.bots))
            for post in entries.filter({ !$0.delivered }).map(\.post) {
                guard watchAvailable, expected == generation, currentFingerprint() == fingerprint else { changed(); return }
                guard available.contains(where: { $0.id == post.botID && $0.threadID == post.threadID }) else {
                    drop(post, generation: expected); continue
                }
                do {
                    let result = try await service.call("thread_post", ["thread_id": .string(post.threadID), "body": .string(post.body), "idempotency_key": .string(post.id)])
                    guard watchAvailable, expected == generation, currentFingerprint() == fingerprint else { changed(); return }
                    guard !result["message"]["id"].string.isEmpty else { throw AppFailure.invalidResponse }
                    guard let index = entries.firstIndex(where: { $0.post == post }) else { continue }
                    entries[index].delivered = true; entries[index].messageID = result["message"]["id"].string
                    guard save() else { entries[index].delivered = false; continue }
                    send(WatchPacket(kind: "ack", generation: expected, id: post.id, status: "delivered", message: entries[index].messageID))
                } catch AppFailure.service(let code) where (400..<500).contains(code) && code != 408 && code != 429 {
                    // The server refused this message for good (thread gone, conflicting retry): stop retrying it
                    // so it cannot block the messages queued behind it or fill the outbox.
                    drop(post, generation: expected)
                } catch { send(WatchPacket(kind: "ack", generation: expected, id: post.id, status: "failed")); break }
            }
            var result: [WatchBot] = []
            for bot in bots {
                guard watchAvailable, expected == generation, currentFingerprint() == fingerprint else { changed(); return }
                let page = try await service.call("thread_read", ["thread_id": .string(bot.threadID), "limit": .number(Double(WatchLimits.messages))])
                let messages = page["messages"].array.map { Message(raw: $0) }.filter { $0.kind == "text" && !$0.text.isEmpty }.map {
                    WatchMessage(id: String(decoding: $0.id.utf8.prefix(128), as: UTF8.self), text: self.abbreviate($0.text), human: $0.human)
                }
                result.append(WatchBot(id: bot.id, threadID: bot.threadID, name: String(decoding: bot.name.utf8.prefix(80), as: UTF8.self), starred: bot.starred, messages: messages))
            }
            guard watchAvailable, expected == generation, currentFingerprint() == fingerprint else { changed(); return }
            publish(bots: result, signedIn: true)
        } catch { /* Keep the last snapshot and retry on the next contact. */ }
    }
    private func drop(_ post: WatchPost, generation: String) {
        entries.removeAll { $0.post.id == post.id }; _ = save()
        send(WatchPacket(kind: "ack", generation: generation, id: post.id, status: "failed"))
    }
    private func abbreviate(_ text: String) -> String {
        guard text.utf8.count > 300 else { return text }
        return String(decoding: text.utf8.prefix(300), as: UTF8.self) + "…"
    }
    private func publish(bots: [WatchBot], signedIn: Bool) {
        revision += 1
        let epoch = defaults.string(forKey: "watch.epoch") ?? UUID().uuidString
        defaults.set(epoch, forKey: "watch.epoch")
        var bounded = bots
        while true {
            let packet = WatchPacket(kind: "snapshot", snapshot: WatchSnapshot(revision: revision, epoch: epoch, generation: generation, signedIn: signedIn, bots: bounded))
            if let data = WatchCodec.encode(packet) {
                guard WCSession.default.activationState == .activated else { return }
                try? WCSession.default.updateApplicationContext(["data": data])
                return
            }
            // Keep all bot entries; shed the oldest messages until the encoded packet fits.
            guard let index = bounded.indices.filter({ !bounded[$0].messages.isEmpty }).max(by: { bounded[$0].messages.count < bounded[$1].messages.count }) else { return }
            bounded[index].messages.removeFirst()
            bounded[index].omittedMessages = true
        }
    }
    private func send(_ packet: WatchPacket) {
        guard let data = WatchCodec.encode(packet), WCSession.default.activationState == .activated else { return }
        if WCSession.default.outstandingUserInfoTransfers.count < WatchLimits.queue * 2 && !WCSession.default.outstandingUserInfoTransfers.contains(where: { ($0.userInfo["data"] as? Data) == data }) {
            WCSession.default.transferUserInfo(["data": data])
        }
        if WCSession.default.isReachable { WCSession.default.sendMessage(["data": data], replyHandler: nil, errorHandler: nil) }
    }
    private func receive(_ data: Data) {
        guard let packet = WatchCodec.decode(data) else { return }
        guard synchronizeIdentity() else { return }
        if packet.kind == "refresh" { requestWork(); return }
        guard packet.kind == "post", let post = packet.post, post.generation == generation, !fingerprint.isEmpty,
              UUID(uuidString: post.id) != nil, UUID(uuidString: post.botID) != nil, UUID(uuidString: post.threadID) != nil,
              !post.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              post.body.utf8.count <= WatchLimits.bodyBytes else { return }
        if let existing = entries.first(where: { $0.post.id == post.id }) {
            guard existing.post == post else { return }
            if existing.delivered { send(WatchPacket(kind: "ack", generation: generation, id: post.id, status: "delivered", message: existing.messageID)) }
        } else {
            if entries.count >= WatchLimits.queue { entries.removeAll { $0.delivered } }
            guard entries.count < WatchLimits.queue else { send(WatchPacket(kind: "ack", generation: generation, id: post.id, status: "failed")); return }
            entries.append(Entry(post: post, delivered: false))
            guard save() else { entries.removeLast(); send(WatchPacket(kind: "ack", generation: generation, id: post.id, status: "failed")); return }
        }
        requestWork()
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) { Task { @MainActor in self.changed() } }
    nonisolated func sessionWatchStateDidChange(_ session: WCSession) { Task { @MainActor in self.changed() } }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) { Task { @MainActor in self.requestWork() } }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let data = message["data"] as? Data else { return }; Task { @MainActor in self.receive(data) }
    }
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let data = userInfo["data"] as? Data else { return }; Task { @MainActor in self.receive(data) }
    }
}
