import AppKit
import SwiftUI

/// The Swarmaa main window: agents, channels and their threads (TEAMS.md §1).
/// One at a time; reopening brings it forward and refreshes.
@MainActor
final class TeamsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    let model = TeamsModel()

    /// `threadID` opens straight onto that thread (a notch swarm or question).
    func show(threadID: String? = nil) {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 720),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: false)
            window.title = "Swarmaa"
            window.minSize = NSSize(width: 820, height: 520)
            window.contentView = NSHostingView(rootView: TeamsRootView(model: model))
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.setFrameAutosaveName("SwarmaaTeamsWindow")
            if !window.setFrameUsingName("SwarmaaTeamsWindow") { window.center() }
            self.window = window
            // The first time the window opens, show the setup checklist if anything is wrong.
            Task { [model] in
                await model.runSetup()
                if model.setupRows.contains(where: { $0.state == .needsSetup }) { model.showSetup = true }
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        model.isVisible = true
        if let threadID { model.select(threadID: threadID) }
        Task { await model.refresh() }
    }

    func windowDidBecomeKey(_ notification: Notification) { model.isVisible = true }
    func windowDidMiniaturize(_ notification: Notification) { model.isVisible = false }
    func windowDidDeminiaturize(_ notification: Notification) { model.isVisible = true }
    func windowWillClose(_ notification: Notification) {
        model.isVisible = false
        model.stopStream()
    }
}

struct TeamsRootView: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        HStack(spacing: 0) {
            TeamsRail(model: model)
            Divider()
            content
        }
        .frame(minWidth: 820, minHeight: 520)
        .foregroundStyle(Palette.textPrimary)
        .alert(L10n.t("Swarmaa"), isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button(L10n.t("OK")) { model.error = nil }
        } message: { Text(verbatim: model.error ?? "") }
        .sheet(item: Binding(get: { model.detailSwarmID.map(SwarmID.init) }, set: { model.detailSwarmID = $0?.id })) {
            SwarmDetailView(model: model, swarmID: $0.id)
        }
        .sheet(isPresented: $model.showSetup) { SetupChecklistView(model: model) { model.showSetup = false } }
    }

    private struct SwarmID: Identifiable { let id: String }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .serviceTooOld:
            TeamsEmptyState(symbol: "arrow.triangle.2.circlepath",
                            title: L10n.t("Update the Swarmaa service to use teams"),
                            detail: L10n.t("This service has no agents or threads yet. Update it, then reopen this window."),
                            action: (L10n.t("Try again"), { Task { await model.refresh() } }))
        case .failed(let message):
            TeamsEmptyState(symbol: "exclamationmark.triangle", title: message, detail: nil,
                            action: (L10n.t("Try again"), { Task { await model.refresh() } }))
        case .ready:
            switch model.pane {
            case .home: NeedsYouPane(model: model)
            case .tasks: TasksPane(model: model)
            case .agents:
                if model.isEmpty {
                    CreateFirstAgentView(model: model)
                } else {
                    HSplitView {
                        TeamsSidebar(model: model).frame(minWidth: 240, idealWidth: 280, maxWidth: 360)
                        Group {
                            if let t = model.selectedThreadID { ThreadView(model: model, threadID: t) }
                            else {
                                TeamsEmptyState(symbol: "bubble.left.and.bubble.right", title: L10n.t("Choose an agent or channel"),
                                                detail: nil, action: nil)
                            }
                        }
                        .frame(minWidth: 420, maxWidth: .infinity)
                    }
                }
            case .flows: FlowsPane(model: model)
            case .usage: UsagePane(status: model.status)
            }
        }
    }
}

// MARK: - Rail

struct TeamsRail: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        VStack(spacing: 14) {
            item("tray.full.fill", L10n.t("Needs you"), .home)
                .overlay(alignment: .topTrailing) {
                    if !model.attention.isEmpty {
                        Text(verbatim: model.attention.count > 99 ? "99+" : "\(model.attention.count)")
                            .font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 4).background(Capsule().fill(Color.accentColor))
                            .accessibilityLabel(L10n.t("\(model.attention.count) need you"))
                    }
                }
            item("checklist", L10n.t("Tasks"), .tasks)
            item("person.2.fill", L10n.t("Agents"), .agents)
            item("point.3.connected.trianglepath.dotted", L10n.t("Flows"), .flows)
            item("chart.pie.fill", L10n.t("Usage"), .usage)
            Divider().frame(width: 28)
            ForEach(model.status?.usage ?? [], id: \.provider) { usage in
                Button { model.pane = .usage } label: { QuotaRing(usage: usage) }
                    .buttonStyle(.plain)
                    .help("\(SwarmaCells.vendorName(usage.provider)): \(usage.headroom.map { "\(Int($0))% " + L10n.t("left") } ?? L10n.t("unknown"))")
            }
            Spacer()
            Button { AppDelegate.shared?.openSettings() } label: {
                Image(systemName: "gearshape").font(.system(size: 17)).frame(width: 36, height: 36)
            }
            .buttonStyle(.plain).foregroundStyle(Palette.textSecondary).help(L10n.t("Settings"))
        }
        .padding(.vertical, 14)
        .frame(width: 60)
    }

    private func item(_ symbol: String, _ title: String, _ pane: TeamsModel.Pane) -> some View {
        Button { model.pane = pane } label: {
            Image(systemName: symbol).font(.system(size: 16, weight: .medium))
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 9).fill(model.pane == pane ? Palette.barTrack : .clear))
        }
        .buttonStyle(.plain)
        .foregroundStyle(model.pane == pane ? Palette.textPrimary : Palette.textSecondary)
        .help(title)
        .accessibilityLabel(title)
    }
}

