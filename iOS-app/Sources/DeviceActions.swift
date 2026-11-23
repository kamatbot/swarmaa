import Foundation
import EventKit
import SwiftUI
import UIKit
import UserNotifications
#if canImport(AlarmKit)
import AlarmKit
#endif

// Device actions: reminders, events and timers that the Mac routed to this iPhone (docs/RING-AGENT.md §11.3–§11.4).

/// A capability name on the wire (`device_actions`), and what a device row needs to run.
enum DeviceCapability: String, Codable, Sendable, CaseIterable {
    case reminders, calendar, alarms
    var appName: String {
        switch self { case .reminders: "Reminders"; case .calendar: "Calendar"; case .alarms: "Alarms" }
    }
}

/// A permission row's state (§11.5). `limited` still runs (Calendar write-only: no handle, no undo).
enum PermissionState: Equatable, Sendable {
    case notAsked, allowed, limited, denied, unavailable(String)
    var grants: Bool { self == .allowed || self == .limited }
}

/// The closed `LocalAction` set as sent on device rows (`types.ts`, snake_case). Unknown fields are ignored.
struct DeviceAction: Codable, Equatable, Sendable {
    var type: String
    var title: String?
    var dueAt: String?
    var notes: String?
    var list: String?
    var startAt: String?
    var endAt: String?
    var allDay: Bool?
    var location: String?
    var label: String?
    var fireAt: String?
    var kind: String?
    enum CodingKeys: String, CodingKey {
        case type, title, dueAt = "due_at", notes, list, startAt = "start_at", endAt = "end_at", allDay = "all_day", location, label
        case fireAt = "fire_at", kind
    }
    init(type: String, title: String? = nil, dueAt: String? = nil, notes: String? = nil, list: String? = nil, startAt: String? = nil,
         endAt: String? = nil, allDay: Bool? = nil, location: String? = nil, label: String? = nil, fireAt: String? = nil, kind: String? = nil) {
        self.type = type; self.title = title; self.dueAt = dueAt; self.notes = notes; self.list = list; self.startAt = startAt
        self.endAt = endAt; self.allDay = allDay; self.location = location; self.label = label; self.fireAt = fireAt; self.kind = kind
    }

    static let types: Set<String> = ["reminder.create", "event.create", "timer.start"]
    /// `LIMITS` in types.ts.
    static let titleLimit = 200, notesLimit = 4000

    /// The action re-checked on the phone (§11.6): type, lengths and dates. nil = refuse.
    var validated: DeviceItem.Kind? {
        func text(_ value: String?, _ limit: Int) -> String? {
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.count <= limit else { return nil }
            return value
        }
        func optional(_ value: String?, _ limit: Int) -> String?? {
            guard let value else { return .some(nil) }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count <= limit else { return nil }
            return .some(trimmed.isEmpty ? nil : trimmed)
        }
        switch type {
        case "reminder.create":
            guard let title = text(title, Self.titleLimit), let notes = optional(notes, Self.notesLimit), [nil, "default", "todo"].contains(list) else { return nil }
            var due: Date?
            if let dueAt { guard let date = Self.date(dueAt) else { return nil }; due = date }
            return .reminder(title: title, due: due, notes: notes, todo: list == "todo")
        case "event.create":
            guard let title = text(title, Self.titleLimit), let notes = optional(notes, Self.notesLimit), let location = optional(location, Self.titleLimit),
                  let start = startAt.flatMap(Self.date), let end = endAt.flatMap(Self.date), end >= start else { return nil }
            return .event(title: title, start: start, end: end, allDay: allDay ?? false, location: location, notes: notes)
        case "timer.start":
            guard let label = text(label, Self.titleLimit), let fire = fireAt.flatMap(Self.date), [nil, "timer", "alarm"].contains(kind) else { return nil }
            return .timer(label: label, fireAt: fire, alarm: kind == "alarm")
        default:
            return nil
        }
    }

    static func date(_ value: String) -> Date? {
        guard value.count <= 64 else { return nil }
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? plain.date(from: value)
    }
}

/// What the store is asked to save. `notes` always ends with the `swarmaa:<action_id>` marker line.
struct DeviceItem: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case reminder(title: String, due: Date?, notes: String?, todo: Bool)
        case event(title: String, start: Date, end: Date, allDay: Bool, location: String?, notes: String?)
        case timer(label: String, fireAt: Date, alarm: Bool)
    }
    var title: String
    var notes: String
    var due: Date?
    var start: Date?
    var end: Date?
    var allDay = false
    var location: String?
}

struct DeviceList: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
}

