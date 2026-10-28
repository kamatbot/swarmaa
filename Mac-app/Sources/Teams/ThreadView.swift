import SwiftUI

/// One thread: header with the runner picker, messages newest at the bottom,
/// and the composer pinned below them.
struct ThreadView: View {
    @ObservedObject var model: TeamsModel
    let threadID: String

    private var messages: [TeamsMessage] { model.messages[threadID] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            ThreadHeader(model: model, threadID: threadID)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.hasOlder[threadID] == true {
                            ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                                .onAppear { Task { await model.loadOlder(threadID) } }
                        }
                        if messages.isEmpty, model.messages[threadID] != nil {
                            Text(verbatim: L10n.t("No messages yet. Say hello below."))
                                .foregroundStyle(Palette.textSecondary).frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        ForEach(messages) { MessageRow(model: model, message: $0).id($0.id) }
                    }
                    .padding(16)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: messages.last?.id) { _, last in
                    guard let last else { return }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                    model.markSelectedRead()
                }
            }
            Divider()
            Composer(model: model, threadID: threadID)
        }
    }
}

struct ThreadHeader: View {
    @ObservedObject var model: TeamsModel
    let threadID: String

    var body: some View {
        HStack(spacing: 10) {
            if let agent = model.agent(threadID: threadID) {
                TeamsAvatar(seed: agent.avatar ?? agent.id, name: agent.name, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: agent.name).font(.headline)
                        if let role = agent.role, !role.isEmpty { RoleBadge(role: role) }
                    }
                    Text(verbatim: Self.status(agent.status)).font(.caption)
                        .foregroundStyle(agent.status == "waiting_on_you" ? Palette.watch : Palette.textSecondary)
                }
                Spacer()
                RunnerPicker(model: model, agent: agent)
            } else if let channel = model.channel(threadID: threadID) {
                TeamsAvatar(seed: channel.id, name: channel.name ?? "", isChannel: true, size: 28)
                Text(verbatim: "# " + (channel.name ?? L10n.t("Channel"))).font(.headline)
                HStack(spacing: -6) {
                    ForEach(channel.members.prefix(5), id: \.self) { id in
                        if let a = model.agent(id: id) { TeamsAvatar(seed: a.avatar ?? a.id, name: a.name, size: 20) }
                    }
                }
                Spacer()
            } else {
                Spacer()
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    static func status(_ status: String?) -> String {
        switch status {
        case "working": return L10n.t("Working")
        case "waiting_on_you": return L10n.t("Waiting on you")
        case "offline": return L10n.t("Offline: no worker can run this runner")
        default: return L10n.t("Idle")
        }
    }
}

/// "Claude Opus 5.5 · High": Auto, or a routed provider at an effort. Shows
/// each provider's quota left beside it.
struct RunnerPicker: View {
    @ObservedObject var model: TeamsModel
    let agent: TeamsAgent
    static let efforts = ["low", "medium", "high"]

    var body: some View {
        Menu {
            Button { set(.auto) } label: { check(agent.runner.isAuto, L10n.t("Auto")) }
            Divider()
            ForEach(model.runnerProviders, id: \.provider) { p in
                Menu(Self.providerTitle(p)) {
                    ForEach(Self.efforts, id: \.self) { effort in
                        let runner = TeamsRunner(provider: p.provider, effort: effort)
                        Button { set(runner) } label: {
                            check(agent.runner.provider == p.provider && agent.runner.effort == effort, runner.label)
                        }
                    }
                }
                .disabled(!p.liveWorker)
            }
        } label: {
            Text(verbatim: agent.runner.label)
        }
        .menuStyle(.borderlessButton).fixedSize()
        .help(L10n.t("Runner: which provider answers this agent. Changing it keeps the thread."))
    }

    static func providerTitle(_ p: SwarmaStatus.Routing.Provider) -> String {
        var title = SwarmaCells.vendorName(p.provider)
        if let h = p.headroom { title += " — \(Int(h))% " + L10n.t("left") }
        if !p.liveWorker { title += " (" + L10n.t("offline") + ")" }
        return title
    }

    @ViewBuilder private func check(_ on: Bool, _ title: String) -> some View {
        if on { Label(title, systemImage: "checkmark") } else { Text(verbatim: title) }
    }

