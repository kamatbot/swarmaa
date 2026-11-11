import AppKit
import SwiftUI

// MARK: - Shared pieces

/// A provider's two-letter monogram on its accent: CL, CX, AG. Decorative; the name sits beside it.
struct ProviderMonogram: View {
    let provider: String?
    var size: CGFloat = 28
    /// Shown when no provider is known (an Auto runner): initials on a neutral chip.
    var fallback: String = ""
    var ring: Color? = nil

    var body: some View {
        let known = provider.map { !$0.isEmpty } ?? false
        Text(verbatim: known ? TeamsCopy.providerShort(provider!) : String(fallback.prefix(2)).uppercased())
            .font(KS.mono(size * 0.34, .bold))
            .foregroundStyle(known ? KS.onSignal : KS.ink)
            .frame(width: size, height: size)
            .background(Circle().fill(known ? KS.providerTint(provider!) : KS.chip))
            .overlay { if let ring { Circle().strokeBorder(ring, lineWidth: 2) } }
            .accessibilityHidden(true)
    }
}

/// "11:57" today, "2w" before.
enum KSClock {
    static func short(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        if Calendar.current.isDate(date, inSameDayAs: now) { return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }
        let days = max(1, Int(now.timeIntervalSince(date) / 86_400))
        return days < 7 ? "\(days)d" : days < 60 ? "\(days / 7)w" : "\(days / 30)mo"
    }

    static func duration(_ s: TimeInterval) -> String {
        let n = Int(max(0, s))
        return n < 60 ? "\(n)s" : n < 3600 ? "\(n / 60)m \(String(format: "%02d", n % 60))s" : "\(n / 3600)h \(n / 60 % 60)m"
    }
}

/// An 8 pt status dot with a soft halo when it is live.
struct StatusDot: View {
    enum State { case needsYou, running, done, idle, failed }
    let state: State
    var size: CGFloat = 8
    var color: Color {
        switch state {
        case .needsYou: KS.amber
        case .running: KS.signal
        case .done: KS.sage
        case .idle: KS.idle
        case .failed: KS.coral
        }
    }
    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .background(Circle().fill(color.opacity(state == .needsYou || state == .running ? 0.2 : 0)).frame(width: size + 6, height: size + 6))
            .accessibilityHidden(true)
    }
}

/// An 11 pt upper-case section label with an optional count pill.
struct KSSectionLabel: View {
    let text: String
    var count: Int? = nil
    var body: some View {
        HStack(spacing: 8) {
            KSLabel(text)
            if let count {
                Spacer(minLength: 0)
                Text(verbatim: "\(count)").font(KS.body(11, .medium)).foregroundStyle(KS.onInkSoft)
                    .padding(.horizontal, 7).background(Capsule().fill(KS.chip))
            }
        }
    }
}

// MARK: - Model derivations for one bot

extension TeamsModel {
    /// The swarm the bot view follows: the newest open one in its thread, else the newest.
    func botSwarm(_ bot: TeamsBot) -> TeamsSwarm? {
        var seen: [TeamsSwarm] = []
        for m in messages[bot.threadID] ?? [] {
            guard let id = m.swarm?.id ?? m.ref?.swarmID, let s = swarms[id] ?? m.swarm else { continue }
            seen.removeAll { $0.id == s.id }; seen.append(s)
        }
        for s in openSwarms where s.threadID == bot.threadID && !seen.contains(where: { $0.id == s.id }) { seen.append(swarms[s.id] ?? s) }
        let closed: Set<String> = ["done", "cancelled", "failed"]
        return seen.last { !closed.contains($0.status) } ?? seen.last
    }

    /// When the swarm's card landed in the thread: when it started, near enough.
    func botSwarmStarted(_ bot: TeamsBot, _ swarm: TeamsSwarm) -> Date? {
        (messages[bot.threadID] ?? []).first { ($0.swarm?.id ?? $0.ref?.swarmID) == swarm.id }?.createdAt
    }

