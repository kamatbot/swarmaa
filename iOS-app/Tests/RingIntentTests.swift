import XCTest
import UserNotifications
@testable import Swarmaa

@MainActor final class RingIntentTests: XCTestCase {
    private func object(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    func testRequestEncodesTheVoiceIntentContract() throws {
        let captured = Date(timeIntervalSince1970: 1_790_000_000)
        let request = VoiceIntentRequest(memoID: "8F2C1D9E-3B4A-4C5D-8E6F-7A8B9C0D1E2F", threadID: "2B9F4C3A-1D2E-4F50-8A6B-7C8D9E0F1A2B",
                                         transcript: "remind me to call mom at 5", capturedAt: captured, spokenAt: captured.addingTimeInterval(4.26),
                                         timeZone: TimeZone(identifier: "Asia/Bangkok")!, durationSeconds: 4.26, source: "ring",
                                         timings: ["idle": 0, "first_packet": 310, "transcribed": 2210])
        let json = try object(request)
        XCTAssertEqual(Set(json.keys), ["memo_id", "thread_id", "transcript", "captured_at", "spoken_at", "time_zone", "duration_seconds", "source", "timings"])
        XCTAssertEqual(json["memo_id"] as? String, "8f2c1d9e-3b4a-4c5d-8e6f-7a8b9c0d1e2f")
        XCTAssertEqual(json["thread_id"] as? String, "2b9f4c3a-1d2e-4f50-8a6b-7c8d9e0f1a2b")
        XCTAssertEqual(json["transcript"] as? String, "remind me to call mom at 5")
        XCTAssertEqual(json["captured_at"] as? String, "2026-09-21T14:13:20Z")
        XCTAssertEqual(json["spoken_at"] as? String, "2026-09-21T14:13:24Z")
        XCTAssertEqual(json["time_zone"] as? String, "Asia/Bangkok")
        XCTAssertEqual(json["duration_seconds"] as? Double, 4.3)
        XCTAssertEqual(json["source"] as? String, "ring")
        XCTAssertEqual((json["timings"] as? [String: Any])?["first_packet"] as? Int, 310)
    }

    func testRequestOmitsAbsentOptionalsAndBoundsTranscript() throws {
        let request = VoiceIntentRequest(memoID: UUID().uuidString, threadID: UUID().uuidString, transcript: String(repeating: "a", count: 20_000),
                                         capturedAt: Date(), spokenAt: Date(), timings: [:])
        let json = try object(request)
        XCTAssertNil(json["duration_seconds"])
        XCTAssertNil(json["timings"])
        XCTAssertEqual((json["transcript"] as? String)?.count, VoiceIntentRequest.transcriptLimit)
    }

    func testResultDecodesLocalAndToleratesMissingFields() throws {
        let local = try JSONDecoder().decode(VoiceIntentResult.self, from: Data("""
        {"memo_id":"m1","route":"local","message_seq":42,"actions":[{"id":"a1","type":"reminder.create","status":"done",
         "summary":"Reminder set: Call mom · Today 17:00","undoable":true}],"extra":"ignored"}
        """.utf8))
        XCTAssertEqual(local.memoID, "m1")
        XCTAssertEqual(local.route, "local")
        XCTAssertEqual(local.messageSeq, 42)
        XCTAssertEqual(local.actions, [.init(id: "a1", type: "reminder.create", status: "done", summary: "Reminder set: Call mom · Today 17:00", undoable: true)])
        XCTAssertNil(local.delegatedTo)

        let delegate = try JSONDecoder().decode(VoiceIntentResult.self, from: Data("""
        {"memo_id":"m2","route":"delegate","message_seq":7,"delegated_to":{"bot_id":"b9","name":"Research"}}
        """.utf8))
        XCTAssertEqual(delegate.actions, [])
        XCTAssertEqual(delegate.delegatedTo, .init(botID: "b9", name: "Research"))

        XCTAssertThrowsError(try JSONDecoder().decode(VoiceIntentResult.self, from: Data(#"{"route":"local"}"#.utf8)))
    }

    func testNotificationText() {
        let done = VoiceIntentResult(memoID: "m", route: "local", actions: [
            .init(id: "1", type: "reminder.create", status: "done", summary: "Reminder set: Call mom · Today 17:00", undoable: true),
            .init(id: "2", type: "note.append", status: "done", summary: "  Note saved  ", undoable: true)
        ])
        XCTAssertEqual(RingIntent.notificationText(done).title, "Ring memo")
        XCTAssertEqual(RingIntent.notificationText(done).body, "Reminder set: Call mom · Today 17:00\nNote saved")

        let failed = VoiceIntentResult(memoID: "m", route: "local", actions: [.init(id: "1", type: "reminder.create", status: "failed", summary: "Allow Reminders for Swarmaa", undoable: false)])
        XCTAssertEqual(RingIntent.notificationText(failed).title, "Ring memo needs attention")

        XCTAssertEqual(RingIntent.notificationText(.init(memoID: "m", route: "assistant")).body, "Sent to Assistant")
        XCTAssertEqual(RingIntent.notificationText(.init(memoID: "m", route: "local")).body, "Sent to Assistant")
        XCTAssertEqual(RingIntent.notificationText(.init(memoID: "m", route: "delegate", delegatedTo: .init(botID: "b", name: "Research"))).body, "Sent to Research")
        XCTAssertEqual(RingIntent.notificationText(.init(memoID: "m", route: "delegate")).body, "Sent to your bot")
    }

    func testNotificationTextForQueuedAndRunningActions() {
        let running = VoiceIntentResult(memoID: "M", route: "local", actions: [
            .init(id: "1", type: "reminder.create", status: "running", summary: "Reminder: Call mom · Today 17:00", undoable: false)
        ])
        XCTAssertTrue(RingIntent.isPending(running))
        XCTAssertEqual(RingIntent.notificationText(running).title, "Working on it…")
        XCTAssertEqual(RingIntent.notificationText(running).body, "Reminder: Call mom · Today 17:00")

        let queuedNoSummary = VoiceIntentResult(memoID: "m", route: "local", actions: [.init(id: "1", type: "note.append", status: "queued", summary: " ", undoable: false)])
        XCTAssertEqual(RingIntent.notificationText(queuedNoSummary).title, "Working on it…")
        XCTAssertEqual(RingIntent.notificationText(queuedNoSummary).body, "Your Mac is finishing the action.")

        // A failure wins over a still-running sibling.
        let mixed = VoiceIntentResult(memoID: "m", route: "local", actions: [
            .init(id: "1", type: "reminder.create", status: "failed", summary: "Allow Reminders for Swarmaa", undoable: false),
            .init(id: "2", type: "note.append", status: "running", summary: "Saving note", undoable: false)
        ])
        XCTAssertFalse(RingIntent.notificationText(mixed).title == "Working on it…")
        XCTAssertEqual(RingIntent.notificationText(mixed).title, "Ring memo needs attention")

        XCTAssertEqual(RingIntent.notificationIdentifier(running), "ring-intent-m")
    }

    func testFollowUpMergesListedActionsById() throws {
        let first = VoiceIntentResult(memoID: "m", route: "local", messageSeq: 3, actions: [
            .init(id: "a1", type: "reminder.create", status: "running", summary: "Reminder: Call mom", undoable: false),
            .init(id: "a2", type: "note.append", status: "done", summary: "Note saved", undoable: true)
        ])
        let listed = try RingIntent.listedActions(Data("""
        {"actions":[{"id":"zz","type":"timer.start","status":"done","summary":"Other memo","undoable":true,"created_at":"x"},
                    {"id":"a1","type":"reminder.create","status":"done","summary":"Reminder set: Call mom · Today 17:00","undoable":true},
                    {"type":"broken"}]}
        """.utf8))
        XCTAssertEqual(listed.map(\.id), ["zz", "a1"])
        let merged = RingIntent.merging(first, with: listed)
        XCTAssertEqual(merged.actions.map(\.id), ["a1", "a2"])
        XCTAssertEqual(merged.actions[0].status, "done")
        XCTAssertEqual(merged.messageSeq, 3)
        XCTAssertFalse(RingIntent.isPending(merged))
        XCTAssertEqual(RingIntent.notificationText(merged).title, "Ring memo")
        XCTAssertEqual(RingIntent.notificationText(merged).body, "Reminder set: Call mom · Today 17:00\nNote saved")
        XCTAssertEqual(RingIntent.merging(first, with: []), first)
        XCTAssertEqual(try RingIntent.listedActions(Data("{}".utf8)), [])
    }

    func testRequestCarriesDeviceIDAndBoundedDeviceActions() throws {
        let device = "6A1F0C2B-3D4E-4F50-8A6B-7C8D9E0F1A2B"
        let request = VoiceIntentRequest(memoID: UUID().uuidString, threadID: UUID().uuidString, transcript: "remind me", capturedAt: Date(), spokenAt: Date(),
                                         deviceID: device, deviceActions: ["reminders", "calendar", "reminders", String(repeating: "x", count: 33)])
        let json = try object(request)
        XCTAssertEqual(json["device_id"] as? String, device.lowercased())
        XCTAssertEqual(json["device_actions"] as? [String], ["reminders", "calendar"])
        // Device-capable with nothing allowed yet still says so (rule 3 of §11.1).
        let none = try object(VoiceIntentRequest(memoID: UUID().uuidString, threadID: UUID().uuidString, transcript: "x", capturedAt: Date(), spokenAt: Date(),
                                                 deviceID: device, deviceActions: []))
        XCTAssertEqual(none["device_actions"] as? [String], [])
        // device_actions requires device_id.
        let orphan = try object(VoiceIntentRequest(memoID: UUID().uuidString, threadID: UUID().uuidString, transcript: "x", capturedAt: Date(), spokenAt: Date(),
                                                   deviceID: "not-a-uuid", deviceActions: ["reminders"]))
        XCTAssertNil(orphan["device_id"])
        XCTAssertNil(orphan["device_actions"])
    }

    func testResultDecodesDeviceRowsAndOldRowsDefaultToMac() throws {
        let device = try JSONDecoder().decode(VoiceIntentResult.self, from: Data("""
        {"memo_id":"m","route":"device","message_seq":5,"actions":[{"id":"a1","type":"reminder.create","status":"queued",
         "summary":"Reminder: Call mom · Today 17:00 · waiting for your iPhone","undoable":false,"runner":"device",
         "action":{"type":"reminder.create","title":"Call mom","due_at":"2026-11-23T10:00:00Z","extra":1}}]}
        """.utf8))
        XCTAssertEqual(device.route, "device")
        let row = try XCTUnwrap(device.actions.first)
        XCTAssertEqual(row.runner, "device")
        XCTAssertEqual(row.action, DeviceAction(type: "reminder.create", title: "Call mom", dueAt: "2026-11-23T10:00:00Z"))
        XCTAssertTrue(RingIntent.runsHere(row))
        XCTAssertTrue(RingIntent.isPending(device))
        XCTAssertFalse(RingIntent.isPendingOnMac(device))
        XCTAssertEqual(RingIntent.notificationText(device).title, "Working on it…")

        let old = try JSONDecoder().decode(VoiceIntentResult.self, from: Data("""
        {"memo_id":"m","route":"local","actions":[{"id":"a1","type":"reminder.create","status":"running","summary":"Reminder: Call mom","undoable":false}]}
        """.utf8))
        XCTAssertEqual(old.actions.first?.runner, "mac")
        XCTAssertNil(old.actions.first?.action)
        XCTAssertFalse(RingIntent.runsHere(try XCTUnwrap(old.actions.first)))
        XCTAssertTrue(RingIntent.isPendingOnMac(old))

        let blocked = VoiceIntentResult(memoID: "m", route: "device", actions: [
            .init(id: "1", type: "reminder.create", status: "blocked", summary: "Allow Reminders to finish: Call mom", undoable: false, runner: "device")
        ])
        XCTAssertEqual(RingIntent.notificationText(blocked).title, "Ring memo needs attention")
        XCTAssertEqual(RingIntent.notificationText(.init(memoID: "m", route: "device")).body, "Done on this iPhone")
    }

    func testUndoRequestReadsTheNotificationPayload() {
        XCTAssertEqual(RingIntent.undoRequest(["action_id": "a1", "handle": "x-1"])?.handle, "x-1")
        XCTAssertNil(RingIntent.undoRequest(["action_id": "a1"]))
        XCTAssertNil(RingIntent.undoRequest(["action_id": "a1", "handle": ""]))
        XCTAssertEqual(RingIntent.category.identifier, "RING_ACTION")
        XCTAssertEqual(RingIntent.category.actions.map(\.identifier), [RingIntent.undoAction])
    }

    func testTimingsKeepFirstMarkAndOrderTheLogLine() {
        let start = Date(timeIntervalSince1970: 1_000)
        var timings = RingTimings(origin: start, fromIdleEdge: true)
        timings.mark("count_reply", at: start.addingTimeInterval(0.1))
        timings.mark("first_packet", at: start.addingTimeInterval(0.4))
        timings.mark("count_reply", at: start.addingTimeInterval(9))
        XCTAssertEqual(timings.marks, ["idle": 0, "count_reply": 100, "first_packet": 400])
        XCTAssertEqual(timings.line, "idle=0 count_reply=100 first_packet=400")
        XCTAssertNil(RingTimings(origin: start, fromIdleEdge: false).marks["idle"])
    }

    func testDeliveryDecodesOldManifestsAsAttempted() throws {
        let old = try JSONDecoder().decode([PhoneMemos.Delivery].self, from: Data("""
        [{"id":"a","generation":"g","threadID":"t","hash":"h","capturedAt":"2026-11-22T10:00:00Z","bytes":10,"state":"pending"}]
        """.utf8))
        XCTAssertEqual(old.first?.attempted, true)
        XCTAssertEqual(old.first?.state, "pending")

        let fresh = PhoneMemos.Delivery(id: "b", generation: "g", threadID: "t", hash: "h", capturedAt: "c", bytes: 1, state: "pending")
        XCTAssertFalse(fresh.attempted)
        let roundTrip = try JSONDecoder().decode(PhoneMemos.Delivery.self, from: JSONEncoder().encode(fresh))
        XCTAssertFalse(roundTrip.attempted)
        XCTAssertEqual(roundTrip.id, "b")
    }
}
