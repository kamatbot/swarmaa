import SwiftUI
import WatchConnectivity
import WidgetKit

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
        syncComplication()
    }
    /// Shares the open-question count with the complications; reloads them only when it changed.
    private func syncComplication() {
        let needs = snapshot?.signedIn == true ? Set((snapshot?.questions ?? []).map(\.threadID)).count : 0
        let signedIn = snapshot?.signedIn == true
        guard needs != ComplicationData.needsCount || signedIn != ComplicationData.signedIn else { return }
        ComplicationData.write(needs: needs, signedIn: signedIn)
        WidgetCenter.shared.reloadTimelines(ofKind: "app.swarmaa.needs-you")
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
        WatchTransactions.shared.refresh(generation: snapshot?.signedIn == true ? snapshot?.generation : nil)
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
            snapshot = incoming; _ = save(); syncComplication()
            WatchMemos.shared.setGeneration(incoming.signedIn ? incoming.generation : nil)
            WatchTransactions.shared.invalidateOtherGenerations(incoming.signedIn ? incoming.generation : nil)
        } else if packet.kind == "transaction", let transaction = packet.transaction {
            WatchTransactions.shared.receive(transaction, generation: snapshot?.signedIn == true ? snapshot?.generation : nil)
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
    private func restoreMemoGeneration() {
        let generation = snapshot?.signedIn == true ? snapshot?.generation : nil
        WatchMemos.shared.setGeneration(generation)
        WatchTransactions.shared.invalidateOtherGenerations(generation)
    }
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

/// The Swarmaa navy palette, scaled to watchOS.
enum WK {
    static let ground = rgb(0x050D1A), surface = rgb(0x12233E), chip = rgb(0x182C4D)
    static let ink = rgb(0xE3E9F2), strong = rgb(0xF2F5FA), muted = rgb(0x8B9CB6)
    static let signal = rgb(0x8FB8FF), onSignal = rgb(0x0A1830), mine = rgb(0x1B3155)
    static let needs = rgb(0xECC09A), needsTint = rgb(0xE0A77A).opacity(0.16), ready = rgb(0xCDDCB8), failed = rgb(0xE0896A)
    private static func rgb(_ hex: UInt32) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1)
    }
    /// 13pt-or-larger text styles, so Dynamic Type still works.
    static let meta = Font.system(.footnote, design: .monospaced)
    static let caption = Font.system(.footnote)
}
extension View {
    func wkRow(_ fill: Color = WK.surface) -> some View {
        listRowBackground(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(fill))
    }
    func wkCard(_ fill: Color = WK.surface) -> some View {
        padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    /// The navy ground behind every Watch screen.
    func wkScreen() -> some View {
        containerBackground(WK.ground.gradient, for: .navigation).foregroundStyle(WK.ink).tint(WK.signal)
    }
}
struct WKPrimary: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold)).foregroundStyle(WK.onSignal)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(WK.signal.opacity(enabled ? 1 : 0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

@main struct SwarmaaWatchApp: App {
    @Environment(\.scenePhase) private var phase
    private let store = WatchStore.shared
    @State private var router = WatchRouter.shared
    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $router.path) {
                Group {
                    if let snapshot = store.snapshot, snapshot.signedIn {
                        List {
                            NavigationLink(value: "memos") { Label("Voice memos", systemImage: "waveform") }.wkRow()
                            if snapshot.bots.isEmpty { Text("Your bots will appear here after Swarmaa on iPhone syncs.").font(WK.caption).foregroundStyle(WK.muted).listRowBackground(Color.clear) }
                            ForEach(snapshot.bots.sorted { $0.starred && !$1.starred }) { bot in
                                let needs = (snapshot.questions ?? []).contains { $0.threadID == bot.threadID }
                                NavigationLink { WatchThread(store: store, bot: bot) } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 4) {
                                            if bot.starred { Image(systemName: "star.fill").font(.footnote).foregroundStyle(WK.needs).accessibilityLabel("Starred") }
                                            Text(bot.name).font(.headline).foregroundStyle(WK.strong).lineLimit(2)
                                        }
                                        if needs { Text("Needs you").font(WK.caption.weight(.semibold)).foregroundStyle(WK.needs) }
                                        else if let last = bot.messages.last { Text(last.text).font(WK.caption).foregroundStyle(WK.muted).lineLimit(1) }
                                    }.padding(.vertical, 4)
                                }.wkRow()
                            }
                            NavigationLink { WatchTransactionsView(store: store) } label: { Label("Transactions", systemImage: "list.bullet.rectangle") }.wkRow()
                            Button("Refresh") { store.refresh() }.buttonStyle(WKPrimary()).listRowBackground(Color.clear)
                        }.navigationTitle("Bots")
                    } else {
                        ScrollView {
                            VStack(spacing: 12) {
                                Text("Open Swarmaa on your paired iPhone to connect.").font(.body).foregroundStyle(WK.ink).multilineTextAlignment(.center)
                                Button("Refresh") { store.refresh() }.buttonStyle(WKPrimary())
                            }
                        }
                    }
                }.wkScreen().navigationDestination(for: String.self) { _ in WatchMemosView(store: store) }
            }.tint(WK.signal).onAppear { store.refresh() }
            .onOpenURL { url in if url.host == "record" { router.recordMemo() } else if url.host == "needs" { router.path = [] } }
        }.onChange(of: phase) { _, new in
            // Keep recording when the screen dims or the wrist drops; the audio background mode keeps the session alive.
            if new == .active { store.refresh() }
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
            VStack(alignment: .leading, spacing: 8) {
                if let current {
                    ForEach((store.snapshot?.questions ?? []).filter { $0.threadID == current.threadID }) { question in
                        WatchQuestionView(question: question)
                    }
                    if store.snapshot?.moreQuestions == true { Text("More questions may be available on iPhone.").font(WK.caption).foregroundStyle(WK.muted) }
                    if current.omittedMessages { Text("Some older messages omitted.").font(WK.caption).foregroundStyle(WK.muted) }
                    if current.messages.isEmpty && !current.omittedMessages { Text("Recent messages with this bot will appear here.").font(WK.caption).foregroundStyle(WK.muted) }
                    ForEach(current.messages) { message in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(message.human ? "You" : "Bot").font(WK.caption.weight(.semibold)).foregroundStyle(WK.muted)
                            Text(WatchMarkdown.text(message.text)).foregroundStyle(message.human ? WK.strong : WK.ink)
                        }.wkCard(message.human ? WK.mine : WK.surface)
                    }
                    // A delivered message that already shows in the recent messages is not listed twice.
                    ForEach(store.queue.filter { item in item.post.botID == bot.id && !(item.status == "delivered" && current.messages.contains { $0.id == item.messageID }) }) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.post.body).foregroundStyle(WK.strong)
                            Text(item.status == "delivered" ? "Delivered" : item.status == "failed" ? "Delivery unconfirmed" : "Pending").font(WK.meta)
                                .foregroundStyle(item.status == "delivered" ? WK.ready : item.status == "failed" ? WK.failed : WK.needs)
                            if item.status == "failed" { Button("Retry") { store.retry(item) }.tint(WK.signal) }
                        }.wkCard(WK.mine)
                    }
                    Button("Refresh messages") { store.refresh() }.tint(WK.chip)
                    TextField("Message", text: $draft, axis: .vertical)
                    Button("Send") { if store.enqueue(bot: current, body: draft) { draft = "" } }
                        .buttonStyle(WKPrimary())
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let error = store.error { Text(error).font(WK.caption).foregroundStyle(WK.failed) }
                } else { Text("This bot is no longer available. Refresh on iPhone.").foregroundStyle(WK.muted) }
            }
        }.navigationTitle(bot.name).wkScreen()
    }
}

