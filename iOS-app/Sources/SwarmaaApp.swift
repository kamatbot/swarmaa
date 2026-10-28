import SwiftUI
import UIKit
import AppIntents
import UserNotifications

@MainActor enum Runtime {
    static let model = AppModel()
    static var openStarRequested = false
}

struct OpenStarredBotIntent: AppIntent {
    static let title: LocalizedStringResource = "Open starred bot"
    static let description = IntentDescription("Open your starred bot’s thread in Swarmaa.")
    static let openAppWhenRun = true
    @MainActor func perform() async throws -> some IntentResult {
        Runtime.openStarRequested = true
        let model = Runtime.model
        if !model.connected { await model.restore() }
        await model.refresh()
        guard let bot = model.starred else { throw AppFailure.noStar }
        await model.open(bot)
        return .result()
    }
}

struct AskStarredBotIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask starred bot"
    static let description = IntentDescription("Ask your starred bot without opening Swarmaa. Wait up to 30 seconds for its reply.")
    static let openAppWhenRun = false
    @Parameter(title: "Message", requestValueDialog: "What would you like to ask your starred bot?") var message: String
    static var parameterSummary: some ParameterSummary { Summary("Ask starred bot \(\.$message)") }
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let connection = try ConnectionKeychain().load() else { throw AppFailure.unauthorized }
        let service = RelayService(connection: connection)
        do {
            let reply = try await AskStarredBot.run(service: service, message: message)
            await service.transport.disconnect()
            return .result(value: reply, dialog: IntentDialog(stringLiteral: reply))
        } catch { await service.transport.disconnect(); throw error }
    }
}

struct SwarmaaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenStarredBotIntent(), phrases: ["Open my starred bot in \(.applicationName)"], shortTitle: "Open starred bot", systemImageName: "star.bubble")
        AppShortcut(intent: AskStarredBotIntent(), phrases: ["Ask \(.applicationName)"], shortTitle: "Ask starred bot", systemImageName: "bubble.left.and.text.bubble.right")
    }
}

@MainActor final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Runtime.model.onFirstBotList = {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            }
            guard Runtime.model.connected else { return }
            UIApplication.shared.registerForRemoteNotifications()
        }
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await Runtime.model.registerPushToken(deviceToken) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let id = PushNotification.botID(notification.request.content.userInfo)
        return await MainActor.run {
            id != nil && id == Runtime.model.visibleThreadBotID ? [] : [.banner, .sound, .badge]
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        guard let id = PushNotification.botID(response.notification.request.content.userInfo) else { return }
        await MainActor.run { Runtime.model.receivePushTap(["bot_id": id]) }
    }
}

@main struct SwarmaaApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    var body: some Scene {
        WindowGroup { RootView(model: Runtime.model).preferredColorScheme(.light) }
    }
}

// Adapted from Mac-app/Sources/Teams/KS.swift; native condensed type and original Moji art.
enum KS {
    static let ink = Color(hex: 0x15111F), paper = Color(hex: 0xF4EFE6), lime = Color(hex: 0xCFE08A)
    static let coral = Color(hex: 0xE8836B), sage = Color(hex: 0xF1F5E2), coralTint = Color(hex: 0xFBEFE7)
    static let sky = Color(hex: 0xB7CCE8), butter = Color(hex: 0xEAD9A6), lilac = Color(hex: 0xD9CDEE)
    static let soft = Color(hex: 0x3A3347), muted = Color(hex: 0x5A5168)
    static func body(_ size: CGFloat = 16, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight).width(.condensed) }
    static func display(_ size: CGFloat) -> Font { .system(size: size, weight: .black).width(.compressed) }
    static func mono(_ size: CGFloat = 11) -> Font { .system(size: size, weight: .medium, design: .monospaced) }
    static func tint(_ provider: String) -> Color { provider == "claude" ? lime : provider == "codex" ? coral : sky }
}
extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}
extension View {
    func card(_ color: Color = .white, radius: CGFloat = 18, shadow: Bool = false) -> some View {
        background {
            ZStack {
                if shadow { RoundedRectangle(cornerRadius: radius).fill(KS.ink).offset(x: 4, y: 4) }
                RoundedRectangle(cornerRadius: radius).fill(color)
            }
        }.overlay(RoundedRectangle(cornerRadius: radius).stroke(KS.ink, lineWidth: 2.5))
    }
}
struct Pill: ButtonStyle {
    var fill: Color = .white
    var primary = false
    @Environment(\.isEnabled) var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(KS.body(16, .semibold)).foregroundStyle(KS.ink)
            .padding(.horizontal, 14).frame(minHeight: primary ? 54 : 44)
            .frame(maxWidth: primary ? .infinity : nil)
            .card(fill, radius: 28, shadow: primary && !configuration.isPressed)
            .opacity(enabled ? 1 : 0.45)
            .offset(y: configuration.isPressed ? 2 : 0)
    }
}
struct Moji: View {
    var seed: String
    var size: CGFloat = 44
    var mark = false
    var body: some View {
        let kinds = ["lead", "runner", "scout", "navigator", "clerk", "scribe", "badge-sun", "badge-peri", "badge-peach"]
        let hash = seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
        let name = "moji-" + (mark ? "mark" : kinds[Int(hash % UInt32(kinds.count))])
        Group {
            if let path = Bundle.main.path(forResource: name, ofType: "png"), let image = UIImage(contentsOfFile: path) {
                Image(uiImage: image).resizable().scaledToFit()
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}
struct Eyebrow: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text.uppercased()).font(KS.mono()).tracking(1.4).foregroundStyle(KS.muted) }
}
struct CloseButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).frame(width: 44, height: 44).card(.white, radius: 24) }
            .buttonStyle(.plain).accessibilityLabel("Close")
    }
}
struct ContentSheet<Content: View>: View {
    @State private var measured: CGFloat = 1
    var content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        content.fixedSize(horizontal: false, vertical: true).padding(20).padding(.bottom, 12).frame(maxWidth: .infinity).background(KS.paper)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured = $0 }
            .presentationDetents([.height(measured)])
            .presentationDragIndicator(.hidden).presentationCornerRadius(28)
    }
}

