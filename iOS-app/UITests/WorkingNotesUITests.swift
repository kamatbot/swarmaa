import XCTest

@MainActor final class WorkingNotesUITests: XCTestCase {
    func testExpandCollapseAndReopenThread() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-working-notes-demo"]
        app.launch()
        app.buttons["starred-shortcut"].tap()
        let scroll = app.scrollViews.firstMatch
        scroll.swipeDown()
        let fold = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Worked for 3m · 2 steps")).firstMatch
        XCTAssertTrue(fold.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Checking the launch brief"].exists)
        fold.tap()
        XCTAssertTrue(app.staticTexts["Checking the launch brief"].waitForExistence(timeout: 3))
        app.buttons["Back to bots"].tap()
        app.buttons["starred-shortcut"].tap()
        scroll.swipeDown()
        XCTAssertTrue(app.staticTexts["Checking the launch brief"].exists)
        fold.tap()
        XCTAssertFalse(app.staticTexts["Checking the launch brief"].exists)
        scroll.swipeUp()
        XCTAssertTrue(app.buttons["Answer question"].exists)
        XCTAssertTrue(app.buttons["Approve"].exists)
    }
}
