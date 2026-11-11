import AppKit
import SwiftUI

// MARK: - Bots home

/// Bots are home: the left column lists them, updates first; the centre is the
/// selected bot (thread, timeline, logs) or its settings; the right column holds
/// what needs you and what the bot made, when the window is wide enough.
struct BotsHome: View {
    @ObservedObject var model: TeamsModel
    @State private var width: CGFloat = 1400

    var body: some View {
        Group {
            if model.bots.isEmpty {
                VStack(spacing: 0) {
                    TeamsEmptyState(symbol: "person.2.fill", title: L10n.t("Make your first bot"),
                                    detail: L10n.t("A bot is a persistent swarm with one job. It keeps one thread where everything it does, and everything it needs from you, shows up."),
                                    action: nil)
                    KSBottomBar {
                        Spacer()
                        Button(L10n.t("New bot")) { model.creatingBot = true }.buttonStyle(.ks(.primary))
                    }
                }
            } else {
                HStack(spacing: 0) {
                    BotsSidebar(model: model).frame(width: 264)
                    Group {
                        if let id = model.editingBotID, let bot = model.bot(id: id) {
                            BotSettingsPane(model: model, bot: bot).id(id)
                        } else if let bot = model.selectedBot {
                            BotWorkspace(model: model, bot: bot).id(bot.id)
                        } else if let t = model.selectedThreadID {
                            ThreadView(model: model, threadID: t).id(t)
                        } else {
                            TeamsEmptyState(symbol: "bubble.left.and.bubble.right", title: L10n.t("Choose a bot"), detail: nil, action: nil)
                        }
                    }
                    .frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
                    // The right column needs room; under ~1200 pt of window it folds away.
                    if width >= 1120, model.editingBotID == nil, let bot = model.selectedBot {
                        BotSideColumn(model: model, bot: bot).frame(width: width >= 1300 ? 330 : 300)
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            }
        }
    }
}

struct BotsSidebar: View {
    @ObservedObject var model: TeamsModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let bots = model.sortedBots
        let hidden = model.hiddenBots
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                KSSectionLabel(text: L10n.t("Bots"), count: bots.count).padding(.leading, 6)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(bots.enumerated()), id: \.element.id) { BotRow(model: model, bot: $1, order: $0) }
                        if !hidden.isEmpty {
                            Button {
                                withAnimation(reduceMotion ? nil : KS.motion) { model.showHiddenBots.toggle() }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold))
                                        .rotationEffect(.degrees(model.showHiddenBots ? 90 : 0))
                                    KSLabel(L10n.t("Hidden · \(hidden.count)"))
                                    Spacer()
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(KS.textMuted)
                            .padding(.horizontal, 8).padding(.top, 10)
                            .accessibilityLabel(L10n.t("Hidden bots, \(hidden.count)"))
                            if model.showHiddenBots {
                                ForEach(hidden) { BotRow(model: model, bot: $0) }
                                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: -4)))
                            }
                        }
                        if bots.isEmpty && hidden.isEmpty {
                            Text(verbatim: L10n.t("No bots match")).font(KS.body(13)).foregroundStyle(KS.textMuted).padding(10)
                        }
                    }
                }
                .scrollIndicators(.automatic)
            }
            SidebarAgents(model: model)
            SidebarQuota(model: model)
        }
        .padding(.horizontal, 12).padding(.vertical, 16)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(KS.paperDeep)
        .overlay(alignment: .trailing) { Rectangle().fill(KS.hairline).frame(width: 1) }
    }
}

