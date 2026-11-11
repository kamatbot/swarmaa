import Foundation
import CryptoKit

enum MemoLimits {
    static let count = 20
    static let bytes = 20 * 1024 * 1024
    static let seconds: TimeInterval = 15 * 60
    static func hash(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
struct MemoEnvelope: Codable, Sendable {
    let id, generation, hash: String
    let bytes: Int
    var valid: Bool {
        UUID(uuidString: id) != nil && UUID(uuidString: generation) != nil &&
        hash.count == 64 && hash.allSatisfy { $0.isHexDigit && !$0.isUppercase } && bytes > 0 && bytes <= MemoLimits.bytes
    }
}
