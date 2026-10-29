import SwiftUI

// MARK: - Needs you

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
        (Text(verbatim: row.word).foregroundColor(KS.ink).fontWeight(.bold)
            + Text(verbatim: row.detail.isEmpty ? "" : " · " + row.detail).foregroundColor(KS.textSoft))
            .font(KS.body(14)).lineLimit(1)
    }
}

// MARK: - Tasks

struct TasksPane: View {
    @ObservedObject var model: TeamsModel
    @State private var showResolved = false
    @State private var selectionAnchor: String?

    var body: some View {
        let sections = TeamsTaskGrouping.sections(model.taskRows, search: model.taskSearch, sort: model.taskSort)
        VStack(spacing: 0) {
            KSTopBar {
                Text(verbatim: L10n.t("TASKS.")).font(KS.display(24)).fixedSize()
                Text(verbatim: L10n.t("Everything your bots are doing, done or stuck on."))
                    .font(KS.body(13)).foregroundStyle(KS.textSoft).lineLimit(1)
                Spacer(minLength: 0)
                Button(L10n.t(model.selectingTasks ? "Cancel" : "Select")) {
                    model.selectingTasks.toggle(); model.taskSelection.removeAll(); model.taskDetailID = nil
                }.buttonStyle(.ks(.paper)).disabled(model.bulkTasksBusy)
                TeamsConnectionStatus(model: model)
                KSSearchField(prompt: L10n.t("Search tasks"), text: $model.taskSearch, height: 32).frame(minWidth: 120, maxWidth: 220)
                Picker(L10n.t("Sort"), selection: $model.taskSort) {
                    Text(verbatim: L10n.t("By state")).tag(TeamsTaskSort.state)
                    Text(verbatim: L10n.t("Newest")).tag(TeamsTaskSort.newest)
                }
                .pickerStyle(.segmented).fixedSize().labelsHidden()
            }
            HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if sections.isEmpty {
                        TeamsEmptyState(symbol: "checklist", title: model.taskSearch.isEmpty ? L10n.t("No tasks") : L10n.t("No matches"),
                                        detail: model.taskSearch.isEmpty ? L10n.t("Tasks your bots run show up here.") : nil, action: nil)
                    } else if model.taskSort == .newest {
                        panel(sections.flatMap(\.rows).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }, shadow: false)
                    } else {
                        ForEach(Array(sections.enumerated()), id: \.element.section) { i, entry in
                            let number = String(format: "%02d", i + 1)
                            if entry.section == .resolved {
                                Button { showResolved.toggle() } label: {
                                    Label(number + " — " + entry.section.title + " · \(entry.rows.count)", systemImage: showResolved ? "chevron.down" : "chevron.right")
                                }
                                .buttonStyle(.ks(.paper)).accessibilityAddTraits(showResolved ? .isSelected : [])
                                if showResolved { panel(entry.rows, shadow: false) }
                            } else {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(spacing: 8) {
                                        KSLabel(number + " — " + entry.section.title)
                                        KSChip("\(entry.rows.count)", fill: Self.tint(entry.section), ink: entry.section == .failed ? KS.paper : KS.ink)
                                    }
                                    panel(entry.rows, shadow: i == 0)
                                }
                            }
                        }
                    }
                    if !model.resolvedCursors.isEmpty, showResolved || model.taskSort == .newest {
                        Button(L10n.t("Load more resolved tasks")) { Task { await model.loadMoreResolved() } }
                            .buttonStyle(.ks(.white)).disabled(model.loadingResolved)
                    }
                }
                .padding(28)
            }
            if model.taskDetailID != nil {
                TaskDetailPanel(model: model).frame(minWidth: 290, idealWidth: 350, maxWidth: 390)
            }
            }
            if let message = model.bulkTaskMessage {
                Text(verbatim: message).font(KS.body(13)).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(KS.sageTint).accessibilityLabel(message)
            }
            KSBottomBar {
                if !model.taskSelection.isEmpty {
                    Text(verbatim: L10n.t("\(model.taskSelection.count) selected")).font(KS.body(14, .bold))
                    Spacer()
                    ForEach([true, false], id: \.self) { resolved in
                        Button(L10n.t(resolved ? "Resolve" : "Unresolve")) { Task { await model.bulkResolve(resolved) } }
                            .buttonStyle(.ks(resolved ? .primary : .paper))
                            .disabled(model.bulkTasksBusy || model.answeringBlocked || !model.taskRows.contains {
                                model.taskSelection.contains($0.id) && model.taskCanApply($0, resolved: resolved)
                            })
                    }
                    Button(L10n.t("Cancel")) { model.taskSelection.removeAll(); model.selectingTasks = false }
                        .disabled(model.bulkTasksBusy)
                } else {
                    Spacer()
                    if let row = model.taskRows.first(where: { $0.id == model.taskDetailID }) { TaskActions(model: model, row: row) }
                }
            }
        }
        .background(KS.paper)
        .onExitCommand { model.taskDetailID = nil; model.taskSelection.removeAll(); model.selectingTasks = false }
        .onChange(of: model.taskRows) { _, rows in
            model.taskSelection.formIntersection(rows.filter(model.taskSelectable).map(\.id))
        }
    }

    static func tint(_ section: TeamsTaskSection) -> Color {
        switch section {
        case .needsInput: return KS.coral
        case .review: return KS.sage
        case .working: return KS.sky
        case .failed: return KS.ink
        case .resolved: return KS.white
        }
    }

    private func activate(_ row: TeamsTaskRow) {
        let flags = NSEvent.modifierFlags
        if model.selectingTasks || flags.contains(.command) || flags.contains(.shift) {
            guard model.taskSelectable(row) else { return }
            model.selectingTasks = true; model.taskDetailID = nil
            let sections = TeamsTaskGrouping.sections(model.taskRows, search: model.taskSearch, sort: model.taskSort)
            let rows = model.taskSort == .newest
                ? sections.flatMap(\.rows).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
                : sections.filter { $0.section != .resolved || showResolved }.flatMap(\.rows)
            if flags.contains(.shift), let anchor = selectionAnchor,
               let start = rows.firstIndex(where: { $0.id == anchor }), let end = rows.firstIndex(where: { $0.id == row.id }) {
                model.taskSelection.formUnion(rows[min(start, end)...max(start, end)].filter(model.taskSelectable).map(\.id))
            } else {
                if !model.taskSelection.insert(row.id).inserted { model.taskSelection.remove(row.id) }
                selectionAnchor = row.id
            }
        } else if row.kind == "task" {
            Task { await model.openTaskDetail(row.id) }
        } else if let item = model.attention.first(where: { $0.id == row.id }) {
            Task { await model.open(item) }
        }
    }

    private func panel(_ rows: [TeamsTaskRow], shadow: Bool) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                Button { activate(row) } label: {
                    HStack(spacing: 0) {
                        if model.selectingTasks {
                            Image(systemName: model.taskSelection.contains(row.id) ? "checkmark.square.fill" : "square")
                                .foregroundStyle(model.taskSelectable(row) ? KS.ink : KS.textMuted)
                                .padding(.leading, 14).accessibilityLabel(L10n.t(model.taskSelectable(row) ? "Select task" : "Task cannot be selected"))
                        }
                        TaskRowView(model: model, row: row, selected: model.taskSelection.contains(row.id) || model.taskDetailID == row.id)
                    }
                }
                .buttonStyle(.plain).disabled(model.bulkTasksBusy || (model.selectingTasks && !model.taskSelectable(row)))
                .accessibilityAddTraits(model.taskSelection.contains(row.id) ? .isSelected : [])
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .ksCard(fill: .clear, radius: 20, shadow: shadow)
    }
}

