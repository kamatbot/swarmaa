import Foundation

// SR116 smart-ring codec. Kept in sync with FitOdds
// (ios/FitOdds/Core/BandDiagnosticProtocol.swift, docs/SR116-PROTOCOL.md).
// Swarmaa owns the ring's offline recordings; FitOdds only reads health history.

enum SR116Protocol {
    static let service = "56FF"
    static let writeCharacteristic = "33F3"
    static let notifyCharacteristic = "33F4"
    static let magic: UInt16 = 0xFCFE
    static let headerLength = 10
    static let maxPayload = 4096

    struct Frame: Equatable {
        let command: UInt16
        let totalPackets: UInt16
        let currentPacket: UInt16
        let payload: Data
    }

    enum DecodeError: Error, Equatable { case tooShort, badMagic, lengthMismatch, badPacketIndex }

    /// Read-only queries. Each reply is identified by the same command number.
    enum Query: UInt16, CaseIterable {
        case battery = 0x06
        case currentSteps = 0x1D
        case stepHistory = 0x21
        case sleepHistory = 0x22
        case healthHistory = 0x24
        case deviceInfo = 0x25
        case audioState = 0x2F
        case features = 0x37
        case recordingCount = 0x3D

        var title: String {
            switch self {
            case .battery: "Battery"
            case .currentSteps: "Current steps"
            case .stepHistory: "Step history (today)"
            case .sleepHistory: "Sleep history (today)"
            case .healthHistory: "Health history (today)"
            case .deviceInfo: "Device info"
            case .audioState: "Recording state"
            case .features: "Features"
            case .recordingCount: "Recordings on ring"
            }
        }

        /// Payload as the vendor app sends it; history queries take a day index (0 = today).
        func payload(day: UInt8 = 0) -> Data {
            switch self {
            case .battery, .audioState, .features: Data([0, 0])
            case .stepHistory, .sleepHistory, .healthHistory: Data([day])
            case .currentSteps, .deviceInfo, .recordingCount: Data()
            }
        }

        /// Replies that mean "no records" for a history query.
        var emptyReply: UInt16? {
            switch self {
            case .stepHistory: 0x2A
            case .sleepHistory: 0x2B
            case .healthHistory: 0x2D
            default: nil
            }
        }
    }

    static func encode(command: UInt16, payload: Data = Data(), totalPackets: UInt16 = 1, currentPacket: UInt16 = 1) -> Data {
        var out = Data(capacity: headerLength + payload.count)
        for value in [magic, command, totalPackets, currentPacket, UInt16(payload.count)] {
            out.append(UInt8(value & 0xFF)); out.append(UInt8(value >> 8))
        }
        out.append(payload)
        return out
    }

    static func encode(_ query: Query, day: UInt8 = 0) -> Data { encode(command: query.rawValue, payload: query.payload(day: day)) }

    static func decode(_ data: Data) throws -> Frame {
        let b = [UInt8](data)
        guard b.count >= headerLength else { throw DecodeError.tooShort }
        func u16(_ i: Int) -> UInt16 { UInt16(b[i]) | UInt16(b[i + 1]) << 8 }
        guard u16(0) == magic else { throw DecodeError.badMagic }
        let length = Int(u16(8))
        guard length <= maxPayload, b.count == headerLength + length else { throw DecodeError.lengthMismatch }
        let total = u16(4), current = u16(6)
        guard total >= 1, current >= 1, current <= total else { throw DecodeError.badPacketIndex }
        return Frame(command: u16(2), totalPackets: total, currentPacket: current, payload: Data(b[headerLength...]))
    }

    // MARK: - Payload readers