    /// The bot's task cards, newest state per task, in thread order.
    func botTaskCards(_ bot: TeamsBot) -> [(card: TeamsTaskCard, at: Date?)] {
        var order: [String] = [], latest: [String: (TeamsTaskCard, Date?)] = [:]
        for m in messages[bot.threadID] ?? [] {
            guard let t = m.task else { continue }
            if latest[t.id] == nil { order.append(t.id) }
            latest[t.id] = (t, m.createdAt)
        }
        return order.compactMap { latest[$0].map { (card: $0.0, at: $0.1) } }
    }

    /// Open questions for this bot, from the service's list and its thread.
    func botQuestions(_ bot: TeamsBot) -> [TeamsQuestion] {
        var out = openQuestions.filter { $0.threadID == bot.threadID && $0.status == "open" }
        for q in (messages[bot.threadID] ?? []).compactMap(\.question) where q.status == "open" && !out.contains(where: { $0.id == q.id }) {
            out.append(q)
        }
        // A question answered in the thread drops out even if the list is a refresh behind.
        let answered = Set((messages[bot.threadID] ?? []).compactMap(\.question).filter { $0.status != "open" }.map(\.id))
        return out.filter { !answered.contains($0.id) }
    }

    func botIsRunning(_ bot: TeamsBot) -> Bool {
        botActiveTaskCount(bot) > 0 || crew(bot).contains { $0.status == "working" }
    }

    func botDot(_ bot: TeamsBot) -> StatusDot.State {
        if botNeedsYou(bot) > 0 { return .needsYou }
        if botIsRunning(bot) { return .running }
        if botUnread(bot) > 0 { return .done }
        return .idle
    }

    /// The live providers on this Mac's workers, each once, in a stable order.
    var workerProviders: [String] {
        let all = (status?.workers ?? []).flatMap(\.providers)
        let order = ["claude", "codex", "antigravity"]
        return Array(Set(all)).sorted { (order.firstIndex(of: $0) ?? 9, $0) < (order.firstIndex(of: $1) ?? 9, $1) }
    }

    func runningCount(provider: String) -> Int {
        (status?.workers ?? []).filter { $0.providers.first == provider }.reduce(0) { $0 + $1.running.count }
    }
}

/// Token use per finished task, looked up once per launch.
@MainActor enum TaskTokenCache {
    static var tokens: [String: Int] = [:]
    static var missing: Set<String> = []
}

// MARK: - Window top bar

/// The one bar across the workspace: breadcrumb, ⌘K search, agents online, and the primary action.
struct WorkspaceTopBar: View {
    @ObservedObject var model: TeamsModel
    @FocusState private var searchFocused: Bool

    private var trail: [String] {
        switch model.pane {
        case .bots: return [L10n.t("bots")] + (model.selectedBot.map { [$0.name] } ?? [])
        case .tasks: return [L10n.t("tasks")]
        case .usage: return [L10n.t("usage")]
        }
    }

