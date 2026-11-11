import SwiftUI
import WatchConnectivity

@MainActor @Observable final class WatchStore: NSObject, WCSessionDelegate {
    static let shared = WatchStore()
    struct Queued: Codable, Identifiable { let post: WatchPost; var status: String; var messageID: String? = nil; var id: String { post.id } }
    private struct State: Codable { var snapshot: WatchSnapshot?; var queue: [Queued]; var oldEpochs: [String] }
    var snapshot: WatchSnapshot?
    var queue: [Queued] = []
    var error: String?
    private var oldEpochs: [String] = []
    private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("watch-state.json")
    private override init() {
        super.init()
        if let data = try? Data(contentsOf: file), let state = try? JSONDecoder().decode(State.self, from: data) { snapshot = state.snapshot; queue = state.queue; oldEpochs = state.oldEpochs }
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }
    @discardableResult private func save() -> Bool {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(State(snapshot: snapshot, queue: queue, oldEpochs: oldEpochs)).write(to: file, options: .atomic)
            return true
        } catch { self.error = "Could not save on Watch. Try again."; return false }
    }
    func refresh() {
        transmit(WatchPacket(kind: "refresh"), durable: true)
        WatchMemos.shared.retryPending()
        for item in queue where item.status != "delivered" { transmit(WatchPacket(kind: "post", post: item.post), durable: true) }
    }
    func enqueue(bot: WatchBot, body: String) -> Bool {
        guard let snapshot, snapshot.signedIn, snapshot.bots.contains(where: { $0.id == bot.id && $0.threadID == bot.threadID }) else { error = "Open Swarmaa on iPhone to sync."; return false }
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= WatchLimits.bodyBytes else { error = "Enter a message up to 4,000 bytes."; return false }
        if queue.count >= WatchLimits.queue { queue.removeAll { $0.status == "delivered" } }
        guard queue.count < WatchLimits.queue else { error = "Outbox is full. Retry pending messages first."; return false }
        let post = WatchPost(id: UUID().uuidString, generation: snapshot.generation, botID: bot.id, threadID: bot.threadID, body: text)
        queue.append(Queued(post: post, status: "pending"))
        guard save() else { queue.removeLast(); return false }
        error = nil; transmit(WatchPacket(kind: "post", post: post), durable: true); return true
    }
    func retry(_ item: Queued) {
        guard let i = queue.firstIndex(where: { $0.id == item.id }) else { return }
        queue[i].status = "pending"
        guard save() else { queue[i].status = "failed"; return }
        transmit(WatchPacket(kind: "post", post: item.post), durable: true)
    }
    private func transmit(_ packet: WatchPacket, durable: Bool) {
        guard let data = WatchCodec.encode(packet), WCSession.default.activationState == .activated else { return }
        if durable && !WCSession.default.outstandingUserInfoTransfers.contains(where: { ($0.userInfo["data"] as? Data) == data }) {
            WCSession.default.transferUserInfo(["data": data])
        }
        if WCSession.default.isReachable { WCSession.default.sendMessage(["data": data], replyHandler: nil, errorHandler: nil) }
    }
    private func receive(_ data: Data) {
        guard let packet = WatchCodec.decode(data) else { return }
        if let incoming = packet.snapshot, packet.kind == "snapshot" {
            guard !oldEpochs.contains(incoming.epoch) else { return }
            if let previous = snapshot {
                if incoming.epoch == previous.epoch { guard incoming.revision > previous.revision else { return } }
                else { oldEpochs.append(previous.epoch); oldEpochs = Array(oldEpochs.suffix(8)) }
            }
            if incoming.generation != snapshot?.generation || !incoming.signedIn { queue = [] }
            snapshot = incoming; _ = save()
            WatchMemos.shared.setGeneration(incoming.signedIn ? incoming.generation : nil)
        } else if packet.kind == "memo_ack", let id = packet.id, let generation = packet.generation, let hash = packet.hash, let status = packet.status {
            WatchMemos.shared.receipt(id: id, generation: generation, hash: hash, status: status)
        } else if packet.kind == "ack", packet.generation == snapshot?.generation,
                  let index = queue.firstIndex(where: { $0.id == packet.id && $0.post.generation == packet.generation }),
                  let status = packet.status, ["delivered", "failed"].contains(status) {
            // A late failure must never undo a confirmed delivery.
            if queue[index].status != "delivered" { queue[index].status = status; queue[index].messageID = packet.message; _ = save() }
        }
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let data = session.receivedApplicationContext["data"] as? Data
        Task { @MainActor in
            if let data { self.receive(data) }
            self.restoreMemoGeneration()
            self.refresh()
        }
    }
    private func restoreMemoGeneration() { WatchMemos.shared.setGeneration(snapshot?.signedIn == true ? snapshot?.generation : nil) }
    nonisolated func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard error != nil, let id = fileTransfer.file.metadata?["id"] as? String, let generation = fileTransfer.file.metadata?["generation"] as? String else { return }
        Task { @MainActor in WatchMemos.shared.transferFailed(id: id, generation: generation) }
    }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) { Task { @MainActor in self.refresh() } }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = applicationContext["data"] as? Data else { return }; Task { @MainActor in self.receive(data) }
    }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let data = message["data"] as? Data else { return }; Task { @MainActor in self.receive(data) }
    }
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let data = userInfo["data"] as? Data else { return }; Task { @MainActor in self.receive(data) }
    }
}