    /// Device timestamps are 6-byte LE seconds of *local* wall-clock time.
    static func date(fromDeviceSeconds seconds: UInt64, timeZone: TimeZone = .current) -> Date {
        let local = TimeInterval(seconds)
        let offset = TimeInterval(timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: local)))
        return Date(timeIntervalSince1970: local - offset)
    }

    struct Reader {
        private let bytes: [UInt8]
        private(set) var offset = 0
        init(_ data: Data) { bytes = [UInt8](data) }
        var remaining: Int { bytes.count - offset }
        mutating func u8() -> UInt8? { guard remaining >= 1 else { return nil }; defer { offset += 1 }; return bytes[offset] }
        mutating func u16() -> UInt16? { guard remaining >= 2 else { return nil }; defer { offset += 2 }; return UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8 }
        mutating func i16() -> Int16? { u16().map { Int16(bitPattern: $0) } }
        mutating func u32() -> UInt32? {
            guard remaining >= 4 else { return nil }; defer { offset += 4 }
            return (0..<4).reduce(UInt32(0)) { $0 | UInt32(bytes[offset + $1]) << (8 * $1) }
        }
        mutating func seconds6() -> UInt64? {
            guard remaining >= 6 else { return nil }; defer { offset += 6 }
            return (0..<6).reduce(UInt64(0)) { $0 | UInt64(bytes[offset + $1]) << (8 * $1) }
        }
        mutating func bytes(_ n: Int) -> [UInt8]? { guard remaining >= n else { return nil }; defer { offset += n }; return Array(bytes[offset..<offset + n]) }
    }

    /// Splits a history payload into fixed-size records, skipping all-0xFF padding records.
    static func records(_ payload: Data, size: Int) -> [Data] {
        let b = [UInt8](payload)
        return stride(from: 0, through: b.count - size, by: size).compactMap { start in
            let r = b[start..<start + size]
            return r.allSatisfy { $0 == 0xFF } ? nil : Data(r)
        }
    }

    struct StepRecord: Equatable { let deviceSeconds: UInt64; let duration: UInt16; let steps: UInt32; let calories: UInt16; let distance: UInt16 }
    struct SleepRecord: Equatable { let deviceSeconds: UInt64; let quality: UInt8; let movement: UInt8 }
    struct HealthRecord: Equatable { let deviceSeconds: UInt64; let heartRate: UInt8; let spo2: UInt8; let temperatureTenths: Int16 }
    struct CurrentSteps: Equatable { let deviceSeconds: UInt64; let steps: UInt32; let calories: UInt16; let distance: UInt16 }
    struct DeviceInfo: Equatable { let firmware: UInt16; let mac: String; let manufacturer: UInt16; let model: UInt16 }

    static func stepRecords(_ payload: Data) -> [StepRecord] {
        records(payload, size: 16).compactMap { var r = Reader($0)
            guard let t = r.seconds6(), let d = r.u16(), let s = r.u32(), let c = r.u16(), let m = r.u16() else { return nil }
            return StepRecord(deviceSeconds: t, duration: d, steps: s, calories: c, distance: m)
        }
    }

    static func sleepRecords(_ payload: Data) -> [SleepRecord] {
        records(payload, size: 8).compactMap { var r = Reader($0)
            guard let t = r.seconds6(), let q = r.u8(), let m = r.u8() else { return nil }
            return SleepRecord(deviceSeconds: t, quality: q, movement: m)
        }
    }

    static func healthRecords(_ payload: Data) -> [HealthRecord] {
        records(payload, size: 14).compactMap { var r = Reader($0)
            guard let t = r.seconds6(), let hr = r.u8(), let o = r.u8(), let temp = r.i16() else { return nil }
            return HealthRecord(deviceSeconds: t, heartRate: hr, spo2: o, temperatureTenths: temp)
        }
    }

    static func currentSteps(_ payload: Data) -> CurrentSteps? {
        var r = Reader(payload)
        guard let t = r.seconds6(), let s = r.u32(), let c = r.u16(), let d = r.u16() else { return nil }
        return CurrentSteps(deviceSeconds: t, steps: s, calories: c, distance: d)
    }

    static func deviceInfo(_ payload: Data) -> DeviceInfo? {
        var r = Reader(payload)
        guard let fw = r.u16(), let mac = r.bytes(6), let man = r.u16(), let model = r.u16() else { return nil }
        return DeviceInfo(firmware: fw, mac: mac.map { String(format: "%02X", $0) }.joined(separator: ":"), manufacturer: man, model: model)
    }

    /// Human-readable summary of a reply, for diagnostics. Values are provisional until verified on the ring.
    static func describe(_ frame: Frame, timeZone: TimeZone = .current) -> String {
        let p = frame.payload
        let time = ISO8601DateFormatter()
        time.timeZone = timeZone
        func when(_ s: UInt64) -> String { time.string(from: date(fromDeviceSeconds: s, timeZone: timeZone)) }
        let part = frame.totalPackets > 1 ? " [packet \(frame.currentPacket)/\(frame.totalPackets)]" : ""
        switch frame.command {
        case 0x06:
            var r = Reader(p); guard let pct = r.u8() else { break }
            return "Battery \(pct)%" + ((r.u8() ?? 0) != 0 ? ", charging" : "")
        case 0x1D:
            guard let s = currentSteps(p) else { break }
            return "Steps now: \(s.steps), calories \(s.calories), distance \(s.distance) at \(when(s.deviceSeconds))"
        case 0x21:
            let rs = stepRecords(p)
            return "Step history\(part): \(rs.count) records, \(rs.reduce(0) { $0 + Int($1.steps) }) steps" + (rs.first.map { " from \(when($0.deviceSeconds))" } ?? "")
        case 0x22:
            let rs = sleepRecords(p)
            return "Sleep history\(part): \(rs.count) records" + (rs.first.map { " from \(when($0.deviceSeconds))" } ?? "")
        case 0x2A, 0x2B, 0x2D:
            // Empty-history replies carry the queried day's local midnight.
            var r = Reader(p)
            let kind = frame.command == 0x2A ? "Step" : frame.command == 0x2B ? "Sleep" : "Health"
            return "\(kind) history: none" + (r.seconds6().map { " for day starting \(when($0))" } ?? "")
        case 0x24:
            let rs = healthRecords(p).filter { $0.heartRate > 0 || $0.spo2 > 0 }
            let hr = rs.map(\.heartRate).filter { $0 > 0 }
            let o2 = rs.map(\.spo2).filter { $0 > 0 }
            let temp = rs.map(\.temperatureTenths).filter { $0 > 0 }.last.map { String(format: ", skin %.1f °C", Double($0) / 10) } ?? ""
            return "Health history\(part): \(rs.count) readings" + (hr.isEmpty ? "" : ", HR \(hr.min()!)–\(hr.max()!) bpm")
                + (o2.isEmpty ? "" : ", SpO₂ \(o2.min()!)–\(o2.max()!) %") + temp
        case 0x25:
            guard let i = deviceInfo(p) else { break }
            return String(format: "Device info: firmware 0x%04X, manufacturer 0x%04X, model 0x%04X, MAC ", i.firmware, i.manufacturer, i.model) + i.mac
        case 0x2F:
            guard let s = p.first else { break }
            return String(format: "Recording state 0x%02X", s) + (s & 0x10 != 0 ? " (recording)" : "")
        case 0x37:
            let f = [UInt8](p)
            return "Features: live recording \(f.count > 0 && f[0] != 0 ? "yes" : "no"), stored recordings \(f.count > 1 && f[1] != 0 ? "yes" : "no")"
        case 0x3D:
            var r = Reader(p); guard let n = r.u16() else { break }
            return "Recordings on ring: \(n)"
        case 0x34:
            return "Recording audio packet \(frame.currentPacket)/\(frame.totalPackets)"
        case 0x36:
            var r = Reader(p)
            return "Recording transfer complete; ring reports \(r.u16().map(String.init) ?? "?") remaining"
        case 0x28: return "Button event \(p.first.map(String.init) ?? "?")"
        case 0x44:
            guard let n = p.first, p.count >= 1 + Int(n), let name = String(data: p.dropFirst().prefix(Int(n)), encoding: .utf8) else { break }
            return "Name \(name)"
        default: break
        }
        return String(format: "Command 0x%02X", frame.command) + part + ": \(p.count) bytes"
    }
}