struct TaskRowView: View {
    @ObservedObject var model: TeamsModel
    let row: TeamsTaskRow
    var selected = false

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(row.section == .resolved ? KS.lime : row.section == .working ? KS.sky : KS.white)
                Circle().stroke(KS.ink, lineWidth: 2.5)
                if row.section == .resolved { Image(systemName: "checkmark").font(.system(size: 12, weight: .heavy)) }
            }
            .frame(width: 26, height: 26).accessibilityLabel(row.section.title)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: row.title).font(KS.body(16, .bold)).lineLimit(1)
                    .strikethrough(row.section == .resolved)
                    .foregroundStyle(row.section == .resolved ? KS.textMuted : KS.ink)
                TaskStateLine(row: row)
            }
            Spacer()
            if let at = row.at {
                Text(at, format: .relative(presentation: .numeric, unitsStyle: .narrow)).font(KS.mono(10)).foregroundStyle(KS.textMuted)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(selected ? KS.sageTint : row.section == .needsInput ? KS.coralTint : KS.white)
        .contentShape(Rectangle())
    }
}

struct TaskActions: View {
    @ObservedObject var model: TeamsModel
    let row: TeamsTaskRow
    var body: some View {
        HStack(spacing: 8) {
            if row.kind != "task", let item = model.attention.first(where: { $0.id == row.id }) {
                Button(L10n.t("Open")) { Task { await model.open(item) } }.buttonStyle(.ks(.paper))
                    .accessibilityLabel("Open: " + row.title)
            }
            if row.branch != nil {
                Button(model.reviewed.contains(row.id) ? L10n.t("Copied") : L10n.t("Copy review command")) { model.review(row) }
                    .buttonStyle(.ks(.paper))
            }
            if row.kind == "task", row.section == .failed {
                Button(L10n.t("Retry")) { Task { await model.retry(row.id) } }.buttonStyle(.ks(.white))
                    .disabled(model.busyTasks.contains(row.id))
            }
            if row.resolvable, !model.answeringBlocked {
                Button(row.section == .resolved ? L10n.t("Unresolve") : L10n.t("Mark resolved")) {
                    Task { await model.resolve(row.id, row.section != .resolved) }
                }
                .buttonStyle(.ks(.primary))
                .accessibilityLabel((row.section == .resolved ? "Unresolve: " : "Resolve: ") + row.title)
                .disabled(model.busyTasks.contains(row.id))
            }
        }
    }
}

