import SwiftUI
import UIKit

/// A bot's character (the Mac's KSMoji), tinted to the bot's colour.
struct MojiAvatar: View {
    var seed: String
    var size: CGFloat = 34
    var colorHex: UInt32?
    var body: some View {
        let kind = mojiCharacter(seed)
        Group {
            if let image = UIImage(named: "moji-" + kind) { Image(uiImage: image).resizable().interpolation(.high).scaledToFit() }
            else { Circle().fill(KS.chip) }
        }
        .frame(width: size, height: size)
        .hueRotation(.degrees(colorHex.map { mojiHueShift(kind, toHex: $0) } ?? 0))
        .accessibilityHidden(true)
    }
}

/// An 8 pt status dot with a soft halo when it is live.
struct StatusDot: View {
    enum State { case needsYou, running, done, idle }
    let state: State
    var color: Color {
        switch state { case .needsYou: Color(hex: 0xE0A77A); case .running: KS.signal; case .done: Color(hex: 0xB9C9A2); case .idle: Color(hex: 0x4F6688) }
    }
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
            .background(Circle().fill(color.opacity(state == .needsYou || state == .running ? 0.2 : 0)).frame(width: 14, height: 14))
            .accessibilityHidden(true)
    }
}

/// "11:57" today, "2d" / "1w" before (the Mac's clock).
func shortClock(_ value: String, now: Date = Date()) -> String {
    guard let date = isoDate(value) else { return "" }
    if Calendar.current.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
    let days = max(1, Int(now.timeIntervalSince(date) / 86_400))
    return days < 7 ? "\(days)d" : days < 60 ? "\(days / 7)w" : "\(days / 30)mo"
}

/// The Mac window's top bar tone.
extension KS { static let topBar = Color(hex: 0x0F1F38) }

enum BotTab: String, CaseIterable { case thread = "Thread", timeline = "Timeline", logs = "Logs" }

extension AppModel {
    func leadProvider(_ bot: Bot) -> String {
        agents.first { $0["id"].string == bot.raw["lead_agent_id"].string }?["runner"]["provider"].string ?? ""
    }
    func isRunning(_ bot: Bot) -> Bool {
        let live = ["running", "queued", "claimed"]
        if tasks.contains(where: { $0["bot_id"].string == bot.id && live.contains($0["status"].string) && !$0["resolved"].bool }) { return true }
        guard openBot?.id == bot.id else { return false }
        return !typing.isEmpty || taskCards(messages).contains { live.contains($0.card["status"].string) }
            || followedSwarm(messages)?.swarm["status"].string == "running"
    }
    func dot(_ bot: Bot) -> StatusDot.State {
        bot.needsYou > 0 ? .needsYou : isRunning(bot) ? .running : bot.unread > 0 ? .done : .idle
    }
    /// Open questions in the open thread, newest state per question.
    var openQuestions: [JSON] {
        var seen: [String: JSON] = [:], order: [String] = []
        for m in messages where m.kind == "question" {
            let q = m.question, id = q["id"].string
            if seen[id] == nil { order.append(id) }
            seen[id] = q
        }
        return order.compactMap { seen[$0] }.filter { $0["status"].string == "open" }
    }
}

/// Regular width (iPad full screen, or a wide window): the Mac main window's three columns.
/// Compact width never builds this; RootView keeps the iPhone stack there.
struct IPadWorkspace<ThreadBody: View, TasksBody: View, UsageBody: View>: View {
    @Bindable var model: AppModel
    @Binding var screen: Screen
    @Binding var sheet: Sheet?
    @Binding var search: String
    var open: (Bot) -> Void
    @ViewBuilder var threadBody: () -> ThreadBody
    @ViewBuilder var tasksBody: () -> TasksBody
    @ViewBuilder var usageBody: () -> UsageBody
    @State private var tab = BotTab.thread
    @State private var showMap = false
    @State private var monitor = false
    @FocusState private var searchFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The Mac's panes. Which one shows follows `screen`, so a task row that opens a bot lands back on Bots.
    enum Pane { case bots, tasks, usage }
    private var pane: Pane { screen == .tasks ? .tasks : screen == .usage ? .usage : .bots }
    private func show(_ p: Pane) {
        switch p {
        case .bots: screen = model.openBot == nil ? .home : .thread
        case .tasks: screen = .tasks; Task { try? await model.loadTasks() }
        case .usage: screen = .usage
        }
    }