/// EventKit / AlarmKit behind a protocol so tests use a fake. All on the main actor (EKEventStore is not Sendable).
@MainActor protocol DeviceStore: AnyObject {
    func access(_ capability: DeviceCapability) -> PermissionState
    func request(_ capability: DeviceCapability) async -> PermissionState
    /// Writable reminder lists or calendars (empty without full access).
    func lists(_ capability: DeviceCapability) -> [DeviceList]
    /// Returns the reminder's `calendarItemIdentifier`.
    func addReminder(_ item: DeviceItem, list: String?) throws -> String
    /// Incomplete reminders in the target list whose notes end with `marker`.
    func findReminder(marker: String, list: String?) async -> String?
    /// false = no such item.
    func removeReminder(_ identifier: String) throws -> Bool
    /// Returns `eventIdentifier`, or nil when calendar access is write-only.
    func addEvent(_ item: DeviceItem, calendar: String?) throws -> String?
    /// Events within ±1 day of `around` in the target calendar whose notes end with `marker`.
    func findEvent(marker: String, around: Date, calendar: String?) -> String?
    func removeEvent(_ identifier: String) throws -> Bool
    func scheduleAlarm(id: UUID, label: String, fireAt: Date, countdown: Bool) async throws
    func alarmExists(id: UUID) -> Bool
    func cancelAlarm(id: UUID) throws -> Bool
}

/// Result of running or undoing one device row.
enum DeviceOutcome: Equatable, Sendable {
    case done(handle: String?)
    case failed(code: String)
    case undone
    /// Permission missing: nothing reported, the row stays queued (or undoing) on the host.
    case blocked(DeviceCapability)
    /// The same id is already running here.
    case busy
    /// Unknown type: ignored, never reported (§11.6).
    case ignored

    var reportStatus: String? {
        switch self { case .done: "done"; case .failed: "failed"; case .undone: "undone"; default: nil }
    }
}

/// `local_action_report` arguments.
struct DeviceReport: Codable, Equatable, Sendable {
    let actionID: String
    let status: String
    let handle: String?
    let code: String?
    let execMs: Int?
    enum CodingKeys: String, CodingKey { case actionID = "action_id", status, handle, code, execMs = "exec_ms" }
    static let codes: Set<String> = ["permission_denied", "action_disabled", "timeout", "unavailable", "failed"]
}

/// A `local_action_pending` row (`DeviceActionView`).
struct DevicePendingAction: Decodable, Equatable, Sendable {
    let id: String
    let type: String
    let status: String
    let op: String
    let handle: String?
    let action: DeviceAction?
    enum CodingKeys: String, CodingKey { case id, type, status, op, handle, action }
    init(id: String, type: String, status: String = "queued", op: String = "run", handle: String? = nil, action: DeviceAction? = nil) {
        self.id = id; self.type = type; self.status = status; self.op = op; self.handle = handle; self.action = action
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(String.self, forKey: .type)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        op = try c.decodeIfPresent(String.self, forKey: .op) ?? (status == "undoing" ? "undo" : "run")
        handle = try c.decodeIfPresent(String.self, forKey: .handle)
        action = (try? c.decodeIfPresent(DeviceAction.self, forKey: .action)) ?? nil
    }
    static func list(_ data: Data) -> [DevicePendingAction] {
        struct Row: Decodable { let row: DevicePendingAction?; init(from decoder: Decoder) throws { row = try? DevicePendingAction(from: decoder) } }
        struct List: Decodable { let actions: [Row]? }
        return ((try? JSONDecoder().decode(List.self, from: data))?.actions ?? []).compactMap(\.row)
    }
}

/// The iPhone executor: ledger, idempotency marker, undo, permission blocks and the drain loop (§11.4).
@MainActor final class DeviceActions {
    static let shared = DeviceActions()
    static let ledgerKey = "ring.deviceActions", deviceIDKey = "ring.deviceID"
    static let remindersListKey = "ring.remindersList", todoListKey = "ring.todoList", calendarKey = "ring.calendar"
    static let pendingLimit = 8

    /// One ledger entry per action id. `saved` = outcome final (status set) but not yet reported.
    struct Entry: Codable, Equatable, Sendable {
        enum State: String, Codable, Sendable { case started, saved, blocked, reported }
        var state: State
        var identifier: String?
        var action: DeviceAction
        var at: Date
        var op = "run"
        var status: String?
        var code: String?
        var execMs: Int?
        var outcome: DeviceOutcome? {
            switch status ?? "" {
            case "done": .done(handle: identifier)
            case "failed": .failed(code: code ?? "failed")
            case "undone": .undone
            default: nil
            }
        }
    }

    let store: any DeviceStore
    private let defaults: UserDefaults
    /// Foreground: asks for a not-yet-asked capability at once; true when it was granted.
    private let prompt: @MainActor (DeviceCapability) async -> Bool
    /// Background or refused: one local notification per capability.
    private let notifyBlocked: @MainActor (DeviceCapability, String) -> Void
    private(set) var entries: [String: Entry]
    private var inFlight = Set<String>()
    private var draining = false
    private var drainAgain = false

    init(store: (any DeviceStore)? = nil, defaults: UserDefaults = .standard,
         prompt: (@MainActor (DeviceCapability) async -> Bool)? = nil,
         notifyBlocked: (@MainActor (DeviceCapability, String) -> Void)? = nil) {
        self.store = store ?? EventKitDeviceStore()
        self.defaults = defaults
        self.prompt = prompt ?? DeviceActions.foregroundPrompt
        self.notifyBlocked = notifyBlocked ?? DeviceActions.postPermissionNotification
        entries = defaults.data(forKey: Self.ledgerKey).flatMap { try? JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:]
    }

