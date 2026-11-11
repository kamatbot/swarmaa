import Foundation

struct TransactionValues: Codable, Equatable, Sendable {
    var id: String?
    let payee, date, amount, currency, category: String
    func sameFields(as other: TransactionValues) -> Bool {
        payee == other.payee && date == other.date && amount == other.amount && currency == other.currency && category == other.category
    }
}
struct TransactionReview: Codable, Equatable, Sendable {
    let reviewId, reviewToken, expiresAt, accountId, operation: String
    let before: TransactionValues?
    let after: TransactionValues
    let status: String
    let receipt: TransactionReceipt?
    func sameBinding(as other: TransactionReview) -> Bool {
        reviewId == other.reviewId && accountId == other.accountId && operation == other.operation && before == other.before &&
        after.sameFields(as: other.after) && (other.after.id == nil || after.id == other.after.id)
    }
}
struct TransactionReceipt: Codable, Equatable, Sendable {
    let id, reviewId, accountId: String
    let expense: TransactionValues
    let confirmedAt, status: String
    func matches(review: TransactionReview, confirmationID: String) -> Bool {
        guard id == confirmationID, reviewId == review.reviewId, accountId == review.accountId, status == "confirmed", !confirmedAt.isEmpty,
              expense.id?.isEmpty == false else { return false }
        let a = review.after
        return expense.payee == a.payee && expense.date == a.date && expense.amount == a.amount && expense.currency == a.currency && expense.category == a.category && (a.id == nil || a.id == expense.id)
    }
}
struct TransactionRequest: Codable, Equatable, Identifiable, Sendable {
    let id, generation, threadID, operation: String
    let expenseID: String?
    let values: TransactionValues
}
struct TransactionConfirmation: Codable, Equatable, Identifiable, Sendable {
    let id, generation, threadID, reviewID, reviewToken: String
    var requestID: String? = nil
}
struct TransactionPacket: Codable, Sendable {
    let kind: String
    var request: TransactionRequest? = nil
    var confirmation: TransactionConfirmation? = nil
    var generation: String? = nil
    var requestID: String? = nil
    var review: TransactionReview? = nil
    var receipt: TransactionReceipt? = nil
    var state: String? = nil
}