struct BotRow: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot
    /// Position in the list, for the staggered entrance.
    var order = 0
    @State private var hovered = false
    @State private var shown = BotRow.entered
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Rows ease in once per launch, not on every pane switch or refresh.
    private static var entered = false

    init(model: TeamsModel, bot: TeamsBot, order: Int = 0, hovered: Bool = false) {
        self.model = model; self.bot = bot; self.order = order
        _hovered = State(initialValue: hovered)
    }

    private var selected: Bool { model.selectedThreadID == bot.threadID }

    private func accessibilityName(needs: Int, unread: Int) -> String {
        let hidden: String = bot.archived ? L10n.t("Hidden") + ", " : ""
        let state: String = needs > 0 ? ", " + L10n.t("needs you") : unread > 0 ? ", " + L10n.t("\(unread) new") : ""
        return hidden + bot.name + state
    }

    /// "Claude · Running": who leads it, then what it is doing.
    private func subtitle(needs: Int, unread: Int) -> String {
        let lead = model.agent(id: bot.leadAgentID)?.runner.provider.map(SwarmaCells.vendorName) ?? TeamsBotList.label(bot)
        let state: String = needs > 0 ? L10n.t("Needs you") : model.botIsRunning(bot) ? L10n.t("Running")
            : unread > 0 ? L10n.t("\(unread) new") : L10n.t("Idle")
        return lead + " · " + state
    }

    var body: some View {
        let needs = model.botNeedsYou(bot), unread = model.botUnread(bot)
        let latest = model.botLatest(bot)
        Button { model.select(threadID: bot.threadID) } label: {
            HStack(alignment: .center, spacing: 10) {
                StatusDot(state: model.botDot(bot))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(verbatim: bot.name).font(KS.body(14, .semibold)).foregroundStyle(KS.strong).lineLimit(1)
                        Spacer(minLength: 2)
                        if unread > 0, needs == 0 { KSBadge(count: unread) }
                        else if let at = latest?.at {
                            Text(verbatim: KSClock.short(at)).font(KS.mono(11, .regular)).foregroundStyle(KS.textDim).lineLimit(1)
                        }
                    }
                    Text(verbatim: subtitle(needs: needs, unread: unread)).font(KS.body(12))
                        .foregroundStyle(needs > 0 ? KS.needsYouText.opacity(0.85) : KS.textMuted).lineLimit(1)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(selected ? KS.selected : hovered ? KS.chip.opacity(0.6) : .clear)
                    .animation(reduceMotion ? nil : KS.motion, value: hovered)
                    .animation(reduceMotion ? nil : KS.motion, value: selected)
            }
            .overlay(alignment: .leading) {
                if selected { RoundedRectangle(cornerRadius: 1).fill(KS.signal).frame(width: 2).padding(.vertical, 4) }
            }
            .contentShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .help(latest?.line ?? bot.job)
        .onHover { hovered = $0 }
        .opacity(bot.archived ? 0.55 : 1)
        .opacity(shown ? 1 : 0).offset(y: shown ? 0 : 6)
        .onAppear {
            guard !shown else { return }
            if reduceMotion { shown = true } else {
                withAnimation(.spring(response: 0.42, dampingFraction: 0.82).delay(Double(min(order, 9)) * 0.035)) { shown = true }
            }
            DispatchQueue.main.async { BotRow.entered = true }
        }
        .contextMenu {
            Button(L10n.t("Bot settings")) { model.editingBotID = bot.id }
            if bot.archived, !bot.isLegacyAgent {
                Button(L10n.t("Unhide")) { Task { await model.setBotHidden(bot, hidden: false) } }
                    .disabled(model.savingBot)
            }
        }
        .accessibilityLabel(accessibilityName(needs: needs, unread: unread))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Bot header

/// The bot view's title block: name at 26 pt, a meta line, the status pill and the bot's actions.
struct BotThreadHeader: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot
    @State private var renaming = false
    @State private var name = ""

    private var settingsOpen: Bool { model.editingBotID == bot.id }
    private var starred: Bool { bot.starred }
    private var starLabel: String { L10n.t(starred ? "Unstar" : "Star") }
    private var firstQuestionID: String? {
        model.messages[bot.threadID]?.first { $0.question?.status == "open" }?.question?.id
    }

    private var meta: String {
        var parts = [SwarmaCells.scopeLabel(bot.scope)].filter { !$0.isEmpty }
        if let swarm = model.botSwarm(bot) {
            parts.append(swarm.title)
            parts.append(L10n.t("swarm of \(swarm.steps.count) steps"))
            if let at = model.botSwarmStarted(bot, swarm) { parts.append(L10n.t("started ") + KSClock.short(at)) }
        } else {
            parts.append(TeamsBotList.label(bot))
            if let runner = model.agent(id: bot.leadAgentID)?.runner { parts.append(runner.label) }
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if settingsOpen {
                KSBarButton(symbol: "chevron.left", label: L10n.t("Back to thread")) { model.editingBotID = nil }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: settingsOpen ? bot.name + " / " + L10n.t("Settings") : bot.name)
                        .font(KS.body(26, .semibold)).tracking(-0.3).foregroundStyle(Color(hex: 0xF6F8FC)).lineLimit(1)
                    if !settingsOpen { botMenu }
                }
                if !settingsOpen {
                    Text(verbatim: meta).font(KS.body(14)).foregroundStyle(KS.textMuted).lineLimit(1).truncationMode(.middle)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            TeamsConnectionStatus(model: model)
            if !settingsOpen { statusPill }
            if !settingsOpen {
                KSBarButton(symbol: starred ? "star.fill" : "star", label: starLabel, on: starred) {
                    Task { await model.setBotStarred(bot, starred: !starred) }
                }
                .disabled(model.savingBot || bot.isLegacyAgent || bot.archived)
            }
            KSBarButton(symbol: "slider.horizontal.3", label: L10n.t("Bot settings"), on: settingsOpen) {
                model.editingBotID = settingsOpen ? nil : bot.id
            }
        }
        .alert(L10n.t("Rename bot"), isPresented: $renaming) {
            TextField(L10n.t("Name"), text: $name)
            Button(L10n.t("Cancel"), role: .cancel) { }
            Button(L10n.t("Rename")) {
                Task { await model.renameBot(bot, name: name.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.savingBot)
        }
    }

    @ViewBuilder private var statusPill: some View {
        let needs = model.botNeedsYou(bot)
        if needs > 0 {
            Button { if let q = firstQuestionID { model.botTab = .thread; model.targetQuestionID = q } } label: {
                pill(needs > 1 ? L10n.t("\(needs) needs you") : L10n.t("Needs you"), KS.needsYouText, KS.needsYouTint)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n.t("\(needs) needs you"))
        } else if model.botIsRunning(bot) {
            let n = model.botActiveTaskCount(bot)
            pill(n > 0 ? L10n.t("Running · \(n)") : L10n.t("Running"), KS.signal, KS.signal.opacity(0.14))
        } else {
            pill(L10n.t("Idle"), KS.textMuted, KS.chip)
        }
    }

    private func pill(_ text: String, _ ink: Color, _ fill: Color) -> some View {
        HStack(spacing: 7) {
            Circle().fill(ink).frame(width: 7, height: 7)
            Text(verbatim: text).font(KS.body(13, .semibold))
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 12).frame(height: 28)
        .background(Capsule().fill(fill))
        .fixedSize()
        .padding(.top, 4)
    }

    private var botMenu: some View {
        Menu {
            Button(L10n.t("Bot settings")) { model.editingBotID = bot.id }.keyboardShortcut(",", modifiers: .command)
            Button(L10n.t("Rename…")) { name = bot.name; renaming = true }
                .disabled(bot.isLegacyAgent || model.savingBot)
            Button(starLabel) { Task { await model.setBotStarred(bot, starred: !starred) } }
                .disabled(model.savingBot || bot.isLegacyAgent || bot.archived)
            Button(L10n.t("Earlier messages")) { Task { await model.loadOlder(bot.threadID) } }
                .disabled(model.hasOlder[bot.threadID] != true || model.loadingThreads.contains(bot.threadID))
            Divider()
            Button(L10n.t("Hide bot"), role: .destructive) { Task { await model.setBotHidden(bot, hidden: true) } }
                .foregroundStyle(KS.danger).disabled(bot.isLegacyAgent || bot.archived || model.savingBot)
        } label: {
            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(KS.textMuted)
                .frame(width: 24, height: 24).contentShape(Rectangle())
        }
        // `.button` + plain keeps the label as drawn; `.borderlessButton` flattens it to an NSMenu title and image.
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel(L10n.t("Bot menu") + ", " + bot.name)
    }
}

// MARK: - Task card

/// A bot task that needs the owner: ready for review, failed, or a failed check.
struct TaskCardView: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    var body: some View {
        let task = message.task
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                Text(verbatim: task?.title ?? message.body ?? L10n.t("Task")).font(KS.body(15, .bold)).lineLimit(2)
                Spacer()
                if let task { KSChip(Self.state(task).0, fill: Self.state(task).1, ink: Self.state(task).2) }
            }
            if let body = message.body, task?.title != nil { Text(verbatim: body).font(KS.body(14)).foregroundStyle(KS.textSoft) }
            if let task {
                HStack(spacing: 8) {
                    if let branch = task.branch { Text(verbatim: branch).font(KS.mono(12)).textSelection(.enabled) }
                    if let n = task.changedFiles { Text(verbatim: n == 1 ? L10n.t("1 file") : L10n.t("\(n) files")).font(KS.body(13)).foregroundStyle(KS.textMuted) }
                    if let p = task.served?.provider { Text(verbatim: "· " + SwarmaCells.vendorName(p)).font(KS.body(13)).foregroundStyle(KS.textMuted) }
                }
                if let f = task.failure, task.isFailed {
                    Text(verbatim: [f.code, f.detail].compactMap { $0 }.joined(separator: " · ")).font(KS.body(13)).foregroundStyle(KS.textSoft)
                }
                HStack(spacing: 8) {
                    if task.isFailed {
                        Button(L10n.t("Retry")) { Task { await model.retry(task.id) } }.buttonStyle(.ks(.primary, compact: true))
                            .disabled(model.busyTasks.contains(task.id))
                    } else if let branch = task.branch, !task.resolved {
                        Button(L10n.t("Copy review command")) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString("git log -p \(branch)", forType: .string)
                        }.buttonStyle(.ks(.paper, compact: true))
                        Button(L10n.t("Mark resolved")) { Task { await model.resolve(task.id, true) } }
                            .buttonStyle(.ks(.white, compact: true)).disabled(model.busyTasks.contains(task.id))
                    }
                    if task.resolved { KSChip(L10n.t("Resolved"), fill: KS.sageTint, ink: KS.readyText) }
                }
            }
        }
        .padding(12).frame(maxWidth: 640, alignment: .leading)
        .ksCard(fill: message.task?.isFailed == true ? KS.coralTint : KS.white, radius: 16)
    }

    static func state(_ t: TeamsTaskCard) -> (String, Color, Color) {
        if t.check?.status == "failed" { return (L10n.t("Check failed"), KS.failedTint, KS.failedText) }
        if t.status == "failed" { return (L10n.t("Failed"), KS.failedTint, KS.failedText) }
        if t.resolved { return (L10n.t("Resolved"), KS.sageTint, KS.readyText) }
        if t.branch != nil { return (L10n.t("Ready for review"), KS.sageTint, KS.readyText) }
        return (TeamsCopy.swarmStatus(t.status ?? ""), KS.neutralTint, KS.textSoft)
    }
}