    var body: some View {
        Group {
            if monitor {
                SwarmMapPanel(model: model, monitor: true, expand: {}, close: { monitor = false })
            } else {
                // No system navigation bars: one top bar across the window, then the Mac's columns.
                GeometryReader { g in
                    VStack(spacing: 0) {
                        topBar(width: g.size.width)
                        switch pane {
                        case .bots:
                            HStack(spacing: 0) {
                                sidebar.frame(width: g.size.width < 1100 ? 240 : 300)
                                    .overlay(alignment: .trailing) { Rectangle().fill(KS.hairline).frame(width: 1) }
                                detail
                            }
                        case .tasks: tasksBody().padding(.top, 12).frame(maxWidth: .infinity, maxHeight: .infinity)
                        case .usage: usageBody().padding(.top, 12).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            }
        }
        .background(KS.ground)
        .task { if !model.isDemo { try? await model.loadTasks() } }
        .background { shortcuts }
        .onChange(of: search) { _, q in if !q.isEmpty && pane != .bots { show(.bots) } }
    }

    /// Hardware keyboard: ⌘K search, ⌘1/2/3 tabs, ⌘⇧M map.
    private var shortcuts: some View {
        Group {
            Button("Search bots") { searchFocused = true }.keyboardShortcut("k", modifiers: .command)
            ForEach(Array(BotTab.allCases.enumerated()), id: \.offset) { i, t in
                Button(t.rawValue) { tab = t }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
            }
            Button("Swarm map") { showMap.toggle() }.keyboardShortcut("m", modifiers: [.command, .shift])
        }.opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }

    // MARK: Top bar (the Mac's WorkspaceTopBar)

    private var trail: [String] {
        switch pane {
        case .bots: return ["bots"] + (model.openBot.map { [$0.name] } ?? [])
        case .tasks: return ["tasks"]
        case .usage: return ["usage"]
        }
    }
    private func breadcrumb(_ parts: [String]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(parts.enumerated()), id: \.offset) { i, part in
                if i > 0 { Text("/").foregroundStyle(Color(hex: 0x4F6688)) }
                Text(part).font(KS.body(i == 0 && part == "swarmaa" ? .semibold : .regular))
                    .foregroundStyle(part == "swarmaa" || i == parts.count - 1 ? KS.strong : KS.soft)
            }
        }.lineLimit(1).fixedSize()
    }
    private func topBar(width: CGFloat) -> some View {
        HStack(spacing: 16) {
            // Full trail, then just the last part, then nothing: never wraps.
            ViewThatFits(in: .horizontal) {
                breadcrumb(["swarmaa"] + trail)
                breadcrumb([trail.last ?? "swarmaa"])
                Color.clear.frame(width: 0, height: 0)
            }
            .accessibilityElement(children: .combine).accessibilityLabel("Breadcrumb: swarmaa, " + trail.joined(separator: ", "))
            panes.layoutPriority(2)
            Spacer(minLength: 8)
            searchField.frame(minWidth: 140, idealWidth: 280, maxWidth: 300).layoutPriority(1)
            if width >= 900, !workerProviders.isEmpty {
                HStack(spacing: -7) {
                    ForEach(workerProviders, id: \.self) { Avatar(name: $0, size: 28, provider: $0).overlay(Circle().strokeBorder(KS.topBar, lineWidth: 2)) }
                }.fixedSize().accessibilityElement(children: .ignore)
                    .accessibilityLabel("Agents online: " + workerProviders.map(vendorName).joined(separator: ", "))
            }
            barButton("point.3.connected.trianglepath.dotted", showMap ? "Hide swarm map" : "Show swarm map", on: showMap) {
                withAnimation(reduceMotion ? nil : KS.glide) { showMap.toggle() }
            }.accessibilityIdentifier("toggle-swarm-map")
            barButton("gearshape", "Settings", on: false) { sheet = .you }
            Button { sheet = .newBot } label: {
                Text(width >= 760 ? "+ New bot" : "+").font(KS.body(.semibold)).foregroundStyle(KS.onSignal)
                    .padding(.horizontal, 16).frame(height: 36)
                    .background(KS.signal, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(PressStyle()).fixedSize().accessibilityLabel("New bot").accessibilityIdentifier("ipad-new-bot")
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 56, maxHeight: 56)
        // The bar's colour runs up under the status bar.
        .background(KS.topBar.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
    }
    /// Bots · Tasks · Usage, the Bots segment carrying how many bots have updates.
    private var panes: some View {
        let updates = model.sortedBots.filter { $0.unread > 0 || $0.needsYou > 0 }.count
        return HStack(spacing: 2) {
            ForEach([(Pane.bots, "Bots"), (.tasks, "Tasks"), (.usage, "Usage")], id: \.1) { p, title in
                let on = pane == p, badge = p == .bots ? updates : 0
                Button { show(p) } label: {
                    HStack(spacing: 6) {
                        Text(title).font(KS.body(.medium)).foregroundStyle(on ? KS.strong : KS.muted)
                        if badge > 0 {
                            Text("\(badge)").font(KS.mono(.semibold)).foregroundStyle(KS.onSignal).padding(.horizontal, 6).frame(minHeight: 18).background(KS.signal, in: Capsule())
                        }
                    }
                    .padding(.horizontal, 12).frame(height: 30)
                    .background(on ? KS.mine : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel(badge > 0 ? title + ", \(badge) with updates" : title)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("pane-" + title.lowercased())
            }
        }
        .padding(.horizontal, 3).frame(height: 38)
        .background(KS.inset, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(KS.hairline, lineWidth: 1).allowsHitTesting(false))
        .fixedSize()
    }
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .semibold)).foregroundStyle(KS.muted)
            TextField("", text: $search, prompt: Text("Search bots").foregroundStyle(KS.muted)).font(KS.body()).foregroundStyle(KS.ink)
                .focused($searchFocused).accessibilityLabel("Search bots").submitLabel(.search)
            if search.isEmpty {
                Text("⌘K").font(KS.mono()).foregroundStyle(KS.soft).padding(.horizontal, 6).padding(.vertical, 1)
                    .background(KS.chip, in: RoundedRectangle(cornerRadius: 6)).accessibilityHidden(true)
            } else {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(KS.muted).frame(minWidth: 32, minHeight: 36) }
                    .buttonStyle(PressStyle()).accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, 12).padding(.trailing, 8).frame(height: 36)
        .background(KS.inset, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(searchFocused ? KS.signal.opacity(0.7) : KS.hairline, lineWidth: 1).allowsHitTesting(false))
        .frame(minHeight: 44).contentShape(Rectangle()).onTapGesture { searchFocused = true }
    }
    private func barButton(_ symbol: String, _ label: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(on ? KS.onSignal : KS.soft)
                .frame(width: 36, height: 36).background(on ? KS.signal : KS.chip.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }.buttonStyle(PressStyle()).fixedSize().accessibilityLabel(label).accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: Sidebar

    private func matches(_ bot: Bot) -> Bool { search.isEmpty || (bot.name + " " + bot.job).localizedCaseInsensitiveContains(search) }

    private var sidebar: some View {
        let bots = model.sortedBots.filter(matches), hidden = model.hiddenBots.filter(matches)
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Eyebrow("Bots")
                Spacer()
                Text("\(model.sortedBots.count)").font(KS.secondary(.medium)).foregroundStyle(KS.soft).padding(.horizontal, 8).background(KS.chip, in: Capsule())
            }.padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 6)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(bots) { row($0) }
                    if !hidden.isEmpty {
                        Button { withAnimation(reduceMotion ? nil : KS.glide) { model.showHidden.toggle() } } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).rotationEffect(.degrees(model.showHidden ? 90 : 0))
                                Eyebrow("Hidden · \(hidden.count)"); Spacer()
                            }.foregroundStyle(KS.muted).frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(PressStyle()).padding(.horizontal, 8).accessibilityLabel("Hidden bots, \(hidden.count)")
                        if model.showHidden { ForEach(hidden) { row($0) } }
                    }
                    if bots.isEmpty && hidden.isEmpty && !model.loading {
                        Text(search.isEmpty ? "No bots yet. Make one with New bot." : "No bots match “\(search)”.")
                            .font(KS.body()).foregroundStyle(KS.muted).padding(12)
                    }
                }.padding(.horizontal, 10)
            }
            VStack(alignment: .leading, spacing: 18) {
                agentsSection
                quotaSection
            }.padding(.horizontal, 12).padding(.vertical, 16)
        }
        .background(KS.grouped)
    }

    private func row(_ bot: Bot) -> some View {
        let selected = model.openBot?.id == bot.id
        let lead = model.leadProvider(bot)
        let state = bot.needsYou > 0 ? "Needs you" : model.isRunning(bot) ? "Running" : bot.unread > 0 ? "\(bot.unread) new" : "Idle"
        return Button { open(bot) } label: {
            HStack(spacing: 12) {
                MojiAvatar(seed: bot.avatarSeed, size: 34, colorHex: bot.colorHex)
                    .overlay(alignment: .bottomTrailing) { StatusDot(state: model.dot(bot)).padding(2).background(KS.grouped, in: Circle()).offset(x: 3, y: 3) }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(bot.name).font(KS.body(.semibold)).foregroundStyle(KS.strong).lineLimit(1)
                        if bot.starred { Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(KS.needsText) }
                        Spacer(minLength: 2)
                        if bot.unread > 0, bot.needsYou == 0 {
                            Text("\(bot.unread)").font(KS.mono(.semibold)).foregroundStyle(KS.onSignal).padding(.horizontal, 6).frame(minHeight: 18).background(KS.signal, in: Capsule())
                        } else { Text(shortClock(bot.activity)).font(KS.mono()).foregroundStyle(KS.muted).lineLimit(1) }
                    }
                    Text((lead.isEmpty ? "Bot" : vendorName(lead)) + " · " + state).font(KS.secondary())
                        .foregroundStyle(bot.needsYou > 0 ? KS.needsText.opacity(0.85) : KS.muted).lineLimit(1)
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? KS.mine : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(alignment: .leading) { if selected { RoundedRectangle(cornerRadius: 1).fill(KS.signal).frame(width: 2).padding(.vertical, 4) } }
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(PressStyle()).opacity(bot.archived ? 0.55 : 1)
        .accessibilityLabel((bot.archived ? "Hidden, " : "") + bot.name + ", " + (lead.isEmpty ? "" : vendorName(lead) + ", ") + state)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("ipad-bot-" + bot.id)
        .contextMenu { Button("Bot settings") { open(bot); screen = .settings } }
    }

    /// The live providers on the host's workers, each once, in a stable order.
    private var workerProviders: [String] {
        let order = ["claude", "codex", "antigravity"]
        let all = Set(model.status["workers"].array.flatMap { $0["providers"].array.map(\.string) }.filter { !$0.isEmpty })
        return all.sorted { (order.firstIndex(of: $0) ?? 9, $0) < (order.firstIndex(of: $1) ?? 9, $1) }
    }

    private var agentsSection: some View {
        let workers = model.status["workers"].array
        let live = Set(workers.filter { $0["live"].bool }.flatMap { $0["providers"].array.map(\.string) })
        return VStack(alignment: .leading, spacing: 4) {
            Eyebrow("Agents").padding(.leading, 6).padding(.bottom, 4)
            if workerProviders.isEmpty { Text("No workers connected").font(KS.secondary()).foregroundStyle(KS.muted).padding(.horizontal, 6) }
            ForEach(workerProviders, id: \.self) { p in
                let n = workers.filter { $0["providers"].array.first?.string == p }.reduce(0) { $0 + $1["running"].array.count }
                HStack(spacing: 10) {
                    Avatar(name: p, size: 24, provider: p)
                    Text(vendorName(p)).font(KS.body()).foregroundStyle(KS.soft)
                    Spacer()
                    Text(n > 0 ? "\(n) running" : live.contains(p) ? "idle" : "offline").font(KS.mono()).foregroundStyle(n > 0 ? KS.signal : KS.muted)
                }.padding(.horizontal, 6).accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private var quotaSection: some View {
        let usage = model.status["usage"].array
        if !usage.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow("Quota · 5 h").padding(.leading, 6)
                ForEach(Array(usage.enumerated()), id: \.offset) { _, u in
                    let provider = u["provider"].string
                    let window = u["windows"].array.first { $0["name"].string.replacingOccurrences(of: " ", with: "") == "5h" } ?? u["windows"].array.first
                    let used = min(max(window?["used_percent"].number ?? 0, 0), 100)
                    Button { show(.usage) } label: {
                        VStack(spacing: 5) {
                            HStack { Text(vendorName(provider)); Spacer(); Text(window?["used_percent"].number.map { "\(Int($0))%" } ?? "—") }
                                .font(KS.mono()).foregroundStyle(KS.soft)
                            GeometryReader { g in
                                ZStack(alignment: .leading) { Capsule().fill(KS.chip); Capsule().fill(KS.tint(provider)).frame(width: g.size.width * used / 100) }
                            }.frame(height: 4)
                        }.padding(.horizontal, 6).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityLabel(vendorName(provider) + ", \(Int(used)) percent used in 5 hours").accessibilityHint("Opens Usage")
                }
            }
        }
    }

    // MARK: Detail

    private var detail: some View {
        GeometryReader { g in
            // The centre keeps at least ~480 pt (the bot header fits); when the map and the inspector don't both fit,
            // the map takes the inspector's place.
            let inspector = !showMap || g.size.width >= 480 + 320 + 340
            HStack(spacing: 0) {
                content.frame(maxWidth: .infinity)
                if inspector, let bot = model.openBot {
                    IPadInspector(model: model, bot: bot, sheet: $sheet) { tab = .thread }
                        .frame(width: 320)
                        .overlay(alignment: .leading) { Rectangle().fill(KS.hairline).frame(width: 1) }
                }
                if showMap {
                    SwarmMapPanel(model: model, expand: { monitor = true }, close: { showMap = false })
                        .frame(width: 340)
                        .overlay(alignment: .leading) { Rectangle().fill(KS.hairline).frame(width: 1) }
                        .transition(.move(edge: .trailing))
                }
            }
        }
        .background(KS.ground)
    }

    @ViewBuilder private var content: some View {
        if let bot = model.openBot {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    IPadBotHeader(model: model, bot: bot, settings: { screen = .settings })
                    if let s = followedSwarm(model.messages)?.swarm, !["done", "cancelled"].contains(s["status"].string) {
                        let total = s["progress"]["total"] == .null ? swarmSteps(s).count : s["progress"]["total"].int
                        let done = s["progress"]["done"] == .null ? swarmSteps(s).filter { $0["status"].string == "done" }.count : s["progress"]["done"].int
                        if total > 0 {
                            GeometryReader { g in
                                ZStack(alignment: .leading) { Capsule().fill(KS.chip); Capsule().fill(KS.signal).frame(width: g.size.width * min(1, Double(done) / Double(total))) }
                            }.frame(height: 5).padding(.top, 16)
                                .accessibilityElement().accessibilityLabel("\(done) of \(total) steps done")
                        }
                    }
                    tabs
                }.padding(.horizontal, 24).padding(.top, 20)
                switch tab {
                case .thread: threadBody()
                case .timeline: IPadTimeline(model: model)
                case .logs: IPadLogs(model: model)
                }
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 30, weight: .light)).accessibilityHidden(true)
                Text(model.sortedBots.isEmpty ? "Make your first bot with New bot." : "Choose a bot to see its thread.").font(KS.body())
                if model.sortedBots.isEmpty { Button("New bot") { sheet = .newBot }.buttonStyle(Pill(fill: KS.signal)) }
            }.foregroundStyle(KS.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var tabs: some View {
        HStack(spacing: 4) {
            ForEach(Array(BotTab.allCases.enumerated()), id: \.offset) { i, t in
                let on = tab == t
                Button { tab = t } label: {
                    Text(t.rawValue).font(KS.body(.semibold)).foregroundStyle(on ? KS.strong : KS.muted)
                        .padding(.horizontal, 16).frame(minHeight: 36)
                        .background(on ? KS.chip : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityHint("Command \(i + 1)")
                .accessibilityIdentifier("tab-" + t.rawValue.lowercased())
            }
            Spacer()
        }
        .padding(.top, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
    }
}

/// The Mac bot header: character, name with its menu, meta line; status pill, star and bot settings on the right.
private struct IPadBotHeader: View {
    @Bindable var model: AppModel
    let bot: Bot
    var settings: () -> Void
    @State private var saving = false
    private var meta: String {
        var parts = [bot.scope.replacingOccurrences(of: "project:", with: "")].filter { !$0.isEmpty }
        if let (swarm, at) = followedSwarm(model.messages) {
            parts.append(swarm["title"].string.isEmpty ? "Swarm" : swarm["title"].string)
            parts.append("swarm of \(swarmSteps(swarm).count) steps")
            if !at.isEmpty { parts.append("started " + shortClock(at)) }
        } else if !bot.job.isEmpty { parts.append(bot.job) }
        return parts.joined(separator: " · ")
    }
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    MojiAvatar(seed: bot.avatarSeed, size: 34, colorHex: bot.colorHex)
                    Text(bot.name).font(.system(.title, design: .default, weight: .semibold)).foregroundStyle(Color(hex: 0xF6F8FC)).lineLimit(1)
                        .accessibilityAddTraits(.isHeader)
                    menu
                }
                Text(meta).font(KS.body()).foregroundStyle(KS.muted).lineLimit(1).truncationMode(.middle)
            }.layoutPriority(1)
            Spacer(minLength: 8)
            pill
            iconButton(bot.starred ? "star.fill" : "star", bot.starred ? "Unstar" : "Star", on: bot.starred) { setStar(!bot.starred) }
                .disabled(saving || bot.archived || model.isDemo)
            iconButton("slider.horizontal.3", "Bot settings", on: false, settings)
        }
    }
    private var menu: some View {
        Menu {
            Button("Bot settings", action: settings)
            Button(bot.starred ? "Unstar" : "Star") { setStar(!bot.starred) }.disabled(saving || bot.archived || model.isDemo)
            Button("Earlier messages") { Task { do { try await model.olderMessages() } catch { model.error = safeError(error) } } }
            Divider()
            Button("Hide bot", role: .destructive) { Task { do { try await model.archive(bot) } catch { model.error = safeError(error) } } }
                .disabled(bot.archived || model.isDemo)
        } label: {
            Image(systemName: "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(KS.muted)
                .frame(width: 32, height: 44).contentShape(Rectangle())
        }.accessibilityLabel("Bot menu, " + bot.name)
    }
    private func setStar(_ on: Bool) {
        saving = true
        var draft = bot; draft.raw["starred"] = .bool(on)
        Task { defer { saving = false }; do { try await model.save(draft) } catch { model.error = safeError(error) } }
    }
    private func iconButton(_ symbol: String, _ label: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(on ? KS.needsText : KS.soft)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }.buttonStyle(PressStyle(icon: true)).accessibilityLabel(label).accessibilityAddTraits(on ? .isSelected : [])
    }
    @ViewBuilder private var pill: some View {
        let needs = max(bot.needsYou, model.openQuestions.count)
        let running = model.isRunning(bot)
        let (text, ink, fill): (String, Color, Color) = needs > 0 ? (needs > 1 ? "\(needs) need you" : "Needs you", KS.needsText, KS.needsTint)
            : running ? ("Running", KS.signal, KS.signalTint) : ("Idle", KS.muted, KS.chip)
        HStack(spacing: 8) { Circle().fill(ink).frame(width: 7, height: 7); Text(text).font(KS.secondary(.semibold)) }
            .foregroundStyle(ink).padding(.horizontal, 12).frame(minHeight: 26).background(fill, in: Capsule()).fixedSize().padding(.top, 9)
            .accessibilityElement(children: .combine)
    }
}

