import Foundation
import SwiftUI
import UIKit
import Speech
import UserNotifications
@preconcurrency import CoreBluetooth

/// One row of the "This iPhone" list (§11.5, revised). `wireName` nil = status row: shown, never advertised.
/// A new capability (Contacts, Location, Home) is one new type added to `DevicePermissions.all`.
protocol DevicePermission: Sendable {
    var id: String { get }
    var wireName: String? { get }
    var icon: String { get }
    var title: String { get }
    var subtitle: String { get }
    var deniedNote: String? { get }
    func state() async -> PermissionState
    func request() async -> PermissionState
}

enum DevicePermissions {
    static let all: [any DevicePermission] = [RemindersPermission(), CalendarPermission(), AlarmsPermission(),
                                              SpeechPermission(), NotificationsPermission(), BluetoothPermission()]

    /// `device_actions` for `voice_intent`: wire names of rows that are allowed or limited (unique, at most 8).
    static func capabilities(_ rows: [any DevicePermission] = all) async -> [String] {
        var names: [String] = []
        for row in rows {
            guard let name = row.wireName, !names.contains(name), names.count < 8, name.count <= 32 else { continue }
            if await row.state().grants { names.append(name) }
        }
        return names
    }
    static func row(for capability: DeviceCapability) -> (any DevicePermission)? { all.first { $0.wireName == capability.rawValue } }

    /// userInfo of a notification that opens the This iPhone section when tapped.
    static let openKey = "swarmaa_open", openValue = "this-iphone"
    static func opens(_ userInfo: [AnyHashable: Any]) -> Bool { userInfo[openKey] as? String == openValue }
}

/// Set by a notification tap; RootView opens the Ring sheet, which holds the This iPhone section.
@MainActor @Observable final class ThisIPhoneRoute {
    static let shared = ThisIPhoneRoute()
    var requested = false
}

// MARK: Rows

struct RemindersPermission: DevicePermission {
    let id = "reminders", wireName: String? = "reminders", icon = "checklist", title = "Reminders", subtitle = "Set and check reminders"
    let deniedNote: String? = nil
    func state() async -> PermissionState { await DeviceActions.access(.reminders) }
    func request() async -> PermissionState { await DeviceActions.request(.reminders) }
}

struct CalendarPermission: DevicePermission {
    let id = "calendar", wireName: String? = "calendar", icon = "calendar", title = "Calendar", subtitle = "See your day and add events"
    let deniedNote: String? = nil
    func state() async -> PermissionState { await DeviceActions.access(.calendar) }
    func request() async -> PermissionState { await DeviceActions.request(.calendar) }
}

struct AlarmsPermission: DevicePermission {
    let id = "alarms", wireName: String? = "alarms", icon = "alarm", title = "Alarms", subtitle = "Set alarms and timers"
    let deniedNote: String? = nil
    func state() async -> PermissionState { await DeviceActions.access(.alarms) }
    func request() async -> PermissionState { await DeviceActions.request(.alarms) }
}

struct SpeechPermission: DevicePermission {
    let id = "speech", wireName: String? = nil, icon = "waveform", title = "Speech recognition", subtitle = "Turn ring memos into text on this iPhone"
    let deniedNote: String? = "Memos lose the fast path: audio is sent and the Assistant handles it"
    func state() async -> PermissionState {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: .allowed
        case .notDetermined: .notAsked
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }
    func request() async -> PermissionState {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in SFSpeechRecognizer.requestAuthorization { _ in c.resume() } }
        return await state()
    }
}

struct NotificationsPermission: DevicePermission {
    let id = "notifications", wireName: String? = nil, icon = "bell", title = "Notifications", subtitle = "Confirm each action on your lock screen"
    let deniedNote: String? = nil
    func state() async -> PermissionState {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized: .allowed
        case .provisional, .ephemeral: .limited
        case .notDetermined: .notAsked
        case .denied: .denied
        @unknown default: .denied
        }
    }
    func request() async -> PermissionState {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        return await state()
    }
}

