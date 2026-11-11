import SwiftUI
import WatchConnectivity

@MainActor @Observable final class WatchTransactions {
    static let shared = WatchTransactions()
    struct Entry: Codable, Identifiable {
        let request: TransactionRequest
        var review: TransactionReview?
        var confirmation: TransactionConfirmation?
        var receipt: TransactionReceipt?
        var state: String
        var id: String { request.id }
    }
    var entries: [Entry] = []
    var error: String?
    private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("watch-transactions.json")
    private init() { if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([Entry].self, from: data) { entries = saved } }
    private func save() -> Bool {
        do { try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true); try JSONEncoder().encode(entries).write(to: file, options: .atomic); return true }
        catch { self.error = "Could not save transaction on Watch."; return false }
    }
    func send(_ packet: TransactionPacket) {
        guard let data = WatchCodec.encode(WatchPacket(kind: "transaction", transaction: packet)), WCSession.default.activationState == .activated else { return }
        if !WCSession.default.outstandingUserInfoTransfers.contains(where: { ($0.userInfo["data"] as? Data) == data }) { WCSession.default.transferUserInfo(["data": data]) }
        if WCSession.default.isReachable { WCSession.default.sendMessage(["data": data], replyHandler: nil, errorHandler: nil) }
    }
    func preview(generation: String, threadID: String, operation: String, expenseID: String?, values: TransactionValues) {
        guard entries.filter({ $0.request.generation == generation }).count < 20 else { error = "Transaction list is full."; return }
        let request = TransactionRequest(id: UUID().uuidString, generation: generation, threadID: threadID, operation: operation, expenseID: expenseID, values: values)
        entries.append(Entry(request: request, state: "preview"))
        guard save() else { entries.removeLast(); return }
        error = nil; send(TransactionPacket(kind: "preview", request: request))
    }
    func confirm(_ item: Entry, generation: String) {
        guard item.request.generation == generation, let index = entries.firstIndex(where: { $0.id == item.id }),
              let review = entries[index].review, entries[index].confirmation == nil, entries[index].receipt == nil,
              let expiration = ISO8601DateFormatter().date(from: review.expiresAt) ?? { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: review.expiresAt) }(), expiration > Date() else { error = "Review expired or is no longer available. Request a new preview."; return }
        let confirmation = TransactionConfirmation(id: UUID().uuidString, generation: generation, threadID: item.request.threadID, reviewID: review.reviewId, reviewToken: review.reviewToken, requestID: item.request.id)
        entries[index].confirmation = confirmation; entries[index].state = "confirm"
        guard save() else { entries[index].confirmation = nil; entries[index].state = "review"; return }
        send(TransactionPacket(kind: "confirm", confirmation: confirmation))
    }
    func retry(_ item: Entry) {
        if let confirmation = item.confirmation { send(TransactionPacket(kind: "confirm", confirmation: confirmation)) }
        else { send(TransactionPacket(kind: "preview", request: item.request)) }
    }
    func receive(_ packet: TransactionPacket, generation: String?) {
        guard packet.kind == "result", let generation, packet.generation == generation,
              let i = entries.firstIndex(where: { $0.id == packet.requestID && $0.request.generation == generation }) else { return }
        if let review = packet.review {
            guard review.operation == entries[i].request.operation, !review.accountId.isEmpty, !review.reviewId.isEmpty, !review.reviewToken.isEmpty,
                  (review.operation == "create" ? review.before == nil : review.before?.id == entries[i].request.expenseID) else { error = "Review changed. Open the iPhone app."; return }
            if let existing = entries[i].review {
                guard review.sameBinding(as: existing), review.reviewToken == existing.reviewToken, review.expiresAt == existing.expiresAt else { error = "Review changed. Open the iPhone app."; return }
            } else { entries[i].review = review }
        }
        if let receipt = packet.receipt {
            guard let review = entries[i].review, let confirmation = entries[i].confirmation, receipt.matches(review: review, confirmationID: confirmation.id) else { error = "Could not verify the transaction receipt."; return }
            entries[i].receipt = receipt; entries[i].state = "confirmed"
        } else if entries[i].receipt == nil {
            if entries[i].confirmation != nil { entries[i].state = "unconfirmed" }
            else if entries[i].review != nil { entries[i].state = "review" }
            else { entries[i].state = packet.state ?? "unconfirmed" }
        }
        _ = save()
    }
    func invalidateOtherGenerations(_ generation: String?) {
        entries.removeAll { $0.request.generation != generation }; _ = save()
        for transfer in WCSession.default.outstandingUserInfoTransfers {
            guard let data = transfer.userInfo["data"] as? Data, let packet = WatchCodec.decode(data), let transaction = packet.transaction else { continue }
            if (transaction.request?.generation ?? transaction.confirmation?.generation) != generation { transfer.cancel() }
        }
    }
    func discard(_ item: Entry) {
        guard item.confirmation == nil || item.receipt != nil, let i = entries.firstIndex(where: { $0.id == item.id }) else { return }
        send(TransactionPacket(kind: "discard", request: item.request))
        entries.remove(at: i); _ = save()
    }
    func refresh(generation: String?) {
        guard let generation else { return }
        for item in entries where item.request.generation == generation && item.receipt == nil {
            if item.confirmation != nil || item.review == nil { retry(item) }
        }
    }
}
struct WatchTransactionsView: View {
    let store: WatchStore
    private let tx = WatchTransactions.shared
    @State private var payee = ""
    @State private var amount = ""
    @State private var currency = "THB"
    @State private var category = "Other"
    @State private var date = Date()
    @State private var operation = "create"
    @State private var expenseID = ""
    @State private var threadID = ""
    var body: some View {
        List {
            if let snapshot = store.snapshot, snapshot.signedIn {
                Picker("Bot", selection: $threadID) { ForEach(snapshot.bots) { bot in Text(bot.name).tag(bot.threadID) } }.wkRow()
                Picker("Operation", selection: $operation) { Text("Create").tag("create"); Text("Update").tag("update") }.wkRow()
                if operation == "update" { TextField("Exact expense ID", text: $expenseID).wkRow() }
                TextField("Payee", text: $payee).wkRow()
                TextField("Amount", text: $amount).wkRow()
                Picker("Currency", selection: $currency) { Text("THB").tag("THB"); Text("USD").tag("USD"); Text("EUR").tag("EUR") }.wkRow()
                DatePicker("Date", selection: $date, displayedComponents: .date).wkRow()
                TextField("Category", text: $category).wkRow()
                Button("Preview") {
                    let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
                    let values = TransactionValues(id: nil, payee: payee, date: f.string(from: date), amount: amount, currency: currency, category: category)
                    tx.preview(generation: snapshot.generation, threadID: threadID, operation: operation, expenseID: operation == "update" ? expenseID : nil, values: values)
                }.disabled(threadID.isEmpty || payee.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || payee.utf8.count > 200 || category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category.utf8.count > 200 || expenseID.utf8.count > 200 || amount.range(of: "^(0|[1-9]\\d{0,11})(\\.\\d{1,2})?$", options: .regularExpression) == nil || (operation == "update" && expenseID.isEmpty))
                    .buttonStyle(WKPrimary()).listRowBackground(Color.clear)
                ForEach(tx.entries.filter { $0.request.generation == snapshot.generation }) { item in
                    NavigationLink { WatchTransactionReview(store: store, itemID: item.id) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.request.values.payee).font(.headline).foregroundStyle(WK.strong)
                            Text(item.receipt != nil ? "Ledger updated" : item.state == "review" ? "Review available" : item.state == "unconfirmed" ? "Confirmation unconfirmed" : "Preview pending").font(WK.caption)
                                .foregroundStyle(item.receipt != nil ? WK.ready : item.state == "review" ? WK.signal : item.state == "unconfirmed" ? WK.failed : WK.needs)
                        }
                    }.wkRow()
                }
                if let error = tx.error { Text(error).font(WK.caption).foregroundStyle(WK.failed) }
            }
        }.navigationTitle("Transactions").wkScreen().onAppear {
            if threadID.isEmpty, let bots = store.snapshot?.bots { threadID = (bots.first(where: { $0.starred }) ?? bots.first)?.threadID ?? "" }
        }
    }
}
struct WatchTransactionReview: View {
    let store: WatchStore
    let itemID: String
    private let tx = WatchTransactions.shared
    private var item: WatchTransactions.Entry? { tx.entries.first { $0.id == itemID && $0.request.generation == store.snapshot?.generation && store.snapshot?.signedIn == true } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let item, let review = item.review {
                    Text("Account: " + review.accountId)
                    Text("Operation: " + review.operation)
                    if let before = review.before { Text("Before").font(.headline).foregroundStyle(WK.strong); fields(before) }
                    else { Text("Before: none").foregroundStyle(WK.muted) }
                    Text("After").font(.headline).foregroundStyle(WK.strong); fields(review.after)
                    Text("Expires: " + review.expiresAt).font(WK.meta).foregroundStyle(WK.muted)
                    if item.receipt != nil { Text("Ledger updated"); Button("Remove from Watch") { tx.discard(item) } }
                    else if item.confirmation != nil { Text("Confirmation unconfirmed"); Button("Retry confirmation") { tx.retry(item) } }
                    else { NavigationLink("Review confirmation") { WatchTransactionConfirm(store: store, itemID: itemID) }; Button("Discard preview") { tx.discard(item) } }
                } else if let item {
                    Text(item.state == "review_on_phone" ? "Review on iPhone: details exceed Watch limits." : "Preview unconfirmed. Check the iPhone, Mac and transaction integration configuration.")
                    Button("Retry preview") { tx.retry(item) }
                    Button("Discard preview") { tx.discard(item) }
                } else { Text("This transaction is unavailable.") }
            }
        }.navigationTitle("Review").wkScreen()
    }
    @ViewBuilder private func fields(_ value: TransactionValues) -> some View {
        if let id = value.id { Text("ID: " + id) }
        Text("Payee: " + value.payee); Text("Date: " + value.date); Text("Amount: " + value.amount); Text("Currency: " + value.currency); Text("Category: " + value.category)
    }
}
struct WatchTransactionConfirm: View {
    let store: WatchStore
    let itemID: String
    private let tx = WatchTransactions.shared
    private var item: WatchTransactions.Entry? { tx.entries.first { $0.id == itemID && $0.request.generation == store.snapshot?.generation && store.snapshot?.signedIn == true } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let item, let review = item.review {
                    Text("Confirm ledger update").font(.headline).foregroundStyle(WK.strong)
                    Text("Account: " + review.accountId); Text("Operation: " + review.operation)
                    if let b = review.before { Text("Before"); fields(b) } else { Text("Before: none") }
                    Text("After"); fields(review.after); Text("Expires: " + review.expiresAt)
                    Button("Confirm update") { if let generation = store.snapshot?.generation { tx.confirm(item, generation: generation) } }.buttonStyle(WKPrimary()).disabled(item.confirmation != nil || item.receipt != nil)
                    if let error = tx.error { Text(error).foregroundStyle(WK.failed) }
                }
            }
        }.navigationTitle("Confirm").wkScreen()
    }
    @ViewBuilder private func fields(_ v: TransactionValues) -> some View {
        if let id = v.id { Text("ID: " + id) }
        Text("Payee: " + v.payee); Text("Date: " + v.date); Text("Amount: " + v.amount); Text("Currency: " + v.currency); Text("Category: " + v.category)
    }
}