/// A provider's remaining quota as a ring, coloured by the app's usage bands.
struct QuotaRing: View {
    let usage: SwarmaStatus.Usage
    var size: CGFloat = 30

    private var used: Double? { usage.headroom.map { 1 - min(max($0, 0), 100) / 100 } }

    var body: some View {
        ZStack {
            Circle().stroke(Palette.ringTrack, lineWidth: 3)
            if let used {
                Circle().trim(from: 0, to: 1 - used)
                    .stroke(UsageBand.band(for: used).color(), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            Text(verbatim: String(SwarmaCells.vendorName(usage.provider).prefix(1)))
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(usage.ok ? Palette.textPrimary : Palette.textSecondary)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Sidebar

struct TeamsSidebar: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        VStack(spacing: 0) {
            TextField(L10n.t("Search"), text: $model.search)
                .textFieldStyle(.roundedBorder).padding(10)
            List(selection: Binding(get: { model.selectedThreadID }, set: { model.select(threadID: $0) })) {
                ForEach(model.visibleSections, id: \.section.id) { entry in
                    Section(entry.section.name) {
                        ForEach(entry.rows) { row in
                            TeamsRowView(row: row).tag(row.threadID)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
    }
}

struct TeamsRowView: View {
    let row: TeamsRow

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            TeamsAvatar(seed: row.avatarSeed, name: row.name, isChannel: row.isChannel)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: row.isChannel ? "# " + row.name : row.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    if let role = row.role, !role.isEmpty { RoleBadge(role: role) }
                    Spacer(minLength: 4)
                    if let time = row.time {
                        Text(time, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                            .font(.system(size: 11)).foregroundStyle(Palette.textSecondary).lineLimit(1)
                    }
                }
                HStack(spacing: 6) {
                    Text(verbatim: row.status == "waiting_on_you" ? L10n.t("Waiting on you") : row.preview)
                        .font(.system(size: 12))
                        .foregroundStyle(row.status == "waiting_on_you" ? Palette.watch : Palette.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if row.unread > 0 {
                        Text(verbatim: row.unread > 99 ? "99+" : "\(row.unread)")
                            .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Color.accentColor))
                            .accessibilityLabel(L10n.t("\(row.unread) unread"))
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct RoleBadge: View {
    let role: String
    var body: some View {
        Text(verbatim: role).font(.system(size: 10, weight: .medium)).lineLimit(1)
            .foregroundStyle(Palette.textSecondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(Palette.barTrack))
    }
}

/// Initials on a colour picked from the avatar seed, so the same agent is the
/// same colour on every Mac.
struct TeamsAvatar: View {
    let seed: String
    let name: String
    var isChannel = false
    var size: CGFloat = 32

    private var hue: Double {
        Double(seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value } % 360) / 360
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: isChannel ? 8 : size / 2).fill(Color(hue: hue, saturation: 0.45, brightness: 0.7))
            Text(verbatim: isChannel ? "#" : String(name.prefix(1)).uppercased())
                .font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Empty states and panes

struct TeamsEmptyState: View {
    let symbol: String
    let title: String
    let detail: String?
    let action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 34)).foregroundStyle(Palette.textSecondary)
            Text(verbatim: title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            if let detail { Text(verbatim: detail).foregroundStyle(Palette.textSecondary).multilineTextAlignment(.center) }
            if let action { Button(action.0, action: action.1).controlSize(.large) }
        }
        .padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct CreateFirstAgentView: View {
    @ObservedObject var model: TeamsModel
    @State private var creating = false

    var body: some View {
        TeamsEmptyState(symbol: "person.crop.circle.badge.plus", title: L10n.t("Create your first agent"),
                        detail: L10n.t("An agent is a teammate with a name, a role and a thread you come back to."),
                        action: (L10n.t("Create agent…"), { creating = true }))
            .sheet(isPresented: $creating) { CreateAgentSheet(model: model) }
    }
}

struct CreateAgentSheet: View {
    @ObservedObject var model: TeamsModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var role = ""
    @State private var instructions = ""
    @State private var scope = ""
    @State private var edits = false
    @State private var busy = false

    private var scopes: [String] { (model.status?.scopes ?? []).map(\.scope) }
    private var ready: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && !scope.trimmingCharacters(in: .whitespaces).isEmpty && !busy
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(verbatim: L10n.t("New agent")).font(.title2.weight(.semibold))
            Form {
                TextField(L10n.t("Name"), text: $name)
                TextField(L10n.t("Role"), text: $role, prompt: Text(verbatim: L10n.t("e.g. Team lead")))
                if scopes.isEmpty {
                    TextField(L10n.t("Project"), text: $scope, prompt: Text(verbatim: "project:…"))
                } else {
                    Picker(L10n.t("Project"), selection: $scope) {
                        ForEach(scopes, id: \.self) { Text(verbatim: SwarmaCells.scopeLabel($0)).tag($0) }
                    }
                }
                Toggle(L10n.t("May edit files"), isOn: $edits)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: L10n.t("Instructions"))
                    TextEditor(text: $instructions).font(.body).frame(height: 110)
                        .overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.barTrack))
                }
            }
            HStack {
                Spacer()
                Button(L10n.t("Cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L10n.t("Create")) {
                    busy = true
                    Task {
                        let ok = await model.createAgent(name: name.trimmingCharacters(in: .whitespaces),
                                                         role: role.trimmingCharacters(in: .whitespaces),
                                                         instructions: String(instructions.prefix(8192)),
                                                         scope: scope.trimmingCharacters(in: .whitespaces),
                                                         runner: .auto, edits: edits)
                        busy = false
                        if ok { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction).disabled(!ready)
            }
        }
        .padding(20).frame(width: 460)
        .onAppear { if scope.isEmpty, let first = scopes.first { scope = first } }
    }
}

struct FlowsPane: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        if model.openSwarms.isEmpty {
            TeamsEmptyState(symbol: "point.3.connected.trianglepath.dotted", title: L10n.t("No open swarms"),
                            detail: L10n.t("Swarms your agents start show up here while they run."), action: nil)
        } else {
            List(model.openSwarms) { swarm in
                Button {
                    if let t = swarm.threadID { model.select(threadID: t) }
                    model.detailSwarmID = swarm.id
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: swarm.title).font(.headline)
                            Text(verbatim: TeamsCopy.swarmStatus(swarm.status)).font(.caption).foregroundStyle(Palette.textSecondary)
                        }
                        Spacer()
                        Text(verbatim: "\(swarm.progress.done)/\(swarm.progress.total)").font(.headline.monospacedDigit())
                        Image(systemName: "chevron.right").foregroundStyle(Palette.textSecondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct UsagePane: View {
    let status: SwarmaStatus?

    var body: some View {
        if let usage = status?.usage, !usage.isEmpty {
            List(usage, id: \.provider) { u in
                HStack(spacing: 14) {
                    QuotaRing(usage: u, size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: SwarmaCells.vendorName(u.provider)).font(.headline)
                        if let error = u.error { Text(verbatim: error).font(.caption).foregroundStyle(Palette.critical) }
                        ForEach(Array(u.windows.enumerated()), id: \.offset) { _, w in
                            Text(verbatim: "\(w.name ?? "") \(w.usedPercent.map { "\(Int($0))% " + L10n.t("used") } ?? "")")
                                .font(.caption).foregroundStyle(Palette.textSecondary)
                        }
                    }
                    Spacer()
                    if let h = u.headroom { Text(verbatim: "\(Int(h))% " + L10n.t("left")).font(.headline.monospacedDigit()) }
                }
                .padding(.vertical, 4)
            }
        } else {
            TeamsEmptyState(symbol: "chart.pie", title: L10n.t("No usage readings yet"),
                            detail: L10n.t("Swarmaa shows each provider's quota once a worker reports it."), action: nil)
        }
    }
}

enum TeamsCopy {
    static func swarmStatus(_ status: String) -> String {
        switch status {
        case "planning": return L10n.t("Planning")
        case "running": return L10n.t("Running")
        case "waiting_on_you": return L10n.t("Waiting on you")
        case "blocked": return L10n.t("Blocked")
        case "done": return L10n.t("Done")
        case "cancelled": return L10n.t("Cancelled")
        case "failed": return L10n.t("Failed")
        case "pending": return L10n.t("Pending")
        default: return status
        }
    }
}
