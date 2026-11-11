import XCTest
import SwiftUI
@testable import Codenotch

/// What oMLX's cells show on the notch and in the menu bar's menu: speed
/// measured by the runtime, the context ring, today's ledger, and the phase
/// and queue its admin endpoint reports.
@MainActor
final class OMLXViewTests: XCTestCase {
    private let qwen = OMLXMetrics.cellID(instance: "Qwen3.8-27B-oQ8e-mtp")
    private let flash = OMLXMetrics.cellID(instance: "Qwen3.8-flash-oQ4e")

    private func model(_ id: String, context: Int) -> [String: Any] {
        ["id": id, "loaded": true, "is_loading": false, "estimated_size": 1_000_000, "actual_size": 900_000,
         "engine_type": "vlm", "model_context_length": context, "max_context_window": context,
         "is_helper": false, "is_hidden": false]
    }

    private func runtime() throws -> ProviderSnapshot {
        OMLXFixtures.snapshot(try OMLXUsage.parse(OMLXFixtures.listing([
            model("Qwen3.8-27B-oQ8e-mtp", context: 32_768), model("Qwen3.8-flash-oQ4e", context: 8192)
        ])))
    }

    private func ollama(_ names: [String]) throws -> ProviderSnapshot {
        let data = try JSONSerialization.data(withJSONObject: ["models": names.map { ["name": $0, "size": 4_831_838_208] }])
        return ProviderSnapshot(id: "ollama-local", displayName: "Ollama", glyph: .ollamaLocal, fidelity: .official,
                                status: .ok, windows: [], kind: .localRuntime, localRuntime: try OllamaLocalUsage.parse(data))
    }

    func testTheSettingsRowRendersOnAndOff() async throws {
        let domain = "OMLXSettingsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let preferences = Preferences(defaults: defaults)
        let store = UsageStore(providers: [OMLXLocalProvider(endpoint: URL(string: OMLXEndpoint.defaultAddress)!,
                                                              session: URLSession(configuration: .ephemeral), key: { nil })],
                               archive: UsageArchive(defaults: defaults), disconnected: [OMLXMetrics.providerID])
        let metrics = OMLXMetrics(makeLink: { _ in OMLXLinkStub() },
                                  logsDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(domain))
        for enabled in [false, true] {
            preferences.setConnected(enabled, for: OMLXMetrics.providerID)
            store.disconnected = preferences.disconnectedIDs(among: store.knownIDs)
            let content = OMLXSettingsRow(preferences: preferences, store: store, metrics: metrics)
                .padding(20).frame(width: 460).background(Color(nsColor: .windowBackgroundColor))
            let hosting = NSHostingView(rootView: content)
            hosting.frame = NSRect(origin: .zero, size: hosting.fittingSize)
            hosting.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(hosting.fittingSize.height, 100)
            let rep = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
            let image = NSImage(size: hosting.bounds.size)
            image.addRepresentation(rep)
            try save(image, name: "omlx-settings-\(enabled ? "on" : "off").png")
        }
        metrics.stop()
    }

    private func save(_ image: NSImage, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["OMLX_RENDER_DIRECTORY"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
    }
}