    /// Random per-install id (§11.6), lowercased like other uuids on the wire.
    var deviceID: String {
        if let id = defaults.string(forKey: Self.deviceIDKey), UUID(uuidString: id) != nil { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: Self.deviceIDKey)
        return id
    }

    static func marker(_ id: String) -> String { "swarmaa:" + id.lowercased() }
    nonisolated static func lastLine(_ notes: String?) -> String? {
        notes?.split(separator: "\n", omittingEmptySubsequences: false).last.map { $0.trimmingCharacters(in: .whitespaces) }
    }
    static func notes(_ notes: String?, id: String) -> String { (notes.map { $0 + "\n" } ?? "") + marker(id) }

    func access(_ capability: DeviceCapability) -> PermissionState { store.access(capability) }
    @MainActor static func access(_ capability: DeviceCapability) -> PermissionState { shared.access(capability) }
    @MainActor static func request(_ capability: DeviceCapability) async -> PermissionState { await shared.store.request(capability) }
    @MainActor static func lists(_ capability: DeviceCapability) -> [DeviceList] { shared.store.lists(capability) }

    private func setting(_ key: String) -> String? { defaults.string(forKey: key).flatMap { $0.isEmpty ? nil : $0 } }

    // MARK: Run

    func run(id rawID: String, action: DeviceAction, now: Date = Date()) async -> DeviceOutcome {
        let id = rawID.lowercased()
        guard inFlight.insert(id).inserted else { return .busy }
        defer { inFlight.remove(id) }
        prune(now: now)
        let existing = entries[id]
        if let existing, existing.state == .saved || existing.state == .reported, let outcome = existing.outcome { return outcome }
        guard DeviceAction.types.contains(action.type) else { return .ignored }
        let started = Date()
        guard let kind = action.validated else { return finish(id, action: action, at: now, .failed(code: "failed"), since: started) }
        let resume = existing?.state == .started // a run was cut off between "started" and "saved": look for its marker
        let marker = Self.marker(id)

        switch kind {
        case let .reminder(title, due, notes, todo):
            guard store.access(.reminders) == .allowed else { return block(id, action: action, at: now, .reminders, keep: existing) }
            let list = setting(todo ? Self.todoListKey : Self.remindersListKey)
            if resume, let found = await store.findReminder(marker: marker, list: list) {
                return finish(id, action: action, at: now, .done(handle: found), since: started)
            }
            begin(id, action: action, at: now)
            do {
                let handle = try store.addReminder(DeviceItem(title: title, notes: Self.notes(notes, id: id), due: due), list: list)
                return finish(id, action: action, at: now, .done(handle: handle), since: started)
            } catch { return finish(id, action: action, at: now, .failed(code: "failed"), since: started) }

        case let .event(title, start, end, allDay, location, notes):
            let access = store.access(.calendar)
            guard access.grants else { return block(id, action: action, at: now, .calendar, keep: existing) }
            let calendar = access == .allowed ? setting(Self.calendarKey) : nil
            if resume {
                // Write-only access can't read events back: assume the cut-off save landed rather than risk a duplicate.
                guard access == .allowed else { return finish(id, action: action, at: now, .done(handle: nil), since: started) }
                if let found = store.findEvent(marker: marker, around: start, calendar: calendar) {
                    return finish(id, action: action, at: now, .done(handle: found), since: started)
                }
            }
            begin(id, action: action, at: now)
            do {
                let handle = try store.addEvent(DeviceItem(title: title, notes: Self.notes(notes, id: id), start: start, end: end, allDay: allDay, location: location),
                                                calendar: calendar)
                return finish(id, action: action, at: now, .done(handle: access == .allowed ? handle : nil), since: started)
            } catch { return finish(id, action: action, at: now, .failed(code: "failed"), since: started) }

        case let .timer(label, fireAt, alarm):
            guard fireAt > now else { return finish(id, action: action, at: now, .failed(code: "timeout"), since: started) }
            let alarmID = UUID(uuidString: id)
            let alarms = store.access(.alarms)
            if resume {
                if let alarmID, store.alarmExists(id: alarmID) { return finish(id, action: action, at: now, .done(handle: "alarm:" + id), since: started) }
                if store.access(.reminders) == .allowed, let found = await store.findReminder(marker: marker, list: nil) {
                    return finish(id, action: action, at: now, .done(handle: found), since: started)
                }
            }
            if let alarmID, alarms == .allowed {
                begin(id, action: action, at: now)
                do {
                    try await store.scheduleAlarm(id: alarmID, label: label, fireAt: fireAt, countdown: !alarm)
                    return finish(id, action: action, at: now, .done(handle: "alarm:" + id), since: started)
                } catch {
                    // AlarmKit refused: fall through to the Reminders timer below when allowed.
                    guard store.access(.reminders) == .allowed else { return finish(id, action: action, at: now, .failed(code: "failed"), since: started) }
                }
            }
            guard store.access(.reminders) == .allowed else {
                return block(id, action: action, at: now, alarms == .notAsked ? .alarms : .reminders, keep: existing)
            }
            begin(id, action: action, at: now)
            do {
                let handle = try store.addReminder(DeviceItem(title: "⏱ " + label, notes: Self.notes(nil, id: id), due: fireAt), list: nil)
                return finish(id, action: action, at: now, .done(handle: handle), since: started)
            } catch { return finish(id, action: action, at: now, .failed(code: "failed"), since: started) }
        }
    }

