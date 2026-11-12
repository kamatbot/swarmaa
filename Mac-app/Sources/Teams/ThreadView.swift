import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// One thread: header with the runner picker, messages newest at the bottom,
/// and the composer pinned below them.
struct ThreadView: View {
    @ObservedObject var model: TeamsModel
    let threadID: String

    @State private var nearBottom = true
    /// False while a freshly opened (or freshly loaded) thread lays out; it fades in already in place.
    @State private var settled = false
    @State private var answeringQuestion: TeamsQuestion?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Cached history stays on screen while it refreshes, goes stale or fails; the state shows as a banner above it.
    private var messages: [TeamsMessage] { model.messages[threadID] ?? [] }
    private func messageRow(_ message: TeamsMessage) -> some View {
        MessageRow(model: model, message: message, agent: model.agent(id: message.author.id),
                   isLead: model.bot(threadID: message.threadID)?.leadAgentID == message.author.id).equatable().id(message.id)
    }

    var body: some View {
        VStack(spacing: 0) {
            // A bot's header, progress and tabs sit above this in BotWorkspace.
            if model.bot(threadID: threadID) == nil { ThreadHeader(model: model, threadID: threadID) }
            ScrollViewReader { proxy in
                ZStack(alignment: .bottom) {
                    ScrollView {
                        // Not lazy: a lazy stack guesses unrendered rows' heights, and pinned to the bottom it
                        // kept re-correcting as long markdown rows settled, so the chat bounced. A thread holds
                        // a page or two of messages, so exact heights are cheap.
                        VStack(alignment: .leading, spacing: 20) {
                            // Older history loads when you scroll up to it (below), not on appear: in this
                            // non-lazy stack the row "appears" the moment a thread opens, and that early page
                            // of history landing under you was the first-load jump.
                            if model.hasOlder[threadID] == true, !messages.isEmpty {
                                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                            }
                            if model.loadingThreads.contains(threadID) { ProgressView("Loading messages") }
                            if let error = model.threadErrors[threadID] {
                                Text(error)
                            }
                            if model.messages[threadID]?.isEmpty == true, !model.loadingThreads.contains(threadID),
                               !model.staleThreads.contains(threadID), model.threadErrors[threadID] == nil {
                                Text(verbatim: L10n.t("No messages yet. Say hello below."))
                                    .foregroundStyle(KS.textMuted).frame(maxWidth: .infinity).padding(.top, 40)
                            }
                            ForEach(teamsThreadRows(messages)) { row in
                                if row.folded {
                                    DisclosureGroup(isExpanded: Binding(
                                        get: { model.expandedWorkingNotes[threadID, default: []].contains(row.id) },
                                        set: { if $0 { model.expandedWorkingNotes[threadID, default: []].insert(row.id) }
                                               else { model.expandedWorkingNotes[threadID]?.remove(row.id) } }
                                    )) {
                                        ForEach(row.messages) { messageRow($0) }
                                    } label: { Text(row.label).font(KS.meta()).foregroundStyle(KS.textMuted) }
                                } else if let message = row.messages.first {
                                    messageRow(message)
                                }
                            }
                            ForEach(model.liveTyping(threadID)) { TypingBubble(model: model, typing: $0, threadID: threadID).id("typing:" + $0.id) }
                        }
                        .padding(.horizontal, 24).padding(.vertical, 20)
                    }
                    .opacity(settled ? 1 : 0)
                    // Opening a bot, or its messages first arriving, lays out rows, photos and the bottom anchor
                    // over a few frames; showing that read as the thread jumping. Reveal it once it has settled.
                    .task(id: "\(threadID):\(messages.isEmpty)") {
                        settled = false
                        try? await Task.sleep(for: .milliseconds(reduceMotion ? 60 : 120))
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.14)) { settled = true }
                    }
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    // At the bottom, stay pinned there while messages grow (markdown renders after a
                    // message lands, typing text streams in); reading older messages, keep your place.
                    .defaultScrollAnchor(nearBottom ? .bottom : .top, for: .sizeChanges)
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
                    } action: { _, value in nearBottom = value }
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentOffset.y < 80 && geometry.contentSize.height > geometry.containerSize.height
                    } action: { _, nearTop in
                        guard nearTop, settled, model.hasOlder[threadID] == true, let first = messages.first?.id else { return }
                        Task {
                            await model.loadOlder(threadID)
                            proxy.scrollTo(first, anchor: .top) // keep your place above the new page
                        }
                    }
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
                        // Your own message always brings you to the latest.
                        guard let last, nearBottom || messages.last?.isHuman == true else { return }
                        nearBottom = true
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                        model.markSelectedRead()
                    }
                    .task(id: "\(threadID):\(model.targetQuestionID ?? "")") {
                        if let message = await model.findTargetQuestion(in: threadID) {
                            proxy.scrollTo(message.id, anchor: .center)
                            if message.question?.status == "open" { answeringQuestion = message.question }
                        }
                    }

                    // Subframe Motion: answer-stream jump-to-latest pill
                    if !nearBottom {
                        Button {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
                                if let lastTyping = model.liveTyping(threadID).last {
                                    proxy.scrollTo("typing:" + lastTyping.id, anchor: .bottom)
                                } else if let last = messages.last {
                                    proxy.scrollTo(last.id, anchor: .bottom)
                                }
                            }
                            nearBottom = true
                        } label: {
                            HStack(spacing: 5) {
                                Text(verbatim: L10n.t("Latest response"))
                                Image(systemName: "arrow.down").font(KS.glyph(10, .bold))
                            }
                            .font(KS.meta(.semibold))
                            .foregroundStyle(KS.onSignal)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(Capsule().fill(KS.signal))
                            .shadow(color: KS.shadow.opacity(0.14), radius: 6, y: 2)
                            .offset(y: -8)
                        }
                        .buttonStyle(.plain)
                        .transition(reduceMotion ? .identity : .asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .bottom)),
                            removal: .opacity
                        ))
                    }
                }
            }
            HStack(spacing: 8) {
                if model.threadErrors[threadID] != nil {
                    Button("Retry history") { Task { await model.loadLatest(threadID) } }.buttonStyle(.ks(.white, compact: true))
                }
                let questions = messages.compactMap(\.question).filter { $0.status == "open" }
                // An open approval pauses the thread: its button goes straight to it.
                if let approval = questions.first(where: { $0.action != nil }) {
                    Button(L10n.t("Review approval")) { answeringQuestion = approval }
                        .buttonStyle(.ks(.primary, compact: true)).fixedSize()
                } else if !questions.isEmpty {
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
            }.padding(.horizontal, 24).padding(.top, 4)
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
        HStack(spacing: 12) {
            if let agent = model.agent(threadID: threadID) {
                TeamsAvatar(seed: agent.avatar ?? agent.id, name: agent.name, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: agent.name).font(KS.title())
                        if let role = agent.role, !role.isEmpty { RoleBadge(role: role) }
                    }
                    Text(verbatim: Self.status(agent.status)).font(KS.secondary())
                        .foregroundStyle(agent.status == "waiting_on_you" ? KS.needsYouText : KS.textMuted)
                }
                Spacer()
                RunnerPicker(model: model, agent: agent)
            } else if let channel = model.channel(threadID: threadID) {
                TeamsAvatar(seed: channel.id, name: channel.name ?? "", isChannel: true, size: 28)
                Text(verbatim: "# " + (channel.name ?? L10n.t("Channel"))).font(KS.section())
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

/// Not observing the model: a non-lazy thread re-rendered every row on each publish (usage every 3 s, typing,
/// task refreshes), which made scrolling hitch. A row redraws when its message, author or lead changes;
/// cards inside still observe the model themselves.
struct MessageRow: View, Equatable {
    let model: TeamsModel
    let message: TeamsMessage
    var agent: TeamsAgent? = nil
    var isLead = false
    static func == (a: MessageRow, b: MessageRow) -> Bool { a.message == b.message && a.agent == b.agent && a.isLead == b.isLead }
    @State private var hovering = false

    var body: some View {
        switch message.kind {
        case .text: TextBubble(model: model, message: message)
        case .handoff, .notice:
            VStack(alignment: .leading, spacing: 4) {
                ServiceLine(symbol: message.kind == .handoff ? "arrow.right.circle" : "info.circle", text: message.body ?? "")
                MessageFooter(model: model, message: message, hovering: hovering)
            }.onHover { hovering = $0 }
        case .swarm: SwarmCard(model: model, message: message)
        case .run: RunCard(run: message.run, count: message.ref?.taskIDs.count ?? 0)
        case .question:
            if let q = message.question { QuestionCard(model: model, question: q, interactive: false) }
            else { TextBubble(model: model, message: message) }
        case .answer: AnswerBubble(answer: message.answer)
        case .task: TaskCardView(model: model, message: message)
        case .schedule: ScheduleCardView(model: model, message: message)
        case .unknown: EmptyView()
        }
    }
}

/// Under every text message: copy (raw markdown source); system notices add a dismiss at the trailing edge.
struct MessageFooter: View {
    let model: TeamsModel
    let message: TeamsMessage
    var hovering = true
    @State private var copied = false

    private var failed: Bool { ["Turn failed", "Turn action rejected"].contains { message.body?.hasPrefix($0) == true } }

    var body: some View {
        HStack(spacing: 8) {
            if let body = message.body, !body.isEmpty {
                Button {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(body, forType: .string)
                    copied = true
                    Task { try? await Task.sleep(for: .milliseconds(1200)); copied = false }
                } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc").font(KS.meta()).foregroundStyle(KS.textMuted) }
                    .buttonStyle(.plain).help(L10n.t("Copy message")).accessibilityLabel(L10n.t("Copy message"))
            }
            if message.author.kind == "system" {
                Spacer(minLength: 0)
                Button { Task { await model.dismiss(message) } } label: {
                    Image(systemName: "xmark").font(KS.meta()).foregroundStyle(KS.textMuted)
                }
                .buttonStyle(.plain).help(L10n.t("Dismiss")).accessibilityLabel(L10n.t("Dismiss"))
                .opacity(hovering || failed ? 1 : 0)
            }
        }.padding(.horizontal, 4)
    }
}

/// Pulsing indicator for live responses (Subframe Motion `answer-stream` feedback).
struct TypingDotsIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(KS.signal)
                    .frame(width: 4, height: 4)
                    .opacity(pulse ? (index == 1 ? 1.0 : 0.35) : (index == 1 ? 0.35 : 1.0))
                    .scaleEffect(pulse ? (index == 1 ? 1.2 : 0.85) : (index == 1 ? 0.85 : 1.2))
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
        .accessibilityHidden(true)
    }
}

