import XCTest
import SwiftUI
@testable import Codenotch

@MainActor
final class LMStudioViewTests: XCTestCase {
    private let qwen = LMStudioMetrics.cellID(instance: "qwen3.8-27b")

    private func runtime() throws -> ProviderSnapshot {
        LMStudioFixtures.snapshot(try LMStudioUsage.parse(LMStudioFixtures.listing(instances: [
            ("qwen3.8-27b", "qwen/qwen3.8-27b", 32_768), ("flash-next-test", "qwen/qwen3.8-flash-next", 8192)
        ])))
    }

    private func ollama(_ names: [String]) throws -> ProviderSnapshot {
        let data = try JSONSerialization.data(withJSONObject: ["models": names.map { ["name": $0, "size": 4_831_838_208] }])
        return ProviderSnapshot(id: "ollama-local", displayName: "Ollama", glyph: .ollamaLocal, fidelity: .official,
                                status: .ok, windows: [], kind: .localRuntime, localRuntime: try OllamaLocalUsage.parse(data))
    }

    /// A second runtime (oMLX) reporting its own activities and ledger used
    /// to overwrite LM Studio's single slot; each source now keeps its own.
    private func secondRuntime() throws -> ProviderSnapshot {
        ProviderSnapshot(id: "omlx", displayName: "oMLX", glyph: .lmstudio, fidelity: .official, status: .ok,
                         windows: [], kind: .localRuntime,
                         localRuntime: try LMStudioUsage.parse(LMStudioFixtures.listing(instances: [
                             ("qwen3.8-27b-mlx", "qwen/qwen3.8-27b", 65_536)
                         ])))
    }

    func testASecondRuntimeNeverOverwritesLMStudiosLedger() throws {
        let board = UsageBoard()
        board.setSnapshots([try runtime(), try secondRuntime()])
        let mlx = "omlx:model:qwen3.8-27b-mlx"
        let now = Date()
        var lmstudioLedger = LocalTokenLedger()
        lmstudioLedger.record(LocalPrediction(instance: "qwen3.8-27b", at: now.addingTimeInterval(-1),
                                              inputTokens: 100, outputTokens: 10), as: qwen)
        var omlxLedger = LocalTokenLedger()
        omlxLedger.record(LocalPrediction(instance: "qwen3.8-27b-mlx", at: now.addingTimeInterval(-1),
                                          inputTokens: 200, outputTokens: 20), as: mlx)

        board.setLedger(lmstudioLedger, source: "lmstudio")
        board.setLedger(omlxLedger, source: "omlx")
        XCTAssertEqual(board.snapshots.first { $0.id == qwen }?.localLedger?.tokensTodayText, "100 in · 10 out")
        XCTAssertEqual(board.snapshots.first { $0.id == mlx }?.localLedger?.tokensTodayText, "200 in · 20 out")

        // And the other way round: LM Studio reporting again leaves oMLX's alone.
        board.setLedger(LocalTokenLedger(), source: "lmstudio")
        XCTAssertNil(board.snapshots.first { $0.id == qwen }?.localLedger)
        XCTAssertEqual(board.snapshots.first { $0.id == mlx }?.localLedger?.tokensTodayText, "200 in · 20 out")
    }

    func testTheBoardKeepsEachRuntimesActivitiesApart() throws {
        let board = UsageBoard()
        let mlx = "omlx:model:qwen3.8-27b-mlx"
        board.setSnapshots([try runtime(), try secondRuntime()])
        board.setLocalActivities([qwen: LocalModelActivity(phase: .generating, queued: 0, since: Date())], source: "lmstudio")
        board.setLocalActivities([mlx: LocalModelActivity(phase: .processingPrompt, queued: 1, since: Date())], source: "omlx")
        XCTAssertEqual(board.activity(for: board.snapshots.first { $0.id == qwen }!)?.sessions.first?.name, "Generating")
        XCTAssertEqual(board.activity(for: board.snapshots.first { $0.id == mlx }!)?.queued, 1)

        // LM Studio going idle clears only its own cell.
        board.setLocalActivities([:], source: "lmstudio")
        XCTAssertNil(board.activity(for: board.snapshots.first { $0.id == qwen }!))
        XCTAssertNotNil(board.activity(for: board.snapshots.first { $0.id == mlx }!), "LM Studio idling left oMLX busy")
    }

    func testTheSettingsRowRendersOnAndOff() async throws {
        let domain = "LMStudioSettingsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let preferences = Preferences(defaults: defaults)
        let store = UsageStore(providers: [LMStudioLocalProvider(endpoint: URL(string: LMStudioEndpoint.defaultAddress)!,
                                                                  session: URLSession(configuration: .ephemeral), token: { nil })],
                               archive: UsageArchive(defaults: defaults), disconnected: ["lmstudio"])
        let metrics = LMStudioMetrics(makeLink: { _ in LMStudioLinkStub() },
                                      logsDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(domain))
        for enabled in [false, true] {
            preferences.setConnected(enabled, for: "lmstudio")
            store.disconnected = preferences.disconnectedIDs(among: store.knownIDs)
            let content = LMStudioSettingsRow(preferences: preferences, store: store, metrics: metrics)
                .padding(20).frame(width: 460).background(Color(nsColor: .windowBackgroundColor))
            let hosting = NSHostingView(rootView: content)
            hosting.frame = NSRect(origin: .zero, size: hosting.fittingSize)
            hosting.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(hosting.fittingSize.height, 100)
            let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            let image = NSImage(size: hosting.bounds.size)
            image.addRepresentation(rep)
            try save(image, name: "lmstudio-settings-\(enabled ? "on" : "off").png")
        }
        metrics.stop()
    }

    private func save(_ image: NSImage, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["LMSTUDIO_RENDER_DIRECTORY"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
    }
}