// MARK: - Bot settings

/// Today's global Swarmaa settings, applied to one bot: the job, the crew,
/// which service does what, and the rules. Save and Cancel are pinned below.
struct BotSettingsPane: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot
    @State private var name = ""
    @State private var job = ""
    @State private var leadID = ""
    @State private var members: [String] = []
    @State private var routing = TeamsBotRouting()
    @State private var rules = TeamsBotRules()
    @State private var scheduled = false
    @State private var schedule = ""
    @State private var adding = false
    @State private var deleting = false

    private var scopeAgents: [TeamsAgent] { model.agents.filter { $0.scope == bot.scope || bot.scope.isEmpty } }

    var body: some View {
        VStack(spacing: 0) {
            BotThreadHeader(model: model, bot: bot)
                .padding(.horizontal, 28).padding(.top, 22).padding(.bottom, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }

            ScrollView {
                if bot.isLegacyAgent {
                    Text(verbatim: L10n.t("This is an agent from before bots. Update the Swarmaa service to give it a crew, routing and rules."))
                        .font(KS.body(15)).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .ksCard(fill: KS.butter, radius: 18).padding(24)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 380), spacing: 26, alignment: .top)], alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 22) { jobSection; crewSection }
                    VStack(alignment: .leading, spacing: 22) { routingSection; rulesSection }
                }
                .padding(24)
                .disabled(bot.isLegacyAgent)
            }

            Text(verbatim: L10n.t("Changes apply from the next turn. Running work keeps its settings."))
                .font(KS.body(14)).foregroundStyle(KS.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 2)
                .background(KS.white)
            KSBottomBar {
                if !bot.isLegacyAgent {
                    if bot.archived {
                        Button(L10n.t("Unhide")) { Task { await model.setBotHidden(bot, hidden: false) } }
                            .buttonStyle(.ks(.paper))
                    } else {
                        Button(L10n.t("Hide bot")) { Task { await model.setBotHidden(bot, hidden: true) } }
                            .buttonStyle(.ks(.danger)).disabled(model.savingBot)
                    }
                    Button(L10n.t("Delete bot…")) { deleting = true }.buttonStyle(.ks(.danger)).disabled(model.savingBot)
                }
                Spacer()
                Button(L10n.t("Cancel")) { model.editingBotID = nil }.buttonStyle(.ks(.paper)).keyboardShortcut(.cancelAction)
                Button(L10n.t("Save changes")) {
                    Task {
                        let ok = await model.saveBot(bot, name: name.trimmingCharacters(in: .whitespaces), job: String(job.prefix(8192)),
                                                     leadAgentID: leadID, memberAgentIDs: members.filter { $0 != leadID },
                                                     routing: routing, rules: rules,
                                                     schedule: scheduled && !schedule.trimmingCharacters(in: .whitespaces).isEmpty ? schedule : nil)
                        if ok { model.editingBotID = nil }
                    }
                }
                .buttonStyle(.ks(.primary)).keyboardShortcut(.defaultAction)
                .disabled(bot.isLegacyAgent || model.savingBot || name.trimmingCharacters(in: .whitespaces).isEmpty || leadID.isEmpty)
            }
        }
        .background(KS.paper)
        .sheet(isPresented: $deleting) { DeleteBotSheet(model: model, bot: bot) }
        .onAppear(perform: load)
        .task(id: bot.id) { await model.refreshBot(bot.id) }
    }

    private func load() {
        name = bot.name; job = bot.job; leadID = bot.leadAgentID; members = bot.memberAgentIDs
        routing = bot.routing; rules = bot.rules
        scheduled = bot.schedule != nil; schedule = bot.schedule ?? "CRON_TZ=\(TimeZone.current.identifier) 0 9 * * 1-5"
    }

    // 01 — The job
    private var jobSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            KSLabel(L10n.t("01 — The job"))
            VStack(alignment: .leading, spacing: 14) {
                field(L10n.t("Name")) { TextField("", text: $name).textFieldStyle(.plain).font(KS.body(16)) }
                field(L10n.t("What it does")) {
                    TextEditor(text: $job).font(KS.body(15)).scrollContentBackground(.hidden).frame(minHeight: 96)
                        .accessibilityLabel(L10n.t("What it does"))
                }
                HStack { Text(verbatim: L10n.t("Project")).font(KS.body(15, .semibold)); Spacer(); KSChip(bot.scope) }
            }
            .padding(18).ksCard(radius: 16)
        }
    }

    private func field<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(KS.body(15, .semibold))
            content().padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 14).fill(KS.white))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(KS.hairline, lineWidth: 1))
        }
    }

    // 02 — The crew
    private var crewSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            KSLabel(L10n.t("02 — The crew"))
            VStack(spacing: 0) {
                ForEach(Array(([leadID] + members.filter { $0 != leadID }).enumerated()), id: \.element) { i, id in
                    let a = model.agent(id: id)
                    HStack(spacing: 12) {
                        KSMoji(seed: a?.avatar ?? id, size: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: a?.name ?? L10n.t("Unknown agent")).font(KS.body(16, .bold))
                            Text(verbatim: [a?.role, a?.edits == true ? L10n.t("edits in its own branch, never pushes") : L10n.t("reads only")]
                                .compactMap { $0 }.joined(separator: " · ")).font(KS.body(13)).foregroundStyle(KS.textMuted)
                        }
                        Spacer()
                        if id == leadID { KSChip(L10n.t("Lead")) }
                        else {
                            Button(L10n.t("Make lead")) { members.append(leadID); leadID = id; members.removeAll { $0 == id } }
                                .buttonStyle(.ks(.paper, compact: true))
                            Button { members.removeAll { $0 == id } } label: { Image(systemName: "xmark") }
                                .buttonStyle(.ks(.white, compact: true)).accessibilityLabel(L10n.t("Remove \(a?.name ?? "agent") from the crew"))
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .overlay(alignment: .bottom) { if i < members.filter({ $0 != leadID }).count { Rectangle().fill(KS.hairline).frame(height: 1) } }
                }
            }
            .ksCard(radius: 16)
            let candidates = scopeAgents.filter { $0.id != leadID && !members.contains($0.id) }
            Menu {
                ForEach(candidates) { a in Button(a.name + (a.role.map { " · " + $0 } ?? "")) { members.append(a.id) } }
            } label: { Label(L10n.t("Add to the crew"), systemImage: "plus") }
                .menuStyle(.button).buttonStyle(.ks(.white)).fixedSize()
                .disabled(candidates.isEmpty)
        }
    }

    // 03 — Which service does what
    private var routingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            KSLabel(L10n.t("03 — Which service does what"))
            VStack(spacing: 0) {
                ForEach(Array(TeamsBotRouting.Kind.allCases.enumerated()), id: \.element) { i, kind in
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: kind.title).font(KS.body(16, .bold))
                            Text(verbatim: kind.detail).font(KS.body(13)).foregroundStyle(KS.textMuted)
                            if let now = bot.routingNow[kind.rawValue], let p = now.providerNow {
                                Text(verbatim: L10n.t("Now: ") + SwarmaCells.vendorName(p) + (now.reason.map { " · " + $0 } ?? ""))
                                    .font(KS.mono(10)).foregroundStyle(KS.textSoft)
                            }
                        }
                        Spacer(minLength: 8)
                        runnerMenu(kind)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .overlay(alignment: .bottom) { if i < 3 { Rectangle().fill(KS.hairline).frame(height: 1) } }
                }
            }
            .ksCard(radius: 16, shadow: true)
        }
    }

    private func runnerTitle(_ kind: TeamsBotRouting.Kind) -> String {
        if kind == .review, routing.review == nil, routing.reviewDifferentFromAuthor { return L10n.t("A different service than the author") }
        guard let r = routing[kind] else { return L10n.t("Auto · most quota left") }
        return r.label
    }

    private func runnerMenu(_ kind: TeamsBotRouting.Kind) -> some View {
        Menu {
            Button(L10n.t("Auto · most quota left")) { routing[kind] = nil; if kind == .review { routing.reviewDifferentFromAuthor = false } }
            if kind == .review {
                Button(L10n.t("A different service than the author")) { routing.review = nil; routing.reviewDifferentFromAuthor = true }
            }
            Divider()
            ForEach(model.runnerProviders, id: \.provider) { p in
                Menu(RunnerPicker.providerTitle(p)) {
                    ForEach(RunnerPicker.efforts, id: \.self) { effort in
                        let r = TeamsRunner(provider: p.provider, model: routing[kind]?.provider == p.provider ? routing[kind]?.model : nil, effort: effort)
                        Button(r.label) { routing[kind] = r }
                    }
                }
            }
        } label: { Text(verbatim: runnerTitle(kind)).lineLimit(1) }
            .menuStyle(.button).buttonStyle(.ks(.paper)).fixedSize()
            .accessibilityLabel(kind.title + ": " + runnerTitle(kind))
    }

    // 04 — Rules
    private var rulesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            KSLabel(L10n.t("04 — Rules"))
            VStack(spacing: 0) {
                ruleRow(L10n.t("Chat replies"),
                        TeamsBotRules.firstReplyChoices.first { $0.id == rules.firstReply }?.detail ?? "") {
                    Picker("", selection: $rules.firstReply) {
                        ForEach(TeamsBotRules.firstReplyChoices, id: \.id) { Text(verbatim: $0.title).tag($0.id) }
                    }
                    .labelsHidden().fixedSize()
                    .accessibilityLabel(L10n.t("Chat replies"))
                }
                ruleRow(L10n.t("Keep a quota floor"),
                        rules.quotaFloorPct == 0 ? L10n.t("Off: a service may be used until it runs out")
                                                 : L10n.t("Auto work skips a service below \(rules.quotaFloorPct)% left")) {
                    Stepper(value: $rules.quotaFloorPct, in: 0...50, step: 5) { Text(verbatim: "\(rules.quotaFloorPct)%").font(KS.mono(13, .semibold)) }
                        .fixedSize()
                }
                ruleRow(L10n.t("Ask me before anything public"), L10n.t("Posts, emails and releases wait for your yes")) {
                    Toggle("", isOn: $rules.approvePublic).labelsHidden().toggleStyle(.switch)
                }
                ruleRow(L10n.t("Review every edit"), L10n.t("A second service checks each branch first")) {
                    Toggle("", isOn: $rules.reviewEdits).labelsHidden().toggleStyle(.switch)
                }
                ruleRow(L10n.t("Run tests before calling an edit done"), L10n.t("A failing check sends it back to the author")) {
                    Toggle("", isOn: $rules.requireTests).labelsHidden().toggleStyle(.switch)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ruleContent(L10n.t("Also run on a schedule"), L10n.t("Otherwise it works when you message it")) {
                        Toggle("", isOn: $scheduled).labelsHidden().toggleStyle(.switch)
                    }
                    if scheduled {
                        TextField(L10n.t("Cron, e.g. 0 9 * * 1-5"), text: $schedule).textFieldStyle(.plain).font(KS.mono(13))
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 12).fill(KS.paper))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(KS.hairline, lineWidth: 1))
                            .accessibilityLabel(L10n.t("Schedule, as cron"))
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .ksCard(radius: 16)
        }
    }

    private func ruleRow<C: View>(_ title: String, _ detail: String, @ViewBuilder _ control: () -> C) -> some View {
        ruleContent(title, detail, control)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
    }

    private func ruleContent<C: View>(_ title: String, _ detail: String, @ViewBuilder _ control: () -> C) -> some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: title).font(KS.body(16, .bold))
                Text(verbatim: detail).font(KS.body(13)).foregroundStyle(KS.textMuted)
            }
            Spacer(minLength: 8)
            control()
        }
    }
}

