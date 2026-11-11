import XCTest
import SwiftUI
@testable import Swarmaa

final class OllamaPerformanceTests: XCTestCase {
    func testRateUsesOutputTokensAndGenerationTimeOnly() throws {
        let item: [String: Any] = ["done": true, "eval_count": 180, "eval_duration": 6_000_000_000,
            "prompt_eval_count": 10_000, "total_duration": 90_000_000_000, "load_duration": 20_000_000_000]
        let date = Date(timeIntervalSince1970: 123)
        let reading = try XCTUnwrap(LocalModelPerformance.parse(item, now: date))
        XCTAssertEqual(reading.tokensPerSecond, 30, accuracy: 0.0001)
        XCTAssertEqual(reading.outputTokens, 180)
        XCTAssertEqual(reading.generationSeconds, 6)
        XCTAssertEqual(reading.measuredAt, date)
        XCTAssertEqual(reading.band, .smooth)
    }

    func testMissingInvalidAndUnfinishedMetricsNeverBecomeZeroSpeed() {
        let valid: [String: Any] = ["done": true, "eval_count": 100, "eval_duration": 1_000_000_000]
        for value: Any in [0, -1, true, 0.5, "100", NSNull(), Double.infinity] {
            for key in ["eval_count", "eval_duration"] {
                var item = valid; item[key] = value
                XCTAssertNil(LocalModelPerformance.parse(item), "\(key): \(value)")
            }
        }
        for key in ["done", "eval_count", "eval_duration"] {
            var item = valid; item.removeValue(forKey: key)
            XCTAssertNil(LocalModelPerformance.parse(item))
        }
        var unfinished = valid; unfinished["done"] = false
        XCTAssertNil(LocalModelPerformance.parse(unfinished))
        var failed = valid; failed["error"] = "failed"
        XCTAssertNil(LocalModelPerformance.parse(failed))
    }

    func testSpeedBandsKeepTheirExactThresholds() throws {
        let cases: [(Int, LocalModelPerformance.Band)] = [(1, .verySlow), (9, .verySlow),
            (10, .slow), (19, .slow), (20, .smooth), (39, .smooth), (40, .veryFast), (100, .veryFast)]
        for (tokens, band) in cases {
            let reading = try XCTUnwrap(LocalModelPerformance(outputTokens: tokens, durationNanoseconds: 1_000_000_000))
            XCTAssertEqual(reading.band, band)
        }
    }

    func testFragmentedCompletionCountsTokensInsteadOfNetworkChunks() throws {
        var parser = OllamaThinkingStream(path: "/api/chat", body: Data(#"{"model":"qwen3"}"#.utf8))
        let payload = #"{"message":{"thinking":"reasoning"}}"# + "\n"
            + #"{"message":{"content":"answer"}}"# + "\n"
            + #"{"model":"qwen3:latest","done":true,"eval_count":180,"eval_duration":6000000000}"# + "\n"
        for byte in payload.utf8 { _ = parser.append(Data([byte])) }
        let reading = try XCTUnwrap(parser.takePerformance())
        XCTAssertEqual(reading.tokensPerSecond, 30)
        XCTAssertEqual(reading.outputTokens, 180)
        XCTAssertEqual(parser.model, "qwen3:latest")
        XCTAssertFalse(parser.isThinking)
        XCTAssertNil(parser.takePerformance(), "A final chunk is published only once")
    }

    func testNonStreamingMetricsWaitForEndAndNeverFlashThinking() throws {
        var parser = OllamaThinkingStream(path: "/api/generate", body: Data(#"{"model":"gemma4:e4b","stream":false}"#.utf8))
        let payload = "{\n\"thinking\":\"finished\",\"response\":\"4\",\"done\":true,\"eval_count\":100,\"eval_duration\":2000000000\n}"
        XCTAssertTrue(parser.append(Data(payload.utf8)).isEmpty)
        XCTAssertFalse(parser.isThinking)
        XCTAssertNil(parser.takePerformance())
        parser.finish()
        XCTAssertEqual(try XCTUnwrap(parser.takePerformance()).tokensPerSecond, 50)
        XCTAssertFalse(parser.isThinking)
    }

    func testIncompleteRequestsAndOpenAIUsageCannotInventNativeGenerationTime() {
        var interrupted = OllamaThinkingStream(path: "/api/generate", body: Data(#"{"model":"qwen3"}"#.utf8))
        _ = interrupted.append(Data((#"{"thinking":"pending"}"# + "\n").utf8))
        interrupted.finish()
        XCTAssertNil(interrupted.takePerformance())
        var openAI = OllamaThinkingStream(path: "/v1/chat/completions", body: Data(#"{"model":"qwen3","stream":true}"#.utf8))
        _ = openAI.append(Data(("data: " + #"{"choices":[],"usage":{"completion_tokens":100}}"# + "\n\ndata: [DONE]\n\n").utf8))
        XCTAssertNil(openAI.takePerformance())
    }
}

@MainActor
final class OllamaPerformanceViewTests: XCTestCase {

    private func runtime(names: [String]) throws -> ProviderSnapshot {
        let data = try JSONSerialization.data(withJSONObject: ["models": names.map {
            ["name": $0, "size": 4_831_838_208, "context_length": 2048,
             "details": $0.hasPrefix("qwen") ? [:]
                : ["quantization_level": $0.hasPrefix("llama") ? "Q8_0" : "Q4_K_M"]] as [String: Any]
        }])
        return ProviderSnapshot(id: "ollama-local", displayName: "Ollama", glyph: .ollama, fidelity: .official,
            status: .ok, windows: [], kind: .localRuntime, localRuntime: try OllamaLocalUsage.parse(data))
    }

    private func save(_ image: NSImage, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["OLLAMA_SPEED_RENDER_DIRECTORY"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
    }
}