private func stateIcon(_ state: String) -> some View {
    let (symbol, color, label): (String, Color, String) = switch state {
    case "done", "completed": ("checkmark", KS.readyText, "Done")
    case "waiting_on_you": ("pause.fill", KS.needsText, "Waiting on you")
    case "failed", "blocked", "cancelled": ("xmark", KS.failedText, state.capitalized)
    case "running", "claimed": ("ellipsis", KS.signal, "Running")
    default: ("circle.dotted", KS.muted, "Pending")
    }
    return Image(systemName: symbol).font(.system(size: 11, weight: .bold)).foregroundStyle(color)
        .frame(width: 28, height: 28).background(color.opacity(0.18), in: Circle()).accessibilityLabel(label)
}
private func chip(_ text: String, ink: Color, fill: Color) -> some View {
    Text(text).font(KS.mono(.medium)).foregroundStyle(ink).lineLimit(1).padding(.horizontal, 7).frame(minHeight: 20).background(fill, in: RoundedRectangle(cornerRadius: 6))
}

/// The bot's swarm steps, then its other tasks, newest first.
private struct IPadTimeline: View {
    @Bindable var model: AppModel
    struct Row: Identifiable { let id, state, title, provider, branch, detail, trailing: String }
    private var rows: (swarm: [Row], tasks: [Row], title: String) {
        let cards = taskCards(model.messages)
        let byID = Dictionary(cards.map { ($0.card["id"].string, $0) }, uniquingKeysWith: { _, b in b })
        var used = Set<String>(), steps: [Row] = [], title = ""
        if let swarm = followedSwarm(model.messages)?.swarm {
            title = swarm["title"].string.isEmpty ? "Swarm" : swarm["title"].string
            let all = swarmSteps(swarm)
            for step in all {
                let taskID = step["task_id"].string, card = byID[taskID]
                used.insert(taskID)
                let agent = model.agents.first { $0["id"].string == step["assignee_agent_id"].string }
                let provider = card?.card["served"]["provider"].string ?? agent?["runner"]["provider"].string ?? ""
                var detail: [String] = []
                if let w = waitingLine(step, in: all, agents: model.agents) { detail.append(w) }
                else if let name = agent?["name"].string { detail.append(name) }
                if let n = card?.card["changed_files"].number { detail.append(Int(n) == 1 ? "1 file" : "\(Int(n)) files") }
                if !step["check"].string.isEmpty { detail.append("done when: " + step["check"].string) }
                steps.append(Row(id: step["id"].string, state: step["status"].string, title: step["title"].string, provider: provider,
                                 branch: card?.card["branch"].string ?? "", detail: detail.joined(separator: " · "), trailing: shortClock(card?.at ?? "")))
            }
        }
        let tasks = cards.filter { !used.contains($0.card["id"].string) }.reversed().map { c -> Row in
            let t = c.card, failed = t["status"].string == "failed"
            var detail: [String] = []
            if t["resolved"].bool { detail.append("resolved") }
            if let n = t["changed_files"].number { detail.append(Int(n) == 1 ? "1 file" : "\(Int(n)) files") }
            if failed, !t["failure"]["code"].string.isEmpty { detail.append(t["failure"]["code"].string) }
            return Row(id: t["id"].string, state: t["status"].string == "completed" ? "done" : t["status"].string, title: t["title"].string.isEmpty ? "Task" : t["title"].string,
                       provider: t["served"]["provider"].string, branch: t["branch"].string, detail: detail.joined(separator: " · "), trailing: shortClock(c.at))
        }
        return (steps, Array(tasks), title)
    }
    var body: some View {
        let r = rows
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if r.swarm.isEmpty && r.tasks.isEmpty {
                    Text("No steps yet. A swarm’s steps and the bot’s tasks appear here as it works.").font(KS.body()).foregroundStyle(KS.muted).padding(.vertical, 24)
                }
                if !r.swarm.isEmpty { Eyebrow(r.title).padding(.top, 16).padding(.bottom, 2); ForEach(r.swarm) { row($0) } }
                if !r.tasks.isEmpty { Eyebrow("Tasks").padding(.top, 20).padding(.bottom, 2); ForEach(r.tasks) { row($0) } }
            }.padding(.horizontal, 24).padding(.bottom, 24).frame(maxWidth: .infinity, alignment: .leading)
        }.accessibilityIdentifier("ipad-timeline")
    }
    private func row(_ r: Row) -> some View {
        HStack(alignment: .top, spacing: 14) {
            stateIcon(r.state)
            VStack(alignment: .leading, spacing: 4) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { title(r); chips(r) }
                    VStack(alignment: .leading, spacing: 4) { title(r); HStack(spacing: 6) { chips(r) } }
                }
                if !r.detail.isEmpty { Text(r.detail).font(KS.secondary()).foregroundStyle(KS.muted).lineLimit(3) }
            }
            Spacer(minLength: 8)
            Text(r.trailing).font(KS.mono()).foregroundStyle(KS.muted).padding(.top, 4)
        }.padding(.vertical, 12).accessibilityElement(children: .combine)
    }
    private func title(_ r: Row) -> some View { Text(r.title).font(KS.body(.semibold)).foregroundStyle(KS.strong).lineLimit(2) }
    @ViewBuilder private func chips(_ r: Row) -> some View {
        if !r.provider.isEmpty { chip(r.provider, ink: KS.tint(r.provider), fill: KS.tint(r.provider).opacity(0.16)) }
        if !r.branch.isEmpty { chip(r.branch, ink: KS.soft, fill: Color(hex: 0x16294A)).textSelection(.enabled) }
    }
}