/// Deleting a visible bot hides it first: the service deletes only hidden bots.
private struct DeleteBotSheet: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot
    @Environment(\.dismiss) private var dismiss
    @State private var confirmName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L10n.t("Delete bot?")).font(KS.body(24, .semibold))
            Text(verbatim: L10n.t("This permanently deletes the bot and its chat. This cannot be undone."))
                .font(KS.body(15))
            Text(verbatim: L10n.t("Type the bot's name exactly to confirm:")).font(KS.body(14))
            Text(verbatim: bot.name).font(KS.body(16, .bold)).textSelection(.enabled)
            TextField(L10n.t("Bot name"), text: $confirmName).textFieldStyle(.roundedBorder)
            if let error = model.botError {
                Text(verbatim: error).font(KS.body(14)).foregroundStyle(KS.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if model.savingBot { ProgressView().controlSize(.small) }
                Spacer()
                Button(L10n.t("Cancel")) { dismiss() }.buttonStyle(.ks(.paper)).keyboardShortcut(.cancelAction)
                    .disabled(model.savingBot)
                Button(L10n.t("Delete bot"), role: .destructive) {
                    Task { if await model.deleteBot(bot, confirmName: confirmName) { dismiss() } }
                }
                .buttonStyle(.plain).foregroundStyle(KS.danger)
                .disabled(confirmName != bot.name || model.savingBot)
            }
        }
        .padding(24).frame(width: 460).background(KS.paper)
        .interactiveDismissDisabled(model.savingBot)
        .onAppear { model.botError = nil }
    }
}

