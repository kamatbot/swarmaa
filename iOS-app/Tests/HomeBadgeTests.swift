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