/// Every thread event, one monospaced line each.
private struct IPadLogs: View {
    @Bindable var model: AppModel
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                if model.messages.isEmpty { Text("No events yet").font(KS.body()).foregroundStyle(KS.muted).padding(.vertical, 24) }
                ForEach(model.messages) { m in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(isoDate(m.raw["created_at"].string).map { $0.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)) } ?? "—")
                            .foregroundStyle(KS.muted).frame(width: 118, alignment: .leading)
                        Text(m.kind).foregroundStyle(color(m)).frame(width: 64, alignment: .leading)
                        Text(m.human ? "you" : m.raw["author"]["name"].string.isEmpty ? m.raw["author"]["kind"].string : m.raw["author"]["name"].string)
                            .foregroundStyle(KS.soft).frame(width: 90, alignment: .leading).lineLimit(1)
                        Text(line(m)).foregroundStyle(KS.ink).lineLimit(1).truncationMode(.tail)
                    }.font(KS.mono()).textSelection(.enabled)
                }
            }.padding(.horizontal, 24).padding(.vertical, 16).frame(maxWidth: .infinity, alignment: .leading)
        }.defaultScrollAnchor(.bottom).accessibilityIdentifier("ipad-logs")
    }
    private func line(_ m: Message) -> String {
        if m.kind == "task" {
            let t = m.raw["task"]
            return [t["title"].string, t["status"].string, t["branch"].string, t["changed_files"].number.map { "\(Int($0)) files" } ?? ""].filter { !$0.isEmpty }.joined(separator: "  ")
        }
        if m.kind == "question" { return m.question["prompt"].string }
        if m.kind == "swarm" { return m.raw["swarm"]["title"].string + "  " + m.raw["swarm"]["status"].string }
        return m.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    }
    private func color(_ m: Message) -> Color {
        if m.kind == "task" && m.raw["task"]["status"].string == "failed" { return KS.failedText }
        switch m.kind { case "task", "run": return KS.readyText; case "swarm": return KS.signal; case "question": return KS.needsText; default: return KS.muted }
    }
}