/// A running turn's reply so far: an agent bubble with an animated typing mark.
/// Plain text (it is partial and untrusted), replaced by the real message when it lands.
struct TypingBubble: View {
    @ObservedObject var model: TeamsModel
    let typing: TeamsTyping
    var threadID: String? = nil

    private var agent: TeamsAgent? { model.agent(id: typing.agentID) }
    private var name: String { agent?.name ?? L10n.t("Agent") }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            BotMessageAvatar(model: model, threadID: threadID, agentID: typing.agentID)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(verbatim: name).font(KS.text(.semibold)).foregroundStyle(KS.strong)
                    TypingDotsIndicator()
                    Text(verbatim: L10n.t("typing")).font(KS.meta()).foregroundStyle(KS.textDim)
                }
                Text(verbatim: typing.text).textSelection(.enabled)
                    .font(KS.text()).lineSpacing(4)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KS.bubble))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(KS.hairline, lineWidth: 1))
                    .foregroundStyle(Color(hex: 0xD3DCEB))
                    .opacity(0.75)
            }
            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(name + " " + L10n.t("is typing") + ": " + typing.text)
    }
}

/// An agent's provider monogram (CL, CX, AG); Auto runners show the agent's initials.
struct BotMessageAvatar: View {
    let model: TeamsModel
    let threadID: String?
    let agentID: String