struct WatchQuestionView: View {
    let question: WatchQuestion
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Needs you").font(WK.caption.weight(.semibold)).foregroundStyle(WK.needs)
            Text("Question at last sync").font(.headline).foregroundStyle(WK.strong)
            if let details = question.details {
                Text(details.prompt).foregroundStyle(WK.ink)
                if !details.actionKind.isEmpty { Text("Action: " + details.actionKind) }
                if !details.actionSummary.isEmpty { Text("Summary: " + details.actionSummary) }
                if !details.actionDetail.isEmpty { Text("Details: " + details.actionDetail).font(WK.meta) }
                if !details.actionWhere.isEmpty { Text("Where: " + details.actionWhere).font(WK.meta) }
                if !details.expiresAt.isEmpty { Text("Expires: " + details.expiresAt).font(WK.meta).foregroundStyle(WK.muted) }
                ForEach(Array(details.options.enumerated()), id: \.offset) { entry in Text(entry.element).font(WK.caption).padding(.horizontal, 6).padding(.vertical, 2).background(WK.chip, in: Capsule()) }
                if details.multi { Text("Multiple choices allowed.").font(WK.caption).foregroundStyle(WK.muted) }
                if details.freeText { Text("A written answer is allowed.").font(WK.caption).foregroundStyle(WK.muted) }
            } else { Text("Full question unavailable on Watch.") }
            Text("Review and answer on iPhone.").font(WK.caption).foregroundStyle(WK.muted)
        }.foregroundStyle(WK.ink).wkCard(WK.surface)
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(WK.needs.opacity(0.5), lineWidth: 1))
    }
}

/// Light markdown for the watch: inline spans only, after headings, bullets and fences are flattened.
enum WatchMarkdown {
    static func text(_ body: String) -> AttributedString {
        let flat = body.components(separatedBy: "\n").compactMap { line -> String? in
            let t = line.drop { $0 == " " }
            if t.hasPrefix("```") { return nil }
            if t.hasPrefix("#") { return String(t.drop { $0 == "#" }.drop { $0 == " " }) }
            if t.hasPrefix("- ") || t.hasPrefix("* ") { return "• " + t.dropFirst(2) }
            return line
        }.joined(separator: "\n")
        return (try? AttributedString(markdown: flat, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(body)
    }
}
