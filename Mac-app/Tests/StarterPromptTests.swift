import XCTest
@testable import Codenotch

final class StarterPromptTests: XCTestCase {
    func testNamesTheMCPServerToolsAndProjects() {
        let text = StarterPrompt.text(projects: ["project:demo", "project:web"])
        for needle in ["\"swarma\"", "swarm_status", "task_submit", "auto.read", "auto.patch", "context_get", "project:demo, project:web"] {
            XCTAssertTrue(text.contains(needle), needle)
        }
    }

    func testRemoteConnectionExplainsHowToAddTheServer() {
        let text = StarterPrompt.text(projects: [], remoteMCP: "https://api.swarmaa.com/mcp")
        XCTAssertTrue(text.contains("claude mcp add --transport http swarma https://api.swarmaa.com/mcp"))
        XCTAssertFalse(StarterPrompt.text(projects: []).contains("mcp add"))
    }

    func testFallsBackToTheGeneralProject() {
        XCTAssertTrue(StarterPrompt.text(projects: []).contains("My projects: project:general."))
    }
}

import SwiftUI

final class StarterPromptRenderTests: XCTestCase {
    @MainActor func testRendersForVisualCheck() throws {
        let view = VStack(alignment: .leading, spacing: 12) { StarterPromptBox(text: StarterPrompt.text(projects: ["project:demo"])) }
            .padding(24).frame(width: 672)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let rep = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: NSTemporaryDirectory() + "starter-prompt.png"))
    }
}