enum Screen: String { case home, thread, tasks, usage, connect, settings }
enum Sheet: Identifiable {
    case you, question(JSON), newBot, changes(String)
    var id: String {
        switch self { case .you: "you"; case .question(let q): "question-" + q["id"].string; case .newBot: "newBot"; case .changes: "changes" }
    }
}

struct RootView: View {
    @Bindable var model: AppModel
    @State private var screen: Screen = .home
    @State private var sheet: Sheet?
    @State private var search = ""
    @State private var composer = ""
    @State private var filter = "All"
    @Environment(\.scenePhase) private var phase
    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                if model.connected || model.isDemo {
                    switch screen {
                    case .home: home
                    case .thread: thread.swipeBack { screen = .home; model.openBot = nil }
                    case .tasks: tasks.swipeBack { screen = .home }
                    case .usage: usage.swipeBack { screen = .home }
                    case .connect: ConnectView(model: model) { screen = .home }.swipeBack { screen = .home }
                    case .settings:
                        if let bot = model.openBot ?? model.starred { SettingsView(model: model, bot: bot) { screen = .thread }.swipeBack { screen = .thread } }
                        else { empty("Open a bot to change its settings.") }
                    }
                } else { ConnectView(model: model) { screen = .home } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(KS.paper).foregroundStyle(KS.ink)
            .font(KS.body()).tint(KS.ink)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let error = model.error {
                    HStack { Text(error).font(KS.body(14)); Button("Dismiss") { model.error = nil }.frame(minHeight: 44) }
                        .padding(.horizontal, 20).background(KS.coralTint).accessibilityIdentifier("error")
                }
            }
        }
        .sheet(item: $sheet) { item in
            if case .newBot = item {
                NewBotView(model: model) { sheet = nil }
                    .padding(20).background(KS.paper).foregroundStyle(KS.ink).tint(KS.ink)
                    .presentationDetents([.large]).presentationDragIndicator(.hidden).presentationCornerRadius(28)
            } else { ContentSheet {
                switch item {
                case .you: you
                case .question(let question): AnswerView(model: model, question: question) { sheet = nil }
                case .newBot: NewBotView(model: model) { sheet = nil }
                case .changes(let changes):
                    VStack(alignment: .leading, spacing: 14) {
                        CloseButton { sheet = nil }; Text("CHANGES.").font(KS.display(32))
                        ScrollView { Text(changes).font(KS.mono(12)).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 300)
                    }
                }
            } }
        }
        .task {
            if !ProcessInfo.processInfo.arguments.contains("-demo"), ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil { return }
            if ProcessInfo.processInfo.arguments.contains("-demo") {
                model.loadDemo()
                let args = ProcessInfo.processInfo.arguments
                if let i = args.firstIndex(of: "-screen"), args.indices.contains(i + 1) {
                    let name = args[i + 1]
                    screen = Screen(rawValue: name) ?? (name == "question" ? .thread : .home)
                    if ["you", "question", "newBot"].contains(name) {
                        try? await Task.sleep(for: .milliseconds(200))
                        sheet = name == "question" ? .question(Demo.question) : name == "you" ? .you : .newBot
                    }
                }
            } else { await model.restore() }
            if Runtime.openStarRequested, model.openBot != nil { screen = .thread; Runtime.openStarRequested = false }
        }
        .onChange(of: model.pendingPushBotID) { _, _ in openPushBot() }
        .onChange(of: model.didLoadBots) { _, _ in openPushBot() }
        .onChange(of: model.bots) { _, _ in openPushBot() }
        .onChange(of: screen) { _, _ in updateVisibleThread() }
        .onChange(of: sheet?.id) { _, _ in updateVisibleThread() }
        .onChange(of: model.openBot?.id) { _, _ in updateVisibleThread() }
        .onChange(of: model.openBot?.id) { _, value in if value != nil, Runtime.openStarRequested { screen = .thread; Runtime.openStarRequested = false } }
        .onChange(of: phase) { _, phase in
            guard phase == .active else { return }
            Task { await model.refresh() }
            if Runtime.openStarRequested, model.openBot != nil { screen = .thread; Runtime.openStarRequested = false }
            openPushBot()
        }
    }
    private func updateVisibleThread() {
        model.visibleThreadBotID = screen == .thread && sheet == nil ? model.openBot?.id : nil
    }
    private func openPushBot() {
        guard let bot = model.takePushBot() else { return }
        sheet = nil
        open(bot)
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !model.busy else { return }
        model.busy = true
        Task {
            defer { model.busy = false }
            do { try await action() } catch { model.error = safeError(error) }
        }
    }
    // Switch first, then load: the thread appears at once instead of after a relay round trip.
    private func open(_ bot: Bot) { screen = .thread; Task { await model.open(bot) } }
    private func header(_ title: String, close: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            CloseButton(action: close)
            Text(title.uppercased() + ".").font(KS.display(52)).minimumScaleFactor(0.7).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
    }
    private func empty(_ text: String) -> some View { Text(text).foregroundStyle(KS.muted).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity) }
    private var home: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { sheet = .you } label: { Text("YOU").font(KS.mono(10)).frame(width: 44, height: 44).card(KS.lilac, radius: 24) }.accessibilityLabel("You")
                Circle().fill(model.online ? Color(hex: 0x3F7D20) : KS.coral).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.isDemo ? "MAC STUDIO" : "YOUR MAC").font(KS.mono(10))
                    if !model.online { Text(model.lastSeen.map { "Seen " + $0.formatted(.relative(presentation: .numeric)) } ?? "Offline").font(KS.body(11)) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button { screen = .tasks; perform { try await model.loadTasks() } } label: {
                    Image(systemName: "list.bullet").frame(width: 44, height: 44).card(.white, radius: 24)
                        .overlay(alignment: .topTrailing) {
                            if model.bots.reduce(0, { $0 + $1.needsYou }) > 0 {
                                Text("\(model.bots.reduce(0, { $0 + $1.needsYou }))").font(KS.mono(10)).padding(4).background(KS.coral, in: Circle())
                            }
                        }
                }.accessibilityLabel("Tasks")
                Button { screen = .usage } label: { Image(systemName: "chart.pie").frame(width: 44, height: 44).card(.white, radius: 24) }.accessibilityLabel("Usage")
            }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 8)
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("BOTS.").font(KS.display(44))
                Text("\(model.bots.filter { $0.needsYou > 0 }.count) need you").foregroundStyle(KS.soft)
                Spacer()
            }.padding(.horizontal, 20).padding(.vertical, 16)
            Rectangle().fill(KS.ink).frame(height: 2.5)
            if model.loading { ProgressView("Loading your bots").padding() }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.sortedBots.filter { search.isEmpty || ($0.name + " " + $0.job).localizedCaseInsensitiveContains(search) }) { bot in
                        Button { open(bot) } label: {
                            HStack(spacing: 12) {
                                Moji(seed: bot.raw["lead_agent_id"].string, size: 46)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(bot.name + (bot.starred ? " ★" : "")).font(KS.body(18, .bold))
                                        Spacer()
                                        Text(time(bot.activity)).font(KS.mono(10)).foregroundStyle(KS.muted)
                                    }
                                    HStack {
                                        Text(bot.line.isEmpty ? bot.job : bot.line).lineLimit(1).font(KS.body(15)).foregroundStyle(KS.soft)
                                        Spacer()
                                        if bot.needsYou > 0 || bot.unread > 0 {
                                            Text(bot.needsYou > 0 ? "!" : "\(bot.unread)").font(KS.mono()).padding(.horizontal, 8).frame(minHeight: 22).card(bot.needsYou > 0 ? KS.coral : KS.lime, radius: 14)
                                        }
                                    }
                                }
                            }.padding(.vertical, 14).padding(.horizontal, 4).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("bot-" + bot.id)
                        Divider().overlay(KS.ink.opacity(0.12))
                    }
                    if model.sortedBots.isEmpty && !model.loading { empty("No bots yet. Open You to make your first bot.") }
                }.padding(.horizontal, 16)
            }
            HStack(spacing: 12) {
                HStack { Image(systemName: "magnifyingglass"); TextField("Search bots", text: $search).accessibilityLabel("Search bots") }
                    .padding(.horizontal, 18).frame(height: 54).card(.white, radius: 28, shadow: true)
                if let starred = model.starred {
                    Button { open(starred) } label: {
                        Moji(seed: starred.raw["lead_agent_id"].string, size: 44).frame(width: 54, height: 54).card(.white, radius: 28, shadow: true)
                            .overlay(alignment: .bottomLeading) { Image(systemName: "star.fill").font(.system(size: 10)).padding(5).background(KS.butter, in: Circle()).overlay(Circle().stroke(KS.ink, lineWidth: 2)) }
                    }.buttonStyle(.plain).accessibilityLabel("Open starred bot").accessibilityIdentifier("starred-shortcut")
                }
            }.padding(18).padding(.bottom, 6)
        }
    }
    private var thread: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                CloseButton { screen = .home; model.openBot = nil }
                Moji(seed: model.openBot?.raw["lead_agent_id"].string ?? "", size: 40)
                VStack(alignment: .leading) {
                    Text((model.openBot?.name ?? "Bot").uppercased() + ".").font(KS.display(28))
                    Text("Your crew, in one thread").font(KS.body(13)).foregroundStyle(KS.muted)
                }
                Spacer()
            }.padding(18)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(threadRows(model.messages)) { row in
                            if row.folded {
                                let threadID = model.openBot?.threadID ?? ""
                                DisclosureGroup(isExpanded: Binding(
                                    get: { model.expandedWorkingNotes[threadID, default: []].contains(row.id) },
                                    set: { if $0 { model.expandedWorkingNotes[threadID, default: []].insert(row.id) }
                                           else { model.expandedWorkingNotes[threadID]?.remove(row.id) } }
                                )) {
                                    ForEach(row.messages) { messageView($0).id($0.id) }
                                } label: { Text(row.label).font(KS.body(14)).frame(minHeight: 44) }
                            } else if let message = row.messages.first {
                                messageView(message).id(message.id)
                            }
                        }
                        ForEach(Array(model.typing.enumerated()), id: \.offset) { _, typing in
                            let agent = model.replyingAgent(typing)
                            HStack(alignment: .bottom, spacing: 8) {
                                Moji(seed: agent.id, size: 28)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(agent.name).font(KS.body(13, .bold))
                                    Eyebrow("Replying live")
                                    Text(typing["text"].string.isEmpty ? "Thinking…" : typing["text"].string).fixedSize(horizontal: false, vertical: true)
                                }.padding(14).background(.white, in: RoundedRectangle(cornerRadius: 18))
                                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(KS.ink, style: StrokeStyle(lineWidth: 2, dash: [5, 4])))
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: .infinity)
                    .defaultScrollAnchor(.bottom)
                    .onChange(of: model.messages.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                    .onChange(of: model.typing) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            HStack {
                Button("Earlier messages") { perform { try await model.olderMessages() } }
                Spacer()
                Button { screen = .settings } label: { Label("Bot settings", systemImage: "slider.horizontal.3") }
            }.font(KS.body(14)).frame(minHeight: 44).padding(.horizontal, 20)
            HStack(spacing: 10) {
                TextField("Ask your bot…", text: $composer, axis: .vertical).lineLimit(1...4).padding(.horizontal, 16).frame(minHeight: 54).card(.white, radius: 24).accessibilityIdentifier("composer")
                Button { let text = composer; perform { try await model.post(text); composer = "" } } label: { Image(systemName: "arrow.up").frame(width: 44) }
                    .buttonStyle(Pill(fill: KS.lime, primary: true)).fixedSize(horizontal: true, vertical: false).disabled(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy).accessibilityLabel("Send message")
            }.padding(18)
        }
    }
    @ViewBuilder private func messageView(_ message: Message) -> some View {
        if message.kind == "task" {
            let task = message.raw["task"]
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow(task["resolved"].bool ? "Resolved" : task["status"].string == "completed" ? "Ready for review" : task["status"].string)
                Text(task["title"].string).font(KS.body(17, .bold))
                Text(task["served"]["provider"].string + " · " + task["branch"].string).font(KS.mono(11))
                HStack {
                    Button("Approve") { perform { try await model.resolve(task["id"].string) } }.buttonStyle(Pill(fill: KS.lime)).disabled(task["status"].string != "completed" || task["resolved"].bool || task["check"]["status"].string == "failed" || model.busy)
                    Button("See changes") {
                        perform {
                            var changes = ""
                            if model.isDemo { changes = "Demo preview · 7 files\n\nThe launch banner draft is ready for review. No production artifact is loaded." }
                            else if let service = model.service {
                                let result = try await service.call("task_get", ["task_id": task["id"]])
                                let task = result["task"]
                                var parts: [String] = []
                                for id in task["artifact_ids"].array {
                                    let artifact = try await service.call("artifact_get", ["artifact_id": id])["artifact"]
                                    if ["text/x-diff", "application/x-patch"].contains(artifact["media_type"].string) {
                                        parts.append(artifact["name"].string + "\n\n" + artifact["content"].string)
                                    }
                                }
                                let summary = task["result"]["summary"].string.isEmpty ? task["result"]["answer"].string : task["result"]["summary"].string
                                changes = parts.isEmpty ? (summary.isEmpty ? "No diff artifact was returned. Open this task on your Mac to review its branch." : summary) : parts.joined(separator: "\n\n")
                            }
                            sheet = .changes(changes)
                        }
                    }.buttonStyle(Pill())
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading).card(KS.sage)
        } else if message.kind == "question" {
            VStack(alignment: .leading, spacing: 10) {
                Eyebrow("Needs your input")
                Text(message.question["prompt"].string).font(KS.body(17, .bold))
                Button("Answer question") { sheet = .question(message.question) }.buttonStyle(Pill(fill: KS.coralTint)).disabled(message.question["status"].string != "open")
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading).card(KS.coralTint)
        } else {
            HStack {
                if message.human { Spacer(minLength: 36) }
                VStack(alignment: .leading, spacing: 5) {
                    if !message.human { Text(message.raw["author"]["name"].string).font(KS.body(13, .bold)) }
                    Text(message.text.isEmpty ? (message.kind == "answer" ? "Answer sent" : message.kind.capitalized) : message.text)
                }.padding(14).foregroundStyle(message.human ? KS.paper : KS.ink).card(message.human ? KS.ink : .white)
                if !message.human { Spacer(minLength: 24) }
            }
        }
    }
    private var tasks: some View {
        VStack(spacing: 0) {
            header("Tasks") { screen = .home }
            HStack {
                countCard("NEED YOU", count: model.attention.count, color: KS.coralTint)
                countCard("WORKING", count: model.tasks.filter { ["running", "queued"].contains($0["status"].string) }.count, color: .white)
                countCard("DONE", count: model.tasks.filter { $0["status"].string == "completed" }.count, color: KS.sage)
            }.padding(.horizontal, 18)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(filteredTasks.enumerated()), id: \.offset) { _, row in
                        Button {
                            if let bot = model.bots.first(where: { $0.id == row["bot_id"].string || $0.threadID == row["thread_id"].string }) { open(bot) }
                            else { sheet = .changes(row["objective"].string + "\n\n" + row["status"].string + "\n" + row["next_step"].string) }
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Eyebrow(row["status"].string.isEmpty ? row["label"].string : row["status"].string)
                                Text(row["objective"].string.isEmpty ? row["title"].string : row["objective"].string).font(KS.body(17, .bold))
                                Text(taskDetail(row)).font(KS.body(14)).foregroundStyle(KS.soft)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(14).card(.white, shadow: true)
                        }.buttonStyle(.plain)
                    }
                    if filteredTasks.isEmpty { empty("Nothing here right now.") }
                }.padding(18)
            }.frame(maxHeight: .infinity)
            HStack(spacing: 6) {
                ForEach(["All", "Needs you", "Working", "Done"], id: \.self) { item in
                    Button(item) { filter = item }.font(KS.body(14, .semibold)).frame(maxWidth: .infinity, minHeight: 44).card(filter == item ? KS.lime : .white, radius: 24).accessibilityAddTraits(filter == item ? .isSelected : [])
                }
            }.buttonStyle(.plain).padding(18)
        }
    }
    private var filteredTasks: [JSON] {
        switch filter {
        case "Needs you": return model.attention
        case "Working": return model.tasks.filter { ["running", "queued"].contains($0["status"].string) }
        case "Done": return model.tasks.filter { $0["status"].string == "completed" }
        default: return model.tasks
        }
    }
    private func taskDetail(_ task: JSON) -> String {
        let bot = model.bots.first { $0.id == task["bot_id"].string }
        let provider = task["served"]["provider"].string.isEmpty ? task["required_capability"].string : task["served"]["provider"].string
        let next = task["next_step"].string.isEmpty ? (task["status"].string == "completed" ? "Review the result" : task["status"].string == "failed" ? "Open the thread to review the failure" : "Work is in progress") : task["next_step"].string
        return [bot?.name ?? task["scope"].string, provider, next].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func countCard(_ name: String, count: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) { Text(String(format: "%02d", count)).font(KS.display(28)); Text(name).font(KS.mono(9)) }
            .frame(maxWidth: .infinity, alignment: .leading).padding(10).card(color, radius: 14)
    }
    private var usage: some View {
        VStack(spacing: 0) {
            header("Usage") { screen = .home }
            Text("Auto work follows your host’s routing policy and available quota.").foregroundStyle(KS.soft).padding(.horizontal, 20)
            ScrollView {
                VStack(spacing: 14) {
                    ForEach(Array(model.status["usage"].array.enumerated()), id: \.offset) { _, usage in
                        HStack(spacing: 16) {
                            ZStack {
                                Circle().stroke(KS.paper, lineWidth: 10)
                                Circle().trim(from: 0, to: max(0, min(1, (usage["headroom"].number ?? 0) / 100))).stroke(KS.tint(usage["provider"].string), lineWidth: 10).rotationEffect(.degrees(-90))
                                Circle().stroke(KS.ink, lineWidth: 2).padding(-5)
                                Circle().stroke(KS.ink, lineWidth: 2).padding(5)
                                Text(usage["headroom"].number.map { "\(Int($0))%" } ?? "—").font(KS.display(19))
                            }.frame(width: 62, height: 62).accessibilityLabel("\(usage["provider"].string), \(usage["headroom"].number.map { "\(Int($0)) percent left" } ?? "quota unavailable")")
                            VStack(alignment: .leading, spacing: 5) {
                                Text(usage["provider"].string.capitalized + " · " + usage["plan"].string.uppercased()).font(KS.body(19, .bold))
                                ForEach(Array(usage["windows"].array.enumerated()), id: \.offset) { _, window in
                                    Text(windowText(window)).font(KS.body(14)).foregroundStyle(KS.soft)
                                }
                                if !usage["ok"].bool { Text("Quota reading unavailable").font(KS.body(14)) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(18).card(.white, shadow: true)
                    }
                    if model.status["usage"].array.isEmpty { empty("No quota readings from the host yet.") }
                }.padding(18)
            }
            VStack(alignment: .leading, spacing: 12) {
                Eyebrow("01 — Auto order, right now")
                Text(model.status["routing"]["reason"].string).font(KS.body(14))
                ForEach(["research", "patch", "review", "summary"], id: \.self) { kind in
                    let choice = model.status["routing"]["by_kind"][kind]
                    HStack { Text(kind.capitalized); Spacer(); Text(choice["provider"].string.isEmpty ? "No eligible provider" : choice["provider"].string.capitalized).fontWeight(.semibold) }.font(KS.body(14))
                }
                Button("Refresh usage") { Task { await model.refresh() } }.buttonStyle(Pill(primary: true)).disabled(model.loading)
            }.padding(20)
        }
    }
    private func windowText(_ window: JSON) -> String {
        let used = window["used_percent"].number.map { "\(Int($0))% used" } ?? "unavailable"
        let reset = date(window["resets_at"].string).map { ", resets " + $0.formatted(.relative(presentation: .numeric)) } ?? ""
        return window["name"].string + ": " + used + reset
    }
    private var you: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) { CloseButton { sheet = nil }; Text("YOU.").font(KS.display(32)) }
            Button { sheet = .newBot } label: { menuRow("New bot", "Or ask your starred bot to make one", icon: "plus") }.buttonStyle(Pill(fill: KS.lime, primary: true))
            Button { sheet = nil; screen = .connect } label: { menuRow("Hosts and devices", model.online ? "Host online · pair another host" : "Host offline · pair another host", icon: "desktopcomputer") }.buttonStyle(Pill(primary: true))
            Button {
                sheet = nil
                if let bot = model.starred { model.openBot = bot; screen = .settings }
                else { model.error = "Open a bot’s thread, then choose Bot settings." }
            } label: { menuRow("Bot settings", "Crew, chat replies and your starred shortcut", icon: "slider.horizontal.3") }.buttonStyle(Pill(primary: true))
            Button("Sign out of this host") { perform { try await model.signOut(); sheet = nil; screen = .connect } }.frame(maxWidth: .infinity, minHeight: 44).disabled(model.isDemo)
        }
    }
    private func menuRow(_ title: String, _ subtitle: String, icon: String) -> some View {
        HStack(spacing: 12) { Image(systemName: icon); VStack(alignment: .leading) { Text(title).font(KS.body(18, .bold)); Text(subtitle).font(KS.body(14)).foregroundStyle(KS.soft) }; Spacer() }.padding(.vertical, 8)
    }
}

