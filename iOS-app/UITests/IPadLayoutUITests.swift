import XCTest

/// iPad only: the three-column workspace, its tabs, the swarm map and monitor, and Mark resolved.
/// Run with TEST_RUNNER_SCREENSHOT_DIR=<dir> (seen here as SCREENSHOT_DIR) to also write each screenshot as a PNG there.
@MainActor final class IPadLayoutUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, _ name: String) {
        // The screen, not the app element (an app shot comes back clipped in landscape). It keeps the portrait
        // framebuffer, so landscape files need a 90° turn (sips -r 90).
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        if let dir = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"], !dir.isEmpty {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
        }
    }

    override func tearDown() async throws {
        XCUIDevice.shared.orientation = .portrait
    }

    func testWorkspaceTabsMapMonitorAndResolve() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad layout")
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-handover-demo"]
        app.launch()
        XCTAssertTrue(app.buttons["ipad-bot-launch"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["composer"].waitForExistence(timeout: 3), "Thread tab shows the composer")
        shot(app, "ipad-landscape-thread")

        app.buttons["tab-timeline"].tap()
        XCTAssertTrue(app.staticTexts["Draft the launch banner"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.textFields["composer"].exists)
        shot(app, "ipad-landscape-timeline")

        app.buttons["tab-logs"].tap()
        XCTAssertTrue(app.scrollViews["ipad-logs"].waitForExistence(timeout: 3))
        app.buttons["tab-thread"].tap()

        app.buttons["toggle-swarm-map"].tap()
        XCTAssertTrue(app.buttons["swarm-monitor"].waitForExistence(timeout: 3))
        shot(app, "ipad-landscape-map")

        app.buttons["swarm-monitor"].tap()
        XCTAssertTrue(app.staticTexts["Swarm monitor"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["ipad-bot-launch"].exists, "Monitor hides the sidebar")
        sleep(1)
        shot(app, "ipad-monitor")
        app.buttons["exit-monitor"].tap()
        XCTAssertTrue(app.buttons["ipad-bot-launch"].waitForExistence(timeout: 3))
        app.buttons["toggle-swarm-map"].tap()

        // Mark resolved takes the task out of Needs you at once.
        let resolve = app.buttons["mark-resolved-banner"]
        XCTAssertTrue(resolve.waitForExistence(timeout: 3))
        resolve.tap()
        XCTAssertTrue(resolve.waitForNonExistence(timeout: 3))

        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.buttons["ipad-bot-launch"].waitForExistence(timeout: 3))
        shot(app, "ipad-portrait")
    }
}