    // MARK: Undo

    /// Removes the item behind `handle`. A missing item counts as undone.
    func undo(id rawID: String, handle: String, type: String? = nil, now: Date = Date()) async -> DeviceOutcome {
        let id = rawID.lowercased()
        guard inFlight.insert(id).inserted else { return .busy }
        defer { inFlight.remove(id) }
        let known = entries[id]
        if let known, known.op == "undo", known.state == .saved || known.state == .reported, let outcome = known.outcome { return outcome }
        let action = known?.action ?? DeviceAction(type: type ?? "")
        let kind = type ?? known?.action.type ?? ""
        let started = Date()
        func done(_ outcome: DeviceOutcome) -> DeviceOutcome {
            var entry = Entry(state: .saved, identifier: handle, action: action, at: now, op: "undo")
            entry.status = outcome.reportStatus
            if case let .failed(code) = outcome { entry.code = code }
            entry.execMs = Self.ms(since: started)
            entries[id] = entry; save()
            return outcome
        }
        func blocked(_ capability: DeviceCapability) -> DeviceOutcome {
            entries[id] = Entry(state: .blocked, identifier: handle, action: action, at: now, op: "undo"); save()
            return .blocked(capability)
        }
        guard !handle.isEmpty, handle.count <= 1024 else { return done(.failed(code: "failed")) }
        if handle.hasPrefix("alarm:") {
            guard let alarmID = UUID(uuidString: String(handle.dropFirst(6))) else { return done(.failed(code: "failed")) }
            guard store.access(.alarms) == .allowed else { return blocked(.alarms) }
            do { _ = try store.cancelAlarm(id: alarmID); return done(.undone) } catch { return done(.failed(code: "failed")) }
        }
        do {
            switch kind {
            case "event.create":
                guard store.access(.calendar) == .allowed else { return blocked(.calendar) }
                _ = try store.removeEvent(handle)
            case "reminder.create", "timer.start":
                guard store.access(.reminders) == .allowed else { return blocked(.reminders) }
                _ = try store.removeReminder(handle)
            default:
                // Type unknown (ledger pruned): the identifier is a reminder's or an event's.
                guard store.access(.reminders) == .allowed || store.access(.calendar) == .allowed else { return blocked(.reminders) }
                if store.access(.reminders) == .allowed, try store.removeReminder(handle) { break }
                if store.access(.calendar) == .allowed { _ = try store.removeEvent(handle) }
            }
            return done(.undone)
        } catch { return done(.failed(code: "failed")) }
    }

    // MARK: Ledger

    private func begin(_ id: String, action: DeviceAction, at: Date) {
        entries[id] = Entry(state: .started, action: action, at: at)
        save() // before the save call: a kill in between is found again by the marker
    }
    private func finish(_ id: String, action: DeviceAction, at: Date, _ outcome: DeviceOutcome, since started: Date) -> DeviceOutcome {
        var entry = Entry(state: .saved, action: action, at: at)
        entry.status = outcome.reportStatus
        switch outcome {
        case let .done(handle): entry.identifier = handle.map { String($0.prefix(1024)) }
        case let .failed(code): entry.code = DeviceReport.codes.contains(code) ? code : "failed"
        default: break
        }
        entry.execMs = Self.ms(since: started)
        entries[id] = entry; save()
        return outcome
    }
    private func block(_ id: String, action: DeviceAction, at: Date, _ capability: DeviceCapability, keep existing: Entry?) -> DeviceOutcome {
        if existing?.state != .started { entries[id] = Entry(state: .blocked, action: action, at: existing?.at ?? at); save() }
        return .blocked(capability)
    }
    private static func ms(since start: Date) -> Int { max(0, Int((Date().timeIntervalSince(start) * 1000).rounded())) }

    /// Drops entries older than 24 h, and reported ones after 1 h.
    func prune(now: Date = Date()) {
        let kept = entries.filter { _, entry in
            let age = now.timeIntervalSince(entry.at)
            return entry.state == .reported ? age < 3600 : age < 86_400
        }
        if kept.count != entries.count { entries = kept; save() }
    }
    private func save() {
        defaults.set(try? JSONEncoder().encode(entries), forKey: Self.ledgerKey)
    }