    var body: some View {
        HStack(spacing: 16) {
            HStack(spacing: 8) {
                Text(verbatim: "swarmaa").font(KS.body(14, .semibold)).foregroundStyle(KS.strong)
                ForEach(Array(trail.enumerated()), id: \.offset) { i, part in
                    Text(verbatim: "/").foregroundStyle(KS.idle)
                    Text(verbatim: part).foregroundStyle(i == trail.count - 1 && trail.count > 1 ? KS.strong : KS.textSoft).lineLimit(1)
                }
            }
            .font(KS.body(14))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(L10n.t("Breadcrumb") + ": swarmaa, " + trail.joined(separator: ", "))
            panes
            Spacer(minLength: 8)
            KSSearchField(prompt: L10n.t("Search bots"), text: $model.search, height: 32)
                .focused($searchFocused)
                .frame(minWidth: 180, idealWidth: 280, maxWidth: 300)
                .overlay(alignment: .trailing) {
                    if model.search.isEmpty {
                        Text(verbatim: "⌘K").font(KS.mono(11, .medium)).foregroundStyle(KS.textSoft)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 4).fill(KS.chip))
                            .padding(.trailing, 8).allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .onChange(of: model.search) { _, q in if !q.isEmpty, model.pane != .bots { model.pane = .bots } }
            if !model.workerProviders.isEmpty {
                HStack(spacing: -7) {
                    ForEach(model.workerProviders, id: \.self) { ProviderMonogram(provider: $0, size: 28, ring: KS.topBar) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L10n.t("Agents online") + ": " + model.workerProviders.map(SwarmaCells.vendorName).joined(separator: ", "))
            }
            iconButton("point.3.connected.trianglepath.dotted", L10n.t("Swarm map"), on: model.showSwarmMap) { model.showSwarmMap.toggle() }
                .keyboardShortcut("m", modifiers: [.command, .shift])
            iconButton("gearshape", L10n.t("Settings"), on: false) { AppDelegate.shared?.openSettings() }
            Button { model.creatingBot = true } label: {
                Text(verbatim: "+ " + L10n.t("New bot")).font(KS.body(14, .semibold)).foregroundStyle(KS.onSignal)
                    .padding(.horizontal, 14).frame(height: 32)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(KS.signal))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).fixedSize()
            .accessibilityLabel(L10n.t("New bot"))
        }
        // The traffic lights sit at the bar's leading edge.
        .padding(.leading, 84).padding(.trailing, 16)
        .frame(maxWidth: .infinity, minHeight: KS.topBarHeight, maxHeight: KS.topBarHeight)
        .background(KS.topBar)
        .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
        .background {
            Button(L10n.t("Search bots")) { searchFocused = true }
                .keyboardShortcut("k", modifiers: .command).hidden().accessibilityHidden(true)
        }
    }
}

extension WorkspaceTopBar {
    /// Bots · Tasks · Usage: the window's panes, the Bots segment carrying its update count.
    var panes: some View {
        HStack(spacing: 2) {
            ForEach([(TeamsModel.Pane.bots, L10n.t("Bots")), (.tasks, L10n.t("Tasks")), (.usage, L10n.t("Usage"))], id: \.0) { pane, title in
                let on = model.pane == pane
                let badge = pane == .bots ? model.botsWithUpdates : 0
                Button { model.pane = pane } label: {
                    HStack(spacing: 6) {
                        Text(verbatim: title).font(KS.body(13, .medium)).foregroundStyle(on ? KS.strong : KS.textMuted)
                        if badge > 0 { KSBadge(count: badge) }
                    }
                    .padding(.horizontal, 10).frame(height: 26)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(on ? KS.selected : .clear))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(badge > 0 ? title + ", " + L10n.t("\(badge) with updates") : title)
                .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KS.well))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(KS.hairline, lineWidth: 1))
        .fixedSize()
    }

    func iconButton(_ symbol: String, _ label: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold))
                .foregroundStyle(on ? KS.onSignal : KS.textSoft)
                .frame(width: 32, height: 32)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? KS.signal : KS.chip.opacity(0.6)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label).accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

// MARK: - Bot workspace (centre column)