private func date(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
private func time(_ value: String) -> String { date(value).map { $0.formatted(date: .omitted, time: .shortened) } ?? "" }

struct ConnectView: View {
    @Bindable var model: AppModel
    var close: () -> Void
    @State private var code = ""
    @State private var error: String?
    @State private var connecting = false
    @FocusState private var focused: Bool
    private var digits: String { String(code.filter(\.isNumber).prefix(6)) }
    private func connect() {
        guard !connecting, digits.count == 6 else { return }
        connecting = true; error = nil
        Task {
            defer { connecting = false }
            do { try await model.pair(code: digits); code = ""; close() }
            catch { self.error = safeError(error) }
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.connected { CloseButton(action: close) }
            HStack(alignment: .top, spacing: 12) {
                Moji(seed: "", size: 56, mark: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("YOUR SWARM.").font(KS.display(38))
                    Text("in your pocket.").font(KS.body(27)).italic()
                }
            }
            Text("Your agents run on your Mac. This phone talks to them through the Swarmaa relay, from anywhere.").foregroundStyle(KS.soft)
            Eyebrow("01 — On your Mac, run npm run relay:pair")
            Text("Type the 6-digit code it shows. It works once, for five minutes.")
            Spacer(minLength: 0)
            Eyebrow("Pairing code")
            TextField("000 000", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(KS.mono(34)).multilineTextAlignment(.center)
                .padding(.vertical, 14).frame(maxWidth: .infinity).card(.white, radius: 16)
                .focused($focused).privacySensitive()
                .accessibilityLabel("6-digit pairing code")
                .onChange(of: code) { _, value in
                    let clean = String(value.filter(\.isNumber).prefix(6))
                    if clean != value { code = clean }
                    if clean.count == 6 { connect() }
                }
            if let error { Text(error).font(KS.body(14)) }
            Button(connecting ? "Connecting…" : "Connect", action: connect)
                .buttonStyle(Pill(fill: KS.lime, primary: true))
                .disabled(connecting || model.isDemo || digits.count < 6)
        }
        .padding(20).background(KS.paper)
        .onAppear { focused = !model.isDemo }
    }
}

private let replyModels = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "gemini-3.8-flash-high", "off"]
private let replyNames = ["Haiku 5.5", "Sonnet 5.5", "Opus 5.5", "Gemini Flash", "Agent’s own model"]
struct ReplyPicker: View {
    @Binding var value: String
    var body: some View {
        Picker("Chat replies", selection: $value) { ForEach(Array(zip(replyModels, replyNames)), id: \.0) { id, name in Text(name).tag(id) } }
            .pickerStyle(.menu).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).card(.white, radius: 14)
    }
}
struct NewBotView: View {
    @Bindable var model: AppModel
    var close: () -> Void
    @State private var draft = NewBotDraft()
    @State private var error: String?
    @State private var saving = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { CloseButton(action: close).accessibilityIdentifier("close-sheet"); Text("NEW BOT.").font(KS.display(32)) }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("01 — Name", text: $draft.name, prompt: "e.g. Launch")
                    field("02 — What it does", text: $draft.job, prompt: "Plans each product launch…", lines: 2...3)
                    Eyebrow("03 — Project and lead")
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                        Eyebrow("Project")
                        Picker("Project", selection: $draft.project) { Text("Choose project").tag(""); ForEach(model.scopes, id: \.self) { Text($0.replacingOccurrences(of: "project:", with: "")).tag($0) } }.pickerStyle(.menu).frame(maxWidth: .infinity, minHeight: 44).card(.white, radius: 14).accessibilityIdentifier("project-picker")
                        }
                        VStack(alignment: .leading, spacing: 4) {
                        Eyebrow("Lead")
                        Picker("Lead", selection: $draft.lead) { Text("A new agent").tag(""); ForEach(model.agents.filter { $0["scope"].string == draft.project }, id: \.self) { Text($0["name"].string).tag($0["id"].string) } }.pickerStyle(.menu).frame(maxWidth: .infinity, minHeight: 44).card(.white, radius: 14).accessibilityIdentifier("lead-picker")
                        }
                    }
                    Eyebrow("04 — Chat replies"); ReplyPicker(value: $draft.firstReply)
                }.padding(3)
            }.frame(maxHeight: .infinity).accessibilityIdentifier("new-bot-fields")
            Text(error ?? draft.missing ?? "Your bot is ready to make.").font(KS.body(14)).foregroundStyle(KS.muted)
            Button(saving ? "Making bot…" : "Make bot") {
                saving = true
                Task {
                    defer { saving = false }
                    do { try await model.create(draft); close() } catch { self.error = safeError(error) }
                }
            }.buttonStyle(Pill(fill: KS.lime, primary: true)).disabled(draft.missing != nil || saving || model.isDemo)
        }.onChange(of: draft.project) { _, _ in draft.lead = "" }
    }
}
@MainActor private func field(_ label: String, text: Binding<String>, prompt: String, lines: ClosedRange<Int> = 1...1) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        Eyebrow(label)
        TextField(prompt, text: text, axis: .vertical).lineLimit(lines).padding(12).frame(minHeight: 48).card(.white, radius: 14).accessibilityLabel(label)
    }
}
struct AnswerView: View {
    @Bindable var model: AppModel
    var question: JSON
    var close: () -> Void
    @State private var choices = Set<String>()
    @State private var requestID = UUID().uuidString
    @State private var text = ""
    @State private var error: String?
    @State private var saving = false
    var valid: Bool { question["status"].string == "open" && (!choices.isEmpty || (question["free_text"].bool && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) && text.count <= 2000 }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { CloseButton(action: close).accessibilityIdentifier("close-sheet"); Eyebrow("Your bot asks") }
            Text(question["prompt"].string.uppercased()).font(KS.display(30)).fixedSize(horizontal: false, vertical: true)
            Text(question["multi"].bool ? "Pick any. Nothing is posted until you approve the drafts." : "Choose one answer.").font(KS.body(15))
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(question["options"].array.map(\.string), id: \.self) { option in
                        Button {
                            if choices.contains(option) { choices.remove(option) }
                            else { if !question["multi"].bool { choices = [] }; choices.insert(option) }
                        } label: { HStack { Text(option); Spacer(); Image(systemName: choices.contains(option) ? "checkmark.circle.fill" : "circle") } }
                            .buttonStyle(Pill(fill: choices.contains(option) ? KS.lime : .white))
                    }
                    if question["free_text"].bool { field("Anything else", text: $text, prompt: "e.g. skip X this time") }
                }.padding(3)
            }.frame(height: 160)
            if let error { Text(error).font(KS.body(14)) }
            Button(saving ? "Sending…" : "Send answer") {
                saving = true
                Task {
                    defer { saving = false }
                    do {
                        guard let service = model.service else { return }
                        _ = try await service.call("question_answer", ["question_id": question["id"], "choices": .strings(choices.sorted()), "text": .string(text), "idempotency_key": .string(requestID)])
                        if let bot = model.openBot { try await model.readThread(bot) }
                        close()
                    } catch { self.error = safeError(error) }
                }
            }.buttonStyle(Pill(fill: KS.lime, primary: true)).disabled(!valid || saving || model.isDemo)
        }
    }
}