    /// The report for an entry whose outcome is final and not reported.
    func pendingReports() -> [DeviceReport] {
        entries.filter { $0.value.state == .saved && $0.value.status != nil }.sorted { $0.value.at < $1.value.at }.map { id, entry in
            DeviceReport(actionID: id, status: entry.status ?? "failed", handle: entry.status == "done" ? entry.identifier : nil,
                         code: entry.status == "failed" ? entry.code : nil, execMs: entry.execMs)
        }
    }
    private func markReported(_ id: String) {
        guard var entry = entries[id] else { return }
        entry.state = .reported; entries[id] = entry; save()
    }
    /// The undo target of a finished run, for the notification's Undo action.
    func handle(for id: String) -> String? {
        guard let entry = entries[id.lowercased()], entry.op == "run", entry.status == "done" else { return nil }
        return entry.identifier
    }

    // MARK: Orchestration

    /// Runs a row once; a missing permission is asked in the foreground or notified once per capability.
    func execute(id: String, action: DeviceAction, summary: String) async -> DeviceOutcome {
        var outcome = await run(id: id, action: action)
        if case let .blocked(capability) = outcome, await prompt(capability) { outcome = await run(id: id, action: action) }
        if case let .blocked(capability) = outcome { remind(capability, summary) }
        return outcome
    }
    /// Pending rows stay listed until reported, so every drain sees a blocked row again: notify at most hourly per capability.
    private func remind(_ capability: DeviceCapability, _ summary: String, now: Date = Date()) {
        let key = "ring.permissionNotified"
        var sent = defaults.dictionary(forKey: key) as? [String: Date] ?? [:]
        if let last = sent[capability.rawValue], now.timeIntervalSince(last) < 3600, now >= last { return }
        sent[capability.rawValue] = now
        defaults.set(sent, forKey: key)
        notifyBlocked(capability, summary)
    }

    /// Reports unreported entries, reruns blocked ones whose permission is now there, then claims and runs
    /// this device's queued/undoing rows, reporting each. Single flight: a call during a drain loops once more.
    func drain(report: @MainActor (DeviceReport) async throws -> Void, pending: @MainActor (String) async throws -> Data) async {
        guard !draining else { drainAgain = true; return }
        draining = true
        defer { draining = false }
        repeat {
            drainAgain = false
            prune()
            await sendReports(report)
            for (id, entry) in entries.filter({ $0.value.state == .blocked }).sorted(by: { $0.value.at < $1.value.at }) {
                if entry.op == "undo", let handle = entry.identifier { _ = await undo(id: id, handle: handle, type: entry.action.type) }
                else { _ = await run(id: id, action: entry.action) }
            }
            await sendReports(report)
            guard let data = try? await pending(deviceID) else { continue }
            for row in DevicePendingAction.list(data).prefix(Self.pendingLimit) {
                let id = row.id.lowercased()
                if row.op == "undo" {
                    guard let handle = row.handle else { continue }
                    let outcome = await undo(id: id, handle: handle, type: row.type)
                    if case let .blocked(capability) = outcome { remind(capability, Self.title(row.action) ?? "") }
                } else if let action = row.action, action.type == row.type {
                    // A row the host still lists as queued after we reported it (lost reply): report it again.
                    if entries[id]?.state == .reported, var entry = entries[id] { entry.state = .saved; entries[id] = entry }
                    _ = await execute(id: id, action: action, summary: Self.detail(action) ?? "")
                }
                await sendReports(report)
            }
        } while drainAgain
    }
    private func sendReports(_ report: @MainActor (DeviceReport) async throws -> Void) async {
        for item in pendingReports() {
            do { try await report(item); markReported(item.actionID) }
            catch let failure as AppFailure {
                // The host already decided (409 action_conflict, 404 gone): its state wins, stop retrying.
                if case let .service(status) = failure, status == 409 || status == 404 { markReported(item.actionID) }
            } catch {}
        }
    }

    /// Updates a `voice_intent` answer with the outcome of each device row it hands to this iPhone.
    func perform(_ result: VoiceIntentResult, now: Date = Date()) async -> VoiceIntentResult {
        var actions: [VoiceIntentResult.Action] = []
        for row in result.actions {
            guard RingIntent.runsHere(row), let action = row.action else { actions.append(row); continue }
            let outcome = await execute(id: row.id, action: action, summary: Self.detail(action, now: now) ?? row.summary)
            let summary = Self.summary(action, outcome, now: now) ?? row.summary
            let status: String
            switch outcome {
            case .done: status = "done"
            case .failed: status = "failed"
            case .undone: status = "undone"
            case .blocked: status = "blocked"
            case .busy, .ignored: status = row.status
            }
            var undoable = false
            if case let .done(handle) = outcome { undoable = handle != nil }
            actions.append(.init(id: row.id, type: row.type, status: status, summary: summary, undoable: undoable, runner: row.runner, action: action))
        }
        return VoiceIntentResult(memoID: result.memoID, route: result.route, messageSeq: result.messageSeq, actions: actions, delegatedTo: result.delegatedTo)
    }
    /// The single finished, undoable device row of a result, for the notification's Undo action.
    func undoTarget(_ result: VoiceIntentResult) -> (id: String, handle: String)? {
        let rows = result.actions.filter { $0.runner == "device" && $0.status == "done" && $0.undoable }
        guard rows.count == 1, let id = rows.first?.id, let handle = handle(for: id) else { return nil }
        return (id.lowercased(), handle)
    }

