import SwiftUI

// MARK: - Needs you

/// The default pane: what needs the owner, then what is running.
struct NeedsYouPane: View {
    @ObservedObject var model: TeamsModel
    @State private var selectedID: String?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date(), format: .dateTime.weekday(.wide).month().day()).font(.caption).foregroundStyle(Palette.textSecondary)
                Text(verbatim: model.attention.count == 1 ? L10n.t("1 thing needs you")
                                                           : L10n.t("\(model.attention.count) things need you"))
                    .font(.title2.weight(.semibold))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.vertical, 14)
            Divider()
            if model.attention.isEmpty && model.openSwarms.isEmpty {
                TeamsEmptyState(symbol: "checkmark.circle", title: L10n.t("Nothing needs you"),
                                detail: L10n.t("Questions, reviews and failures from your agents show up here."), action: nil)
            } else {
                List(selection: $selectedID) {
                    if !model.attention.isEmpty {
                        Section(L10n.t("Needs you")) {
                            ForEach(model.attention) { NeedsYouRow(model: model, item: $0).tag($0.id) }
                        }
                    }
                    if !model.openSwarms.isEmpty {
                        Section(L10n.t("Running")) {
                            ForEach(model.openSwarms) { RunningSwarmRow(model: model, swarm: $0, interactive: false).tag($0.id) }
                        }
                    }
                }
            }
            Divider()
            HStack {
                if let item = model.attention.first(where: { $0.id == selectedID }) {
                    AttentionActions(model: model, item: item)
                } else if let swarm = model.openSwarms.first(where: { $0.id == selectedID }) {
                    Button("Open swarm") { model.detailSwarmID = swarm.id }
                } else if !model.isEmpty { Text("Select an item to act on it").font(.caption) }
                Spacer()
                if model.isEmpty { Button("Create agent…") { model.creatingAgent = true }.buttonStyle(.borderedProminent) }
                Button(L10n.t("Refresh")) { Task { await model.refresh() } }
            }
            .padding(12)
        }
    }
}

struct NeedsYouRow: View {
    @ObservedObject var model: TeamsModel
    let item: TeamsAttentionItem

    private var row: TeamsTaskRow { TeamsTaskRow(item) }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: item.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                TaskStateLine(row: row)
            }
            Spacer(minLength: 8)
            if let at = item.at {
                Text(at, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                    .font(.caption).foregroundStyle(Palette.textSecondary)
            }
        }
        .padding(.vertical, 3)
    }

}

struct AttentionActions: View {
    @ObservedObject var model: TeamsModel
    let item: TeamsAttentionItem
    private var row: TeamsTaskRow { TeamsTaskRow(item) }
    @ViewBuilder var body: some View {
        let busy = model.busyTasks.contains(item.id)
        switch (item.kind, row.section) {
        case ("question", _):
            Button(L10n.t("Answer")) { Task { await model.open(item) } }.buttonStyle(.borderedProminent)
        case ("swarm", _):
            Button(L10n.t("Open")) { Task { await model.open(item) } }
        case ("task", .failed):
            Button(L10n.t("Retry")) { Task { await model.retry(item.id) } }.disabled(busy)
        case ("task", .review) where row.branch != nil:
            Button(model.reviewed.contains(row.id) ? "Review command copied" : "Copy review command") { model.review(row) }
                .help(L10n.t("Copies git log -p \(row.branch ?? "") to the clipboard"))
            if model.reviewed.contains(item.id), !model.answeringBlocked {
                Button(L10n.t("Mark resolved")) { Task { await model.resolve(item.id, true) } }
                    .buttonStyle(.borderedProminent).disabled(busy)
            }
        default:
            EmptyView()
        }
    }
}

struct RunningSwarmRow: View {
    @ObservedObject var model: TeamsModel
    let swarm: TeamsSwarm
    var interactive = true

    var body: some View {
        Group {
            if interactive { Button { model.detailSwarmID = swarm.id } label: { summary }.buttonStyle(.plain) }
            else { summary }
        }
    }

    private var summary: some View {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: swarm.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                    let names = swarm.runningAssignees.compactMap { model.agent(id: $0)?.name }
                    Text(verbatim: names.isEmpty ? TeamsCopy.swarmStatus(swarm.status) : names.joined(separator: ", "))
                        .font(.callout).foregroundStyle(Palette.textSecondary).lineLimit(2)
                }
                Spacer()
                Text(verbatim: "\(swarm.progress.done)/\(swarm.progress.total)").font(.system(size: 13, weight: .bold).monospacedDigit())
            }
            .contentShape(Rectangle())
    }
}

/// "Ready for review · branch swarmaa/claude/aa96efb9 · 12 files", the word coloured.
struct TaskStateLine: View {
    let row: TeamsTaskRow
    var body: some View {
        (Text(verbatim: row.word).foregroundColor(row.section.color).fontWeight(.semibold)
            + Text(verbatim: row.detail.isEmpty ? "" : " · " + row.detail).foregroundColor(Palette.textSecondary))
            .font(.callout).lineLimit(2)
    }
}

// MARK: - Tasks

struct TasksPane: View {
    @ObservedObject var model: TeamsModel
    @State private var showResolved = false
    @State private var selectedID: String?

