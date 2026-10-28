import SwiftUI

/// One thread: header with the runner picker, messages newest at the bottom,
/// and the composer pinned below them.
struct ThreadView: View {
    @ObservedObject var model: TeamsModel
    let threadID: String

    @State private var nearBottom = true
    @State private var answeringQuestion: TeamsQuestion?

    /// Cached history stays on screen while it refreshes, goes stale or fails; the state shows as a banner above it.
    private var messages: [TeamsMessage] { model.messages[threadID] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            if let bot = model.bot(threadID: threadID) { BotThreadHeader(model: model, bot: bot) }
            else { ThreadHeader(model: model, threadID: threadID) }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.hasOlder[threadID] == true, !messages.isEmpty {
                            ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                                .onAppear { Task { await model.loadOlder(threadID) } }
                        }
                        if model.loadingThreads.contains(threadID) { ProgressView("Loading messages") }
                        if let error = model.threadErrors[threadID] {
                            Text(error)
                        }
                        if model.messages[threadID]?.isEmpty == true, !model.loadingThreads.contains(threadID),
                           !model.staleThreads.contains(threadID), model.threadErrors[threadID] == nil {
                            Text(verbatim: L10n.t("No messages yet. Say hello below."))
                                .foregroundStyle(Palette.textSecondary).frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        ForEach(messages) { MessageRow(model: model, message: $0).id($0.id) }
                        ForEach(model.liveTyping(threadID)) { TypingBubble(model: model, typing: $0).id("typing:" + $0.id) }
                    }
                    .padding(.horizontal, 24).padding(.vertical, 18)
                }
                .defaultScrollAnchor(.bottom)
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
                } action: { _, value in nearBottom = value }
                .onChange(of: model.targetQuestionID) { _, target in
                    if let target, let message = messages.first(where: { $0.question?.id == target || $0.ref?.questionID == target }) {
                        proxy.scrollTo(message.id, anchor: .center)
                    }
                }
                .onChange(of: model.liveTyping(threadID).last?.text) { _, text in
                    guard text != nil, nearBottom, let last = model.liveTyping(threadID).last else { return }
                    proxy.scrollTo("typing:" + last.id, anchor: .bottom)
                }
                .onChange(of: messages.last?.id) { _, last in
                    guard let last, nearBottom else { return }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                    model.markSelectedRead()
                }
                .task(id: "\(threadID):\(model.targetQuestionID ?? "")") {
                    if let message = await model.findTargetQuestion(in: threadID) {
                        proxy.scrollTo(message.id, anchor: .center)
                        if message.question?.status == "open" { answeringQuestion = message.question }
                    }
                }
            }
            HStack(spacing: 8) {
                if model.threadErrors[threadID] != nil {
                    Button("Retry history") { Task { await model.loadLatest(threadID) } }.buttonStyle(.ks(.white, compact: true))
                }
                let questions = messages.compactMap(\.question).filter { $0.status == "open" }
                if !questions.isEmpty {
                    Menu("Answer question (\(questions.count))") {
                        ForEach(questions) { q in Button(q.prompt) { answeringQuestion = q } }
                    }.menuStyle(.button).buttonStyle(.ks(.primary, compact: true)).fixedSize()
                }
                let swarmMessages = messages.filter { $0.kind == .swarm }
                if !swarmMessages.isEmpty {
                    Menu("Open swarm") {
                        ForEach(swarmMessages) { message in
                            if let id = message.swarm?.id ?? message.ref?.swarmID {
                                Button(model.swarms[id]?.title ?? message.swarm?.title ?? "Swarm") { model.detailSwarmID = id }
                            }
                        }
                    }
                }
                Spacer()
            }.padding(.horizontal, 20).padding(.top, 6)
            Composer(model: model, threadID: threadID).id(threadID)
        }
        .background(KS.paper)
        .sheet(item: $answeringQuestion) { question in
            VStack {
                QuestionCard(model: model, question: currentQuestion(question)).padding()
                HStack { Spacer(); Button("Done") { answeringQuestion = nil }.keyboardShortcut(.cancelAction) }.padding()
            }.frame(width: 520).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func currentQuestion(_ question: TeamsQuestion) -> TeamsQuestion {
        messages.compactMap(\.question).first { $0.id == question.id } ?? question
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
                        Text(verbatim: agent.name).font(KS.body(21, .bold))
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
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(KS.paper)
        .overlay(alignment: .bottom) { Rectangle().fill(KS.ink).frame(height: 2.5) }
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
                    ForEach(Array(Set(model.agents.filter { $0.runner.provider == p.provider }.compactMap { $0.runner.model })).sorted(), id: \.self) { name in
                        Button(name) { set(TeamsRunner(provider: p.provider, model: name, effort: agent.runner.effort)) }
                    }
                    ForEach(Self.efforts, id: \.self) { effort in
                        let runner = agent.runner.changing(provider: p.provider, effort: effort)
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
        .disabled(model.savingRunners.contains(agent.id))
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
            if let q = message.question { QuestionCard(model: model, question: q, interactive: false) }
            else { TextBubble(model: model, message: message) }
        case .answer: AnswerBubble(answer: message.answer)
        case .task: TaskCardView(model: model, message: message)
        case .unknown: EmptyView()
        }
    }
}