extension SR116Protocol {
    /// Offline-recording transfer controls. Neither deletes anything; the
    /// delete acknowledgement (0x36 from the app) is intentionally absent.
    enum Transfer: UInt16 {
        case stop = 0x40
        case requestNext = 0x34
    }
    static func encode(_ transfer: Transfer) -> Data { encode(command: transfer.rawValue) }

    static let opusPacketBytes = 40
    static let opusFramesPerPacket = 320 // 20 ms at 16 kHz
    static let opusSampleRate = 16_000.0

    /// Reassembles one offline recording from 0x34 packets 1…T. Each packet's
    /// payload is a 6-byte timestamp followed by 40-byte Opus packets.
    struct RecordingAssembler {
        static let maxPackets = 20_000
        static let maxOpusBytes = 20 * 1024 * 1024

        enum Failure: Error, Equatable { case outOfOrder(expected: Int, got: Int), totalChanged, tooLarge, misaligned }

        private(set) var totalPackets = 0
        private(set) var receivedPackets = 0
        /// Opus packets back to back, `opusPacketBytes` each: one growing buffer instead of one `Data` per packet.
        private(set) var opusBytes = Data()
        private(set) var opusCount = 0
        private(set) var firstDeviceSeconds: UInt64?
        private var lastPayload: Data?