    // MARK: Card text on this iPhone (the host's card text stays authoritative)

    static func title(_ action: DeviceAction?) -> String? {
        guard let action else { return nil }
        return (action.type == "timer.start" ? action.label : action.title).map { clip($0) }
    }
    /// "Call mom · Today 17:00", used after "Reminder set:" and "Allow Reminders to finish:".
    static func detail(_ action: DeviceAction, now: Date = Date(), zone: TimeZone = .current) -> String? {
        guard let kind = action.validated else { return nil }
        switch kind {
        case let .reminder(title, due, _, _): return clip(title) + (due.map { " · " + at($0, now: now, zone: zone) } ?? "")
        case let .timer(label, fire, _):
            return clip(label) + " · " + (same(fire, now, zone) ? hm(fire, zone) : at(fire, now: now, zone: zone))
        case let .event(title, start, end, allDay, _, _):
            if allDay {
                let last = max(start, end.addingTimeInterval(-1))
                return clip(title) + " · " + day(start, now: now, zone: zone) + (same(last, start, zone) ? "" : "–" + day(last, now: now, zone: zone)) + " (all day)"
            }
            let span = same(start, end, zone) ? at(start, now: now, zone: zone) + "–" + hm(end, zone) : at(start, now: now, zone: zone) + " – " + at(end, now: now, zone: zone)
            return clip(title) + " · " + span
        }
    }
    static func summary(_ action: DeviceAction, _ outcome: DeviceOutcome, now: Date = Date()) -> String? {
        guard let detail = detail(action, now: now) else { return nil }
        let todo = action.list == "todo", alarm = action.kind == "alarm"
        switch (action.type, outcome) {
        case ("reminder.create", .done): return (todo ? "To-do added: " : "Reminder set: ") + detail
        case ("timer.start", .done): return (alarm ? "Alarm set: " : "Timer set: ") + detail
        case ("event.create", .done): return "Event added: " + detail
        case (_, .undone): return "Removed: " + detail
        case (_, .blocked(let capability)): return "Allow \(capability.appName) to finish: " + detail
        case ("reminder.create", .failed): return "Couldn't set the reminder: " + detail
        case ("timer.start", .failed(let code)): return code == "timeout" ? "Too late to set: " + detail : "Couldn't set the timer: " + detail
        case ("event.create", .failed): return "Couldn't add the event: " + detail
        default: return nil
        }
    }
    private static func clip(_ s: String, _ n: Int = 80) -> String { s.count <= n ? s : String(s.prefix(n - 1)).trimmingCharacters(in: .whitespaces) + "…" }
    private static func calendar(_ zone: TimeZone) -> Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = zone; return c }
    private static func same(_ a: Date, _ b: Date, _ zone: TimeZone) -> Bool { calendar(zone).isDate(a, inSameDayAs: b) }
    private static func hm(_ date: Date, _ zone: TimeZone) -> String {
        let c = calendar(zone).dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
    private static func day(_ date: Date, now: Date, zone: TimeZone) -> String {
        let cal = calendar(zone)
        if cal.isDate(date, inSameDayAs: now) { return "Today" }
        if let tomorrow = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(date, inSameDayAs: tomorrow) { return "Tomorrow" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB"); formatter.timeZone = zone
        formatter.dateFormat = cal.component(.year, from: date) == cal.component(.year, from: now) ? "EEE d MMM" : "EEE d MMM yyyy"
        return formatter.string(from: date)
    }
    private static func at(_ date: Date, now: Date, zone: TimeZone) -> String { day(date, now: now, zone: zone) + " " + hm(date, zone) }

    // MARK: Default permission hooks

    private static func foregroundPrompt(_ capability: DeviceCapability) async -> Bool {
        guard UIApplication.shared.applicationState == .active, shared.store.access(capability) == .notAsked else { return false }
        return await shared.store.request(capability).grants
    }
    static let permissionCategory = "RING_PERMISSION"
    private static func postPermissionNotification(_ capability: DeviceCapability, _ summary: String) {
        let content = UNMutableNotificationContent()
        content.title = "Allow \(capability.appName) on this iPhone"
        content.body = summary.isEmpty ? "Your ring memo is waiting for \(capability.appName)." : "Allow \(capability.appName) to finish: " + String(summary.prefix(200))
        content.threadIdentifier = "ring-memo"
        content.userInfo = [DevicePermissions.openKey: DevicePermissions.openValue]
        // One per capability: a second blocked memo replaces the first.
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "ring-permission-" + capability.rawValue, content: content, trigger: nil))
    }
}

