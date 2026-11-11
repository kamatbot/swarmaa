import Sparkle
import XCTest
@testable import Swarmaa

/// "Checking…" is a state the settings sheet must always leave: a check that
/// ends any other way, or never reports back, still lands somewhere.
@MainActor
final class UpdaterOutcomeTests: XCTestCase {
    func testACycleThatEndsSilentlyClearsChecking() {
        XCTAssertEqual(Updater.outcome(afterCycleFrom: .checking, errorCode: nil), .idle)
    }

    func testACycleThatCouldNotReachTheFeedSaysSo() {
        let code = Int(SUError.appcastError.rawValue)
        XCTAssertEqual(Updater.outcome(afterCycleFrom: .checking, errorCode: code), .unreachable)
    }

    func testAnAnswerAlreadyGivenIsKept() {
        XCTAssertEqual(Updater.outcome(afterCycleFrom: .found("1.14.0"), errorCode: nil), .found("1.14.0"))
        let upToDate = Updater.Outcome.upToDate(Date(timeIntervalSince1970: 1))
        XCTAssertEqual(Updater.outcome(afterCycleFrom: upToDate, errorCode: nil), upToDate)
    }

    func testACheckThatNeverAnswersStopsSayingChecking() {
        guard case .failed(let why) = Updater.outcome(afterTimeoutFrom: .checking) else {
            return XCTFail("a stalled check must not stay on Checking…")
        }
        XCTAssertTrue(why.contains("swarmaa.com"), why)
        XCTAssertEqual(Updater.outcome(afterTimeoutFrom: .upToDate(Date(timeIntervalSince1970: 1))),
                       .upToDate(Date(timeIntervalSince1970: 1)))
    }

}
