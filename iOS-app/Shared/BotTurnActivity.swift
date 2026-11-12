import ActivityKit
import Foundation

public struct BotTurnAttributes: ActivityAttributes, Sendable, Codable, Hashable {
    public struct ContentState: Codable, Hashable, Sendable {
        public var status: String // running | needs_you | done | failed
        public var step: String // short current activity label
        public var startedAt: Date
        public var endedAt: Date?

        public init(status: String, step: String, startedAt: Date, endedAt: Date? = nil) {
            self.status = status
            self.step = step
            self.startedAt = startedAt
            self.endedAt = endedAt
        }
    }

    public var botId: String
    public var botName: String
    public var avatar: String?
    public var color: String?

    public init(botId: String, botName: String, avatar: String? = nil, color: String? = nil) {
        self.botId = botId
        self.botName = botName
        self.avatar = avatar
        self.color = color
    }
}