    var body: some View {
        let agent = model.agent(id: agentID)
        // The agent's character, with its provider (CL/CX/AG) as a small badge.
        KSMoji(seed: agent?.avatar ?? agentID, size: 32)
            .overlay(alignment: .bottomTrailing) {
                if agent?.runner.provider != nil {
                    ProviderMonogram(provider: agent?.runner.provider, size: 14, fallback: "").offset(x: 4, y: 4)
                }
            }
    }
}

struct TextBubble: View {
    let model: TeamsModel
    let message: TeamsMessage
    @State private var hovering = false

    private var author: String {
        message.author.name ?? model.agent(id: message.author.id)?.name ?? L10n.t("Agent")
    }

    /// Agent bodies are untrusted text: shown, never acted on. Inline
    /// Markdown only, so nothing renders as more than styled text and links.

    /// "Claude · lead": the runner's provider, then the role.
    private var authorMeta: String {
        let agent = model.agent(id: message.author.id)
        let lead = model.bot(threadID: message.threadID)?.leadAgentID == message.author.id
        return [agent?.runner.provider.map(SwarmaCells.vendorName) ?? (agent == nil ? nil : L10n.t("Auto")),
                lead ? L10n.t("lead") : agent?.role].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if message.isHuman { Spacer(minLength: 120) } else if let id = message.author.id {
                BotMessageAvatar(model: model, threadID: message.threadID, agentID: id)
            }
            VStack(alignment: message.isHuman ? .trailing : .leading, spacing: 6) {
                if !message.isHuman {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: author).font(KS.text(.semibold)).foregroundStyle(KS.strong)
                        if !authorMeta.isEmpty { Text(verbatim: authorMeta).font(KS.secondary()).foregroundStyle(KS.textMuted) }
                        if let date = message.createdAt { Text(verbatim: KSClock.short(date)).font(KS.meta()).foregroundStyle(KS.textDim) }
                    }
                }
                ForEach(message.attachments) { attachment in
                    ThreadPhoto(attachment: attachment, threadID: message.threadID, messageID: message.id)
                }
                if let body = message.body, !body.isEmpty {
                    // A step's four-part report: any text before it, then the report card.
                    if message.author.kind == "agent", let (lead, report) = StepReport.parse(body) {
                        if !lead.isEmpty { bubble(lead) }
                        StepReportCard(report: report)
                    } else { bubble(body) }
                }
                MessageFooter(model: model, message: message, hovering: hovering)
            }
            if !message.isHuman { Spacer(minLength: 40) }
        }
        .frame(maxWidth: .infinity, alignment: message.isHuman ? .trailing : .leading)
        // Only system notices track hover: a state change under a human/agent bubble must not re-render its selectable text.
        .onHover { if message.author.kind == "system" { hovering = $0 } }
    }

    private func bubble(_ body: String) -> some View { SelectableBubble(text: body, human: message.isHuman).equatable() }
}