// MARK: - New bot

struct NewBotSheet: View {
    @ObservedObject var model: TeamsModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var job = ""
    @State private var scope = ""
    @State private var leadID = ""

    private var scopes: [String] { (model.status?.scopes ?? []).map(\.scope) }
    private var agents: [TeamsAgent] { model.agents.filter { $0.scope == scope } }
    private var missing: String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return L10n.t("Give it a name.") }
        if job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return L10n.t("Say what it does.") }
        if scope.isEmpty { return L10n.t("Pick a project.") }
        return nil
    }
    private var ready: Bool { missing == nil && !model.savingBot }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L10n.t("New bot")).font(KS.body(24, .semibold))
            Text(verbatim: L10n.t("One job, done for as long as the bot exists. You can add a crew and set its routing after."))
                .font(KS.body(14)).foregroundStyle(KS.textSoft)
            labeled(L10n.t("Name")) { TextField(L10n.t("e.g. Launch"), text: $name).textFieldStyle(.plain).font(KS.body(16)) }
            labeled(L10n.t("What it does")) {
                TextEditor(text: $job).font(KS.body(15)).scrollContentBackground(.hidden).frame(height: 90)
                    .accessibilityLabel(L10n.t("What it does"))
            }
            HStack(spacing: 14) {
                labeled(L10n.t("Project")) {
                    Picker("", selection: $scope) { ForEach(scopes, id: \.self) { Text(verbatim: SwarmaCells.scopeLabel($0)).tag($0) } }
                        .labelsHidden()
                }
                labeled(L10n.t("Lead")) {
                    Picker("", selection: $leadID) {
                        Text(verbatim: L10n.t("A new agent for this bot")).tag("")
                        ForEach(agents) { Text(verbatim: $0.name).tag($0.id) }
                    }.labelsHidden()
                }
            }
            if let message = model.botError ?? missing {
                Text(verbatim: message).font(KS.body(14))
                    .foregroundStyle(model.botError != nil ? KS.coral : KS.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if model.savingBot { ProgressView().controlSize(.small) }
                Spacer()
                Button(L10n.t("Cancel")) { dismiss() }.buttonStyle(.ks(.paper)).keyboardShortcut(.cancelAction)
                Button(L10n.t("Make bot")) {
                    Task {
                        let ok = await model.createBot(name: name.trimmingCharacters(in: .whitespaces),
                                                       job: String(job.prefix(8192)), scope: scope,
                                                       leadAgentID: leadID.isEmpty ? nil : leadID, memberAgentIDs: [],
                                                       onLeadCreated: { leadID = $0 })
                        if ok { dismiss() }
                    }
                }
                .buttonStyle(.ks(.primary)).keyboardShortcut(.defaultAction).disabled(!ready)
            }
        }
        .padding(24).frame(width: 520).fixedSize(horizontal: false, vertical: true)
        .background(KS.paper).environment(\.colorScheme, .dark)
        .onAppear { model.botError = nil; if scope.isEmpty { scope = scopes.first ?? "" } }
        .onChange(of: scope) { _, _ in leadID = "" }
    }

    private func labeled<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(KS.body(15, .semibold))
            content().padding(.horizontal, 12).padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill(KS.white))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(KS.hairline, lineWidth: 1))
        }
    }
}

