import AppKit
import SwiftUI

// MARK: - Bots home

/// Bots are home: the sidebar lists them, updates first; the right pane is
/// the selected bot's thread, or its settings.
struct BotsHome: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        if model.bots.isEmpty {
            VStack(spacing: 0) {
                TeamsEmptyState(symbol: "person.2.fill", title: L10n.t("Make your first bot"),
                                detail: L10n.t("A bot is a persistent swarm with one job. It keeps one thread where everything it does, and everything it needs from you, shows up."),
                                action: nil)
                KSBottomBar { Spacer(); Button(L10n.t("New bot")) { model.creatingBot = true }.buttonStyle(.ks(.primary)) }
            }
        } else {
            HStack(spacing: 0) {
                BotsSidebar(model: model).frame(width: 300)
                Rectangle().fill(KS.ink).frame(width: 2.5)
                Group {
                    if let id = model.editingBotID, let bot = model.bot(id: id) {
                        BotSettingsPane(model: model, bot: bot).id(id)
                    } else if let t = model.selectedThreadID {
                        ThreadView(model: model, threadID: t).id(t)
                    } else {
                        TeamsEmptyState(symbol: "bubble.left.and.bubble.right", title: L10n.t("Choose a bot"), detail: nil, action: nil)
                    }
                }
                .frame(minWidth: 460, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct BotsSidebar: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        let bots = model.sortedBots
        let updates = bots.filter { model.botHasUpdates($0) }
        let rest = bots.filter { !model.botHasUpdates($0) }
        VStack(spacing: 0) {
            KSSearchField(prompt: L10n.t("Search bots"), text: $model.search).padding(14)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if !updates.isEmpty {
                        HStack(spacing: 8) { KSLabel(L10n.t("01 — Updates")); KSBadge(count: updates.count) }
                            .padding(.horizontal, 8).padding(.top, 2)
                        ForEach(updates) { BotRow(model: model, bot: $0) }
                    }
                    if !rest.isEmpty {
                        KSLabel(updates.isEmpty ? L10n.t("01 — All bots") : L10n.t("02 — All bots"))
                            .padding(.horizontal, 8).padding(.top, updates.isEmpty ? 2 : 14)
                        ForEach(rest) { BotRow(model: model, bot: $0) }
                    }
                    if bots.isEmpty {
                        Text(verbatim: L10n.t("No bots match")).font(KS.body(14)).foregroundStyle(KS.textMuted).padding(10)
                    }
                }
                .padding(.horizontal, 12).padding(.bottom, 12)
            }
            KSBottomBar {
                Button { model.creatingBot = true } label: { Label(L10n.t("New bot"), systemImage: "plus").frame(maxWidth: .infinity) }
                    .buttonStyle(.ks(.white))
            }
        }
        .background(KS.paper)
    }
}

struct BotRow: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot

    private var selected: Bool { model.selectedThreadID == bot.threadID }

    private var tag: String {
        if let s = bot.schedule, !s.isEmpty { return L10n.t("Scheduled") }
        let n = bot.crewIDs.count
        return n > 1 ? L10n.t("Swarm · \(n)") : L10n.t("Bot")
    }

    var body: some View {
        let needs = model.botNeedsYou(bot), unread = model.botUnread(bot)
        let latest = model.botLatest(bot)
        Button { model.select(threadID: bot.threadID) } label: {
            HStack(spacing: 11) {
                KSMoji(seed: bot.avatar ?? bot.leadAgentID, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(verbatim: bot.name).font(KS.body(16, .bold)).lineLimit(1)
                        Spacer(minLength: 2)
                        if needs == 0, unread == 0, let at = latest?.at {
                            Text(at, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                                .font(KS.mono(10)).foregroundStyle(KS.textMuted).lineLimit(1)
                        }
                    }
                    HStack(spacing: 6) {
                        Text(verbatim: tag.uppercased()).font(KS.mono(9, .semibold)).tracking(0.6).foregroundStyle(KS.textMuted).fixedSize()
                        Text(verbatim: latest?.line ?? bot.job).font(KS.body(13)).foregroundStyle(KS.textSoft).lineLimit(1)
                    }
                }
                if needs > 0 { KSChip(L10n.t("Needs you"), fill: KS.coral) }
                else if unread > 0 { KSBadge(count: unread) }
            }
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background {
                if selected { RoundedRectangle(cornerRadius: 16).fill(KS.ink).offset(x: 3, y: 3) }
                RoundedRectangle(cornerRadius: 16).fill(selected ? KS.white : .clear)
            }
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? KS.ink : .clear, lineWidth: 2))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(bot.name + (needs > 0 ? ", " + L10n.t("needs you") : unread > 0 ? ", " + L10n.t("\(unread) new") : ""))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Bot thread header