/// A running turn's reply so far: an agent bubble with a quiet "typing" mark.
/// Plain text (it is partial and untrusted), replaced by the real message when it lands.
struct TypingBubble: View {
    @ObservedObject var model: TeamsModel
    let typing: TeamsTyping

    private var agent: TeamsAgent? { model.agent(id: typing.agentID) }
    private var name: String { agent?.name ?? L10n.t("Agent") }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            TeamsAvatar(seed: agent?.avatar ?? typing.agentID, name: name, size: 30)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: name).font(KS.body(14, .bold))
                    Image(systemName: "ellipsis").font(.system(size: 11, weight: .bold)).foregroundStyle(KS.textMuted)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                    Text(verbatim: L10n.t("typing")).font(KS.mono(10)).foregroundStyle(KS.textMuted)
                }
                Text(verbatim: typing.text).textSelection(.enabled)
                    .font(KS.body(16)).lineSpacing(2)
                    .padding(.horizontal, 15).padding(.vertical, 10)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6,
                                                       bottomTrailingRadius: 20, topTrailingRadius: 20).fill(KS.white))
                    .overlay(UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6,
                                                    bottomTrailingRadius: 20, topTrailingRadius: 20)
                        .stroke(KS.ink, style: StrokeStyle(lineWidth: 2, dash: [5, 4])))
                    .foregroundStyle(KS.ink)
            }
            Spacer(minLength: 60)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name + " " + L10n.t("is typing") + ": " + typing.text)
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
    @State private var rendered: (body: String, text: AttributedString)?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if message.isHuman { Spacer(minLength: 60) } else if let id = message.author.id {
                TeamsAvatar(seed: model.agent(id: id)?.avatar ?? id, name: author, size: 30)
            }
            VStack(alignment: message.isHuman ? .trailing : .leading, spacing: 3) {
                if !message.isHuman {
                    HStack(spacing: 6) {
                        Text(verbatim: author).font(KS.body(14, .bold))
                        if let date = message.createdAt { Text(date, style: .time).font(KS.mono(10)).foregroundStyle(KS.textMuted) }
                    }
                }
                Text(rendered?.body == (message.body ?? "") ? rendered!.text : AttributedString(message.body ?? "")).textSelection(.enabled)
                    .font(KS.body(16)).lineSpacing(2)
                    .padding(.horizontal, 15).padding(.vertical, 10)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: message.isHuman ? 20 : 6,
                                                       bottomTrailingRadius: message.isHuman ? 6 : 20, topTrailingRadius: 20)
                        .fill(message.isHuman ? KS.ink : KS.white))
                    .overlay(UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: message.isHuman ? 20 : 6,
                                                    bottomTrailingRadius: message.isHuman ? 6 : 20, topTrailingRadius: 20)
                        .stroke(KS.ink, lineWidth: message.isHuman ? 0 : 2))
                    .foregroundStyle(message.isHuman ? KS.paper : KS.ink)
            }
            if !message.isHuman { Spacer(minLength: 60) }
        }
        .frame(maxWidth: .infinity, alignment: message.isHuman ? .trailing : .leading)
        .task(id: message.body) {
            let body = message.body ?? ""
            let parsed = await Task.detached(priority: .userInitiated) {
                (try? AttributedString(markdown: body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(body)
            }.value
            guard !Task.isCancelled else { return }
            rendered = (body, parsed)
        }
    }
}

struct AnswerBubble: View {
    let answer: TeamsAnswer?
    var body: some View {
        let parts = (answer?.choices ?? []) + [answer?.text].compactMap { $0 }
        Text(verbatim: parts.joined(separator: " · "))
            .font(KS.body(16))
            .padding(.horizontal, 15).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 20).fill(KS.ink))
            .foregroundStyle(KS.paper)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// `handoff` and `notice`: one quiet, centred service line.