struct BluetoothPermission: DevicePermission {
    let id = "bluetooth", wireName: String? = nil, icon = "dot.radiowaves.left.and.right", title = "Bluetooth", subtitle = "Connect to your ring"
    let deniedNote: String? = nil
    func state() async -> PermissionState {
        switch CBManager.authorization {
        case .allowedAlways: .allowed
        case .notDetermined: .notAsked
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }
    /// iOS asks when the ring is first looked for, so this starts that.
    func request() async -> PermissionState {
        await MainActor.run { RingLink.shared.findRings() }
        return await state()
    }
}

// MARK: View

/// Connectors-style list of what Swarmaa may do on this iPhone, with list and calendar pickers.
struct ThisIPhoneSection: View {
    var rows: [any DevicePermission] = DevicePermissions.all
    @State private var states: [String: PermissionState] = [:]
    @State private var asking: String?
    @State private var reminderLists: [DeviceList] = []
    @State private var calendars: [DeviceList] = []
    @AppStorage("ring.remindersList") private var remindersList = ""
    @AppStorage("ring.todoList") private var todoList = ""
    @AppStorage("ring.calendar") private var calendar = ""
    @Environment(\.scenePhase) private var phase

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow("This iPhone")
            Text("Ring memos set reminders, events and timers right here; iCloud syncs them to your Mac. Anything not allowed here runs on your Mac instead.")
                .font(KS.secondary()).foregroundStyle(KS.muted).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                ForEach(rows.indices, id: \.self) { index in
                    permissionRow(rows[index])
                    if index < rows.count - 1 { Rectangle().fill(KS.hairline).frame(height: 1) }
                }
            }
            .padding(.horizontal, 12).card()
        }
        .task { await reload() }
        .onChange(of: phase) { _, value in if value == .active { Task { await reload() } } }
    }

    @ViewBuilder private func permissionRow(_ row: any DevicePermission) -> some View {
        let state = states[row.id] ?? .notAsked
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: row.icon).font(.system(size: 16, weight: .medium)).foregroundStyle(KS.ink)
                    .frame(width: 36, height: 36).background(KS.chip, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(KS.headline()).foregroundStyle(KS.strong)
                    Text(subtitle(row, state)).font(KS.secondary()).foregroundStyle(KS.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                trailing(row, state)
            }
            if state == .denied, let note = row.deniedNote {
                Text(note).font(KS.secondary()).foregroundStyle(KS.needsText).fixedSize(horizontal: false, vertical: true)
            }
            if row.wireName == DeviceCapability.reminders.rawValue, state == .allowed {
                picker("Reminders list", selection: $remindersList, lists: reminderLists)
                picker("To-do list", selection: $todoList, lists: reminderLists)
            }
            if row.wireName == DeviceCapability.calendar.rawValue, state == .allowed {
                picker("Calendar", selection: $calendar, lists: calendars)
            }
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private func subtitle(_ row: any DevicePermission, _ state: PermissionState) -> String {
        if case let .unavailable(reason) = state { return reason }
        return row.subtitle
    }

    @ViewBuilder private func trailing(_ row: any DevicePermission, _ state: PermissionState) -> some View {
        switch state {
        case .notAsked:
            Button(asking == row.id ? "Asking…" : "Allow") { ask(row) }
                .buttonStyle(Pill(fill: KS.signal)).disabled(asking != nil)
                .accessibilityLabel("Allow \(row.title)")
        case .allowed:
            grantedPill("Allowed")
        case .limited:
            grantedPill(row.wireName == DeviceCapability.calendar.rawValue ? "Allowed · undo unavailable" : "Allowed")
        case .denied:
            Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                .buttonStyle(Pill())
        case .unavailable:
            EmptyView()
        }
    }

    private func grantedPill(_ text: String) -> some View {
        Text(text).font(KS.secondary(.semibold)).foregroundStyle(KS.soft).multilineTextAlignment(.trailing)
            .padding(.horizontal, 10).frame(minHeight: 28).background(KS.chip, in: Capsule())
            .fixedSize(horizontal: false, vertical: true)
    }

    private func picker(_ label: String, selection: Binding<String>, lists: [DeviceList]) -> some View {
        HStack {
            Text(label).font(KS.secondary()).foregroundStyle(KS.soft)
            Spacer(minLength: 8)
            Picker(label, selection: selection) {
                Text("Default").tag("")
                ForEach(lists) { list in Text(list.title).tag(list.id) }
            }
            .pickerStyle(.menu).tint(KS.ink)
        }
        .padding(.leading, 48).frame(minHeight: 44)
    }

    private func ask(_ row: any DevicePermission) {
        asking = row.id
        Task {
            let granted = await row.request()
            states[row.id] = granted
            asking = nil
            // Memos that waited for this permission run now.
            if granted.grants, row.wireName != nil { RingLink.shared.drainDevice() }
            await reload()
        }
    }

    private func reload() async {
        for row in rows { states[row.id] = await row.state() }
        reminderLists = DeviceActions.lists(.reminders)
        calendars = DeviceActions.lists(.calendar)
    }
}
