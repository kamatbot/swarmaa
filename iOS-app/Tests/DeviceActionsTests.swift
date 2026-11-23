import XCTest
@testable import Swarmaa

/// §11 acceptance for the iPhone executor. Foundation types only: this target compiles its own AppCore copy.
@MainActor final class DeviceActionsTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suite = "device-actions-" + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)
    }
    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private final class FakeStore: DeviceStore {
        var reminders: PermissionState = .allowed
        var calendar: PermissionState = .allowed
        var alarms: PermissionState = .unavailable("Needs iOS 26 — timers use Reminders")
        var items: [String: DeviceItem] = [:]
        var events: [String: DeviceItem] = [:]
        var alarmsScheduled: [UUID] = []
        var created = 0
        func access(_ capability: DeviceCapability) -> PermissionState {
            switch capability { case .reminders: reminders; case .calendar: calendar; case .alarms: alarms }
        }
        func request(_ capability: DeviceCapability) async -> PermissionState { access(capability) }
        func lists(_ capability: DeviceCapability) -> [DeviceList] { [] }
        func addReminder(_ item: DeviceItem, list: String?) throws -> String {
            created += 1
            let id = "r\(created)"
            items[id] = item
            return id
        }
        func findReminder(marker: String, list: String?) async -> String? {
            items.first { DeviceActions.lastLine($0.value.notes) == marker }?.key
        }
        func removeReminder(_ identifier: String) throws -> Bool { items.removeValue(forKey: identifier) != nil }
        func addEvent(_ item: DeviceItem, calendar: String?) throws -> String? {
            created += 1
            let id = "e\(created)"
            events[id] = item
            return calendar == nil && self.calendar == .limited ? nil : id
        }
        func findEvent(marker: String, around: Date, calendar: String?) -> String? {
            events.first { DeviceActions.lastLine($0.value.notes) == marker }?.key
        }
        func removeEvent(_ identifier: String) throws -> Bool { events.removeValue(forKey: identifier) != nil }
        func scheduleAlarm(id: UUID, label: String, fireAt: Date, countdown: Bool) async throws { created += 1; alarmsScheduled.append(id) }
        func alarmExists(id: UUID) -> Bool { alarmsScheduled.contains(id) }
        func cancelAlarm(id: UUID) throws -> Bool { alarmsScheduled.removeAll { $0 == id }; return true }
    }

    private final class Host {
        var pending: [[String: Any]] = []
        var reports: [DeviceReport] = []
        var failReports = false
        var pendingCalls = 0
    }

    private var blocked: [DeviceCapability] = []
    private func make(_ store: FakeStore, prompt: Bool = false) -> DeviceActions {
        DeviceActions(store: store, defaults: defaults, prompt: { _ in prompt }, notifyBlocked: { [weak self] capability, _ in self?.blocked.append(capability) })
    }
    private func drain(_ actions: DeviceActions, _ host: Host) async {
        await actions.drain(report: { report in
            if host.failReports { throw URLError(.timedOut) }
            host.reports.append(report)
        }, pending: { deviceID in
            host.pendingCalls += 1
            XCTAssertNotNil(UUID(uuidString: deviceID))
            // Like the host: a row stays listed until it is reported (done/failed for a run, undone for an undo).
            let listed = host.pending.filter { row in
                let id = row["id"] as? String ?? "", undo = row["op"] as? String == "undo"
                return !host.reports.contains { $0.actionID == id && (undo ? $0.status == "undone" : $0.status != "undone") }
            }
            return try JSONSerialization.data(withJSONObject: ["actions": listed])
        })
    }
    private let soon = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
    private var reminder: DeviceAction { DeviceAction(type: "reminder.create", title: "Call mom", dueAt: soon, notes: "Bring cake") }
    private func row(_ id: String, _ action: [String: Any], op: String = "run", handle: String? = nil) -> [String: Any] {
        var row: [String: Any] = ["id": id, "type": action["type"] ?? "", "status": op == "run" ? "queued" : "undoing", "summary": "waiting for your iPhone",
                                  "undoable": false, "runner": "device", "op": op, "action": action]
        if let handle { row["handle"] = handle }
        return row
    }

    func testRunTwiceWithTheSameIDCreatesOneItem() async {
        let store = FakeStore()
        let actions = make(store)
        let id = UUID().uuidString.lowercased()
        let first = await actions.run(id: id, action: reminder)
        let second = await actions.run(id: id, action: reminder)
        XCTAssertEqual(first, .done(handle: "r1"))
        XCTAssertEqual(second, first)
        XCTAssertEqual(store.created, 1)
        // A fresh instance reads the same ledger.
        let third = await make(store).run(id: id, action: reminder)
        XCTAssertEqual(third, .done(handle: "r1"))
        XCTAssertEqual(store.created, 1)
    }

    func testStartedEntryWithMarkedItemCreatesNothing() async throws {
        let store = FakeStore()
        let id = UUID().uuidString.lowercased()
        store.items["old"] = DeviceItem(title: "Call mom", notes: "Bring cake\n" + DeviceActions.marker(id))
        let ledger = [id: DeviceActions.Entry(state: .started, action: reminder, at: Date())]
        defaults.set(try JSONEncoder().encode(ledger), forKey: DeviceActions.ledgerKey)
        let outcome = await make(store).run(id: id, action: reminder)
        XCTAssertEqual(outcome, .done(handle: "old"))
        XCTAssertEqual(store.created, 0)
    }

    func testMarkerIsTheLastLineOfNotes() async {
        let store = FakeStore()
        let id = UUID().uuidString
        _ = await make(store).run(id: id, action: reminder)
        let notes = store.items["r1"]?.notes ?? ""
        XCTAssertEqual(notes, "Bring cake\nswarmaa:" + id.lowercased())
        XCTAssertEqual(DeviceActions.lastLine(notes), DeviceActions.marker(id))
        XCTAssertNotNil(store.items["r1"]?.due)
    }

    func testDeniedBlocksWithoutReportAndGrantingDrainsAndReportsDone() async {
        let store = FakeStore()
        store.reminders = .denied
        let actions = make(store)
        let host = Host()
        let id = UUID().uuidString.lowercased()
        host.pending = [row(id, ["type": "reminder.create", "title": "Call mom", "due_at": soon])]
        await drain(actions, host)
        XCTAssertEqual(host.reports, [])
        XCTAssertEqual(blocked, [.reminders])
        XCTAssertEqual(actions.entries[id]?.state, .blocked)
        XCTAssertEqual(store.created, 0)

        store.reminders = .allowed
        await drain(actions, host)
        XCTAssertEqual(host.reports.map(\.actionID), [id])
        XCTAssertEqual(host.reports.first?.status, "done")
        XCTAssertEqual(host.reports.first?.handle, "r1")
        XCTAssertNil(host.reports.first?.code)
        XCTAssertEqual(store.created, 1)
        XCTAssertEqual(actions.entries[id]?.state, .reported)
    }

    func testWriteOnlyCalendarIsDoneWithoutHandle() async {
        let store = FakeStore()
        store.calendar = .limited
        let actions = make(store)
        let start = Date().addingTimeInterval(86_400)
        let iso = ISO8601DateFormatter()
        let event = DeviceAction(type: "event.create", title: "Dentist", startAt: iso.string(from: start), endAt: iso.string(from: start.addingTimeInterval(1800)))
        let id = UUID().uuidString.lowercased()
        let outcome = await actions.run(id: id, action: event)
        XCTAssertEqual(outcome, .done(handle: nil))
        XCTAssertEqual(store.events.count, 1)
        let host = Host()
        await drain(actions, host)
        XCTAssertEqual(host.reports.first?.status, "done")
        XCTAssertNil(host.reports.first?.handle)
    }

    func testTimerFallsBackToAReminder() async {
        let store = FakeStore()
        let actions = make(store)
        let fire = ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))
        let outcome = await actions.run(id: UUID().uuidString, action: DeviceAction(type: "timer.start", label: "Tea", fireAt: fire))
        XCTAssertEqual(outcome, .done(handle: "r1"))
        XCTAssertEqual(store.items["r1"]?.title, "⏱ Tea")
        XCTAssertNotNil(store.items["r1"]?.due)
        XCTAssertEqual(store.alarmsScheduled, [])

        let past = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-60))
        let late = await actions.run(id: UUID().uuidString, action: DeviceAction(type: "timer.start", label: "Late", fireAt: past))
        XCTAssertEqual(late, .failed(code: "timeout"))

        store.alarms = .allowed
        let id = UUID().uuidString.lowercased()
        let wake = await actions.run(id: id, action: DeviceAction(type: "timer.start", label: "Wake", fireAt: fire, kind: "alarm"))
        XCTAssertEqual(wake, .done(handle: "alarm:" + id))
        XCTAssertEqual(store.alarmsScheduled, [UUID(uuidString: id)!])
    }

    func testUndoOfAMissingItemIsUndone() async {
        let store = FakeStore()
        let actions = make(store)
        let id = UUID().uuidString.lowercased()
        let undone = await actions.undo(id: id, handle: "gone", type: "reminder.create")
        XCTAssertEqual(undone, .undone)
        let host = Host()
        await drain(actions, host)
        XCTAssertEqual(host.reports, [DeviceReport(actionID: id, status: "undone", handle: nil, code: nil, execMs: host.reports.first?.execMs)])

        // An undoing row from the host removes the item it names.
        let other = UUID().uuidString.lowercased()
        _ = await actions.run(id: other, action: reminder)
        host.pending = [row(other, ["type": "reminder.create", "title": "Call mom"], op: "undo", handle: "r1")]
        await drain(actions, host)
        XCTAssertNil(store.items["r1"])
        XCTAssertEqual(host.reports.last?.status, "undone")
    }

    func testFailedReportIsRetriedByDrain() async {
        let store = FakeStore()
        let actions = make(store)
        let id = UUID().uuidString.lowercased()
        _ = await actions.run(id: id, action: reminder)
        let host = Host()
        host.failReports = true
        await drain(actions, host)
        XCTAssertEqual(actions.entries[id]?.state, .saved)
        host.failReports = false
        await drain(actions, host)
        XCTAssertEqual(host.reports.map(\.actionID), [id])
        await drain(actions, host)
        XCTAssertEqual(host.reports.count, 1)
        XCTAssertEqual(store.created, 1)
    }

    func testUnknownTypeIsIgnoredAndInvalidActionFails() async {
        let store = FakeStore()
        let actions = make(store)
        let note = await actions.run(id: UUID().uuidString, action: DeviceAction(type: "note.append"))
        XCTAssertEqual(note, .ignored)
        let long = DeviceAction(type: "reminder.create", title: String(repeating: "a", count: 201))
        let refused = await actions.run(id: UUID().uuidString, action: long)
        XCTAssertEqual(refused, .failed(code: "failed"))
        XCTAssertEqual(store.created, 0)
    }

    private struct FakeRow: DevicePermission {
        let id: String
        let wireName: String?
        var icon = "circle", title = "Row", subtitle = "Row"
        var deniedNote: String? = nil
        let fixed: PermissionState
        func state() async -> PermissionState { fixed }
        func request() async -> PermissionState { fixed }
    }

    func testDeviceActionsComeFromAllowedRowsOnly() async {
        var rows: [any DevicePermission] = [
            FakeRow(id: "reminders", wireName: "reminders", fixed: .allowed),
            FakeRow(id: "calendar", wireName: "calendar", fixed: .limited),
            FakeRow(id: "alarms", wireName: "alarms", fixed: .unavailable("Needs iOS 26 — timers use Reminders")),
            FakeRow(id: "speech", wireName: nil, fixed: .allowed),
            FakeRow(id: "notifications", wireName: nil, fixed: .allowed),
            FakeRow(id: "bluetooth", wireName: nil, fixed: .allowed)
        ]
        let six = await DevicePermissions.capabilities(rows)
        XCTAssertEqual(six, ["reminders", "calendar"])
        rows.append(FakeRow(id: "contacts", wireName: "contacts", fixed: .allowed))
        let seven = await DevicePermissions.capabilities(rows)
        XCTAssertEqual(seven, ["reminders", "calendar", "contacts"])

        XCTAssertEqual(DevicePermissions.all.map(\.id), ["reminders", "calendar", "alarms", "speech", "notifications", "bluetooth"])
        XCTAssertEqual(DevicePermissions.all.compactMap(\.wireName), ["reminders", "calendar", "alarms"])
    }
}