    private func set(_ runner: TeamsRunner) {
        guard runner != agent.runner else { return }
        Task { await model.setRunner(runner, for: agent) }
    }
}

// MARK: - Messages

struct MessageRow: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    var body: some View {
        switch message.kind {
        case .text: TextBubble(model: model, message: message)
        case .handoff: ServiceLine(symbol: "arrow.right.circle", text: message.body ?? "")
        case .notice: ServiceLine(symbol: "info.circle", text: message.body ?? "")
        case .swarm: SwarmCard(model: model, message: message)
        case .run: RunCard(run: message.run, count: message.ref?.taskIDs.count ?? 0)
        case .question:
            if let q = message.question { QuestionCard(model: model, question: q) }
        case .answer: AnswerBubble(answer: message.answer)
        case .unknown: EmptyView()
        }
    }
}

struct TextBubble: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    private var author: String {
        message.author.name ?? model.agent(id: message.author.id)?.name ?? L10n.t("Agent")
    }

    /// Agent bodies are untrusted text: shown, never acted on. Inline
    /// Markdown only, so nothing renders as more than styled text and links.
    private var text: AttributedString {
        let body = message.body ?? ""
        return (try? AttributedString(markdown: body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(body)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.isHuman { Spacer(minLength: 60) } else if let id = message.author.id {
                TeamsAvatar(seed: model.agent(id: id)?.avatar ?? id, name: author, size: 26)
            }
            VStack(alignment: message.isHuman ? .trailing : .leading, spacing: 3) {
                if !message.isHuman {
                    HStack(spacing: 6) {
                        Text(verbatim: author).font(.system(size: 12, weight: .semibold))
                        if let date = message.createdAt { Text(date, style: .time).font(.system(size: 11)).foregroundStyle(Palette.textSecondary) }
                    }
                }
                Text(text).textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 12)
                        .fill(message.isHuman ? Color.accentColor.opacity(0.85) : Palette.barTrack))
                    .foregroundStyle(message.isHuman ? Color.white : Palette.textPrimary)
            }
            if !message.isHuman { Spacer(minLength: 60) }
        }
        .frame(maxWidth: .infinity, alignment: message.isHuman ? .trailing : .leading)
    }
}

struct AnswerBubble: View {
    let answer: TeamsAnswer?
    var body: some View {
        let parts = (answer?.choices ?? []) + [answer?.text].compactMap { $0 }
        Text(verbatim: parts.joined(separator: " · "))
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.85)))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// `handoff` and `notice`: one quiet, centred service line.
struct ServiceLine: View {
    let symbol: String
    let text: String
    var body: some View {
        Label { Text(verbatim: text) } icon: { Image(systemName: symbol) }
            .font(.system(size: 12)).foregroundStyle(Palette.textSecondary)
            .frame(maxWidth: .infinity)
    }
}

/// The HandoffLine and NoticeLine named in the brief, as one view.
typealias HandoffLine = ServiceLine
typealias NoticeLine = ServiceLine

private struct CardBox<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(12)
            .frame(maxWidth: 520, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Palette.barTrack.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.barTrack))
    }
}

struct SwarmCard: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage
    @State private var expanded = false

    private var swarm: TeamsSwarm? {
        message.ref?.swarmID.flatMap { model.swarms[$0] } ?? message.swarm
    }

    var body: some View {
        CardBox {
            if let swarm {
                HStack(spacing: 8) {
                    Button { expanded.toggle() } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 14)
                    }
                    .buttonStyle(.plain).accessibilityLabel(expanded ? L10n.t("Hide steps") : L10n.t("Show steps"))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: swarm.title).font(.system(size: 13, weight: .semibold))
                        Text(verbatim: TeamsCopy.swarmStatus(swarm.status)).font(.system(size: 11))
                            .foregroundStyle(swarm.status == "waiting_on_you" ? Palette.watch : Palette.textSecondary)
                    }
                    Spacer()
                    Text(verbatim: "\(swarm.progress.done)/\(swarm.progress.total)").font(.system(size: 13, weight: .bold).monospacedDigit())
                    Button { model.detailSwarmID = swarm.id } label: { Image(systemName: "chevron.right.circle") }
                        .buttonStyle(.plain).help(L10n.t("Open swarm"))
                }
                ProgressView(value: Double(swarm.progress.done), total: Double(max(swarm.progress.total, 1)))
                    .tint(Palette.ample)
                if expanded {
                    ForEach(swarm.steps) { SwarmStepRow(model: model, step: $0) }
                }
            } else {
                Text(verbatim: L10n.t("Swarm")).foregroundStyle(Palette.textSecondary)
            }
        }
        .task { if swarm == nil, let id = message.ref?.swarmID { await model.loadSwarm(id) } }
    }
}