struct BotThreadHeader: View {
    @ObservedObject var model: TeamsModel
    let bot: TeamsBot

    private var crew: [TeamsAgent] { model.crew(bot) }

    private var crewLine: String {
        let names = crew.map(\.name)
        guard let lead = names.first else { return SwarmaCells.scopeLabel(bot.scope) }
        let others = names.dropFirst()
        let who = others.isEmpty ? lead : lead + " " + L10n.t("leads") + " " + Self.list(Array(others))
        return (others.isEmpty ? L10n.t("Bot") : L10n.t("Swarm")) + " · " + who + " · " + SwarmaCells.scopeLabel(bot.scope)
    }

    /// "Auto · Antigravity researches, Claude edits" from routing_now, else the configured runners.
    private var routingLine: String {
        func who(_ kind: TeamsBotRouting.Kind) -> String? {
            if let p = bot.routingNow[kind.rawValue]?.providerNow { return SwarmaCells.vendorName(p) }
            return bot.routing[kind].flatMap { $0.provider.map(SwarmaCells.vendorName) }
        }
        let auto = TeamsBotRouting.Kind.allCases.contains { bot.routing[$0] == nil }
        var parts: [String] = []
        if let r = who(.research) { parts.append(r + " " + L10n.t("researches")) }
        if let e = who(.patch) { parts.append(e + " " + L10n.t("edits")) }
        let head = auto ? L10n.t("Auto") : L10n.t("Set")
        return parts.isEmpty ? head + " · " + L10n.t("most quota left") : head + " · " + parts.joined(separator: ", ")
    }

    static func list(_ names: [String]) -> String {
        names.count <= 1 ? names.joined() : names.dropLast().joined(separator: ", ") + " " + L10n.t("and") + " " + names.last!
    }

    var body: some View {
        HStack(spacing: 12) {
            KSMoji(seed: bot.avatar ?? bot.leadAgentID, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: bot.name).font(KS.body(21, .bold))
                Text(verbatim: crewLine.uppercased()).font(KS.mono(10)).tracking(1).foregroundStyle(KS.textMuted).lineLimit(1)
            }
            HStack(spacing: -8) { ForEach(crew.dropFirst().prefix(5)) { KSMoji(seed: $0.avatar ?? $0.id, size: 26) } }
                .padding(.leading, 4)
            Spacer(minLength: 8)
            Button { model.editingBotID = bot.id } label: {
                HStack(spacing: 7) {
                    Circle().fill(KS.lime).frame(width: 9, height: 9).overlay(Circle().stroke(KS.ink, lineWidth: 2))
                    Text(verbatim: routingLine).lineLimit(1)
                }
            }
            .buttonStyle(.ks(.white)).help(L10n.t("Which service does what, from Bot settings"))
            Button { model.editingBotID = bot.id } label: { Label(L10n.t("Bot settings"), systemImage: "slider.horizontal.3") }
                .buttonStyle(.ks(.paper))
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(KS.paper)
        .overlay(alignment: .bottom) { Rectangle().fill(KS.ink).frame(height: 2.5) }
    }
}

// MARK: - Task card