struct SettingsView: View {
    @Bindable var model: AppModel
    var close: () -> Void
    @State private var draft: Bot
    @State private var error: String?
    @State private var saving = false
    init(model: AppModel, bot: Bot, close: @escaping () -> Void) { self.model = model; self.close = close; _draft = State(initialValue: bot) }
    private func string(_ key: String) -> Binding<String> { Binding(get: { draft.raw[key].string }, set: { draft.raw[key] = .string($0) }) }
    private func rule(_ key: String) -> Binding<Bool> { Binding(get: { draft.raw["rules"][key] == .null ? key != "require_tests" : draft.raw["rules"][key].bool }, set: { draft.raw["rules"][key] = .bool($0) }) }
    var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: 14) {
                HStack { CloseButton(action: close); Moji(seed: draft.raw["lead_agent_id"].string, size: 40); Text(draft.name.uppercased() + ".").font(KS.display(30)) }
                Text(draft.job).foregroundStyle(KS.soft)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        field("Name", text: string("name"), prompt: "Bot name")
                        field("What it does", text: string("job"), prompt: "Job", lines: 2...3)
                        Eyebrow("01 — Chat replies")
                        ReplyPicker(value: Binding(get: { draft.raw["rules"]["first_reply"].string.isEmpty ? replyModels[0] : draft.raw["rules"]["first_reply"].string }, set: { draft.raw["rules"]["first_reply"] = .string($0) }))
                        Eyebrow("02 — Crew")
                        Picker("Lead", selection: string("lead_agent_id")) {
                            ForEach(model.agents.filter { $0["scope"].string == draft.scope }, id: \.self) { agent in Text(agent["name"].string).tag(agent["id"].string) }
                        }.frame(minHeight: 44)
                        ForEach(model.agents.filter { $0["scope"].string == draft.scope && $0["id"].string != draft.raw["lead_agent_id"].string }, id: \.self) { agent in
                            Toggle(agent["name"].string, isOn: Binding(get: { draft.raw["member_agent_ids"].array.contains(agent["id"]) }, set: { on in
                                var members = draft.raw["member_agent_ids"].array.filter { $0 != agent["id"] }
                                if on { members.append(agent["id"]) }; draft.raw["member_agent_ids"] = .array(members)
                            })).frame(minHeight: 44)
                        }
                        Eyebrow("03 — Who does what")
                        ForEach(["research", "patch", "review", "summary"], id: \.self) { kind in
                            Picker(kind.capitalized, selection: Binding(get: { draft.raw["routing"][kind]["provider"].string.isEmpty ? draft.raw["routing"][kind]["mode"].string : draft.raw["routing"][kind]["provider"].string }, set: { value in
                                draft.raw["routing"][kind] = ["claude", "codex", "antigravity"].contains(value) ? .object(["provider": .string(value)]) : .object(["mode": .string(value)])
                            })) {
                                Text("Auto").tag("auto"); Text("Auto").tag("")
                                if kind == "review" { Text("Different from author").tag("different_from_author") }
                                Text("Claude").tag("claude"); Text("Codex").tag("codex"); Text("Antigravity").tag("antigravity")
                            }.frame(minHeight: 44)
                        }
                        Toggle("Star this bot (your bottom-right shortcut)", isOn: Binding(get: { draft.starred }, set: { draft.raw["starred"] = .bool($0) })).frame(minHeight: 44)
                        Toggle("Ask me before anything public", isOn: rule("approve_public")).frame(minHeight: 44)
                        Toggle("Review every edit", isOn: rule("review_edits")).frame(minHeight: 44)
                        Toggle("Run tests before an edit is done", isOn: rule("require_tests")).frame(minHeight: 44)
                    }.padding(14).card(.white).padding(4)
                }.frame(maxHeight: .infinity)
                if let error { Text(error).font(KS.body(14)) }
                Text("Changes apply from the next turn. Running work keeps its settings.").font(KS.body(14)).foregroundStyle(KS.muted)
                Button(saving ? "Saving…" : "Save changes") {
                    saving = true
                    Task { defer { saving = false }; do { try await model.save(draft); close() } catch { self.error = safeError(error) } }
                }.buttonStyle(Pill(fill: KS.lime, primary: true)).disabled(saving || model.isDemo || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding(20)
        }
    }
}