/// The right column: Needs you, Made by this bot, Tokens per provider.
private struct IPadInspector: View {
    @Bindable var model: AppModel
    let bot: Bot
    @Binding var sheet: Sheet?
    var showThread: () -> Void
    @State private var busy = Set<String>()
    @State private var copied: String?
    @State private var tokens: [String: Int] = [:]
    @State private var counting = false

    /// Tasks that wait on you: ready for review, or failed, and not yet resolved. Newest first.
    private var waitingTasks: [JSON] {
        taskCards(model.messages).map(\.card).filter { !$0["resolved"].bool && ["completed", "failed"].contains($0["status"].string) }.reversed()
    }
    private var finished: [(id: String, provider: String, card: JSON)] {
        taskCards(model.messages).compactMap { c in
            ["completed", "failed", "done"].contains(c.card["status"].string) ? (c.card["id"].string, c.card["served"]["provider"].string.isEmpty ? "other" : c.card["served"]["provider"].string, c.card) : nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { needsYou; madeBy; tokenCard }.padding(16)
        }
        .background(KS.grouped)
        .task(id: finished.map(\.id)) {
            counting = true
            var sum: [String: Int] = [:]
            for job in finished.prefix(40) { if let n = await TaskTokens.lookup(model, id: job.id, card: job.card) { sum[job.provider, default: 0] += n } }
            tokens = sum; counting = false
        }
    }