struct BotWorkspace: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                BotThreadHeader(model: model, bot: bot)
                if let swarm = model.botSwarm(bot), swarm.progress.total > 0, !["done", "cancelled"].contains(swarm.status) {
                    progress(swarm)
                }
                tabs
            }
            .padding(.horizontal, 28).padding(.top, 22)
            switch model.botTab {
            case .thread: ThreadView(model: model, threadID: bot.threadID).id(bot.threadID)
            case .timeline: BotTimeline(model: model, bot: bot)
            case .logs: BotLogs(model: model, bot: bot)
            }
        }
        .background(KS.paper)
        .task(id: bot.threadID) {
            if model.messages[bot.threadID] == nil { await model.loadLatest(bot.threadID) }
        }
    }

    private func progress(_ swarm: TeamsSwarm) -> some View {
        let f = Double(swarm.progress.done) / Double(max(swarm.progress.total, 1))
        return GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(KS.chip)
                Capsule().fill(KS.signal).frame(width: g.size.width * f)
            }
        }
        .frame(height: 5).padding(.top, 18).padding(.bottom, 4)
        .accessibilityElement().accessibilityLabel(L10n.t("\(swarm.progress.done) of \(swarm.progress.total) steps done"))
        .accessibilityValue("\(Int(f * 100))%")
    }

    private var tabs: some View {
        HStack(spacing: 4) {
            ForEach(TeamsModel.BotTab.allCases, id: \.self) { tab in
                let on = model.botTab == tab
                Button { model.botTab = tab } label: {
                    Text(verbatim: Self.title(tab)).font(KS.body(15, .medium))
                        .foregroundStyle(on ? KS.strong : KS.textMuted)
                        .padding(.horizontal, 14).frame(height: 32)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? KS.chip : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
            }
            Spacer()
        }
        .padding(.top, 14).padding(.bottom, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
    }

    static func title(_ tab: TeamsModel.BotTab) -> String {
        switch tab {
        case .thread: L10n.t("Thread")
        case .timeline: L10n.t("Timeline")
        case .logs: L10n.t("Logs")
        }
    }
}

// MARK: - Timeline

struct BotTimeline: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot

    private struct Row: Identifiable {
        let id: String
        let state: String
        let title: String
        let provider: String?
        let branch: String?
        let detail: String
        let trailing: String
    }

    private var rows: (swarm: [Row], tasks: [Row]) {
        let cards = model.botTaskCards(bot)
        let byID = Dictionary(cards.map { ($0.card.id, $0) }, uniquingKeysWith: { _, b in b })
        let msgs = model.messages[bot.threadID] ?? []
        var used = Set<String>()
        var steps: [Row] = []
        if let swarm = model.botSwarm(bot) {
            for step in swarm.steps {
                let card = step.taskID.flatMap { byID[$0] }
                if let id = step.taskID { used.insert(id) }
                let agent = model.agent(id: step.assigneeAgentID)
                let provider = card?.card.served?.provider ?? agent?.runner.provider
                var detail: [String] = []
                if step.status == "waiting_on_you" { detail.append(L10n.t("Waiting for your answer")) }
                if let f = step.failureDetail ?? step.failureCode { detail.append(f) }
                if let agent { detail.append(agent.name) }
                if let n = card?.card.changedFiles { detail.append(n == 1 ? L10n.t("1 file") : L10n.t("\(n) files")) }
                if let c = card?.card.check?.status { detail.append(L10n.t("check \(c)")) }
                let done = step.resultMessageID.flatMap { id in msgs.first { $0.id == id }?.createdAt }
                steps.append(Row(id: step.id, state: step.status, title: step.title, provider: provider, branch: card?.card.branch,
                                 detail: detail.joined(separator: " · "), trailing: KSClock.short(done ?? card?.at)))
            }
        }
        let tasks = cards.filter { !used.contains($0.card.id) }.reversed().map { c -> Row in
            let t = c.card
            var detail: [String] = []
            if let f = t.failure, t.isFailed { detail.append([f.code, f.detail].compactMap { $0 }.joined(separator: " · ")) }
            if let n = t.changedFiles { detail.append(n == 1 ? L10n.t("1 file") : L10n.t("\(n) files")) }
            if let k = t.kind { detail.append(k) }
            let state = t.isFailed ? "failed" : t.status == "completed" ? "done" : t.status ?? "pending"
            return Row(id: t.id, state: state, title: t.title ?? L10n.t("Task"), provider: t.served?.provider, branch: t.branch,
                       detail: detail.joined(separator: " · "), trailing: KSClock.short(c.at))
        }
        return (steps, Array(tasks))
    }

    var body: some View {
        let r = rows
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if r.swarm.isEmpty && r.tasks.isEmpty {
                    Text(verbatim: L10n.t("No steps yet. A swarm's steps and the bot's tasks appear here as it works."))
                        .font(KS.body(14)).foregroundStyle(KS.textMuted).padding(.vertical, 24)
                }
                if let swarm = model.botSwarm(bot), !r.swarm.isEmpty {
                    HStack {
                        KSLabel(swarm.title)
                        Spacer()
                        Button(L10n.t("Open swarm")) { model.detailSwarmID = swarm.id }.buttonStyle(.ks(.paper, compact: true))
                    }
                    .padding(.top, 14).padding(.bottom, 2)
                    ForEach(r.swarm) { row($0) }
                }
                if !r.tasks.isEmpty {
                    KSLabel(L10n.t("Tasks")).padding(.top, 18).padding(.bottom, 2)
                    ForEach(r.tasks) { row($0) }
                }
            }
            .padding(.horizontal, 28).padding(.bottom, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func row(_ r: Row) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Self.icon(r.state)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(verbatim: r.title).font(KS.body(16, .semibold)).foregroundStyle(KS.strong).lineLimit(2)
                    if let p = r.provider {
                        KSChip(p, fill: KS.providerTint(p).opacity(0.16), ink: KS.providerTint(p))
                    }
                    if let b = r.branch { KSChip(b, fill: KS.chipAlt, ink: KS.textSoft).textSelection(.enabled) }
                }
                if !r.detail.isEmpty {
                    Text(verbatim: r.detail).font(KS.body(14)).foregroundStyle(KS.textMuted).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Text(verbatim: r.trailing).font(KS.mono(12, .regular)).foregroundStyle(KS.textDim).padding(.top, 4)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder static func icon(_ state: String) -> some View {
        let (symbol, color, label): (String, Color, String) = switch state {
        case "done", "completed": ("checkmark", KS.readyText, L10n.t("Done"))
        case "waiting_on_you": ("pause.fill", KS.needsYouText, L10n.t("Waiting on you"))
        case "failed", "blocked", "cancelled": ("xmark", KS.failedText, TeamsCopy.swarmStatus(state))
        case "running", "claimed": ("ellipsis", KS.signal, L10n.t("Running"))
        default: ("circle.dotted", KS.textMuted, L10n.t("Pending"))
        }
        Image(systemName: symbol).font(.system(size: 11, weight: .bold)).foregroundStyle(color)
            .frame(width: 28, height: 28)
            .background(Circle().fill(color.opacity(0.18)))
            .accessibilityLabel(label)
    }
}

// MARK: - Logs

struct BotLogs: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot

    var body: some View {
        let list = model.messages[bot.threadID] ?? []
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4) {
                if list.isEmpty {
                    Text(verbatim: L10n.t("No events yet")).font(KS.body(14)).foregroundStyle(KS.textMuted).padding(.vertical, 24)
                }
                ForEach(list) { m in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(verbatim: m.createdAt.map { $0.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)) } ?? "—")
                            .foregroundStyle(KS.textDim).frame(width: 110, alignment: .leading)
                        Text(verbatim: m.kind.rawValue).foregroundStyle(Self.color(m)).frame(width: 64, alignment: .leading)
                        Text(verbatim: m.isHuman ? L10n.t("you") : (m.author.name ?? model.agent(id: m.author.id)?.name ?? m.author.kind))
                            .foregroundStyle(KS.textSoft).frame(width: 120, alignment: .leading).lineLimit(1)
                        Text(verbatim: Self.line(m)).foregroundStyle(KS.ink).lineLimit(1).truncationMode(.tail)
                    }
                    .font(KS.mono(12, .regular))
                    .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 28).padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .defaultScrollAnchor(.bottom)
    }

    static func line(_ m: TeamsMessage) -> String {
        var s = m.preview.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        if let t = m.task {
            s = [t.title ?? s, t.status, t.branch, t.changedFiles.map { "\($0) files" }].compactMap { $0 }.joined(separator: "  ")
        }
        return s
    }

    static func color(_ m: TeamsMessage) -> Color {
        if m.task?.isFailed == true { return KS.failedText }
        switch m.kind {
        case .task, .run: return KS.readyText
        case .swarm: return KS.signal
        case .question: return KS.needsYouText
        default: return KS.textMuted
        }
    }
}