extension DeviceActions {
    /// Drain over a host relay: `local_action_report` per entry, then `local_action_pending`.
    func drain(service: any HostService) async {
        await drain(report: { report in _ = try await RingIntent.report(report, service: service) },
                    pending: { deviceID in
                        let listed = try await RingIntent.call(service, "local_action_pending", ["device_id": .string(deviceID), "limit": .number(Double(Self.pendingLimit))],
                                                               seconds: RingIntent.intentTimeout)
                        return try JSONEncoder().encode(listed)
                    })
    }
}

extension DeviceReport {
    var arguments: [String: JSON] {
        var args: [String: JSON] = ["action_id": .string(actionID), "status": .string(status)]
        if let handle, !handle.isEmpty { args["handle"] = .string(String(handle.prefix(1024))) }
        if status == "failed" { args["code"] = .string(code.flatMap { Self.codes.contains($0) ? $0 : nil } ?? "failed") } // 400 otherwise
        if let execMs { args["exec_ms"] = .number(Double(max(0, execMs))) }
        return args
    }
}

// MARK: - EventKit store

@MainActor final class EventKitDeviceStore: DeviceStore {
    private var store = EKEventStore()

    func access(_ capability: DeviceCapability) -> PermissionState {
        switch capability {
        case .reminders: Self.state(EKEventStore.authorizationStatus(for: .reminder))
        case .calendar: Self.state(EKEventStore.authorizationStatus(for: .event))
        case .alarms: DeviceAlarms.state
        }
    }
    private static func state(_ status: EKAuthorizationStatus) -> PermissionState {
        switch status {
        case .fullAccess: .allowed
        case .writeOnly: .limited
        case .notDetermined: .notAsked
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }
    func request(_ capability: DeviceCapability) async -> PermissionState {
        switch capability {
        case .reminders:
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in Self.requestAccess(store, events: false, c) }
        case .calendar:
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in Self.requestAccess(store, events: true, c) }
        case .alarms:
            return await DeviceAlarms.request()
        }
        store = EKEventStore() // a store made before the grant doesn't see the newly allowed items
        return access(capability)
    }
    // EventKit calls these completions on its own queue. Closures made in a nonisolated function carry no
    // main-actor isolation, so Swift 6's runtime isolation check can't trap on them.
    nonisolated private static func requestAccess(_ store: EKEventStore, events: Bool, _ c: CheckedContinuation<Void, Never>) {
        if events { store.requestFullAccessToEvents { _, _ in c.resume() } }
        else { store.requestFullAccessToReminders { _, _ in c.resume() } }
    }
    nonisolated private static func fetch(_ store: EKEventStore, _ predicate: NSPredicate, marker: String, _ c: CheckedContinuation<String?, Never>) {
        store.fetchReminders(matching: predicate) { reminders in
            c.resume(returning: reminders?.first { DeviceActions.lastLine($0.notes) == marker }?.calendarItemIdentifier)
        }
    }
    func lists(_ capability: DeviceCapability) -> [DeviceList] {
        let type: EKEntityType
        switch capability {
        case .reminders: guard access(.reminders) == .allowed else { return [] }; type = .reminder
        case .calendar: guard access(.calendar) == .allowed else { return [] }; type = .event
        case .alarms: return []
        }
        return store.calendars(for: type).filter(\.allowsContentModifications).map { DeviceList(id: $0.calendarIdentifier, title: $0.title) }
    }
    private func reminderList(_ id: String?) -> EKCalendar? {
        id.flatMap { store.calendar(withIdentifier: $0) }.flatMap { $0.allowedEntityTypes.contains(.reminder) ? $0 : nil } ?? store.defaultCalendarForNewReminders()
    }
    func addReminder(_ item: DeviceItem, list: String?) throws -> String {
        guard let calendar = reminderList(list) else { throw AppFailure.invalidResponse }
        let reminder = EKReminder(eventStore: store)
        reminder.title = item.title
        reminder.notes = item.notes
        reminder.calendar = calendar
        if let due = item.due {
            var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            components.timeZone = .current
            reminder.dueDateComponents = components
            reminder.addAlarm(EKAlarm(absoluteDate: due))
        }
        try store.save(reminder, commit: true)
        return reminder.calendarItemIdentifier
    }
    func findReminder(marker: String, list: String?) async -> String? {
        guard let calendar = reminderList(list) else { return nil }
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: [calendar])
        return await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in Self.fetch(store, predicate, marker: marker, c) }
    }
    func removeReminder(_ identifier: String) throws -> Bool {
        guard let reminder = store.calendarItem(withIdentifier: identifier) as? EKReminder else { return false }
        try store.remove(reminder, commit: true)
        return true
    }
    func addEvent(_ item: DeviceItem, calendar: String?) throws -> String? {
        guard let start = item.start, let end = item.end else { throw AppFailure.invalidResponse }
        let event = EKEvent(eventStore: store)
        event.title = item.title
        event.notes = item.notes
        event.location = item.location
        event.isAllDay = item.allDay
        event.startDate = start
        event.endDate = item.allDay ? max(start, end.addingTimeInterval(-1)) : end
        let chosen = access(.calendar) == .allowed ? calendar.flatMap { store.calendar(withIdentifier: $0) }.flatMap { $0.allowsContentModifications ? $0 : nil } : nil
        guard let target = chosen ?? store.defaultCalendarForNewEvents else { throw AppFailure.invalidResponse }
        event.calendar = target
        try store.save(event, span: .thisEvent, commit: true)
        return access(.calendar) == .allowed ? event.eventIdentifier : nil
    }
    func findEvent(marker: String, around: Date, calendar: String?) -> String? {
        let calendars = calendar.flatMap { store.calendar(withIdentifier: $0) }.map { [$0] } ?? store.defaultCalendarForNewEvents.map { [$0] }
        let predicate = store.predicateForEvents(withStart: around.addingTimeInterval(-86_400), end: around.addingTimeInterval(86_400), calendars: calendars)
        return store.events(matching: predicate).first { DeviceActions.lastLine($0.notes) == marker }?.eventIdentifier
    }
    func removeEvent(_ identifier: String) throws -> Bool {
        guard let event = store.event(withIdentifier: identifier) else { return false }
        try store.remove(event, span: .thisEvent, commit: true)
        return true
    }
    func scheduleAlarm(id: UUID, label: String, fireAt: Date, countdown: Bool) async throws {
        try await DeviceAlarms.schedule(id: id, label: label, fireAt: fireAt, countdown: countdown)
    }
    func alarmExists(id: UUID) -> Bool { DeviceAlarms.exists(id: id) }
    func cancelAlarm(id: UUID) throws -> Bool { try DeviceAlarms.cancel(id: id) }
}