    @ViewBuilder private var needsYou: some View {
        let questions = model.openQuestions, tasks = waitingTasks
        let count = questions.count + tasks.count
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("Needs you" + (count == 0 ? "" : " · \(count)"), color: count == 0 ? KS.muted : KS.needsText).padding(.bottom, 12)
            if let q = questions.first {
                question(q)
                ForEach(Array(questions.dropFirst().prefix(3).enumerated()), id: \.offset) { _, more in
                    Button { open(more) } label: {
                        Text("› " + more["prompt"].string).font(KS.secondary()).foregroundStyle(KS.soft).lineLimit(1).frame(maxWidth: .infinity, minHeight: 32, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(PressStyle())
                }
            }
            if !tasks.isEmpty {
                if !questions.isEmpty { Rectangle().fill(KS.hairline).frame(height: 1).padding(.vertical, 14) }
                ForEach(Array(tasks.prefix(3).enumerated()), id: \.offset) { i, t in
                    if i > 0 { Rectangle().fill(KS.hairline).frame(height: 1).padding(.vertical, 12) }
                    taskItem(t)
                }
                if tasks.count > 3 { Text("\(tasks.count - 3) more in Timeline").font(KS.secondary()).foregroundStyle(KS.muted).padding(.top, 8) }
            }
            if count == 0 { Text("No open questions").font(KS.body()).foregroundStyle(KS.muted) }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(KS.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(count == 0 ? KS.hairline : Color(hex: 0xE0A77A).opacity(0.5), lineWidth: 1))
    }

    @ViewBuilder private func question(_ q: JSON) -> some View {
        let action = ApprovalAction(q)
        Text(action.map { $0.summary.isEmpty ? q["prompt"].string : $0.summary } ?? q["prompt"].string)
            .font(KS.headline()).foregroundStyle(KS.strong).lineLimit(4).fixedSize(horizontal: false, vertical: true)
        if let place = action?.where_, !place.isEmpty { Text(place).font(KS.secondary()).foregroundStyle(KS.muted).padding(.top, 4) }
        let note = action?.detail ?? q["options"].array.map(\.string).joined(separator: " · ")
        if !note.isEmpty {
            Text(note).font(action != nil ? KS.mono() : KS.secondary()).foregroundStyle(KS.soft).lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12).card(KS.inset, radius: 8).padding(.top, 12)
        }
        HStack(spacing: 8) {
            if action != nil {
                ForEach(q["options"].array.map(\.string), id: \.self) { option in
                    Button {
                        let id = q["id"].string
                        busy.insert(id)
                        Task { defer { busy.remove(id) }; do { try await model.answer(q, choice: option) } catch { model.error = safeError(error) } }
                    } label: { Text(option).frame(maxWidth: .infinity) }
                        .buttonStyle(Pill(primary: option == "Approve", danger: option == "Deny"))
                }
            } else {
                Button { open(q) } label: { Text("Answer").frame(maxWidth: .infinity) }.buttonStyle(Pill(fill: KS.signal))
            }
        }.disabled(busy.contains(q["id"].string) || (model.isDemo && action != nil)).padding(.top, 12)
    }
    /// The existing answer flow: the question sheet, with the thread behind it.
    private func open(_ q: JSON) { showThread(); sheet = .question(q) }

    @ViewBuilder private func taskItem(_ t: JSON) -> some View {
        let id = t["id"].string, failed = t["status"].string == "failed", branch = t["branch"].string
        Text(t["title"].string.isEmpty ? "Task" : t["title"].string).font(KS.headline()).foregroundStyle(KS.strong).lineLimit(3)
        Text([failed ? "Failed" : "Ready for review", branch, t["changed_files"].number.map { Int($0) == 1 ? "1 file" : "\(Int($0)) files" } ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
            .font(KS.secondary()).foregroundStyle(failed ? KS.failedText : KS.muted).padding(.top, 4).lineLimit(2)
        VStack(spacing: 8) {
            if !branch.isEmpty && !failed {
                Button {
                    UIPasteboard.general.string = "git log -p " + branch
                    copied = id
                } label: { Text(copied == id ? "Copied" : "Copy review command").frame(maxWidth: .infinity) }
                    .buttonStyle(Pill(fill: KS.signal)).accessibilityHint("Copies git log -p " + branch)
            }
            Button {
                busy.insert(id)
                Task { defer { busy.remove(id) }; do { try await model.resolve(id) } catch { model.error = safeError(error) } }
            } label: { Text(busy.contains(id) ? "Resolving…" : "Mark resolved").frame(maxWidth: .infinity) }
                .buttonStyle(Pill()).accessibilityIdentifier("mark-resolved-" + id)
        }.disabled(busy.contains(id)).padding(.top, 12)
    }

    private func card<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) { Eyebrow(title).padding(.bottom, 12); content() }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading).card()
    }

