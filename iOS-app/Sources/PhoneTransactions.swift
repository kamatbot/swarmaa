import Foundation
import SwiftUI

@MainActor @Observable final class PhoneTransactions {
    static let shared = PhoneTransactions()
    struct Entry: Codable {
        let request: TransactionRequest
        var review: TransactionReview?
        var confirmation: TransactionConfirmation?
        var receipt: TransactionReceipt?
        var state: String
    }
    private(set) var entries: [Entry] = []
    private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("watch-transactions.json")
    private init() { if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([Entry].self, from: data) { entries = saved } }
    private func save() -> Bool {
        do { try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true); try JSONEncoder().encode(entries).write(to: file, options: .atomic); return true } catch { return false }
    }
    func requestID(for confirmation: TransactionConfirmation) -> String? { entries.first { $0.confirmation == confirmation }?.request.id }
    func accept(_ packet: TransactionPacket, generation: String, allowedThreads: Set<String>) -> Bool {
        if entries.contains(where: { $0.request.generation != generation }) { entries.removeAll { $0.request.generation != generation }; guard save() else { return false } }
        if packet.kind == "discard", let request = packet.request, request.generation == generation,
           let index = entries.firstIndex(where: { $0.request == request }), entries[index].confirmation == nil || entries[index].receipt != nil {
            entries.remove(at: index); return save()
        }
        if let request = packet.request, packet.kind == "preview" {
            guard request.generation == generation, allowedThreads.contains(request.threadID), UUID(uuidString: request.id) != nil,
                  ["create", "update"].contains(request.operation), request.values.payee.utf8.count <= 200,
                  request.values.category.utf8.count <= 200, request.values.amount.utf8.count <= 32,
                  ["THB", "USD", "EUR"].contains(request.values.currency),
                  request.values.date.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil,
                  request.values.amount.range(of: "^(0|[1-9]\\d{0,11})(\\.\\d{1,2})?$", options: .regularExpression) != nil,
                  !request.values.payee.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !request.values.category.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  (request.expenseID?.utf8.count ?? 0) <= 200,
                  (request.operation == "create" && request.expenseID == nil || request.operation == "update" && !(request.expenseID ?? "").isEmpty) else { return false }
            if let existing = entries.first(where: { $0.request.id == request.id }) { return existing.request == request }
            guard entries.count < 20 else { return false }
            entries.append(Entry(request: request, state: "preview"))
            if save() { return true }; entries.removeLast(); return false
        }
        if let confirmation = packet.confirmation, packet.kind == "confirm" {
            guard confirmation.generation == generation, allowedThreads.contains(confirmation.threadID), UUID(uuidString: confirmation.id) != nil,
                  let i = entries.firstIndex(where: { entry in
                      entry.request.generation == generation && entry.request.threadID == confirmation.threadID &&
                      (entry.review == nil ? entry.request.id == confirmation.requestID : entry.review?.reviewId == confirmation.reviewID && entry.review?.reviewToken == confirmation.reviewToken)
                  }) else { return false }
            if let prior = entries[i].confirmation { return prior == confirmation }
            entries[i].confirmation = confirmation; entries[i].state = "confirm"
            if save() { return true }; entries[i].confirmation = nil; entries[i].state = "review"; return false
        }
        return false
    }
    private func current(_ request: TransactionRequest) -> Entry? {
        entries.first { $0.request == request }
    }
    @discardableResult private func update(_ request: TransactionRequest, _ change: (inout Entry) -> Void) -> Bool {
        guard let index = entries.firstIndex(where: { $0.request == request }) else { return false }
        let original = entries[index]
        change(&entries[index])
        guard save() else { entries[index] = original; return false }
        return true
    }
    func flush(service: any HostService, generation: String, allowedThreads: Set<String>, valid: () -> Bool, send: (TransactionPacket) -> Void) async {
        let requests = entries.map(\.request).filter { $0.generation == generation }
        for request in requests {
            guard valid() else { return }
            guard allowedThreads.contains(request.threadID), var entry = current(request) else { continue }
            do {
                if entry.review == nil {
                    let v = request.values
                    var input: [String: JSON] = ["thread_id": .string(request.threadID), "request_id": .string(request.id), "operation": .string(request.operation), "values": .object(["payee": .string(v.payee), "date": .string(v.date), "amount": .string(v.amount), "currency": .string(v.currency), "category": .string(v.category)])]
                    if let expenseID = request.expenseID { input["expense_id"] = .string(expenseID) }
                    let result = try await service.call("watch_transaction_preview", input)
                    guard valid(), let refreshed = current(request) else { continue }
                    let remote = try JSONDecoder().decode(TransactionReview.self, from: JSONEncoder().encode(result))
                    guard remote.operation == request.operation, !remote.reviewId.isEmpty, !remote.reviewToken.isEmpty, !remote.accountId.isEmpty, !remote.expiresAt.isEmpty,
                          (request.operation == "create" ? remote.before == nil : remote.before?.id == request.expenseID) else { throw AppFailure.invalidResponse }
                    if let confirmation = refreshed.confirmation {
                        guard confirmation.reviewID == remote.reviewId, confirmation.reviewToken == remote.reviewToken else { throw AppFailure.invalidResponse }
                    }
                    // A confirmed replay is attributable only if its receipt matches the persisted confirmation ID.
                    let initial = TransactionReview(reviewId: remote.reviewId, reviewToken: remote.reviewToken, expiresAt: remote.expiresAt, accountId: remote.accountId, operation: remote.operation, before: remote.before, after: remote.after, status: "pending", receipt: nil)
                    if remote.status == "confirmed" {
                        guard let confirmation = refreshed.confirmation, let receipt = remote.receipt, receipt.matches(review: initial, confirmationID: confirmation.id) else { throw AppFailure.invalidResponse }
                        guard update(request, { $0.review = initial; $0.receipt = receipt; $0.state = "confirmed" }) else { continue }
                    } else {
                        guard remote.status == "pending" else { throw AppFailure.invalidResponse }
                        guard update(request, { $0.review = initial; $0.state = $0.confirmation == nil ? "review" : "unconfirmed" }) else { continue }
                    }
                    guard let refreshed = current(request) else { continue }; entry = refreshed
                }
                guard let review = entry.review else { continue }
                if let confirmation = entry.confirmation, entry.receipt == nil {
                    var response: TransactionReview?
                    if entry.state == "unconfirmed" {
                        let result = try await service.call("watch_transaction_get", ["thread_id": .string(confirmation.threadID), "review_id": .string(confirmation.reviewID)])
                        guard valid(), let refreshed = current(request), refreshed.confirmation == confirmation, refreshed.review == review else { continue }
                        let remote = try JSONDecoder().decode(TransactionReview.self, from: JSONEncoder().encode(result))
                        guard remote.sameBinding(as: review) else { throw AppFailure.invalidResponse }
                        if remote.status == "confirmed" { response = remote }
                        else if remote.status != "pending" { throw AppFailure.invalidResponse }
                    }
                    if response == nil {
                        // Persist uncertainty before the call so a crash recovers with get and the same ID.
                        guard let latest = current(request), latest.confirmation == confirmation, latest.review == review,
                              update(request, { $0.state = "unconfirmed" }) else { continue }
                        let result = try await service.call("watch_transaction_confirm", ["thread_id": .string(confirmation.threadID), "review_id": .string(confirmation.reviewID), "review_token": .string(confirmation.reviewToken), "confirmation_id": .string(confirmation.id)])
                        guard valid(), let refreshed = current(request), refreshed.confirmation == confirmation, refreshed.review == review else { continue }
                        response = try JSONDecoder().decode(TransactionReview.self, from: JSONEncoder().encode(result))
                    }
                    guard let remote = response, remote.status == "confirmed", remote.sameBinding(as: review),
                          let receipt = remote.receipt, receipt.matches(review: review, confirmationID: confirmation.id) else { throw AppFailure.invalidResponse }
                    guard update(request, { $0.receipt = receipt; $0.state = "confirmed" }) else { continue }
                }
                guard let latest = current(request) else { continue }
                let packet = TransactionPacket(kind: "result", generation: generation, requestID: request.id, review: latest.review, receipt: latest.receipt, state: latest.state)
                if WatchCodec.encode(WatchPacket(kind: "transaction", transaction: packet)) == nil {
                    send(TransactionPacket(kind: "result", generation: generation, requestID: request.id, state: "review_on_phone"))
                } else { send(packet) }
            } catch {
                guard valid(), let latest = current(request) else { continue }
                let state = latest.confirmation == nil ? "preview_unconfirmed" : "unconfirmed"
                guard update(request, { $0.state = state }) else { continue }
                send(TransactionPacket(kind: "result", generation: generation, requestID: request.id, state: state))
            }
        }
    }

}