// MARK: - AlarmKit (iOS 26), isolated here

/// Every AlarmKit call goes through this enum. Before iOS 26, or on an SDK without AlarmKit, alarms are
/// `unavailable` and timers use the ⏱ Reminders path.
/// TODO(AlarmKit): verify on device — `AlarmPresentation.Alert(title:stopButton:)` (deprecated in later 26.x SDKs
/// in favour of a form without `stopButton`) and whether a countdown needs a Live Activity in SwarmaaLiveActivity.
@MainActor enum DeviceAlarms {
    static let unavailable = PermissionState.unavailable("Needs iOS 26 — timers use Reminders")
    enum Failure: Error { case unavailable }

    static var state: PermissionState {
        #if canImport(AlarmKit)
        if #available(iOS 26, *) { return AlarmKitBridge.state }
        #endif
        return unavailable
    }
    static func request() async -> PermissionState {
        #if canImport(AlarmKit)
        if #available(iOS 26, *) { return await AlarmKitBridge.request() }
        #endif
        return unavailable
    }
    static func schedule(id: UUID, label: String, fireAt: Date, countdown: Bool) async throws {
        #if canImport(AlarmKit)
        if #available(iOS 26, *) { try await AlarmKitBridge.schedule(id: id, label: label, fireAt: fireAt, countdown: countdown); return }
        #endif
        throw Failure.unavailable
    }
    static func exists(id: UUID) -> Bool {
        #if canImport(AlarmKit)
        if #available(iOS 26, *) { return AlarmKitBridge.exists(id: id) }
        #endif
        return false
    }
    static func cancel(id: UUID) throws -> Bool {
        #if canImport(AlarmKit)
        if #available(iOS 26, *) { return try AlarmKitBridge.cancel(id: id) }
        #endif
        return false
    }
}

#if canImport(AlarmKit)
@available(iOS 26, *)
private struct DeviceAlarmMetadata: AlarmMetadata {}

@available(iOS 26, *)
@MainActor private enum AlarmKitBridge {
    typealias Metadata = DeviceAlarmMetadata

    static var state: PermissionState {
        switch AlarmManager.shared.authorizationState {
        case .authorized: .allowed
        case .notDetermined: .notAsked
        case .denied: .denied
        @unknown default: .denied
        }
    }
    static func request() async -> PermissionState {
        _ = try? await AlarmManager.shared.requestAuthorization()
        return state
    }
    /// id = action id; `countdown` (kind 'timer') counts down to `fireAt`, otherwise a fixed-date alarm.
    static func schedule(id: UUID, label: String, fireAt: Date, countdown: Bool) async throws {
        let title: LocalizedStringResource = "\(label)"
        let alert = AlarmPresentation.Alert(title: title, stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.fill"))
        let attributes = AlarmAttributes<Metadata>(presentation: AlarmPresentation(alert: alert), tintColor: Color(hex: 0x8FB8FF))
        let configuration: AlarmManager.AlarmConfiguration<Metadata> = countdown
            ? .timer(duration: max(1, fireAt.timeIntervalSinceNow), attributes: attributes)
            : .alarm(schedule: .fixed(fireAt), attributes: attributes)
        _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
    }
    static func exists(id: UUID) -> Bool { ((try? AlarmManager.shared.alarms) ?? []).contains { $0.id == id } }
    static func cancel(id: UUID) throws -> Bool {
        guard exists(id: id) else { return false } // already fired or cancelled: undone
        try AlarmManager.shared.cancel(id: id)
        return true
    }
}
#endif