struct ServiceLine: View {
    let symbol: String
    let text: String
    var body: some View {
        Label { Text(verbatim: text) } icon: { Image(systemName: symbol) }
            .font(KS.mono(11)).foregroundStyle(KS.textMuted)
            .padding(.vertical, 2)
            .frame(maxWidth: 640, alignment: .leading)
    }
}

/// The HandoffLine and NoticeLine named in the brief, as one view.
typealias HandoffLine = ServiceLine
typealias NoticeLine = ServiceLine

private struct CardBox<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: 640, alignment: .leading)
            .ksCard(radius: 22, shadow: true)
    }
}

struct SwarmCard: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    private var swarm: TeamsSwarm? {
        message.ref?.swarmID.flatMap { model.swarms[$0] } ?? message.swarm
    }

    var body: some View {
        CardBox {
            if let swarm {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        KSLabel(L10n.t("Swarm"))
                        Text(verbatim: swarm.title).font(KS.body(17, .bold))
                        Text(verbatim: TeamsCopy.swarmStatus(swarm.status)).font(.caption)
                            .foregroundStyle(swarm.status == "waiting_on_you" ? Palette.watch : Palette.textSecondary)
                    }
                    Spacer()
                    Text(verbatim: "\(swarm.progress.done)/\(swarm.progress.total)").font(KS.display(30))
                }
                ForEach(swarm.steps) { SwarmStepRow(model: model, step: $0) }
                Button(L10n.t("Open swarm")) { model.detailSwarmID = swarm.id }.buttonStyle(.ks(.paper, compact: true))
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
            Text(verbatim: step.title).font(KS.body(15)).lineLimit(2)
            Spacer()
            if let a = model.agent(id: step.assigneeAgentID) {
                Text(verbatim: a.name.uppercased()).font(KS.mono(10)).foregroundStyle(KS.textMuted)
            }
        }
    }
}

struct RunCard: View {
    let run: TeamsRun?
    let count: Int