/// Depends only on its text: the model publishes on every stream event, and re-rendering a selectable Text
/// mid-drag dropped the selection, so chat text could not be selected while a bot was running.
private struct SelectableBubble: View, Equatable {
    let text: String
    let human: Bool
    var body: some View {
        if human {
            ChatMarkdownView(text: text, style: .ks(KS.strong)).equatable()
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(KS.selected))
                .foregroundStyle(KS.strong)
        } else {
            ChatMarkdownView(text: text, style: .ks(Color(hex: 0xD3DCEB), lineSpacing: 5)).equatable()
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KS.bubble))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(KS.hairline, lineWidth: 1))
                .foregroundStyle(Color(hex: 0xD3DCEB))
                .tint(KS.signal)
        }
    }
}

extension ChatMarkdownStyle {
    static func ks(_ text: Color, lineSpacing: CGFloat = 3) -> Self {
        .init(body: KS.text(), heading: KS.section(), mono: KS.meta(), text: text, muted: KS.textMuted,
              codeBackground: Color.black.opacity(0.25), lineSpacing: lineSpacing, blockSpacing: 9)
    }
}

private struct ThreadPhoto: View {
    let attachment: TeamsAttachment
    let threadID: String
    let messageID: String
    @State private var image: NSImage?
    @State private var failed = false
    /// Photos never change (keyed by sha256): each is fetched once per launch, not on every reopen.
    private static let cache = NSCache<NSString, NSImage>()

    init(attachment: TeamsAttachment, threadID: String, messageID: String) {
        self.attachment = attachment; self.threadID = threadID; self.messageID = messageID
        _image = State(initialValue: Self.cache.object(forKey: attachment.sha256 as NSString))
    }

    var body: some View {
        Group {
            // One footprint while loading and once loaded, so a photo arriving doesn't push the thread around.
            if let image { Image(nsImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12)).frame(width: 240, height: 180, alignment: .leading) }
            else if failed { Text(verbatim: L10n.t("Photo unavailable")).font(KS.text()).foregroundStyle(KS.textMuted).frame(width: 240, height: 180, alignment: .leading) }
            else { ProgressView().frame(width: 240, height: 180) }
        }
        .accessibilityLabel(attachment.name)
        .task(id: attachment.id) {
            guard image == nil else { return }
            do {
                image = NSImage(data: try await SwarmaTeamsClient.shared.threadAttachment(threadID: threadID, messageID: messageID, attachmentID: attachment.id))
                failed = image == nil
                if let image { Self.cache.setObject(image, forKey: attachment.sha256 as NSString) }
            } catch { failed = true }
        }
    }
}