/// A bot task that needs the owner: ready for review, failed, or a failed check.
struct TaskCardView: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    var body: some View {
        let task = message.task
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(verbatim: task?.title ?? message.body ?? L10n.t("Task")).font(KS.body(16, .bold)).lineLimit(2)
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
                    if task.resolved { KSChip(L10n.t("Resolved"), fill: KS.sage) }
                }
            }
        }
        .padding(16).frame(maxWidth: 640, alignment: .leading)
        .ksCard(fill: message.task?.isFailed == true ? KS.coralTint : KS.white, radius: 20)
    }

    static func state(_ t: TeamsTaskCard) -> (String, Color, Color) {
        if t.check?.status == "failed" { return (L10n.t("Check failed"), KS.ink, KS.paper) }
        if t.status == "failed" { return (L10n.t("Failed"), KS.ink, KS.paper) }
        if t.resolved { return (L10n.t("Resolved"), KS.sage, KS.ink) }
        if t.branch != nil { return (L10n.t("Ready for review"), KS.sage, KS.ink) }
        return (TeamsCopy.swarmStatus(t.status ?? ""), KS.white, KS.ink)
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

    private var scopeAgents: [TeamsAgent] { model.agents.filter { $0.scope == bot.scope || bot.scope.isEmpty } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Button { model.editingBotID = nil } label: { Label(bot.name, systemImage: "chevron.left") }.buttonStyle(.ks(.paper))
                KSMoji(seed: bot.avatar ?? bot.leadAgentID, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: (name.isEmpty ? bot.name : name).uppercased() + L10n.t(" BOT.")).font(KS.display(34))
                    Text(verbatim: L10n.t("A persistent swarm. These settings apply to everything it runs, and override the global Swarmaa defaults."))
                        .font(KS.body(14)).foregroundStyle(KS.textSoft)
                }
                Spacer()
            }
            .padding(.horizontal, 24).padding(.vertical, 14)
            .overlay(alignment: .bottom) { Rectangle().fill(KS.ink).frame(height: 2.5) }

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

            KSBottomBar {
                Text(verbatim: L10n.t("Changes apply from the next turn. Running work keeps its settings."))
                    .font(KS.body(14)).foregroundStyle(KS.textMuted).lineLimit(1)
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
        .onAppear(perform: load)
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
            .padding(18).ksCard(radius: 22)
        }
    }

    private func field<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(KS.body(15, .semibold))
            content().padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 14).fill(KS.white))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(KS.ink, lineWidth: 2))
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
                        if id == leadID { KSChip(L10n.t("Lead"), fill: KS.ink, ink: KS.paper) }
                        else {
                            Button(L10n.t("Make lead")) { members.append(leadID); leadID = id; members.removeAll { $0 == id } }
                                .buttonStyle(.ks(.paper, compact: true))
                            Button { members.removeAll { $0 == id } } label: { Image(systemName: "xmark") }
                                .buttonStyle(.ks(.white, compact: true)).accessibilityLabel(L10n.t("Remove \(a?.name ?? "agent") from the crew"))
                        }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .overlay(alignment: .bottom) { if i < members.filter({ $0 != leadID }).count { Rectangle().fill(KS.ink).frame(height: 2) } }
                }
            }
            .ksCard(radius: 22)
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
                    .overlay(alignment: .bottom) { if i < 3 { Rectangle().fill(KS.ink).frame(height: 2) } }
                }
            }
            .ksCard(radius: 22, shadow: true)
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
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(KS.ink, lineWidth: 2))
                            .accessibilityLabel(L10n.t("Schedule, as cron"))
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .ksCard(radius: 22)
        }
    }

    private func ruleRow<C: View>(_ title: String, _ detail: String, @ViewBuilder _ control: () -> C) -> some View {
        ruleContent(title, detail, control)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .overlay(alignment: .bottom) { Rectangle().fill(KS.ink).frame(height: 2) }
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
    private var ready: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && !job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !scope.isEmpty && !model.savingBot
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: L10n.t("NEW BOT.")).font(KS.display(36))
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
            HStack {
                Spacer()
                Button(L10n.t("Cancel")) { dismiss() }.buttonStyle(.ks(.paper)).keyboardShortcut(.cancelAction)
                Button(L10n.t("Make bot")) {
                    Task {
                        let ok = await model.createBot(name: name.trimmingCharacters(in: .whitespaces),
                                                       job: String(job.prefix(8192)), scope: scope,
                                                       leadAgentID: leadID.isEmpty ? nil : leadID, memberAgentIDs: [])
                        if ok { dismiss() }
                    }
                }
                .buttonStyle(.ks(.primary)).keyboardShortcut(.defaultAction).disabled(!ready)
            }
        }
        .padding(24).frame(width: 520).fixedSize(horizontal: false, vertical: true)
        .background(KS.paper).environment(\.colorScheme, .light)
        .onAppear { if scope.isEmpty { scope = scopes.first ?? "" } }
        .onChange(of: scope) { _, _ in leadID = "" }
    }

    private func labeled<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(KS.body(15, .semibold))
            content().padding(.horizontal, 12).padding(.vertical, 9).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill(KS.white))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(KS.ink, lineWidth: 2))
        }
    }
}
