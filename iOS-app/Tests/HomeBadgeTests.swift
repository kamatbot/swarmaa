import XCTest
@testable import Swarmaa

final class HomeBadgeTests: XCTestCase {
    func testBadgeAppearsOrIncreasesOnly() {
        for (old, new, expected) in [(0, 1, true), (2, 3, true), (3, 2, false), (2, 2, false), (2, 0, false), (0, 0, false)] {
            XCTAssertEqual(shouldPopHomeBadge(oldUnread: old, oldNeedsYou: 0, unread: new, needsYou: 0), expected)
            XCTAssertEqual(shouldPopHomeBadge(oldUnread: 0, oldNeedsYou: old, unread: 0, needsYou: new), expected)
        }
        XCTAssertTrue(shouldPopHomeBadge(oldUnread: 5, oldNeedsYou: 0, unread: 0, needsYou: 1))
        XCTAssertTrue(shouldPopHomeBadge(oldUnread: 0, oldNeedsYou: 5, unread: 1, needsYou: 0))
        XCTAssertFalse(shouldPopHomeBadge(oldUnread: 5, oldNeedsYou: 2, unread: 4, needsYou: 1))
    }
}

@MainActor
final class UnreadClearTests: XCTestCase {
    /// The iPad keeps the bot list on screen, so a read thread must clear its badge locally.
    func testReadingAThreadClearsItsUnreadBadgeOnly() throws {
        let model = AppModel()
        let a = Bot(raw: try JSON.parse(#"{"id":"a","badges":{"unread":3}}"#))
        let b = Bot(raw: try JSON.parse(#"{"id":"b","badges":{"unread":2}}"#))
        model.bots = [a, b]
        model.clearUnread("a")
        XCTAssertEqual(model.bots.map(\.unread), [0, 2])
        model.visibleThreadBotID = "b"
        model.clearVisibleUnread()
        XCTAssertEqual(model.bots.map(\.unread), [0, 0])
    }
}