    private var madeBy: some View {
        var seen = Set<String>()
        let landed = taskCards(model.messages).reversed().filter { !$0.card["branch"].string.isEmpty && seen.insert($0.card["branch"].string).inserted }
        return card("Made by this bot") {
            if landed.isEmpty { Text("Files appear as tasks land").font(KS.body()).foregroundStyle(KS.muted) }
            else {
                VStack(spacing: 6) {
                    ForEach(Array(landed.prefix(8).enumerated()), id: \.offset) { _, c in
                        HStack(spacing: 10) {
                            Text("GIT").font(KS.mono(.semibold)).foregroundStyle(KS.onSignal).frame(width: 30, height: 26)
                                .background(c.card["status"].string == "failed" ? KS.failedText : Color(hex: 0xB9C9A2), in: RoundedRectangle(cornerRadius: 6))
                            Text(c.card["branch"].string).font(KS.mono()).foregroundStyle(KS.ink).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                            Spacer(minLength: 4)
                            if let n = c.card["changed_files"].number { Text(Int(n) == 1 ? "+1 file" : "+\(Int(n)) files").font(KS.mono()).foregroundStyle(KS.muted).fixedSize() }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8).background(Color(hex: 0x0C1A31), in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    private var tokenCard: some View {
        let order = tokens.sorted { $0.value > $1.value }, total = tokens.values.reduce(0, +)
        return card("Tokens · this bot") {
            if total == 0 { Text(counting ? "Counting…" : "Token use appears as tasks finish").font(KS.body()).foregroundStyle(KS.muted) }
            else {
                GeometryReader { g in
                    HStack(spacing: 0) { ForEach(order, id: \.key) { p, n in Rectangle().fill(KS.tint(p)).frame(width: g.size.width * CGFloat(n) / CGFloat(total)) } }
                }.frame(height: 6).clipShape(Capsule()).background(KS.chip, in: Capsule()).accessibilityHidden(true)
                Grid(alignment: .leading, verticalSpacing: 6) {
                    ForEach(order, id: \.key) { p, n in
                        GridRow { Text(vendorName(p)).foregroundStyle(KS.muted); Text(tokenText(n)).font(KS.mono()).foregroundStyle(KS.strong).gridColumnAlignment(.trailing) }
                    }
                    GridRow { Text("Total").foregroundStyle(KS.muted); Text(tokenText(total)).font(KS.mono()).foregroundStyle(KS.strong) }
                }.font(KS.body()).padding(.top, 12)
            }
        }
    }
}
