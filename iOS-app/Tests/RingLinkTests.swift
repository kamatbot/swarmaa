import XCTest
@testable import Swarmaa

/// Pure ring-path rules (docs/perf/ring-latency-2026-11-22.md F9–F11, F16).
final class RingLinkTests: XCTestCase {
    func testLiveAndFileTimeouts() {
        XCTAssertEqual(RingPolicy.liveTimeout(duration: 0), 2, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.liveTimeout(duration: 10), 2.5, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.liveTimeout(duration: 120), 8, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.liveTimeout(duration: 600), 8, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.fileTimeout(duration: 0), 4, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.fileTimeout(duration: 10), 9, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.fileTimeout(duration: 32), 20, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.fileTimeout(duration: 300), 20, accuracy: 1e-9)
        // Bad durations fall back to the floor instead of a NaN or negative wait.
        XCTAssertEqual(RingPolicy.liveTimeout(duration: -5), 2, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.fileTimeout(duration: .nan), 4, accuracy: 1e-9)
        XCTAssertEqual(RingPolicy.estimatedDuration(bytes: 40_000), 10, accuracy: 1e-9)
    }

    func testFileFallbackSkippedOnlyForBackgroundRecognizerErrors() {
        XCTAssertFalse(RingPolicy.tryFileFallback(background: true, liveRecognizerFailed: true))
        XCTAssertTrue(RingPolicy.tryFileFallback(background: true, liveRecognizerFailed: false)) // timeout / decode failure
        XCTAssertTrue(RingPolicy.tryFileFallback(background: false, liveRecognizerFailed: true))
        XCTAssertTrue(RingPolicy.tryFileFallback(background: false, liveRecognizerFailed: false))
    }

    func testAbortRetryCounterIsBounded() {
        XCTAssertFalse(RingPolicy.retriesAfterAbort(streak: 0))
        XCTAssertEqual((1...6).map { RingPolicy.retriesAfterAbort(streak: $0) }, [true, true, true, false, false, false])
        XCTAssertEqual(RingPolicy.maxAbortRetries, 3)
    }

    func testUndeliveredListAddsOnceRemovesAndStaysBounded() {
        var list: [String] = []
        list = RingPolicy.adding("/m/g/a.m4a", to: list)
        list = RingPolicy.adding("/m/g/b.m4a", to: list)
        list = RingPolicy.adding("/m/g/a.m4a", to: list)
        XCTAssertEqual(list, ["/m/g/b.m4a", "/m/g/a.m4a"])
        XCTAssertEqual(RingPolicy.removing("/m/g/b.m4a", from: list), ["/m/g/a.m4a"])
        XCTAssertEqual(RingPolicy.removing("/m/g/zzz.m4a", from: list), list)

        var many: [String] = []
        for i in 0..<(RingPolicy.undeliveredLimit + 7) { many = RingPolicy.adding("/m/g/\(i).m4a", to: many) }
        XCTAssertEqual(many.count, RingPolicy.undeliveredLimit)
        XCTAssertEqual(many.last, "/m/g/\(RingPolicy.undeliveredLimit + 6).m4a")

        // The list round-trips through UserDefaults as a plain string array.
        let defaults = UserDefaults(suiteName: "ring-tests-" + UUID().uuidString)!
        defaults.set(list, forKey: "ring.undelivered")
        XCTAssertEqual(defaults.stringArray(forKey: "ring.undelivered"), list)
    }

    func testReplayKeepsCurrentGenerationExistingAndIdleMemos() {
        let a = "/docs/Watch Memos/gen1/8f2c1d9e-3b4a-4c5d-8e6f-7a8b9c0d1e2f.m4a"
        let b = "/docs/Watch Memos/gen1/2B9F4C3A-1D2E-4F50-8A6B-7C8D9E0F1A2B.m4a"
        let other = "/docs/Watch Memos/gen2/11111111-1D2E-4F50-8A6B-7C8D9E0F1A2B.m4a"
        let gone = "/docs/Watch Memos/gen1/22222222-1D2E-4F50-8A6B-7C8D9E0F1A2B.m4a"
        let text = "/docs/Watch Memos/gen1/33333333-1D2E-4F50-8A6B-7C8D9E0F1A2B.txt"
        let list = [a, b, other, gone, text, a]
        let replay = RingPolicy.replayable(list, generation: "gen1", busy: ["2b9f4c3a-1d2e-4f50-8a6b-7c8d9e0f1a2b"]) { $0 != gone }
        XCTAssertEqual(replay.map(\.path), [a])
        XCTAssertEqual(RingPolicy.replayable(list, generation: "gen1", busy: []) { $0 != gone }.map(\.path), [a, b])
        XCTAssertEqual(RingPolicy.replayable([], generation: "gen1", busy: []) { _ in true }, [])
    }

    func testAssemblerKeepsPacketsContiguous() throws {
        func packet(_ n: UInt16, of total: UInt16) -> SR116Protocol.Frame {
            .init(command: 0x34, totalPackets: total, currentPacket: n, payload: Data(repeating: 0, count: 6) + Data(repeating: UInt8(n), count: 80))
        }
        var a = SR116Protocol.RecordingAssembler()
        _ = try a.accept(packet(1, of: 2))
        XCTAssertEqual(a.opusCount, 2)
        XCTAssertEqual(a.opusSlice(fromPacket: 1).count, 40)
        _ = try a.accept(packet(1, of: 2)) // exact retransmission is ignored
        _ = try a.accept(packet(2, of: 2))
        XCTAssertEqual(a.opusCount, 4)
        XCTAssertEqual(a.opusBytes.count, 160)
        XCTAssertEqual(Array(a.opusSlice(fromPacket: 2)), Array(repeating: 2, count: 80))
        XCTAssertEqual(a.opusSlice(fromPacket: 4).count, 0)
        XCTAssertEqual(a.opus.map(\.count), [40, 40, 40, 40])
        XCTAssertEqual(a.seconds, 4 * 0.02, accuracy: 1e-9)
    }
}