struct SwarmStepRow: View {
    @ObservedObject var model: TeamsModel
    let step: TeamsSwarm.Step

    static func symbol(_ status: String) -> (String, Color) {
        switch status {
        case "done": return ("checkmark.circle.fill", Palette.ample)
        case "failed", "blocked", "cancelled": return ("xmark.circle.fill", Palette.critical)
        case "waiting_on_you": return ("questionmark.circle.fill", Palette.watch)
        case "running": return ("circle.dotted", Palette.textPrimary)
        default: return ("circle", Palette.textSecondary)
        }
    }

    var body: some View {
        let (icon, color) = Self.symbol(step.status)
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            Text(verbatim: step.title).font(.system(size: 12)).lineLimit(2)
            Spacer()
            if let a = model.agent(id: step.assigneeAgentID) {
                Text(verbatim: a.name).font(.system(size: 11)).foregroundStyle(Palette.textSecondary)
            }
        }
    }
}

struct RunCard: View {
    let run: TeamsRun?
    let count: Int
    @State private var expanded = false

    var body: some View {
        CardBox {
            Button { expanded.toggle() } label: {
                HStack {
                    Image(systemName: "square.stack.3d.up")
                    Text(verbatim: run?.summary ?? (count == 1 ? L10n.t("Ran 1 subagent") : L10n.t("Ran \(count) subagents")))
                        .font(.system(size: 12))
                    Spacer()
                    if run?.tasks.isEmpty == false { Image(systemName: expanded ? "chevron.down" : "chevron.right") }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Palette.textSecondary)
            if expanded, let run {
                ForEach(run.tasks, id: \.id) { t in
                    let (icon, color) = SwarmStepRow.symbol(t.status == "completed" ? "done" : t.status ?? "pending")
                    HStack(spacing: 8) {
                        Image(systemName: icon).foregroundStyle(color)
                        Text(verbatim: String(t.id.prefix(8))).font(.system(size: 11, design: .monospaced))
                        if let p = t.provider { Text(verbatim: SwarmaCells.vendorName(p)).font(.system(size: 11)) }
                        Spacer()
                    }
                }
                if let branch = run.branch { Text(verbatim: branch).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
            }
        }
    }
}

struct QuestionCard: View {
    @ObservedObject var model: TeamsModel
    let question: TeamsQuestion
    @State private var choices: [String] = []
    @State private var text = ""
    @State private var sending = false

    var body: some View {
        CardBox {
            if question.status == "answered" {
                Label(L10n.t("Answers sent"), systemImage: "checkmark.circle.fill")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.ample)
                Text(verbatim: question.prompt).font(.system(size: 13))
                let answer = question.answer.map { $0.choices + [$0.text].compactMap { $0 } } ?? []
                if !answer.isEmpty {
                    Text(verbatim: answer.joined(separator: " · ")).font(.system(size: 12)).foregroundStyle(Palette.textSecondary)
                }
            } else if question.status == "expired" {
                Text(verbatim: question.prompt).font(.system(size: 13))
                Text(verbatim: L10n.t("This question expired")).font(.system(size: 12)).foregroundStyle(Palette.textSecondary)
            } else {
                Label(question.multi ? L10n.t("Choose any") : L10n.t("Choose one"), systemImage: "questionmark.bubble")
                    .font(.system(size: 11)).foregroundStyle(Palette.watch)
                Text(verbatim: question.prompt).font(.system(size: 13, weight: .semibold))
                ChipFlow(options: question.options, selected: choices) { toggle($0) }
                if question.freeText {
                    TextField(L10n.t("Add a note"), text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...4)
                }
                if model.answeringBlocked {
                    // 403 owner_required: the owner grants this Mac `answer_questions`.
                    VStack(alignment: .leading, spacing: 4) {
                        Label(L10n.t("Ask the owner to allow answering questions from this Mac"), systemImage: "lock")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.watch)
                        Text(verbatim: TeamsSetup.grantCommand).font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled).foregroundStyle(Palette.textSecondary)
                    }
                }
                HStack {
                    Spacer()
                    Button(L10n.t("Send")) {
                        sending = true
                        Task { _ = await model.answer(question, choices: choices, text: text); sending = false }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(sending || TeamsAnswerValidation.validate(question, choices: choices, text: text) != nil)
                }
            }
        }
    }

