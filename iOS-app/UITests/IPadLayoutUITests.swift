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

        app.buttons["pane-tasks"].tap()
        XCTAssertTrue(app.staticTexts["Fix the plan limits on the pricing page"].waitForExistence(timeout: 3), "Tasks pane in the main area")
        XCTAssertFalse(app.buttons["ipad-bot-launch"].exists)
        shot(app, "ipad-landscape-tasks")
        app.buttons["pane-usage"].tap()
        XCTAssertTrue(app.buttons["Refresh usage"].waitForExistence(timeout: 3), "Usage pane in the main area")
        shot(app, "ipad-landscape-usage")
        app.buttons["pane-bots"].tap()
        XCTAssertTrue(app.buttons["ipad-bot-launch"].waitForExistence(timeout: 3))
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

    /// Present now (no retry window) and inside the window, not scrolled out of view.
    private func onScreen(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        element.exists && element.isHittable && app.windows.firstMatch.frame.contains(element.frame)
    }

    /// The thread must still show its newest message after the map changes the column width (it went blank on device).
    func testThreadStaysVisibleWhenMapToggles() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad layout")
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-long-thread-demo"]
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            app.launch()
            let newest = app.staticTexts["Demo reply 100"]
            XCTAssertTrue(newest.waitForExistence(timeout: 10))
            XCTAssertTrue(newest.isHittable, "newest message on screen at launch")
            let name = orientation == .portrait ? "portrait" : "landscape"
            for step in ["open", "closed", "open"] {
                app.buttons["toggle-swarm-map"].tap()
                sleep(1)
                shot(app, "ipad-\(name)-map-\(step)")
                XCTAssertTrue(onScreen(app, newest), "\(name): newest message visible with the map \(step)")
            }
            // Another bot and back with the map open.
            app.buttons["ipad-bot-watch"].tap(); app.buttons["ipad-bot-launch"].tap()
            sleep(1)
            XCTAssertTrue(onScreen(app, newest), "\(name): newest message visible after switching bots")
            // Scrolled to the top, then the map closes: the top of the thread stays on screen, not a blank column.
            let thread = app.scrollViews.containing(.staticText, identifier: "Demo reply 100").firstMatch
            let first = app.staticTexts["Plan Friday’s launch. Ask me before anything goes public."]
            for _ in 0..<40 where !onScreen(app, first) { thread.swipeDown(velocity: .fast) }
            XCTAssertTrue(onScreen(app, first), "\(name): scrolled to the top")
            app.buttons["toggle-swarm-map"].tap(); sleep(1)
            shot(app, "ipad-\(name)-top-map-closed")
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Demo reply' OR label BEGINSWITH 'Plan Friday'")).allElementsBoundByIndex.contains { onScreen(app, $0) },
                          "\(name): thread not blank after the map closes while scrolled up")
            app.buttons["toggle-swarm-map"].tap(); sleep(1)
            app.terminate()
        }
    }
}
