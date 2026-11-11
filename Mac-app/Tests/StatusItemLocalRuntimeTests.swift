import XCTest
import AppKit
@testable import Swarmaa

/// The menu bar's menu has to say about a local model what its cell says,
/// which the store's own snapshot of the runtime cannot: speed, phase, context
/// and today's tokens are put on the cells by `UsageBoard`.
@MainActor
final class StatusItemLocalRuntimeTests: XCTestCase {
    private let qwen = LMStudioMetrics.cellID(instance: "qwen3.8-27b")

    private func lmstudio(_ instances: [(id: String, key: String, context: Int?)]) throws -> ProviderSnapshot {
        LMStudioFixtures.snapshot(try LMStudioUsage.parse(LMStudioFixtures.listing(instances: instances)))
    }

    func testTheMenuListsEachLoadedModelWithWhatItsCellShows() throws {
        let runtime = try lmstudio([("qwen3.8-27b", "qwen/qwen3.8-27b", 32_768),
                                    ("flash-next-test", "qwen/qwen3.8-flash-next", 8192)])
        let ollamaData = try JSONSerialization.data(withJSONObject: ["models": [["name": "gemma4:e4b", "size": 4_831_838_208]]])
        let ollama = ProviderSnapshot(id: "ollama-local", displayName: "Ollama", glyph: .ollamaLocal, fidelity: .official,
                                      status: .ok, windows: [], kind: .localRuntime,
                                      localRuntime: try OllamaLocalUsage.parse(ollamaData))
        let cloud = Fixtures.snapshots()[0]

        let board = UsageBoard()
        board.setSnapshots([cloud, runtime, ollama])
        var ledger = LocalTokenLedger()
        ledger.record(LocalPrediction(instance: "qwen3.8-27b", at: Date().addingTimeInterval(-60),
                                      inputTokens: 20_000, outputTokens: 1_200), as: qwen)
        board.setLedger(ledger)
        board.setPerformances([qwen: try XCTUnwrap(LocalModelPerformance(outputTokens: 1200, tokensPerSecond: 24.1))],
                              source: "lmstudio")
        board.setLocalActivities([qwen: LocalModelActivity(phase: .processingPrompt, queued: 1, since: Date())])
        board.setThinkingModels(["gemma4:e4b": Date()])

        let controller = StatusItemController(onOpenSettings: {})
        controller.snapshots = [cloud, runtime, ollama]
        controller.cells = { board.snapshots }
        controller.activity = { board.activity(for: $0) }
        let menu = NSMenu()
        controller.rebuild(menu: menu, now: Date())
        let titles = menu.items.map(\.title)
        let joined = titles.joined(separator: "\n")

        let cell = try XCTUnwrap(board.snapshots.first { $0.id == qwen })
        XCTAssertTrue(titles.contains("LM Studio — 2 models loaded"), joined)
        XCTAssertTrue(titles.contains("qwen3.8-27b: \(cell.headlineText) · Prompt · 1 queued · Context 61% · Today 20k in · 1200 out"), joined)
        XCTAssertTrue(titles.contains("flash-next-test: — tok/s"), joined)
        XCTAssertTrue(titles.contains("Ollama — 1 model loaded"), joined)
        XCTAssertTrue(titles.contains("gemma4:e4b: \(expectedGigabytes(4.5)) · Thinking"), joined)
        XCTAssertTrue(titles.contains { $0.hasPrefix("Claude — 73%") }, joined)
        // The runtime's row refreshes the runtime; a model's line is not a button.
        let header = try XCTUnwrap(menu.items.first { $0.title.hasPrefix("LM Studio") })
        XCTAssertEqual(header.representedObject as? String, "lmstudio")
        XCTAssertNotNil(header.action)
        XCTAssertNil(try XCTUnwrap(menu.items.first { $0.title.hasPrefix("qwen3.8-27b") }).action)

        // A hidden model has no cell, so it has no line; the count still counts it.
        board.setSnapshots([cloud, ollama, runtime])
        board.setSnapshots(runtime.usageSnapshots.filter { $0.id == qwen } + [cloud])
        controller.rebuild(menu: menu, now: Date())
        XCTAssertFalse(menu.items.map(\.title).contains { $0.hasPrefix("flash-next-test") })
    }

    func testAnEmptyOrUnreachableRuntimeSaysSoOnce() throws {
        let controller = StatusItemController(onOpenSettings: {})
        let menu = NSMenu()
        controller.snapshots = [LMStudioFixtures.snapshot(LocalRuntimeReading(models: [], measuresSpeed: true))]
        controller.rebuild(menu: menu, now: Date())
        XCTAssertEqual(menu.items.map(\.title).first, "LM Studio — Server reachable · No models loaded")
        XCTAssertEqual(menu.items[1].isSeparatorItem, true, "the summary is not repeated under the header")

        var down = LMStudioFixtures.snapshot(LocalRuntimeReading(models: [], measuresSpeed: true))
        down = ProviderSnapshot(id: down.id, displayName: down.displayName, glyph: down.glyph, fidelity: .official,
                                status: .error(LMStudioError.needsToken.localizedDescription), windows: [],
                                kind: .localRuntime)
        controller.snapshots = [down]
        controller.rebuild(menu: menu, now: Date())
        XCTAssertEqual(menu.items.map(\.title).first, "LM Studio — —")
        XCTAssertTrue(menu.items[1].title.contains("API token"), menu.items[1].title)
        XCTAssertFalse(menu.items[1].isEnabled)
    }
}
