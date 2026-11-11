import Foundation

// Only bounded, non-credential data crosses WatchConnectivity.
enum WatchLimits {
    static let queue = 40
    static let bodyBytes = 4_000
    static let packetBytes = 48_000
    static let bots = 20
    static let messages = 5
}
struct WatchBot: Codable, Identifiable, Sendable {
    let id, threadID, name: String
    let starred: Bool
    var messages: [WatchMessage]
    var omittedMessages = false
}
struct WatchMessage: Codable, Identifiable, Sendable {
    let id, text: String
    let human: Bool
}
struct WatchPost: Codable, Identifiable, Equatable, Sendable {
    let id, generation, botID, threadID, body: String
}
struct WatchSnapshot: Codable, Sendable {
    let revision: Int
    let epoch: String
    let generation: String
    let signedIn: Bool
    let bots: [WatchBot]
    var questions: [WatchQuestion]? = nil
    var moreQuestions: Bool? = nil
}
struct WatchPacket: Codable, Sendable {
    var kind: String
    var post: WatchPost? = nil
    var snapshot: WatchSnapshot? = nil
    var generation: String? = nil
    var id: String? = nil
    var status: String? = nil
    var hash: String? = nil
    var message: String? = nil // Server message id of a delivered post.
}
enum WatchCodec {
    static func encode(_ packet: WatchPacket) -> Data? {
        guard let data = try? JSONEncoder().encode(packet), data.count <= WatchLimits.packetBytes else { return nil }
        return data
    }
    static func decode(_ data: Data) -> WatchPacket? {
        guard data.count <= WatchLimits.packetBytes else { return nil }
        return try? JSONDecoder().decode(WatchPacket.self, from: data)
    }
}

struct WatchQuestionDetails: Codable, Sendable {
    let prompt: String
    let options: [String]
    let multi, freeText: Bool
    let actionKind, actionSummary, actionDetail, actionWhere, expiresAt: String
}
struct WatchQuestion: Codable, Identifiable, Sendable {
    let id, threadID: String
    var details: WatchQuestionDetails?
}