    var body: some View {
        let sections = TeamsTaskGrouping.sections(model.taskRows, search: model.taskSearch, sort: model.taskSort)
        VStack(spacing: 0) {
            Text(verbatim: L10n.t("Tasks")).font(.title2.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 14)
            Divider()
            if sections.isEmpty {
                TeamsEmptyState(symbol: "checklist", title: model.taskSearch.isEmpty ? L10n.t("No tasks") : L10n.t("No matches"),
                                detail: model.taskSearch.isEmpty ? L10n.t("Tasks your agents run show up here.") : nil, action: nil)
            } else {
                List(selection: $selectedID) {
                    if model.taskSort == .newest {
                        rows(sections.flatMap(\.rows).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) })
                    } else {
                    ForEach(sections, id: \.section) { entry in
                        if entry.section == .resolved {
                            Section(isExpanded: $showResolved) { rows(entry.rows) } header: {
                                Text(verbatim: "\(entry.section.title) (\(entry.rows.count))")
                            }
                        } else {
                            Section(entry.section.title) { rows(entry.rows) }
                        }
                    }
                    }
                }
                .listStyle(.sidebar)
            }
            Divider()
            if let row = model.taskRows.first(where: { $0.id == selectedID }) {
                TaskActions(model: model, row: row).padding(.horizontal, 12).padding(.top, 8)
            }
            HStack(spacing: 10) {
                TextField(L10n.t("Search tasks"), text: $model.taskSearch).textFieldStyle(.roundedBorder)
                Picker(L10n.t("Sort"), selection: $model.taskSort) {
                    Text(verbatim: L10n.t("Newest")).tag(TeamsTaskSort.newest)
                    Text(verbatim: L10n.t("By state")).tag(TeamsTaskSort.state)
                }
                .pickerStyle(.segmented).fixedSize()
            }
            .padding(12)
        }
    }

    private func rows(_ rows: [TeamsTaskRow]) -> some View {
        ForEach(rows) { TaskRowView(model: model, row: $0).tag($0.id) }
    }
}

struct TaskRowView: View {
    @ObservedObject var model: TeamsModel
    let row: TeamsTaskRow

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: row.section == .resolved ? "checkmark.circle" : "circle")
                .accessibilityLabel(row.section.title)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: row.title).font(.body).lineLimit(2)
                    .strikethrough(row.section == .resolved).foregroundStyle(row.section == .resolved ? Palette.textSecondary : Palette.textPrimary)
                TaskStateLine(row: row)
            }
            Spacer()
            if let at = row.at {
                Text(at, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                    .font(.caption).foregroundStyle(Palette.textSecondary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

struct TaskActions: View {
    @ObservedObject var model: TeamsModel
    let row: TeamsTaskRow
    var body: some View {
        HStack {
            Text(row.title).lineLimit(2)
            Spacer()
            if row.kind != "task", let item = model.attention.first(where: { $0.id == row.id }) {
                Button("Open") { Task { await model.open(item) } }
                    .accessibilityLabel("Open: " + row.title)
            }
            if row.branch != nil {
                Button(model.reviewed.contains(row.id) ? "Copied" : "Copy review command") { model.review(row) }
            }
            if row.kind == "task", row.section == .failed {
                Button("Retry") { Task { await model.retry(row.id) } }.disabled(model.busyTasks.contains(row.id))
            }
            if row.resolvable, !model.answeringBlocked {
                Button(row.section == .resolved ? "Unresolve" : "Resolve") {
                    Task { await model.resolve(row.id, row.section != .resolved) }
                }
                .accessibilityLabel((row.section == .resolved ? "Unresolve: " : "Resolve: ") + row.title)
                .disabled(model.busyTasks.contains(row.id))
            }
        }
    }

}

// MARK: - Setup checklist

struct SetupChecklistView: View {
    @ObservedObject var model: TeamsModel
    /// Shown as a sheet the first time something is wrong; Done closes it.
    var onDone: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: L10n.t("Setup")).font(.title2.weight(.semibold))
            VStack(alignment: .leading, spacing: 10) {
                if model.setupRows.isEmpty {
                    Text(verbatim: L10n.t("Not checked yet.")).foregroundStyle(Palette.textSecondary)
                }
                ForEach(model.setupRows) { SetupRowView(row: $0) }
            }
            HStack {
                Spacer()
                if model.checkingSetup { ProgressView().controlSize(.small) }
                Button(L10n.t("Check again")) { Task { await model.runSetup() } }.disabled(model.checkingSetup)
                if let onDone { Button(L10n.t("Done"), action: onDone).keyboardShortcut(.defaultAction) }
            }
        }
        .padding(20)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .onExitCommand { onDone?() }
        .task { if model.setupRows.isEmpty { await model.runSetup() } }
    }
}

struct SetupRowView: View {
    let row: TeamsSetupRow

    private var badge: (String, Color) {
        switch row.state {
        case .ready: return (L10n.t("Ready"), .green)
        case .notChecked: return (L10n.t("Not checked"), .secondary)
        case .needsSetup: return (L10n.t("Needs setup"), .orange)
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: badge.0).font(.system(size: 11, weight: .semibold)).foregroundStyle(badge.1)
                .frame(width: 84, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: row.title).font(.body)
                if row.state != .ready {
                    Text(verbatim: row.fix).font(.caption).foregroundStyle(Palette.textSecondary)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