struct PhoneTransactionReviewsView: View {
    let close: () -> Void
    private let store = PhoneTransactions.shared
    private var generation: String? {
        guard !ProcessInfo.processInfo.arguments.contains("-demo") else { return nil }
        return WatchBridge.shared.memoGeneration
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { CloseButton(action: close); Text("TRANSACTIONS.").font(KS.display(28)) }
            Text("Review only. Confirm eligible transactions on Watch.").font(KS.body(14))
            ScrollView {
                ForEach(store.entries.filter { $0.request.generation == generation }, id: \.request.id) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        if let review = entry.review {
                            Text("Account: " + review.accountId); Text("Operation: " + review.operation)
                            if let before = review.before { Text("Before").fontWeight(.bold); fields(before) } else { Text("Before: none") }
                            Text("After").fontWeight(.bold); fields(review.after); Text("Expires: " + review.expiresAt)
                        } else { Text("Preview unconfirmed. Check the Mac transaction integration.") }
                        Text(entry.receipt == nil ? entry.state : "Ledger updated")
                        Divider()
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
    @ViewBuilder private func fields(_ v: TransactionValues) -> some View {
        if let id = v.id { Text("ID: " + id) }
        Text("Payee: " + v.payee); Text("Date: " + v.date); Text("Amount: " + v.amount); Text("Currency: " + v.currency); Text("Category: " + v.category)
    }
}