    private func toggle(_ option: String) {
        if let i = choices.firstIndex(of: option) { choices.remove(at: i) }
        else if question.multi { choices.append(option) }
        else { choices = [option] }
    }
}

/// Option chips that wrap onto as many lines as they need.
struct ChipFlow: View {
    let options: [String]
    let selected: [String]
    let tap: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(options, id: \.self) { option in
                let on = selected.contains(option)
                Button { tap(option) } label: {
                    Text(verbatim: option).font(.system(size: 12))
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Capsule().fill(on ? Color.accentColor : Palette.barTrack))
                        .foregroundStyle(on ? Color.white : Palette.textPrimary)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [(items: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] = []
        var current: [Int] = [], x: CGFloat = 0, y: CGFloat = 0, h: CGFloat = 0
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(.unspecified)
            if !current.isEmpty, x + size.width > width {
                rows.append((current, y, x - spacing, h)); y += h + spacing
                current = []; x = 0; h = 0
            }
            current.append(i); x += size.width + spacing; h = max(h, size.height)
        }
        if !current.isEmpty { rows.append((current, y, x - spacing, h)) }
        return rows
    }
}

// MARK: - Composer

struct Composer: View {
    @ObservedObject var model: TeamsModel
    let threadID: String
    @State private var text = ""
    @State private var sending = false

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(verbatim: L10n.t("Message"))
                        .foregroundStyle(Palette.textSecondary).padding(.horizontal, 5).padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $text)
                    .font(.body).scrollContentBackground(.hidden)
                    .frame(minHeight: 36, maxHeight: 140).fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 8)
                    // Return sends; Shift-Return is a new line.
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        send()
                        return .handled
                    }
            }
            Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.system(size: 24)) }
                .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.bottom, 8).help(L10n.t("Send"))
        }
        .padding(.horizontal, 14).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.barTrack.opacity(0.5)))
        .padding(12)
    }

    private func send() {
        let body = text
        guard !sending, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sending = true
        text = ""
        Task {
            if !(await model.send(body)) { text = body }
            sending = false
        }
    }
}

// MARK: - Swarm detail

struct SwarmDetailView: View {
    @ObservedObject var model: TeamsModel
    let swarmID: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let s = model.swarms[swarmID] {
                HStack {
                    Text(verbatim: s.title).font(.title2.weight(.semibold))
                    Spacer()
                    Text(verbatim: "\(s.progress.done)/\(s.progress.total)").font(.title3.monospacedDigit())
                }
                Text(verbatim: TeamsCopy.swarmStatus(s.status)).foregroundStyle(Palette.textSecondary)
                if let goal = s.goal, !goal.isEmpty { Text(verbatim: goal).textSelection(.enabled) }
                Divider()
                ScrollView { VStack(alignment: .leading, spacing: 8) { ForEach(s.steps) { SwarmStepRow(model: model, step: $0) } } }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            HStack { Spacer(); Button(L10n.t("Done")) { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20).frame(width: 520, height: 460)
        .task { await model.loadSwarm(swarmID) }
    }
}

#if DEBUG
#Preview("Question card") {
    let json = """
    {"id":"q1","prompt":"Which channels should the launch use?","options":["X","LinkedIn","Newsletter"],
     "multi":true,"free_text":true,"status":"open"}
    """
    let q = try! JSONDecoder().decode(TeamsQuestion.self, from: Data(json.utf8))
    return QuestionCard(model: TeamsModel(), question: q).padding()
}
#endif