    var body: some View {
        CardBox {
            Group {
                HStack {
                    Image(systemName: "square.stack.3d.up")
                    Text(verbatim: run?.summary ?? (count == 1 ? L10n.t("Ran 1 subagent") : L10n.t("Ran \(count) subagents")))
                        .font(.callout)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Palette.textSecondary)
            if let run {
                ForEach(run.tasks, id: \.id) { t in
                    let (icon, color) = SwarmStepRow.symbol(t.status == "completed" ? "done" : t.status ?? "pending")
                    HStack(spacing: 8) {
                        Image(systemName: icon).foregroundStyle(color)
                        Text(verbatim: String(t.id.prefix(8))).font(.system(size: 11, design: .monospaced))
                        if let p = t.provider { Text(verbatim: SwarmaCells.vendorName(p)).font(.caption) }
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
    var interactive = true
    @State private var choices: [String] = []
    @State private var text = ""
    @State private var sending = false

    @State private var contentHeight: CGFloat = 200
    var body: some View {
        VStack(alignment: .leading) {
            if interactive {
                ScrollView {
                    card.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }.frame(height: min(contentHeight, 320))
            } else { card }
            if interactive && question.status == "open" {
                HStack {
                    Spacer()
                    Button(L10n.t("Send")) {
                        sending = true
                        Task { _ = await model.answer(question, choices: choices, text: text); sending = false }
                    }
                    .buttonStyle(.ks(.primary))
                    .disabled(sending || TeamsAnswerValidation.validate(question, choices: choices, text: text) != nil)
                }
            }
        }
    }

    private var card: some View {
        CardBox {
            if question.status == "answered" {
                Label(L10n.t("Answers sent"), systemImage: "checkmark.circle.fill")
                    .font(.callout.weight(.semibold)).foregroundStyle(Palette.ample)
                Text(verbatim: question.prompt).font(.body)
                let answer = question.answer.map { $0.choices + [$0.text].compactMap { $0 } } ?? []
                if !answer.isEmpty {
                    Text(verbatim: answer.joined(separator: " · ")).font(.callout).foregroundStyle(Palette.textSecondary)
                }
            } else if question.status == "expired" {
                Text(verbatim: question.prompt).font(.body)
                Text(verbatim: L10n.t("This question expired")).font(.callout).foregroundStyle(Palette.textSecondary)
            } else if !interactive {
                HStack { KSLabel(L10n.t("Question")); Spacer(); KSChip(L10n.t("Needs you"), fill: KS.coral) }
                Text(question.prompt).font(KS.body(18, .bold)).textSelection(.enabled)
                if !question.options.isEmpty {
                    ChipFlow(options: question.options, selected: []) { _ in model.targetQuestionID = question.id }
                }
            } else {
                HStack {
                    KSLabel(question.multi ? L10n.t("Pick any") : L10n.t("Pick one"))
                    Spacer()
                    KSChip(L10n.t("Needs you"), fill: KS.coral)
                }
                Text(verbatim: question.prompt).font(KS.body(18, .bold))
                ChipFlow(options: question.options, selected: choices) { toggle($0) }
                if question.freeText {
                    TextField(L10n.t("Add a note"), text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...4)
                }
                if model.answeringBlocked {
                    // 403 owner_required: the owner grants this Mac `answer_questions`.
                    VStack(alignment: .leading, spacing: 4) {
                        Label(L10n.t("Ask the owner to allow answering questions from this Mac"), systemImage: "lock")
                            .font(.callout.weight(.semibold)).foregroundStyle(Palette.watch)
                        Text(verbatim: TeamsSetup.grantCommand).font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled).foregroundStyle(Palette.textSecondary)
                    }
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
                    Text(verbatim: option).font(KS.body(15, .semibold))
                        .padding(.horizontal, 13).padding(.vertical, 7)
                        .background(Capsule().fill(on ? KS.lime : KS.white))
                        .overlay(Capsule().stroke(KS.ink, lineWidth: 2))
                        .foregroundStyle(KS.ink)
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
                let size = subviews[i].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [(items: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] = []
        var current: [Int] = [], x: CGFloat = 0, y: CGFloat = 0, h: CGFloat = 0
        for (i, view) in subviews.enumerated() {
            let size = view.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
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
    @FocusState private var editorFocused: Bool
    private var text: Binding<String> {
        Binding(get: { model.drafts[threadID] ?? "" }, set: { model.drafts[threadID] = $0 })
    }
    private var sending: Bool { model.sendingThreads.contains(threadID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let pending = model.rejectedSends[threadID] ?? model.pendingSends[threadID], !sending {
                Text("Unsent: " + pending.body).font(.caption).lineLimit(3)
                if let error = model.sendErrors[threadID] { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    if model.pendingSends[threadID] != nil {
                        Button("Retry") { send() }
                    }
                    Button("Edit") { model.discardSend(threadID, edit: true) }
                    Button("Discard") { model.discardSend(threadID) }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty {
                    Text(verbatim: L10n.t("Message · Return to send, Shift-Return for a new line"))
                        .foregroundStyle(Palette.textSecondary).padding(.horizontal, 5).padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
                TextEditor(text: text)
                    .focused($editorFocused).accessibilityLabel("Message in this thread")
                    .font(KS.body(16)).scrollContentBackground(.hidden)
                    .frame(minHeight: 36, maxHeight: 140).fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 8)
                    // Return sends; Shift-Return is a new line.
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        send()
                        return .handled
                    }
            }
            Button(action: send) { Label(L10n.t("Send"), systemImage: "arrow.right") }
                .buttonStyle(.ks(.ink))
                .disabled(sending || (model.pendingSends[threadID] == nil && text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                .padding(.bottom, 8).help(L10n.t("Send")).accessibilityLabel(model.pendingSends[threadID] == nil ? "Send message" : "Retry previous message")
        }
            }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .ksCard(radius: 22, shadow: true)
        .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 16)
        .background(KS.paper)
        .overlay(alignment: .top) { Rectangle().fill(KS.ink).frame(height: 2.5) }

    }

    private func send() {
        guard !sending else { return }
        let target = threadID
        editorFocused = true
        Task { _ = await model.sendDraft(threadID: target) }

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
                    .frame(height: min(CGFloat(s.steps.count) * 52 + 16, 320))
            } else if let error = model.swarmErrors[swarmID] {
                Text(error)
                Button("Retry") { Task { await model.loadSwarm(swarmID) } }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            HStack { Spacer(); Button(L10n.t("Done")) { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20).frame(minWidth: 420, idealWidth: 520, maxWidth: 640)
        .fixedSize(horizontal: false, vertical: true)
        .onExitCommand { dismiss() }
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
