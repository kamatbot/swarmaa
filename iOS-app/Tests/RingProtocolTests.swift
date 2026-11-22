import XCTest
@testable import Swarmaa

final class RingProtocolTests: XCTestCase {
    private func bytes(_ hex: String) -> Data { Data(hex.split(separator: " ").map { UInt8($0, radix: 16)! }) }

    func testDeleteAckEchoesRemainingCount() {
        XCTAssertEqual(SR116Protocol.deleteAck(remaining: 3), bytes("FE FC 36 00 01 00 01 00 02 00 03 00"))
        let done = SR116Protocol.Frame(command: 0x36, totalPackets: 1, currentPacket: 1, payload: Data([2, 0]))
        XCTAssertEqual(SR116Protocol.remaining(done), 2)
        XCTAssertNil(SR116Protocol.remaining(.init(command: 0x34, totalPackets: 1, currentPacket: 1, payload: Data())))
    }

    func testRecordingStateAndCount() {
        XCTAssertEqual(SR116Protocol.isRecording(.init(command: 0x2F, totalPackets: 1, currentPacket: 1, payload: Data([0x50, 0]))), true)
        XCTAssertEqual(SR116Protocol.isRecording(.init(command: 0x2F, totalPackets: 1, currentPacket: 1, payload: Data([0x40, 0]))), false)
        XCTAssertEqual(SR116Protocol.recordingCount(.init(command: 0x3D, totalPackets: 1, currentPacket: 1, payload: Data([3, 0]))), 3)
        XCTAssertEqual(SR116Protocol.encode(.recordingCount), bytes("FE FC 3D 00 01 00 01 00 00 00"))
        XCTAssertEqual(SR116Protocol.encode(.stop), bytes("FE FC 40 00 01 00 01 00 00 00"))
    }

    func testAssemblerRequiresEveryPacketInOrder() throws {
        func packet(_ n: UInt16, of total: UInt16) -> SR116Protocol.Frame {
            .init(command: 0x34, totalPackets: total, currentPacket: n, payload: Data(repeating: 0, count: 6) + Data(repeating: UInt8(n), count: 80))
        }
        var a = SR116Protocol.RecordingAssembler()
        XCTAssertTrue(try a.accept(packet(1, of: 2)))
        XCTAssertFalse(a.isComplete)
        XCTAssertThrowsError(try a.accept(packet(3, of: 2)))
        var b = SR116Protocol.RecordingAssembler()
        _ = try b.accept(packet(1, of: 2)); _ = try b.accept(packet(2, of: 2))
        XCTAssertTrue(b.isComplete)
        XCTAssertEqual(b.opus.count, 4)
    }
}