struct AnswerBubble: View {
    let answer: TeamsAnswer?
    var body: some View {
        let parts = (answer?.choices ?? []) + [answer?.text].compactMap { $0 }
        Text(verbatim: parts.joined(separator: " · "))
            .font(KS.text())
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(KS.selected))
            .foregroundStyle(KS.strong)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// `handoff` and `notice`: one quiet, centred service line.
struct ServiceLine: View {
    let symbol: String
    let text: String
    var body: some View {
        Label { Text(verbatim: text) } icon: { Image(systemName: symbol).foregroundStyle(KS.signal) }
            .font(KS.text()).foregroundStyle(KS.textSoft)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(KS.optionLine, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }
}

/// The HandoffLine and NoticeLine named in the brief, as one view.
typealias HandoffLine = ServiceLine
typealias NoticeLine = ServiceLine

private struct CardBox<Content: View>: View {
    var fill: Color = KS.white
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .padding(12)
            .frame(maxWidth: 680, alignment: .leading)
            .ksCard(fill: fill, radius: 8, shadow: true)
    }
}

struct SwarmCard: View {
    @ObservedObject var model: TeamsModel
    let message: TeamsMessage

    private var swarm: TeamsSwarm? {
        message.ref?.swarmID.flatMap { model.swarms[$0] } ?? message.swarm
    }

    var body: some View {
        CardBox(fill: ["waiting_on_you", "failed"].contains(swarm?.status ?? "") ? KS.coralTint : KS.white) {
            if let swarm {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        KSLabel(L10n.t("Swarm"))
                        Text(verbatim: swarm.title).font(KS.section())
                        Text(verbatim: TeamsCopy.swarmStatus(swarm.status)).font(KS.secondary())
                            .foregroundStyle(swarm.status == "waiting_on_you" ? KS.needsYouText : KS.textMuted)
                        if let headline = HandoverStatus.headline(for: swarm, name: HandoverStatus.names(model)) {
                            Text(verbatim: headline).font(KS.secondary()).foregroundStyle(KS.textMuted).lineLimit(2)
                        }
                    }
                    Spacer()
                    Text(verbatim: "\(swarm.progress.done)/\(swarm.progress.total)").font(KS.section())
                }
                HandoverStrip(model: model, swarm: swarm)
                ForEach(swarm.steps) { SwarmStepRow(model: model, step: $0) }
                Button(L10n.t("Open swarm")) { model.detailSwarmID = swarm.id }.buttonStyle(.ks(.paper, compact: true))
            } else {
                Text(verbatim: L10n.t("Swarm")).foregroundStyle(KS.textMuted)
            }
        }
        .task { if swarm == nil, let id = message.ref?.swarmID { await model.loadSwarm(id) } }
    }
}

struct SwarmStepRow: View {
    @ObservedObject var model: TeamsModel
    let step: TeamsSwarm.Step
    /// The swarm detail list adds who is waiting on whom and "Done when".
    var line: String? = nil
    var showsCheck = false

    static func symbol(_ status: String) -> (String, Color) {
        switch status {
        case "done": return ("checkmark.circle.fill", KS.readyText)
        case "failed", "blocked", "cancelled": return ("xmark.circle.fill", KS.danger)
        case "waiting_on_you": return ("questionmark.circle.fill", KS.needsYouText)
        case "running": return ("circle.dotted", KS.ink)
        default: return ("circle", KS.textMuted)
        }
    }