struct TaskDetailPanel: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    KSLabel(L10n.t("TASK DETAILS"))
                    Spacer()
                    Button { model.taskDetailID = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).accessibilityLabel(L10n.t("Close task details"))
                }
                if let d = model.taskDetail, d.task.id == model.taskDetailID {
                    Text(verbatim: d.task.objective).font(KS.body(18, .bold)).textSelection(.enabled)
                    field("State", d.resolved ? L10n.t("Resolved") : d.task.status)
                    let context = model.taskContext(d.task.id)
                    if !context.isEmpty { field("Team", context.joined(separator: " · ")) }
                    field("Agent", d.result?.agent)
                    field("Service", d.served?.provider)
                    field("Model", d.served?.model)
                    if d.served?.model == nil { field("Requested model", d.permission?.runner?.model) }
                    field("Effort", d.permission?.runner?.effort)
                    field("Duration", d.result?.durationMS.map(TeamsRun.duration))
                    VStack(alignment: .leading, spacing: 10) {
                        KSLabel(L10n.t("RUNS") + " · \(d.runs.count)")
                        if d.runs.isEmpty { Text(verbatim: L10n.t("Not recorded")) }
                        ForEach(Array(d.runs.enumerated()), id: \.offset) { index, run in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(verbatim: L10n.t("Attempt \(index + 1)")).font(KS.body(14, .bold))
                                field("Worker", run.worker_id)
                                field("Provider", run.provider)
                                field("Model", run.model)
                                field("Start", run.started_at?.formatted(date: .abbreviated, time: .shortened))
                                field("End", run.ended_at?.formatted(date: .abbreviated, time: .shortened))
                                field("Outcome", run.status)
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(KS.paper, in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    field("Branch", d.result?.branch)
                    field("Changed files", d.result.map { result in
                        !result.files.isEmpty ? result.files.joined(separator: "\n") : result.fileCount.map { L10n.t("\($0) files (names not recorded)") } ?? L10n.t("Not recorded")
                    })
                    field("Summary", d.result?.summary)
                    VStack(alignment: .leading, spacing: 8) {
                        KSLabel(L10n.t("TOKENS"))
                        if let usage = d.result?.usage {
                            field("Input", TeamsTaskBulk.tokens(usage.input_tokens))
                            field("Cached input", usage.cached_input_tokens.map(TeamsTaskBulk.tokens))
                            field("Output", TeamsTaskBulk.tokens(usage.output_tokens))
                        } else { Text(verbatim: L10n.t("Not recorded")) }
                    }
                } else if let error = model.taskDetailError {
                    Text(verbatim: error)
                    Button(L10n.t("Try again")) { if let id = model.taskDetailID { Task { await model.openTaskDetail(id) } } }
                } else { ProgressView(L10n.t("Loading task…")) }
            }.font(KS.body(13)).foregroundStyle(KS.ink).padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }.background(KS.white)
    }

    private func field(_ label: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: L10n.t(label)).font(KS.body(11, .bold)).foregroundStyle(KS.textSoft)
            Text(verbatim: value ?? L10n.t("Not recorded")).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
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