@main struct SwarmaaWatchApp: App {
    @Environment(\.scenePhase) private var phase
    private let store = WatchStore.shared
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Group {
                    if let snapshot = store.snapshot, snapshot.signedIn {
                        List {
                            if snapshot.bots.isEmpty { Text("No bots yet. Open Swarmaa on iPhone to sync.") }
                            ForEach(snapshot.bots.sorted { $0.starred && !$1.starred }) { bot in
                                NavigationLink { WatchThread(store: store, bot: bot) } label: {
                                    Label(bot.name, systemImage: bot.starred ? "star.fill" : "bubble.left")
                                }
                            }
                            NavigationLink("Voice memos") { WatchMemosView(store: store) }
                            Button("Refresh") { store.refresh() }
                        }.navigationTitle("Bots")
                    } else {
                        VStack { Text("Open Swarmaa on your paired iPhone to connect."); Button("Refresh") { store.refresh() } }
                    }
                }
            }.onAppear { store.refresh() }
        }.onChange(of: phase) { _, new in
            if new == .active { store.refresh() } else { WatchMemos.shared.stop() }
        }
    }
}
struct WatchThread: View {
    let store: WatchStore
    let bot: WatchBot
    @State private var draft = ""
    private var current: WatchBot? { store.snapshot?.bots.first { $0.id == bot.id && $0.threadID == bot.threadID } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let current {
                    ForEach((store.snapshot?.questions ?? []).filter { $0.threadID == current.threadID }) { question in
                        WatchQuestionView(question: question)
                    }
                    if store.snapshot?.moreQuestions == true { Text("More questions may be available on iPhone.").font(.caption).foregroundStyle(.secondary) }
                    if current.omittedMessages { Text("Some older messages omitted.").font(.caption).foregroundStyle(.secondary) }
                    if current.messages.isEmpty && !current.omittedMessages { Text("No recent messages.").foregroundStyle(.secondary) }
                    ForEach(current.messages) { message in
                        VStack(alignment: .leading) {
                            Text(message.human ? "You" : "Bot").font(.caption).foregroundStyle(.secondary)
                            Text(message.text)
                        }
                    }
                    // A delivered message that already shows in the recent messages is not listed twice.
                    ForEach(store.queue.filter { item in item.post.botID == bot.id && !(item.status == "delivered" && current.messages.contains { $0.id == item.messageID }) }) { item in
                        VStack(alignment: .leading) {
                            Text(item.post.body)
                            Text(item.status == "delivered" ? "Delivered" : item.status == "failed" ? "Delivery unconfirmed" : "Pending").font(.caption).foregroundStyle(.secondary)
                            if item.status == "failed" { Button("Retry") { store.retry(item) } }
                        }
                    }
                    Button("Refresh messages") { store.refresh() }
                    TextField("Message", text: $draft, axis: .vertical)
                    Button("Send") { if store.enqueue(bot: current, body: draft) { draft = "" } }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let error = store.error { Text(error).font(.caption).foregroundStyle(.secondary) }
                } else { Text("This bot is no longer available. Refresh on iPhone.") }
            }
        }.navigationTitle(bot.name)
    }
}

struct WatchQuestionView: View {
    let question: WatchQuestion
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Question at last sync").font(.headline)
            if let details = question.details {
                Text(details.prompt)
                if !details.actionKind.isEmpty { Text("Action: " + details.actionKind) }
                if !details.actionSummary.isEmpty { Text("Summary: " + details.actionSummary) }
                if !details.actionDetail.isEmpty { Text("Details: " + details.actionDetail) }
                if !details.actionWhere.isEmpty { Text("Where: " + details.actionWhere) }
                if !details.expiresAt.isEmpty { Text("Expires: " + details.expiresAt) }
                ForEach(Array(details.options.enumerated()), id: \.offset) { entry in Text(entry.element) }
                if details.multi { Text("Multiple choices allowed.") }
                if details.freeText { Text("A written answer is allowed.") }
            } else { Text("Full question unavailable on Watch.") }
            Text("Review and answer on iPhone.").font(.caption).foregroundStyle(.secondary)
        }.padding(.vertical, 6)
    }
}