    var body: some View {
        let (icon, color) = Self.symbol(step.status)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: step.title).font(KS.text()).lineLimit(2)
                if let line { Text(verbatim: line).font(KS.secondary()).foregroundStyle(KS.textMuted) }
                if showsCheck, let check = step.check, !check.isEmpty {
                    Text(verbatim: L10n.t("Done when: \(check)")).font(KS.secondary()).foregroundStyle(KS.textMuted).textSelection(.enabled)
                }
            }
            Spacer()
            if let a = model.agent(id: step.assigneeAgentID) {
                Text(verbatim: a.name.uppercased()).font(KS.meta()).foregroundStyle(KS.textMuted)
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
                        .font(KS.text())
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(KS.textMuted)
            if let run {
                ForEach(run.tasks, id: \.id) { t in
                    let (icon, color) = SwarmStepRow.symbol(t.status == "completed" ? "done" : t.status ?? "pending")
                    HStack(spacing: 8) {
                        Image(systemName: icon).foregroundStyle(color)
                        Text(verbatim: String(t.id.prefix(8))).font(KS.meta())
                        if let p = t.provider { Text(verbatim: SwarmaCells.vendorName(p)).font(KS.secondary()) }
                        Spacer()
                    }
                }
                if let branch = run.branch { Text(verbatim: branch).font(KS.meta()).textSelection(.enabled) }
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
    @State private var detailHeight: CGFloat = 60
    var body: some View {
        VStack(alignment: .leading) {
            if interactive {
                ScrollView {
                    card.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }.frame(height: min(contentHeight, 320))
            } else { card }
            // An approval's buttons answer it directly; no Send step.
            if interactive && question.status == "open" && question.action == nil {
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
        CardBox(fill: question.status == "open" ? KS.coralTint : KS.white) {
            if question.status == "answered" {
                Label(L10n.t("Answers sent"), systemImage: "checkmark.circle.fill")
                    .font(KS.text(.semibold)).foregroundStyle(KS.readyText)
                Text(verbatim: question.prompt).font(KS.text())
                let answer = question.answer.map { $0.choices + [$0.text].compactMap { $0 } } ?? []
                if !answer.isEmpty {
                    Text(verbatim: answer.joined(separator: " · ")).font(KS.text()).foregroundStyle(KS.textMuted)
                }
            } else if question.status == "expired" {
                Text(verbatim: question.prompt).font(KS.text())
                Text(verbatim: L10n.t("This question expired")).font(KS.text()).foregroundStyle(KS.textMuted)
            } else if let action = question.action {
                approval(action)
            } else if !interactive {
                HStack { KSLabel(L10n.t("Question")); Spacer(); KSChip(L10n.t("Needs you"), fill: KS.needsYouTint, ink: KS.needsYouText) }
                Text(question.prompt).font(KS.section()).textSelection(.enabled)
                if !question.options.isEmpty {
                    ChipFlow(options: question.options, selected: []) { _ in model.targetQuestionID = question.id }
                }
            } else {
                HStack {
                    KSLabel(question.multi ? L10n.t("Pick any") : L10n.t("Pick one"))
                    Spacer()
                    KSChip(L10n.t("Needs you"), fill: KS.needsYouTint, ink: KS.needsYouText)
                }
                Text(verbatim: question.prompt).font(KS.section())
                ChipFlow(options: question.options, selected: choices) { toggle($0) }
                if question.freeText {
                    TextField(L10n.t("Add a note"), text: $text, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(1...4)
                }
                blockedNote
            }
        }
    }

    @ViewBuilder private var blockedNote: some View {
        if model.answeringBlocked {
            // 403 owner_required: the owner grants this Mac `answer_questions`.
            VStack(alignment: .leading, spacing: 4) {
                Label(L10n.t("Ask the owner to allow answering questions from this Mac"), systemImage: "lock")
                    .font(KS.text(.semibold)).foregroundStyle(KS.needsYouText)
                Text(verbatim: TeamsSetup.grantCommand).font(KS.meta())
                    .textSelection(.enabled).foregroundStyle(KS.textMuted)
            }
        }
    }

    /// An open approval: what will happen, the exact command or text, where, then Approve / Deny.
    @ViewBuilder private func approval(_ action: TeamsQuestion.Action) -> some View {
        HStack {
            KSLabel(L10n.t("Waiting for your approval"))
            Spacer()
            KSChip(Self.kindLabel(action.kind), fill: KS.needsYouTint, ink: KS.needsYouText)
        }
        Text(verbatim: action.summary.isEmpty ? question.prompt : action.summary).font(KS.section()).textSelection(.enabled)
        if !action.summary.isEmpty, question.prompt != action.summary, !question.prompt.isEmpty {
            Text(verbatim: question.prompt).font(KS.text()).foregroundStyle(KS.textMuted)
        }
        if !action.detail.isEmpty {
            ScrollView {
                Text(verbatim: action.detail).font(KS.meta()).foregroundStyle(KS.ink)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { detailHeight = $0 }
            }
            .frame(height: min(detailHeight, 8 * 16 + 20)) // about eight lines, then it scrolls
            .background(KS.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        if let place = action.where {
            Text(verbatim: L10n.t("Where: \(place)")).font(KS.secondary()).foregroundStyle(KS.textMuted).textSelection(.enabled)
        }
        FlowLayout(spacing: 12) {
            ForEach(question.options, id: \.self) { option in
                switch option.lowercased() {
                case "approve": decision(option, .primary, L10n.t("Runs this once"))
                case "deny": decision(option, .danger, L10n.t("The bot won't do this"))
                default: ChipFlow(options: [option], selected: []) { send([$0]) }
                }
            }
        }
        .disabled(sending)
        blockedNote
    }

    private func decision(_ option: String, _ kind: KSButtonStyle.Kind, _ note: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Button(option) { send([option]) }.buttonStyle(.ks(kind))
            Text(verbatim: note).font(KS.secondary()).foregroundStyle(KS.textMuted)
        }
    }

    private func send(_ choices: [String]) {
        sending = true
        Task { _ = await model.answer(question, choices: choices, text: ""); sending = false }
    }

    static func kindLabel(_ kind: TeamsQuestion.Action.Kind) -> String {
        switch kind {
        case .command: L10n.t("Command")
        case .publish: L10n.t("Publish")
        case .send: L10n.t("Send")
        case .deploy: L10n.t("Deploy")
        case .purchase: L10n.t("Purchase")
        case .other: L10n.t("Action")
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
                    Text(verbatim: option).font(KS.text(.semibold))
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? KS.signal : KS.chip))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(on ? .clear : KS.optionLine, lineWidth: 1))
                        .overlay(alignment: .trailing) {
                            if on { Image(systemName: "checkmark").font(KS.glyph(8, .bold)).padding(.trailing, 3).accessibilityHidden(true) }
                        }
                        .foregroundStyle(on ? KS.onSignal : KS.ink)
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
    @StateObject private var dictation = ChatDictation()
    @State private var mediaError: String?
    @State private var preparingPhotos = false
    @State private var startingDictation = false
    @Environment(\.scenePhase) private var scenePhase
    private var text: Binding<String> {
        Binding(get: { model.drafts[threadID] ?? "" }, set: { model.drafts[threadID] = $0 })
    }
    private var sending: Bool { model.sendingThreads.contains(threadID) }
    /// An open approval holds the thread until you answer it.
    private var paused: Bool {
        model.messages[threadID]?.contains { $0.question?.status == "open" && $0.question?.action != nil } ?? false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let pending = model.rejectedSends[threadID] ?? model.pendingSends[threadID], !sending {
                Text("Unsent: " + pending.body).font(KS.secondary()).lineLimit(3)
                if !pending.photos.isEmpty {
                    Text(verbatim: pending.photos.map(\.name).joined(separator: ", ")).font(KS.secondary()).lineLimit(2)
                }
                if let error = model.sendErrors[threadID] { Text(error).font(KS.secondary()).foregroundStyle(KS.danger) }
                HStack {
                    if model.pendingSends[threadID] != nil {
                        Button("Retry") { send() }
                    }
                    Button("Edit") { model.discardSend(threadID, edit: true) }
                        .disabled(preparingPhotos || startingDictation || dictation.isRecording || pending.photos.count + (model.photoDrafts[threadID]?.count ?? 0) > 2)
                    Button("Discard") { model.discardSend(threadID) }
                }
            }
            if let error = mediaError ?? dictation.error { Text(verbatim: error).font(KS.secondary()).foregroundStyle(KS.danger) }
            if let photos = model.photoDrafts[threadID], !photos.isEmpty {
                HStack {
                    ForEach(photos) { photo in
                        ZStack(alignment: .topTrailing) {
                            Group {
                                if let image = NSImage(data: photo.data) { Image(nsImage: image).resizable().scaledToFill() }
                                else { Image(systemName: "photo").foregroundStyle(KS.textMuted) }
                            }
                            .frame(width: 52, height: 52).background(KS.paper).clipped()
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(KS.hairline, lineWidth: 1))
                            Button { model.photoDrafts[threadID]?.removeAll { $0.id == photo.id } } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).accessibilityLabel(L10n.t("Remove photo"))
                                .foregroundStyle(KS.ink).background(Circle().fill(KS.white))
                                .offset(x: 5, y: -5)
                        }
                        .padding(5)
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
            Button(action: choosePhotos) { Image(systemName: "photo") }
                .buttonStyle(KSBarButtonStyle()).disabled(paused || preparingPhotos || startingDictation || dictation.isRecording || (model.photoDrafts[threadID]?.count ?? 0) >= 2)
                .help(L10n.t("Add photos")).accessibilityLabel(L10n.t("Add photos"))
            Button {
                if dictation.isRecording { dictation.stop() }
                else {
                    let prefix = text.wrappedValue
                    startingDictation = true
                    Task {
                        await dictation.start { transcript in text.wrappedValue = prefix + (prefix.isEmpty ? "" : " ") + transcript }
                        startingDictation = false
                    }
                }
            } label: { Image(systemName: dictation.isRecording ? "stop.fill" : "mic.fill") }
                .buttonStyle(KSBarButtonStyle(on: dictation.isRecording)).disabled((paused && !dictation.isRecording) || startingDictation || preparingPhotos).help(L10n.t("Dictation"))
                .accessibilityLabel(dictation.isRecording ? L10n.t("Stop dictation") : L10n.t("Start dictation"))
            ZStack(alignment: .topLeading) {
                if text.wrappedValue.isEmpty || paused {
                    Text(verbatim: paused ? L10n.t("Answer the approval above to continue")
                         : model.bot(threadID: threadID).map { L10n.t("Message \($0.name) · Return to send") } ?? L10n.t("Message · Return to send, Shift-Return for a new line"))
                        .font(KS.text()).foregroundStyle(KS.textMuted).padding(.horizontal, 5).padding(.vertical, 5)
                        .allowsHitTesting(false)
                }
                TextEditor(text: text)
                    .focused($editorFocused).accessibilityLabel("Message in this thread")
                    .disabled(paused || startingDictation || dictation.isRecording)
                    .opacity(paused ? 0 : 1)
                    .font(KS.text()).foregroundStyle(KS.ink).scrollContentBackground(.hidden)
                    .frame(minHeight: 30, maxHeight: 140).fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 5)
                    // Return sends; Shift-Return is a new line.
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        send()
                        return .handled
                    }
            }
            if let runner = model.bot(threadID: threadID).flatMap({ model.agent(id: $0.leadAgentID)?.runner }) {
                Text(verbatim: runner.label.lowercased()).font(KS.meta()).foregroundStyle(KS.textSoft)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 6).fill(KS.chip))
                    .fixedSize().padding(.bottom, 12)
            }
            Button(action: send) { Image(systemName: "arrow.up").font(KS.glyph(14, .semibold)) }
                .buttonStyle(KSBarButtonStyle(send: true))
                .disabled(paused || sending || preparingPhotos || (model.pendingSends[threadID] == nil && text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (model.photoDrafts[threadID]?.isEmpty ?? true)))
                .padding(.bottom, 5).help(L10n.t("Send")).accessibilityLabel(model.pendingSends[threadID] == nil ? "Send message" : "Retry previous message")
        }
            }
        .padding(.leading, 8).padding(.trailing, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(KS.well))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(KS.optionLine, lineWidth: 1))
        .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 20)
        .background(KS.paper)
        .onDisappear { dictation.stop() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { dictation.stop() } }
        .onChange(of: model.threadIsVisible) { _, visible in if !visible { dictation.stop() } }

    }

    private func send() {
        guard !sending, !paused else { return }
        dictation.stop()
        let target = threadID
        editorFocused = true
        Task { _ = await model.sendDraft(threadID: target) }

    }

    private func choosePhotos() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]; panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        let urls = Array(panel.urls.prefix(max(0, 2 - (model.photoDrafts[threadID]?.count ?? 0))))
        preparingPhotos = true
        mediaError = nil
        Task {
            defer { preparingPhotos = false }
            for url in urls {
                do {
                    let data = try await Task.detached {
                        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 25 * 1024 * 1024 else { throw ChatPhoto.MediaError.tooLarge }
                        return try Data(contentsOf: url, options: .mappedIfSafe)
                    }.value
                    let photo = try await ChatPhoto.prepare(data: data, name: url.lastPathComponent)
                    if (model.photoDrafts[threadID]?.count ?? 0) < 2 {
                        model.photoDrafts[threadID, default: []].append(photo)
                    }
                } catch { mediaError = error.localizedDescription }
            }
        }
    }
}