// Fixtures are loaded only after the explicit -demo launch argument; never contact a host.
private enum Demo {
    static let question: JSON = .object(["id": .string("demo-question"), "prompt": .string("Which channels should the launch use?"), "options": .strings(["Blog and changelog", "X", "LinkedIn", "Product Hunt"]), "multi": .bool(true), "free_text": .bool(true), "status": .string("open")])
    static func bot(_ id: String, _ name: String, _ line: String, needs: Int = 0, unread: Int = 0, star: Bool = false) -> Bot {
        Bot(raw: .object(["id": .string(id), "name": .string(name), "job": .string("Plans each product launch across the crew and asks before anything goes public."), "scope": .string("project:swarma"), "thread_id": .string("thread-" + id), "lead_agent_id": .string(id), "member_agent_ids": .strings(["scout", "forge"]), "version": .number(1), "starred": .bool(star), "updated_at": .string("2026-10-28T10:10:00Z"), "badges": .object(["needs_you": .number(Double(needs)), "unread": .number(Double(unread)), "latest": .object(["line": .string(line), "at": .string("2026-10-28T10:10:00Z")])]), "rules": .object(["first_reply": .string("claude-haiku-5-5"), "approve_public": .bool(true), "review_edits": .bool(true)]), "routing": .object(["review": .object(["mode": .string("different_from_author")])])]))
    }
    static func task(_ id: String, _ title: String, _ state: String, _ provider: String) -> JSON {
        .object(["id": .string(id), "objective": .string(title), "title": .string(title), "bot_id": .string("launch"), "scope": .string("project:swarma"), "status": .string(state), "served": .object(["provider": .string(provider)]), "branch": .string("swarmaa/claude/demo"), "changed_files": .number(7), "version": .number(1), "resolved": .bool(false)])
    }
    static func message(_ id: String, _ seq: Int, _ kind: String, _ body: JSON, human: Bool = false) -> Message {
        var raw: JSON = .object(["id": .string(id), "seq": .number(Double(seq)), "thread_id": .string("thread-launch"), "author": .object(["kind": .string(human ? "human" : "agent"), "name": .string(human ? "You" : "Atlas")]), "kind": .string(kind), "body": body])
        if kind == "task" { raw["task"] = body }
        if kind == "question" { raw["question"] = body }
        return Message(raw: raw)
    }
}
private extension AppModel {
    func loadDemo() {
        guard ProcessInfo.processInfo.arguments.contains("-demo") else { return }
        isDemo = true; connected = true; online = true
        bots = [Demo.bot("launch", "Launch", "Which channels should we use?", needs: 1, star: true), Demo.bot("watch", "Competitor watch", "Pricing summary needs a retry", needs: 1), Demo.bot("pulse", "Pulse", "The calendar is ready", unread: 3), Demo.bot("forge", "Forge", "Drafted the pricing page"), Demo.bot("scout", "Scout", "Read the launch brief"), Demo.bot("notes", "Notes", "Everything is up to date")]
        openBot = bots[0]
        agents = [JSON.object(["id": .string("launch"), "name": .string("Atlas"), "scope": .string("project:swarma")]), .object(["id": .string("scout"), "name": .string("Scout"), "scope": .string("project:swarma")]), .object(["id": .string("forge"), "name": .string("Forge"), "scope": .string("project:swarma")])]
        tasks = [Demo.task("banner", "Draft the launch banner", "completed", "claude"), Demo.task("pricing", "Summarise competitor pricing", "failed", "codex"), Demo.task("calendar", "Check the launch calendar", "running", "antigravity"), Demo.task("limits", "Fix the plan limits on the pricing page", "running", "claude")]
        attention = Array(tasks.prefix(2))
        messages = [Demo.message("m1", 1, "text", .string("Plan Friday’s launch. Ask me before anything goes public."), human: true), Demo.message("m2", 2, "text", .string("On it. Scout reads the brief, Forge drafts the banner. I’ll ask before anything goes out.")), Demo.message("m3", 3, "task", tasks[0]), Demo.message("m4", 4, "question", Demo.question)]
        if ProcessInfo.processInfo.arguments.contains("-working-notes-demo") {
            var first = Demo.message("note1", 2, "notice", .string("Checking the launch brief"))
            var last = Demo.message("note2", 3, "handoff", .string("Handed off to the launch crew"))
            first.raw["created_at"] = .string("2026-10-28T10:00:00Z")
            last.raw["created_at"] = .string("2026-10-28T10:03:00Z")
            messages.insert(contentsOf: [first, last], at: 1)
        }
        typing = [.object(["agent_id": .string("scout"), "task_id": .string("demo-turn"), "text": .string("I’m checking the launch calendar…")])]
        let providers = ["antigravity", "claude", "codex"]
        status = .object(["scopes": .array([.object(["scope": .string("project:swarma")])]), "usage": .array(zip(providers, [79, 61, 11]).map { provider, left in
            .object(["provider": .string(provider), "ok": .bool(true), "headroom": .number(Double(left)), "plan": .string(provider == "claude" ? "MAX" : "PRO"), "windows": .array([.object(["name": .string("5 h"), "used_percent": .number(Double(100 - left))]), .object(["name": .string("Week"), "used_percent": .number(provider == "codex" ? 89 : 21)])])])
        }), "routing": .object(["reason": .string("Antigravity → Claude → Codex"), "by_kind": .object(Dictionary(uniqueKeysWithValues: ["research", "patch", "review", "summary"].map { ($0, .object(["provider": .string($0 == "research" ? "claude" : "antigravity")])) }))])])
    }
}

/// The iOS back swipe for screens this app switches itself (no NavigationStack): drag from the
/// left edge and the screen follows the finger; past a third of the width, or flicked, it goes back.
struct SwipeBack: ViewModifier {
    var action: () -> Void
    @State private var offset: CGFloat = 0
    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .offset(x: offset)
                .simultaneousGesture(DragGesture(minimumDistance: 12, coordinateSpace: .global)
                    .onChanged { value in
                        guard value.startLocation.x < 28, value.translation.width > 0 else { return }
                        offset = value.translation.width
                    }
                    .onEnded { value in
                        guard value.startLocation.x < 28 else { return }
                        if value.translation.width > geo.size.width / 3 || value.predictedEndTranslation.width > geo.size.width * 0.6 {
                            withAnimation(.easeOut(duration: 0.18)) { offset = geo.size.width }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { action(); offset = 0 }
                        } else {
                            withAnimation(.spring(duration: 0.25)) { offset = 0 }
                        }
                    })
        }
    }
}
extension View { func swipeBack(_ action: @escaping () -> Void) -> some View { modifier(SwipeBack(action: action)) } }