// MARK: - Schedule card

struct ScheduleCardView: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let card = message.schedule {
                Text(verbatim: card.description).font(KS.body(17, .bold))
                Text(verbatim: card.timezone).font(KS.mono(12)).foregroundStyle(KS.textMuted)
                if card.paused { Text("Paused").font(KS.body(14)) }
                ForEach(card.nextRuns, id: \.self) { run in
                    Text(run, format: .relative(presentation: .named)).font(KS.body(14))
                }
                if let bot = model.bot(id: card.botID), bot.threadID == message.threadID {
                    HStack {
                        Button(card.paused ? "Resume" : "Pause") {
                            var rules = bot.rules
                            rules.schedulePaused = !card.paused
                            Task {
                                _ = await model.saveBot(bot, name: bot.name, job: bot.job, leadAgentID: bot.leadAgentID,
                                                        memberAgentIDs: bot.memberAgentIDs, routing: bot.routing,
                                                        rules: rules, schedule: bot.schedule)
                                await model.refreshBot(bot.id)
                                await model.loadLatest(bot.threadID)
                            }
                        }.buttonStyle(.ks(.primary, compact: true))
                            .disabled(card.cron == nil || model.savingBot || bot.archived)
                        Button("Edit") { model.editingBotID = bot.id }.buttonStyle(.ks(.paper, compact: true))
                    }
                }
            } else { Text(verbatim: message.body ?? "Schedule") }
        }.padding(16).frame(maxWidth: 640, alignment: .leading).ksCard(radius: 16)
    }
}