// MARK: - Swarm detail

struct SwarmDetailView: View {
    @ObservedObject var model: TeamsModel
    let swarmID: String
    @Environment(\.dismiss) private var dismiss
    @State private var contentHeight: CGFloat = 320

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let s = model.swarms[swarmID] {
                HStack {
                    Text(verbatim: s.title).font(KS.title())
                    Spacer()
                    Text(verbatim: "\(s.progress.done)/\(s.progress.total)").font(KS.section())
                }
                Text(verbatim: TeamsCopy.swarmStatus(s.status)).foregroundStyle(KS.textMuted)
                if let goal = s.goal, !goal.isEmpty { Text(verbatim: goal).textSelection(.enabled) }
                Divider()
                let lines = HandoverStatus.lines(for: s, name: HandoverStatus.names(model))
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        HandoverMap(model: model, swarm: s)
                        Divider()
                        ForEach(s.steps) { SwarmStepRow(model: model, step: $0, line: lines[$0.id], showsCheck: true) }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                }
                .frame(height: min(contentHeight, 560))
            } else if let error = model.swarmErrors[swarmID] {
                Text(error)
                Button("Retry") { Task { await model.loadSwarm(swarmID) } }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            HStack { Spacer(); Button(L10n.t("Done")) { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20).frame(minWidth: 640, idealWidth: 760, maxWidth: 960)
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