// MARK: - Right column

struct BotSideColumn: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot
    @State private var tokens: [String: Int] = [:]
    @State private var counting = false
    @State private var sending = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                needsYou
                madeBy
                tokenCard
            }
            .padding(16)
        }
        .background(KS.paperDeep)
        .overlay(alignment: .leading) { Rectangle().fill(KS.hairline).frame(width: 1) }
        .task(id: finishedIDs) { await countTokens() }
    }

    // Needs you

    /// Tasks that wait on you: ready for review, or failed and not yet resolved.
    private var waitingTasks: [TeamsTaskCard] {
        model.botTaskCards(bot).map(\.card).filter { !$0.resolved && ($0.readyForReview || $0.isFailed) }.reversed()
    }

    @ViewBuilder private var needsYou: some View {
        let questions = model.botQuestions(bot)
        let tasks = waitingTasks
        let count = questions.count + tasks.count
        VStack(alignment: .leading, spacing: 0) {
            KSLabel(L10n.t("Needs you") + (count == 0 ? "" : " · \(count)")).padding(.bottom, 10)
            if questions.isEmpty, let t = tasks.first {
                taskItem(t, more: Array(tasks.dropFirst()))
            } else if let q = questions.first {
                Text(verbatim: q.action.map { $0.summary.isEmpty ? q.prompt : $0.summary } ?? q.prompt)
                    .font(KS.body(16, .semibold)).foregroundStyle(KS.strong).lineLimit(4)
                if let place = q.action?.where {
                    Text(verbatim: place).font(KS.body(13)).foregroundStyle(KS.textMuted).padding(.top, 4)
                }
                let note = q.action?.detail ?? (q.options.isEmpty ? "" : q.options.joined(separator: " · "))
                if !note.isEmpty {
                    Text(verbatim: note).font(q.action != nil ? KS.mono(12, .regular) : KS.body(13)).foregroundStyle(KS.textSoft)
                        .lineLimit(6).lineSpacing(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 9).fill(KS.well))
                        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(KS.hairline, lineWidth: 1))
                        .padding(.top, 12)
                }
                HStack(spacing: 8) {
                    if q.action != nil {
                        ForEach(q.options, id: \.self) { option in
                            Button(option) { answer(q, option) }
                                .buttonStyle(.ks(option.lowercased() == "approve" ? .primary : .paper))
                                .frame(maxWidth: .infinity)
                        }
                    } else {
                        Button(L10n.t("Answer")) { open(q) }.buttonStyle(.ks(.primary)).frame(maxWidth: .infinity)
                    }
                }
                .disabled(sending)
                .padding(.top, 12)
                ForEach(questions.dropFirst().prefix(3)) { more in
                    Button { open(more) } label: {
                        Text(verbatim: "› " + more.prompt).font(KS.body(13)).foregroundStyle(KS.textSoft).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.top, 8)
                }
                if model.answeringBlocked {
                    Text(verbatim: L10n.t("Ask the owner to allow answering questions from this Mac"))
                        .font(KS.body(12)).foregroundStyle(KS.needsYouText).padding(.top, 8)
                }
                if !tasks.isEmpty {
                    Text(verbatim: L10n.t("\(tasks.count) tasks wait for review")).font(KS.body(12)).foregroundStyle(KS.textMuted).padding(.top, 8)
                }
            } else {
                Text(verbatim: L10n.t("No open questions")).font(KS.body(13)).foregroundStyle(KS.textMuted)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(KS.white))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(count == 0 ? KS.hairline : KS.amber.opacity(0.5), lineWidth: 1))
        .background(RoundedRectangle(cornerRadius: 15, style: .continuous).fill(KS.amber.opacity(count == 0 ? 0 : 0.08)).padding(-4))
    }

    /// A task waiting on you, with the same actions its card in the thread has.
    @ViewBuilder private func taskItem(_ t: TeamsTaskCard, more: [TeamsTaskCard]) -> some View {
        let busy = model.busyTasks.contains(t.id)
        Text(verbatim: t.title ?? L10n.t("Task")).font(KS.body(15, .semibold)).foregroundStyle(KS.strong)
            .lineLimit(3).help(t.title ?? "")
        Text(verbatim: [TaskCardView.state(t).0, t.branch, t.changedFiles.map { $0 == 1 ? L10n.t("1 file") : L10n.t("\($0) files") }]
            .compactMap { $0 }.joined(separator: " · "))
            .font(KS.body(13)).foregroundStyle(KS.textMuted).padding(.top, 4).lineLimit(2)
        if let f = t.failure, t.isFailed {
            Text(verbatim: [f.code, f.detail].compactMap { $0 }.joined(separator: " · "))
                .font(KS.mono(12, .regular)).foregroundStyle(KS.textSoft).lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 9).fill(KS.well))
                .padding(.top, 12)
        }
        VStack(spacing: 8) {
            if t.isFailed {
                Button(L10n.t("Retry")) { Task { await model.retry(t.id) } }.buttonStyle(.ks(.primary)).frame(maxWidth: .infinity)
                Button(L10n.t("Mark resolved")) { Task { await model.resolve(t.id, true) } }.buttonStyle(.ks(.paper)).frame(maxWidth: .infinity)
            } else if let branch = t.branch {
                Button(L10n.t("Copy review command")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("git log -p \(branch)", forType: .string)
                }.buttonStyle(.ks(.primary)).frame(maxWidth: .infinity)
                Button(L10n.t("Mark resolved")) { Task { await model.resolve(t.id, true) } }.buttonStyle(.ks(.paper)).frame(maxWidth: .infinity)
            }
        }
        .disabled(busy).padding(.top, 12)
        if !more.isEmpty {
            Text(verbatim: L10n.t("\(more.count) more in Timeline")).font(KS.body(12)).foregroundStyle(KS.textMuted).padding(.top, 8)
        }
    }

    private func open(_ q: TeamsQuestion) {
        model.botTab = .thread
        model.targetQuestionID = q.id
    }

    private func answer(_ q: TeamsQuestion, _ option: String) {
        sending = true
        Task { _ = await model.answer(q, choices: [option], text: ""); sending = false }
    }

    // Made by this bot

    private var madeBy: some View {
        var seen = Set<String>()
        let landed = model.botTaskCards(bot).reversed().filter { $0.card.branch != nil && seen.insert($0.card.branch!).inserted }
        return card(L10n.t("Made by this bot")) {
            if landed.isEmpty {
                Text(verbatim: L10n.t("Files appear as tasks land")).font(KS.body(13)).foregroundStyle(KS.textMuted)
            } else {
                VStack(spacing: 6) {
                    ForEach(landed.prefix(8), id: \.card.id) { c in
                        HStack(spacing: 10) {
                            Text(verbatim: "GIT").font(KS.mono(9, .semibold)).foregroundStyle(KS.onSignal)
                                .frame(width: 26, height: 26)
                                .background(RoundedRectangle(cornerRadius: 6).fill(c.card.isFailed ? KS.coral : KS.sage))
                            Text(verbatim: c.card.branch ?? "").font(KS.mono(12, .regular)).foregroundStyle(KS.ink)
                                .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                            Spacer(minLength: 4)
                            if let n = c.card.changedFiles {
                                Text(verbatim: n == 1 ? L10n.t("+1 file") : L10n.t("+\(n) files")).font(KS.mono(11, .regular)).foregroundStyle(KS.textDim).fixedSize()
                            }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x0C1A31)))
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    // Tokens

    private var finished: [(id: String, provider: String)] {
        model.botTaskCards(bot).compactMap { c in
            guard ["completed", "failed", "done"].contains(c.card.status ?? "") else { return nil }
            return (c.card.id, c.card.served?.provider ?? "other")
        }
    }
    private var finishedIDs: [String] { finished.map(\.id) }

    private func countTokens() async {
        let jobs = finished
        counting = true
        for job in jobs.prefix(40) where TaskTokenCache.tokens[job.id] == nil && !TaskTokenCache.missing.contains(job.id) {
            if let n = await model.taskTokens(id: job.id) { TaskTokenCache.tokens[job.id] = n } else { TaskTokenCache.missing.insert(job.id) }
        }
        var sum: [String: Int] = [:]
        for job in jobs { if let n = TaskTokenCache.tokens[job.id] { sum[job.provider, default: 0] += n } }
        tokens = sum
        counting = false
    }

    private var tokenCard: some View {
        let order = tokens.sorted { $0.value > $1.value }
        let total = tokens.values.reduce(0, +)
        return card(L10n.t("Tokens · this bot")) {
            if total == 0 {
                Text(verbatim: counting ? L10n.t("Counting…") : L10n.t("Token use appears as tasks finish"))
                    .font(KS.body(13)).foregroundStyle(KS.textMuted)
            } else {
                GeometryReader { g in
                    HStack(spacing: 0) {
                        ForEach(order, id: \.key) { p, n in
                            Rectangle().fill(KS.providerTint(p)).frame(width: g.size.width * CGFloat(n) / CGFloat(total))
                        }
                    }
                }
                .frame(height: 6).clipShape(Capsule()).background(Capsule().fill(KS.chip))
                Grid(alignment: .leading, verticalSpacing: 6) {
                    ForEach(order, id: \.key) { p, n in
                        GridRow {
                            Text(verbatim: SwarmaCells.vendorName(p)).foregroundStyle(KS.textMuted)
                            Text(verbatim: TeamsTaskBulk.tokens(n)).font(KS.mono(13, .regular)).foregroundStyle(KS.strong).gridColumnAlignment(.trailing)
                        }
                    }
                    GridRow {
                        Text(verbatim: L10n.t("Total")).foregroundStyle(KS.textMuted)
                        Text(verbatim: TeamsTaskBulk.tokens(total)).font(KS.mono(13, .medium)).foregroundStyle(KS.strong)
                    }
                }
                .font(KS.body(13)).padding(.top, 12)
            }
        }
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            KSLabel(title).padding(.bottom, 10)
            content()
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .ksCard(radius: 12)
    }
}

// MARK: - Sidebar sections

struct SidebarAgents: View {
    @ObservedObject var model: TeamsModel
    var body: some View {
        let providers = model.workerProviders
        let live = Set((model.status?.workers ?? []).filter(\.live).flatMap(\.providers))
        VStack(alignment: .leading, spacing: 2) {
            KSSectionLabel(text: L10n.t("Agents")).padding(.leading, 6).padding(.bottom, 6)
            if providers.isEmpty {
                Text(verbatim: L10n.t("No workers connected")).font(KS.body(13)).foregroundStyle(KS.textMuted).padding(.horizontal, 10)
            }
            ForEach(providers, id: \.self) { p in
                let n = model.runningCount(provider: p)
                HStack(spacing: 10) {
                    ProviderMonogram(provider: p, size: 24)
                    Text(verbatim: SwarmaCells.vendorName(p)).font(KS.body(14)).foregroundStyle(KS.onInkSoft)
                    Spacer()
                    Text(verbatim: n > 0 ? L10n.t("\(n) running") : live.contains(p) ? L10n.t("idle") : L10n.t("offline"))
                        .font(KS.mono(11, .regular)).foregroundStyle(n > 0 ? KS.signal : KS.textMuted)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

struct SidebarQuota: View {
    @ObservedObject var model: TeamsModel
    var body: some View {
        let usage = model.allUsage
        if !usage.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                KSSectionLabel(text: L10n.t("Quota · 5 h")).padding(.leading, 6)
                ForEach(usage, id: \.provider) { u in
                    let w = u.windows.first { $0.name == "5h" } ?? u.windows.first
                    let used = min(max(w?.usedPercent ?? 0, 0), 100)
                    Button { model.pane = .usage } label: {
                        VStack(spacing: 5) {
                            HStack {
                                Text(verbatim: SwarmaCells.vendorName(u.provider))
                                Spacer()
                                Text(verbatim: w?.usedPercent.map { "\(Int($0))%" } ?? "—")
                            }
                            .font(KS.mono(12, .regular)).foregroundStyle(KS.textSoft)
                            GeometryReader { g in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(KS.chip)
                                    Capsule().fill(KS.providerTint(u.provider)).frame(width: g.size.width * used / 100)
                                }
                            }.frame(height: 4)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.horizontal, 6)
                    .accessibilityLabel(SwarmaCells.vendorName(u.provider) + ", " + L10n.t("\(Int(used)) percent used"))
                    .accessibilityHint(L10n.t("Opens Usage"))
                }
            }
        }
    }
}
