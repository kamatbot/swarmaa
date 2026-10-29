import XCTest

@MainActor final class NavigationTests: XCTestCase {
    func testColouredBotAppearance() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-appearance-demo"]
        app.launch()
        let row = app.buttons["bot-launch"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let home = XCTAttachment(screenshot: app.screenshot())
        home.name = "Bot appearance — peach Scout home"; home.lifetime = .keepAlways; add(home)
        row.tap()
        XCTAssertTrue(app.textFields["composer"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Launch"].exists)
        let thread = XCTAttachment(screenshot: app.screenshot())
        thread.name = "Bot appearance — peach Scout thread"; thread.lifetime = .keepAlways; add(thread)
        app.buttons["Back to bots"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 3))
    }

    func testHomeRowOpensBot() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo"]
        app.launch()
        let row = app.buttons["bot-watch"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.isHittable)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Home — playful bot rows"
        capture.lifetime = .keepAlways
        add(capture)
        row.tap()
        XCTAssertTrue(app.textFields["composer"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Competitor watch"].exists)
        app.buttons["Back to bots"].tap()
        XCTAssertTrue(app.buttons["bot-watch"].waitForExistence(timeout: 3))
    }

    func testSearchAndUsageWithLargerText() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
        app.launch()
        let search = app.textFields["Search bots"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("No matching bot")
        XCTAssertTrue(app.staticTexts["No bots match “No matching bot”. Try another name or job."].exists)
        app.buttons["Clear search"].tap()
        XCTAssertTrue(app.buttons["bot-launch"].exists)
        app.buttons["Usage"].tap()
        XCTAssertTrue(app.staticTexts["USAGE."].waitForExistence(timeout: 3))
        let refresh = app.buttons["Refresh usage"]
        for _ in 0..<8 {
            if refresh.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(refresh.isHittable, "Routing and refresh remain reachable with larger text")
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Usage — accessibility text"
        capture.lifetime = .keepAlways
        add(capture)
        app.buttons["Close"].tap()
        app.buttons["You"].tap()
        let hosts = app.buttons.containing(.staticText, identifier: "Hosts and devices").firstMatch
        XCTAssertTrue(hosts.waitForExistence(timeout: 3))
        if !hosts.isHittable { app.scrollViews.firstMatch.swipeUp() }
        XCTAssertTrue(hosts.isHittable, "The account sheet scrolls at larger text sizes")

        app.terminate()
        app.launchArguments += ["-screen", "newBot"]
        app.launch()
        XCTAssertTrue(app.buttons["close-sheet"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["close-sheet"].isHittable)
        let fields = app.scrollViews["new-bot-fields"]
        let project = app.buttons["project-picker"]
        let lead = app.buttons["lead-picker"]
        for _ in 0..<5 {
            if project.isHittable && lead.isHittable { break }
            fields.swipeUp()
        }
        XCTAssertTrue(project.isHittable)
        XCTAssertTrue(lead.isHittable)
        XCTAssertGreaterThan(lead.frame.minY, project.frame.maxY, "Large-text pickers stack without overlap")
        let formCapture = XCTAttachment(screenshot: app.screenshot())
        formCapture.name = "New bot — accessibility text"
        formCapture.lifetime = .keepAlways
        add(formCapture)

        app.terminate()
        app.launchArguments = ["-demo", "-screen", "settings", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
        app.launch()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 5))
        XCTAssertTrue(hittable(app.buttons["Close"]))
        app.buttons["Close"].tap()
        XCTAssertTrue(app.textFields["composer"].waitForExistence(timeout: 3))
        XCTAssertTrue(hittable(app.buttons["chat-options"]))
        XCTAssertTrue(hittable(app.buttons["Add photo"]))
        XCTAssertTrue(hittable(app.buttons["Dictate message"]))
        let chatCapture = XCTAttachment(screenshot: app.screenshot())
        chatCapture.name = "Chat — accessibility text"
        chatCapture.lifetime = .keepAlways
        add(chatCapture)
    }

    func testPhotoPickerAddsAndRemovesPhoto() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-screen", "thread"]
        app.launch()
        let addPhoto = app.buttons["Add photo"]
        XCTAssertTrue(addPhoto.waitForExistence(timeout: 10))
        addPhoto.tap()
        let photo = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription)
        if photo.exists { photo.tap() }
        let done = app.buttons["Done"]
        if done.waitForExistence(timeout: 3) && done.isEnabled { done.tap() }
        let remove = app.buttons["Remove photo"]
        XCTAssertTrue(remove.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["Send message"].isEnabled)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Selected photo in chat"
        capture.lifetime = .keepAlways
        add(capture)
        if remove.exists { remove.tap(); XCTAssertFalse(remove.exists) }
    }

    func testPhotoDraftSurvivesBotSwitch() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-screen", "thread", "-photo-preview-demo"]
        app.launch()
        XCTAssertTrue(app.buttons["Remove photo"].waitForExistence(timeout: 10))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "Chat photo preview"
        capture.lifetime = .keepAlways
        add(capture)
        app.textFields["composer"].tap()
        app.textFields["composer"].typeText("Keep this draft")
        app.buttons["Back to bots"].tap()
        app.buttons["bot-watch"].tap()
        XCTAssertFalse(app.buttons["Remove photo"].exists)
        app.buttons["Back to bots"].tap()
        app.buttons["starred-shortcut"].tap()
        XCTAssertTrue(app.buttons["Remove photo"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.textFields["composer"].value as? String, "Keep this draft")
        app.buttons["Remove photo"].tap()
        XCTAssertFalse(app.buttons["Remove photo"].exists)
    }

    func testHiddenOptionAndSettingsActionsAtBottom() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-hidden-bot-demo"]
        app.launch()
        XCTAssertFalse(app.switches["Show hidden"].exists)
        let section = app.buttons["hidden-section"]
        XCTAssertTrue(section.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["bot-notes"].exists)
        section.tap()
        app.scrollViews.firstMatch.swipeUp()
        let hidden = app.buttons["bot-notes"]
        XCTAssertTrue(hidden.waitForExistence(timeout: 3))
        hidden.tap()
        app.buttons["chat-options"].tap()
        app.buttons["Bot settings"].tap()
        XCTAssertTrue(app.buttons["Delete bot…"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Unhide"].exists)
        XCTAssertFalse(app.buttons["Hide bot"].exists)
        XCTAssertGreaterThan(app.buttons["Delete bot…"].frame.midY, app.frame.midY)
        app.buttons["Close"].tap()
        app.buttons["Back to bots"].tap()
        app.buttons["starred-shortcut"].tap()
        app.buttons["chat-options"].tap()
        app.buttons["Bot settings"].tap()
        XCTAssertTrue(app.buttons["Hide bot"].waitForExistence(timeout: 3))
        XCTAssertGreaterThan(app.buttons["Hide bot"].frame.midY, app.frame.midY)
        XCTAssertTrue(app.buttons["Delete bot…"].exists, "delete is offered on visible bots too")
    }

    func testDemoNavigationAndSingleStarredShortcut() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["BOTS."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "starred-shortcut").count, 1)
        app.buttons["Tasks"].tap()
        XCTAssertTrue(app.staticTexts["TASKS."].waitForExistence(timeout: 3))
        app.buttons["Working"].tap()
        XCTAssertTrue(app.staticTexts["Check the launch calendar"].exists)
        app.buttons["Close"].tap()
        app.buttons["Usage"].tap()
        XCTAssertTrue(app.staticTexts["USAGE."].waitForExistence(timeout: 3))
        app.buttons["Close"].tap()
        app.buttons["starred-shortcut"].tap()
        XCTAssertTrue(app.textFields["composer"].waitForExistence(timeout: 3))
        XCTAssertTrue(hittable(app.buttons["Add photo"]))
        XCTAssertTrue(hittable(app.buttons["Dictate message"]))
        XCTAssertGreaterThanOrEqual(app.buttons["chat-options"].frame.width, 44)
        XCTAssertTrue(app.staticTexts["Scout"].exists)
        app.scrollViews.firstMatch.swipeDown()
        XCTAssertTrue(app.staticTexts["Plan Friday’s launch. Ask me before anything goes public."].exists)
        app.buttons["chat-options"].tap()
        app.buttons["Bot settings"].tap()
        XCTAssertTrue(app.buttons["Save changes"].waitForExistence(timeout: 3))
        app.buttons["Close"].tap()
        app.buttons["Back to bots"].tap()
        app.buttons["You"].tap()
        XCTAssertTrue(app.buttons.containing(.staticText, identifier: "New bot").firstMatch.waitForExistence(timeout: 3))
        app.buttons.containing(.staticText, identifier: "New bot").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["NEW BOT."].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Make bot"].isEnabled)
        let fields = app.scrollViews["new-bot-fields"]
        XCTAssertTrue(app.textFields["01 — Name"].exists)
        XCTAssertTrue(app.textFields["02 — What it does"].exists)
        fields.swipeUp()
        XCTAssertTrue(app.buttons["project-picker"].isHittable)
        app.buttons["project-picker"].tap()
        app.buttons["swarma"].tap()
        app.buttons["lead-picker"].tap()
        XCTAssertTrue(app.buttons["A new agent"].exists)
        XCTAssertTrue(app.buttons["Atlas"].exists)
        XCTAssertTrue(app.buttons["Scout"].exists)
        app.buttons["A new agent"].tap()
        let replies = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Haiku 5.5")).firstMatch
        XCTAssertTrue(replies.isHittable)
        replies.tap()
        for choice in ["Haiku 5.5", "Sonnet 5.5", "Opus 5.5", "Gemini Flash", "Agent’s own model"] {
            XCTAssertTrue(app.buttons[choice].exists)
        }
        app.buttons["Haiku 5.5"].tap()
        XCTAssertTrue(app.buttons["Make bot"].isHittable)
        app.buttons["close-sheet"].tap()
        app.buttons["You"].tap()
        app.buttons.containing(.staticText, identifier: "Hosts and devices").firstMatch.tap()
        // Pairing is one 6-digit field: no QR, no link, no host ID.
        XCTAssertTrue(app.textFields["6-digit pairing code"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Scan QR code"].exists)
        XCTAssertFalse(app.buttons["Paste link"].exists)
        XCTAssertFalse(app.buttons["Connect"].isEnabled)
        app.buttons["Close"].tap()
        app.buttons["starred-shortcut"].tap()
        app.buttons["Answer question"].tap()
        XCTAssertTrue(app.buttons["Blog and changelog"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Blog and changelog"].isHittable)
        XCTAssertTrue(app.staticTexts["WHICH CHANNELS SHOULD THE LAUNCH USE?"].exists)
        app.buttons["close-sheet"].tap()
    }

    // Regression: tapping the mic trapped in Swift 6 when Apple's permission callback arrived off the main actor.
    func testMicDoesNotCrash() {
        let app = XCUIApplication()
        app.launchArguments = ["-demo", "-screen", "thread"]
        app.resetAuthorizationStatus(for: .microphone)
        app.launch()
        let mic = app.buttons["Dictate message"]
        XCTAssertTrue(mic.waitForExistence(timeout: 10))
        mic.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<2 {
            let allow = springboard.buttons.matching(NSPredicate(format: "label IN {'OK', 'Allow'}")).firstMatch
            if allow.waitForExistence(timeout: 5) { allow.tap() }
        }
        sleep(2)
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(app.buttons["Dictate message"].exists || app.buttons["Stop dictation"].exists)
    }

    /// A new user sees one big "Make your first bot" item; anyone with bots gets a + in the header instead.
    func testNewBotEntryPoints() {
        let fresh = XCUIApplication()
        fresh.launchArguments = ["-demo", "-new-user-demo"]
        fresh.launch()
        let card = fresh.buttons["new-bot-card"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertFalse(fresh.buttons["new-bot-header"].exists)
        let capture = XCTAttachment(screenshot: fresh.screenshot()); capture.name = "New user — first bot card"; capture.lifetime = .keepAlways; add(capture)
        card.tap()
        XCTAssertTrue(fresh.buttons["close-sheet"].waitForExistence(timeout: 5), "The card opens the new bot sheet")
        fresh.terminate()

        let returning = XCUIApplication()
        returning.launchArguments = ["-demo"]
        returning.launch()
        let plus = returning.buttons["new-bot-header"]
        XCTAssertTrue(plus.waitForExistence(timeout: 10))
        XCTAssertFalse(returning.buttons["new-bot-card"].exists)
        plus.tap()
        XCTAssertTrue(returning.buttons["close-sheet"].waitForExistence(timeout: 5), "The + opens the new bot sheet")
    }

    /// Screens slide in over home; wait for the slide to settle before asking whether a control can be tapped.
    private func hittable(_ element: XCUIElement, timeout: TimeInterval = 2) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if element.exists && element.isHittable { return true }; RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        return element.isHittable
    }
}