        var isComplete: Bool { totalPackets > 0 && receivedPackets == totalPackets }
        var seconds: Double { Double(opusCount) * Double(SR116Protocol.opusFramesPerPacket) / SR116Protocol.opusSampleRate }
        /// Packet-by-packet view (tests, diagnostics); the transfer path reads `opusBytes`.
        var opus: [Data] {
            stride(from: 0, to: opusBytes.count, by: SR116Protocol.opusPacketBytes).map { start in
                Data(opusBytes[opusBytes.startIndex + start ..< opusBytes.startIndex + start + SR116Protocol.opusPacketBytes])
            }
        }
        /// Bytes of packets `index`… as a slice of `opusBytes` (no copy until appended elsewhere).
        func opusSlice(fromPacket index: Int) -> Data {
            let start = min(opusBytes.count, max(0, index) * SR116Protocol.opusPacketBytes)
            return opusBytes[(opusBytes.startIndex + start)...]
        }

        /// Returns true when the frame was consumed. Exact retransmissions of the last packet are ignored.
        mutating func accept(_ frame: Frame) throws -> Bool {
            guard frame.command == Transfer.requestNext.rawValue else { return false }
            let total = Int(frame.totalPackets), current = Int(frame.currentPacket)
            if current == receivedPackets, frame.payload == lastPayload { return true }
            if receivedPackets == 0 {
                guard current == 1 else { throw Failure.outOfOrder(expected: 1, got: current) }
                guard total <= Self.maxPackets else { throw Failure.tooLarge }
                totalPackets = total
            } else {
                guard total == totalPackets else { throw Failure.totalChanged }
                guard current == receivedPackets + 1 else { throw Failure.outOfOrder(expected: receivedPackets + 1, got: current) }
            }
            var r = Reader(frame.payload)
            guard let t = r.seconds6() else { throw Failure.misaligned }
            if firstDeviceSeconds == nil { firstDeviceSeconds = t }
            let body = frame.payload.dropFirst(6)
            guard body.count % SR116Protocol.opusPacketBytes == 0 else { throw Failure.misaligned }
            guard opusBytes.count + body.count <= Self.maxOpusBytes else { throw Failure.tooLarge }
            if receivedPackets == 0 { opusBytes.reserveCapacity(min(Self.maxOpusBytes, total * body.count)) }
            opusBytes.append(contentsOf: body)
            opusCount += body.count / SR116Protocol.opusPacketBytes
            receivedPackets = current
            lastPayload = frame.payload
            return true
        }
    }
}

extension SR116Protocol {
    static let transferComplete: UInt16 = 0x36

    /// Remaining-file count the ring reports in its 0x36 "file complete" frame.
    static func remaining(_ frame: Frame) -> UInt16? {
        guard frame.command == transferComplete else { return nil }
        var r = Reader(frame.payload)
        return r.u16()
    }

    /// DESTRUCTIVE: tells the ring the file just transferred was received, which
    /// deletes it from the ring. Only `RingLink` sends this, and only after the
    /// whole file arrived in order and the decoded memo is saved and re-read.
    static func deleteAck(remaining: UInt16) -> Data {
        encode(command: transferComplete, payload: Data([UInt8(remaining & 0xFF), UInt8(remaining >> 8)]))
    }

    /// Unsolicited 0x2F push: true while the ring is recording offline (bit 0x10).
    static func isRecording(_ frame: Frame) -> Bool? {
        guard frame.command == Query.audioState.rawValue, let state = frame.payload.first else { return nil }
        return state & 0x10 != 0
    }

    static func recordingCount(_ frame: Frame) -> Int? {
        guard frame.command == Query.recordingCount.rawValue else { return nil }
        var r = Reader(frame.payload)
        return r.u16().map(Int.init)
    }
}
