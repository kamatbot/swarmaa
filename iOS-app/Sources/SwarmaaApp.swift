import SwiftUI
import PhotosUI
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

// Kind Swarm: expressive display type, readable native text and original Moji art.
enum KS {
    static let ink = Color(hex: 0x15111F), paper = Color(hex: 0xF4EFE6), lime = Color(hex: 0xCFE08A)
    static let coral = Color(hex: 0xE8836B), sage = Color(hex: 0xF1F5E2), coralTint = Color(hex: 0xFBEFE7)
    static let danger = Color(hex: 0xC8452F)
    static let sky = Color(hex: 0xB7CCE8), butter = Color(hex: 0xEAD9A6), lilac = Color(hex: 0xD9CDEE)
    static let soft = Color(hex: 0x3A3347), muted = Color(hex: 0x5A5168)
    // Semantic styles respond to the reader's text size, including accessibility sizes.
    static func body(_ size: CGFloat = 15, _ weight: Font.Weight = .regular) -> Font {
        let style: Font.TextStyle = size <= 12 ? .caption : size <= 13 ? .footnote : size <= 15 ? .subheadline : size <= 16 ? .callout : size <= 18 ? .body : size <= 22 ? .title3 : .title2
        return .system(style, design: .default, weight: weight)
    }
    static func display(_ size: CGFloat) -> Font {
        .system(size >= 38 ? .title : size >= 30 ? .title2 : size >= 24 ? .title3 : .headline, design: .default, weight: .black).width(.compressed)
    }
    static func mono(_ size: CGFloat = 11) -> Font {
        .system(size >= 28 ? .largeTitle : size >= 14 ? .subheadline : size >= 12 ? .caption : .caption2, design: .monospaced, weight: .medium)
    }
    static func tint(_ provider: String) -> Color { provider == "claude" ? lime : provider == "codex" ? coral : sky }
    // Short, interaction-driven motion; no ambient work while reading a thread.
    static let settle = Animation.spring(response: 0.28, dampingFraction: 0.78)
    static let glide = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.28)
}
extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}
extension View {
    func card(_ color: Color = .white, radius: CGFloat = 12, shadow: Bool = false) -> some View {
        background {
            ZStack {
                if shadow { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(KS.ink).offset(x: 2, y: 3) }
                RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color)
            }
        }.overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(KS.ink, lineWidth: 1).allowsHitTesting(false))
    }
}
struct Pill: ButtonStyle {
    var fill: Color = .white
    var primary = false
    /// Hide and delete: red text and outline.
    var danger = false
    @Environment(\.isEnabled) var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var labelSize: CGFloat = 14
    func makeBody(configuration: Configuration) -> some View {
        let pressed = enabled && configuration.isPressed
        configuration.label.font(.system(size: labelSize, weight: .semibold)).foregroundStyle(danger ? KS.danger : KS.ink)
            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: primary ? 44 : 32)
            .frame(maxWidth: primary || danger ? .infinity : nil)
            .card(fill, radius: 20, shadow: primary && enabled && !pressed)
            .overlay { if danger { RoundedRectangle(cornerRadius: 20).strokeBorder(KS.danger, lineWidth: 1.5).allowsHitTesting(false) } }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
            .offset(y: pressed && !reduceMotion ? 2 : 0)
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : KS.settle, value: pressed)
    }
}
/// Feedback for rows and icon controls without adding a second visual container.
struct PressStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        let pressed = enabled && configuration.isPressed
        configuration.label
            .opacity(pressed ? 0.8 : 1)
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : KS.settle, value: pressed)
    }
}
private struct HomeRowPressedKey: EnvironmentKey {
    static let defaultValue = false
}
private extension EnvironmentValues {
    var homeRowPressed: Bool {
        get { self[HomeRowPressedKey.self] }
        set { self[HomeRowPressedKey.self] = newValue }
    }
}
private struct HomeRowStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        // Keep the usual press feedback; the avatar's squash rides on top of it.
        PressStyle().makeBody(configuration: configuration).environment(\.homeRowPressed, configuration.isPressed && !reduceMotion)
    }
}

/// Each count is independent: a needs-you badge can appear while unread decreases.
func shouldPopHomeBadge(oldUnread: Int, oldNeedsYou: Int, unread: Int, needsYou: Int) -> Bool {
    (unread > 0 && unread > oldUnread) || (needsYou > 0 && needsYou > oldNeedsYou)
}
private struct HomeBadge: View {
    var unread: Int
    var needsYou: Int
    @State private var pop = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Group {
            if needsYou > 0 || unread > 0 {
                Text(needsYou > 0 ? "!" : "\(unread)").font(KS.mono()).padding(.horizontal, 8)
                    .frame(minWidth: 24, minHeight: 24).card(needsYou > 0 ? KS.coral : KS.lime, radius: 14)
                    .accessibilityLabel(needsYou > 0 ? "Needs you" : "\(unread) unread")
            }
        }
        .keyframeAnimator(initialValue: CGFloat(1), trigger: pop) { content, scale in
            content.scaleEffect(reduceMotion ? 1 : scale)
        } keyframes: { _ in
            SpringKeyframe(1.25, duration: 0.12)
            SpringKeyframe(1, duration: 0.18)
        }
        .onChange(of: [unread, needsYou]) { old, new in
            if !reduceMotion && shouldPopHomeBadge(oldUnread: old[0], oldNeedsYou: old[1], unread: new[0], needsYou: new[1]) { pop += 1 }
        }
    }
}
struct Moji: View {
    var seed: String
    var size: CGFloat = 44
    var mark = false
    var colorHex: UInt32?
    @Environment(\.homeRowPressed) private var rowPressed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let name = "moji-" + (mark ? "mark" : mojiCharacter(seed))
        Group {
            // UIImage's named-image cache avoids disk reads and decoding on every live update.
            if let image = UIImage(named: name) {
                Image(uiImage: image).resizable().scaledToFit()
            }
        }.frame(width: size, height: size)
            .background {
                if let colorHex { Circle().fill(Color(hex: colorHex)).frame(width: size * 1.2, height: size * 1.2) }
            }.accessibilityHidden(true)
            .scaleEffect(x: rowPressed && !reduceMotion ? 1.08 : 1, y: rowPressed && !reduceMotion ? 0.92 : 1)
            .rotationEffect(.degrees(rowPressed && !reduceMotion ? -6 : 0))
            .animation(reduceMotion ? nil : .spring(duration: 0.3), value: rowPressed)
    }
}
struct Eyebrow: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text.uppercased()).font(KS.mono()).tracking(0.5).foregroundStyle(KS.muted).fixedSize(horizontal: false, vertical: true) }
}
struct CloseButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)).frame(width: 34, height: 34).card(.white, radius: 17).frame(width: 44, height: 44).contentShape(Rectangle()) }
            .buttonStyle(PressStyle()).fixedSize().accessibilityLabel("Close")
    }
}
struct ContentSheet<Content: View>: View {
    @State private var measured: CGFloat = 1
    var content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        ScrollView {
            content.fixedSize(horizontal: false, vertical: true).padding(16).padding(.bottom, 8).frame(maxWidth: .infinity)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured = $0 }
        }
            .scrollBounceBehavior(.basedOnSize).scrollDismissesKeyboard(.interactively)
            .background(KS.paper).foregroundStyle(KS.ink).tint(KS.ink)
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
    @State private var homeAppeared = false
    @State private var search = ""
    @State private var composer = ""
    @State private var photos: [ChatPhoto] = []
    @State private var selections: [PhotosPickerItem] = []
    @State private var preparingPhotos = false
    @State private var draftGeneration = UUID()
    @State private var dictationStarting = false
    @State private var dictationToken = UUID()
    @State private var demoPreviewLoaded = false
    @State private var drafts: [String: (text: String, photos: [ChatPhoto])] = [:]
    @StateObject private var dictation = ChatDictation()
    @State private var filter = "All"
    @Namespace private var taskFilterSelection
    @ScaledMetric(relativeTo: .subheadline) private var filterLabelSize: CGFloat = 14
    @State private var nearBottom = true
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var textSize
    @FocusState private var searchFocused: Bool
    @FocusState private var composerFocused: Bool
    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                if model.connected || model.isDemo {
                    // A stack, like a navigation controller: home stays put underneath, deeper screens
                    // slide in from the right over it and slide back out, so going back reveals home.
                    ZStack {
                        home.accessibilityHidden(screen != .home).allowsHitTesting(screen == .home)
                        if screen == .thread || (screen == .settings && model.openBot != nil) {
                            thread.swipeBack { screen = .home; model.openBot = nil }
                                .background(KS.paper).transition(.move(edge: .trailing))
                                .accessibilityHidden(screen != .thread)
                        }
                        if screen == .tasks { tasks.swipeBack { screen = .home }.background(KS.paper).transition(.move(edge: .trailing)) }
                        if screen == .usage { usage.swipeBack { screen = .home }.background(KS.paper).transition(.move(edge: .trailing)) }
                        if screen == .connect {
                            ConnectView(model: model) { screen = .home }.swipeBack { screen = .home }.background(KS.paper).transition(.move(edge: .trailing))
                        }
                        if screen == .settings {
                            Group {
                                if let bot = model.openBot ?? model.starred { SettingsView(model: model, bot: bot) { screen = model.openBot == nil ? .home : .thread }.swipeBack { screen = model.openBot == nil ? .home : .thread } }
                                else { empty("Open a bot to change its settings.") }
                            }.background(KS.paper).transition(.move(edge: .trailing))
                        }
                    }
                } else { ConnectView(model: model) { screen = .home } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(KS.paper).foregroundStyle(KS.ink)
            .font(KS.body()).tint(KS.ink)
            .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.9), value: screen)
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
                    // Opening straight onto a screen at launch has nothing to slide in from.
                    var instant = Transaction(); instant.disablesAnimations = true
                    withTransaction(instant) { screen = Screen(rawValue: name) ?? (name == "question" ? .thread : .home) }
                    if ["you", "question", "newBot"].contains(name) {
                        try? await Task.sleep(for: .milliseconds(200))
                        sheet = name == "question" ? .question(Demo.question) : name == "you" ? .you : .newBot
                    }
                }
            } else { await model.restore() }
            if Runtime.openStarRequested, model.openBot != nil { screen = .thread; Runtime.openStarRequested = false }
        }
        .onChange(of: model.connected) { _, connected in if !connected && !model.isDemo { drafts = [:]; photos = []; composer = ""; dictation.stop() } }
        .onChange(of: model.pendingPushBotID) { _, _ in openPushBot() }
        .onChange(of: model.didLoadBots) { _, _ in openPushBot() }
        .onChange(of: model.bots) { _, _ in openPushBot() }
        .onChange(of: screen) { _, value in if value != .home { searchFocused = false }; if value != .thread { dictation.stop(); dictationToken = UUID(); dictationStarting = false }; updateVisibleThread() }
        .onChange(of: sheet?.id) { _, _ in updateVisibleThread() }
        .onChange(of: model.openBot?.id) { oldID, id in
            dictation.stop(); dictationToken = UUID(); dictationStarting = false; draftGeneration = UUID()
            if let oldID, model.connected || model.isDemo { drafts[oldID] = (composer, photos) }
            let draft = id.flatMap { drafts[$0] }
            photos = draft?.photos ?? []; composer = draft?.text ?? ""; selections = []
            if id != nil, model.isDemo, !demoPreviewLoaded, ProcessInfo.processInfo.arguments.contains("-photo-preview-demo"),
               let url = Bundle.main.url(forResource: "moji-scout", withExtension: "png"),
               let data = try? Data(contentsOf: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("demo-photo.jpg")) ?? Data(contentsOf: url),
               let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.8) {
                photos = [ChatPhoto(id: UUID(), name: "Demo photo.jpg", data: jpeg)]; demoPreviewLoaded = true
            }
            if id == nil && (screen == .thread || screen == .settings) { screen = .home; sheet = nil }
            updateVisibleThread()
        }
        .onChange(of: model.openBot?.id) { _, value in if value != nil, Runtime.openStarRequested { screen = .thread; Runtime.openStarRequested = false } }
        .onDisappear { dictation.stop() }
        .onChange(of: selections) { _, items in
            guard !items.isEmpty else { return }
            let thread = model.openBot?.threadID, generation = draftGeneration
            preparingPhotos = true
            Task {
                defer { preparingPhotos = false }
                for item in items.prefix(max(0, 2 - photos.count)) {
                    do {
                        guard let data = try await item.loadTransferable(type: Data.self) else { throw AppFailure.invalidResponse }
                        let photo = try await ChatPhoto.prepare(data: data, name: "Photo.jpg")
                        guard thread == model.openBot?.threadID, generation == draftGeneration else { return }
                        photos.append(photo)
                    } catch { if thread == model.openBot?.threadID && generation == draftGeneration { model.error = "Could not prepare this photo. Please try again." } }
                }
                selections = []
            }
        }
        .onChange(of: phase) { _, phase in
            guard phase == .active else { dictation.stop(); dictationToken = UUID(); dictationStarting = false; return }
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
        HStack(spacing: 8) {
            CloseButton(action: close)
            Text(title.uppercased() + ".").font(KS.display(28)).minimumScaleFactor(0.7).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 4)
    }
    /// A new user's list: one big item that starts their first bot chat.
    private var firstBotCard: some View {
        Button { sheet = .newBot } label: {
            HStack(spacing: 14) {
                Image(systemName: "plus").font(.system(size: 26, weight: .bold)).frame(width: 56, height: 56).card(.white, radius: 28)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Make your first bot").font(KS.body(18, .bold))
                    Text("A bot keeps one chat for one job, like research, a launch or your releases.").font(KS.body(14)).foregroundStyle(KS.soft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).card(KS.lime, radius: 18, shadow: true)
        }.buttonStyle(PressStyle()).padding(.top, 12).accessibilityIdentifier("new-bot-card")
    }
    private func empty(_ text: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "tray").font(.system(size: 28, weight: .light)).accessibilityHidden(true)
            Text(text).font(KS.body()).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }.foregroundStyle(KS.muted).padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var home: some View {
        let bots = model.sortedBots.filter(matches)
        let hidden = model.hiddenBots.filter(matches)
        let needsYou = model.sortedBots.filter { $0.needsYou > 0 }.count
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button { sheet = .you } label: { Text("YOU").font(.system(size: 11, weight: .semibold, design: .monospaced)).frame(width: 44, height: 44).card(KS.lilac, radius: 24) }.accessibilityLabel("You")
                Circle().fill(model.online ? Color(hex: 0x3F7D20) : KS.coral).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.isDemo ? "MAC STUDIO" : "YOUR MAC").font(KS.mono(10)).lineLimit(1)
                    if !model.online { Text(model.lastSeen.map { "Seen " + $0.formatted(.relative(presentation: .numeric)) } ?? "Offline").font(KS.body(11)) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button { screen = .tasks; perform { try await model.loadTasks() } } label: {
                    Image(systemName: "list.bullet").font(.system(size: 20, weight: .medium)).frame(width: 44, height: 44).card(.white, radius: 24)
                        .overlay(alignment: .topTrailing) {
                            if model.sortedBots.reduce(0, { $0 + $1.needsYou }) > 0 {
                                Text("\(model.sortedBots.reduce(0, { $0 + $1.needsYou }))").font(.system(size: 11, weight: .semibold, design: .rounded)).padding(4).background(KS.coral, in: Circle())
                            }
                        }
                }.accessibilityLabel("Tasks")
                Button { screen = .usage } label: { Image(systemName: "chart.pie").font(.system(size: 20, weight: .medium)).frame(width: 44, height: 44).card(.white, radius: 24) }.accessibilityLabel("Usage")
                // New users get the big card in the list instead; this is the quick way for everyone else.
                if !model.sortedBots.isEmpty || !model.hiddenBots.isEmpty {
                    Button { sheet = .newBot } label: { Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).frame(width: 44, height: 44).card(KS.lime, radius: 24) }
                        .accessibilityLabel("New bot").accessibilityIdentifier("new-bot-header")
                }
            }.buttonStyle(PressStyle()).padding(.horizontal, 20).padding(.top, 6)
            (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))) {
                Text("BOTS.").font(KS.display(38))
                Text(needsYou == 0 ? "All caught up" : "\(needsYou) need you").font(KS.body(14)).foregroundStyle(KS.soft)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 14)
            Rectangle().fill(KS.ink.opacity(0.15)).frame(height: 1)
            if model.loading { ProgressView("Loading your bots").padding() }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
                        row(bot)
                            .opacity(reduceMotion || homeAppeared || index >= 10 ? 1 : 0)
                            .offset(y: reduceMotion || homeAppeared || index >= 10 ? 0 : 8)
                            .animation(reduceMotion || index >= 10 ? nil : .easeOut(duration: 0.3).delay(Double(index) * 0.035), value: homeAppeared)
                        Divider().overlay(KS.ink.opacity(0.12))
                    }
                    if !hidden.isEmpty {
                        Button {
                            withAnimation(reduceMotion ? nil : KS.glide) { model.showHidden.toggle() }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold))
                                    .rotationEffect(.degrees(model.showHidden ? 90 : 0))
                                Text("HIDDEN · \(hidden.count)").font(KS.mono(12)).tracking(1)
                                Spacer()
                            }.foregroundStyle(KS.muted).frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(PressStyle()).padding(.horizontal, 4).padding(.top, 8)
                            .accessibilityLabel("Hidden bots, \(hidden.count)").accessibilityIdentifier("hidden-section")
                        if model.showHidden {
                            ForEach(hidden) { bot in
                                row(bot)
                                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: -6)))
                                Divider().overlay(KS.ink.opacity(0.12))
                            }
                        }
                    }
                    if bots.isEmpty && hidden.isEmpty && !model.loading {
                        if search.isEmpty && model.sortedBots.isEmpty && model.hiddenBots.isEmpty { firstBotCard }
                        else { empty("No bots match “\(search)”. Try another name or job.") }
                    }
                }.padding(.horizontal, 20).padding(.bottom, 6)
            }.scrollDismissesKeyboard(.interactively)
                .task(id: bots.isEmpty) {
                    // Root state survives navigation; refresh and search never replay this entrance.
                    if !bots.isEmpty && !homeAppeared { homeAppeared = true }
                }
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 18, weight: .medium)).foregroundStyle(KS.muted)
                    TextField("Search bots", text: $search).focused($searchFocused).accessibilityLabel("Search bots").submitLabel(.search)
                        .onSubmit { searchFocused = false }
                    if !search.isEmpty {
                        Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(KS.muted).frame(minWidth: 44, minHeight: 44) }
                            .buttonStyle(PressStyle()).accessibilityLabel("Clear search")
                    }
                }
                    .padding(.horizontal, 14).frame(minHeight: 48).card(.white, radius: 24)
                    .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(searchFocused ? KS.ink : .clear, lineWidth: 2).allowsHitTesting(false))
                if let starred = model.starred {
                    Button { open(starred) } label: {
                        Moji(seed: starred.avatarSeed, size: 38, colorHex: starred.colorHex).frame(width: 48, height: 48).card(.white, radius: 24, shadow: true)
                            .overlay(alignment: .bottomLeading) { Image(systemName: "star.fill").font(.system(size: 10)).padding(5).background(KS.butter, in: Circle()).overlay(Circle().stroke(KS.ink, lineWidth: 2)) }
                    }.buttonStyle(PressStyle()).accessibilityLabel("Open starred bot").accessibilityIdentifier("starred-shortcut")
                }
            }.padding(.horizontal, 20).padding(.vertical, 14).background(KS.paper)
                .overlay(alignment: .top) { Rectangle().fill(KS.ink.opacity(0.1)).frame(height: 1) }
        }
    }
    private func matches(_ bot: Bot) -> Bool {
        search.isEmpty || (bot.name + " " + bot.job).localizedCaseInsensitiveContains(search)
    }
    private func row(_ bot: Bot) -> some View {
                        Button { open(bot) } label: {
                            HStack(spacing: 12) {
                                Moji(seed: bot.avatarSeed, size: 48, colorHex: bot.colorHex)
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(bot.name).font(KS.body(17, .semibold)).lineLimit(2).layoutPriority(1)
                                        if bot.starred { Image(systemName: "star.fill").font(.system(size: 10, weight: .semibold)).accessibilityLabel("Starred") }
                                        Spacer()
                                        if !textSize.isAccessibilitySize { Text(time(bot.activity)).font(KS.mono(10)).foregroundStyle(KS.muted).fixedSize() }
                                    }
                                    HStack {
                                        Text(bot.line.isEmpty ? bot.job : bot.line).lineLimit(textSize.isAccessibilitySize ? 3 : 2).font(KS.body(14)).foregroundStyle(KS.soft)
                                        Spacer()
                                        HomeBadge(unread: bot.unread, needsYou: bot.needsYou)
                                    }
                                }
                            }.padding(.vertical, 18).contentShape(Rectangle())
                        }.buttonStyle(HomeRowStyle()).opacity(bot.archived ? 0.55 : 1).accessibilityIdentifier("bot-" + bot.id)
    }
    private var thread: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { screen = .home; model.openBot = nil } label: { Image(systemName: "chevron.left").font(.system(size: 15, weight: .medium)).frame(width: 34, height: 34).card(.white, radius: 17).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Back to bots")
                Spacer(minLength: 0)
                HStack(spacing: 6) { Moji(seed: model.openBot?.avatarSeed ?? "", size: 24, colorHex: model.openBot?.colorHex); Text(model.openBot?.name ?? "Bot").font(KS.body(15, .semibold)).lineLimit(1) }.padding(.horizontal, 10).frame(minHeight: 34).card(.white, radius: 17)
                Spacer(minLength: 0)
                Menu {
                    Button("Earlier messages") { perform { try await model.olderMessages() } }
                    Button("Bot settings") { screen = .settings }
                } label: { Image(systemName: "ellipsis").frame(width: 34, height: 34).card(.white, radius: 17).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Chat options").accessibilityIdentifier("chat-options")
            }.padding(.horizontal, 8).padding(.vertical, 2)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
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
                                if let bot = model.openBot, agent.id == bot.raw["lead_agent_id"].string {
                                    Moji(seed: bot.avatarSeed, size: 22, colorHex: bot.colorHex)
                                } else { Moji(seed: agent.id, size: 22) }
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(agent.name).font(KS.body(12, .semibold))
                                        Eyebrow("Replying live")
                                    }
                                    Text(typing["text"].string.isEmpty ? "Thinking…" : typing["text"].string).font(KS.body(15)).lineSpacing(1).fixedSize(horizontal: false, vertical: true)
                                }.padding(10).background(.white, in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(KS.ink.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: .infinity)
                    .scrollDismissesKeyboard(.interactively)
                    .defaultScrollAnchor(.bottom)
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
                    } action: { _, value in nearBottom = value }
                    .onChange(of: model.messages.last?.id) { _, _ in
                        guard nearBottom else { return }
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .onChange(of: model.typing) { _, _ in if nearBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
                    .onAppear { nearBottom = true }
            }
            VStack(alignment: .leading, spacing: 6) {
                if !photos.isEmpty {
                    ScrollView(.horizontal) { HStack { ForEach(photos) { photo in
                        if let image = UIImage(data: photo.data) {
                            Image(uiImage: image).resizable().scaledToFill().frame(width: 60, height: 60).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(alignment: .topTrailing) { Button { photos.removeAll { $0.id == photo.id } } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white).padding(5).background(KS.ink, in: Circle()).frame(width: 44, height: 44) }.accessibilityLabel("Remove photo") }
                        }
                    } } }
                }
                HStack(alignment: .bottom, spacing: 6) {
                    PhotosPicker(selection: $selections, maxSelectionCount: max(1, 2 - photos.count), matching: .images) { Image(systemName: "plus").font(.system(size: 18)).frame(width: 44, height: 44) }.disabled(photos.count >= 2 || preparingPhotos || dictation.isRecording || dictationStarting).accessibilityLabel("Add photo")
                    TextField("Ask your bot…", text: $composer, axis: .vertical).font(KS.body(15)).lineLimit(1...4).focused($composerFocused).padding(.vertical, 8).frame(minHeight: 44).disabled(dictation.isRecording || dictationStarting).accessibilityIdentifier("composer")
                    Button {
                        if dictation.isRecording || dictationStarting { dictation.stop(); dictationToken = UUID(); dictationStarting = false }
                        else { composerFocused = false; dictationStarting = true; let token = UUID(); dictationToken = token; let prefix = composer.isEmpty ? "" : composer + " "; Task { await dictation.start { utterance in composer = prefix + utterance }; if dictationToken == token { dictationStarting = false } } }
                    } label: { Image(systemName: (dictation.isRecording || dictationStarting) ? "stop.fill" : "mic").frame(width: 44, height: 44) }.accessibilityLabel((dictation.isRecording || dictationStarting) ? "Stop dictation" : "Dictate message")
                    Button {
                        dictation.stop(); dictationToken = UUID(); dictationStarting = false
                        let text = composer, selected = photos, thread = model.openBot?.threadID, botID = model.openBot?.id
                        perform { try await model.post(text, photos: selected); if let botID, let draft = drafts[botID], draft.text == text && draft.photos == selected { drafts[botID] = nil }; if model.openBot?.threadID == thread && composer == text && photos == selected { composer = ""; photos = [] } }
                    } label: { Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).frame(width: 34, height: 34).background(KS.lime, in: Circle()).frame(width: 44, height: 44).contentShape(Rectangle()) }.disabled((composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty) || model.busy || preparingPhotos).accessibilityLabel("Send message")
                }.padding(.horizontal, 2).card(.white, radius: 23)
                if let error = dictation.error { Text(error).font(KS.body(13)).foregroundStyle(KS.soft) }
            }.padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 6)

        }
    }
    @ViewBuilder private func messageView(_ message: Message) -> some View {
        if message.kind == "schedule" {
            ScheduleCard(model: model, message: message) { screen = .settings }
        } else if message.kind == "task" {
            let task = message.raw["task"]
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(task["resolved"].bool ? "Resolved" : task["status"].string == "completed" ? "Ready for review" : task["status"].string)
                Text(task["title"].string).font(KS.body(15, .semibold))
                Text(task["served"]["provider"].string + " · " + task["branch"].string).font(KS.mono(11))
                (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))) {
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
            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading).card(KS.sage)
        } else if message.kind == "question" {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow("Needs your input")
                Text(message.question["prompt"].string).font(KS.body(15, .semibold))
                Button("Answer question") { sheet = .question(message.question) }.buttonStyle(Pill(fill: KS.coralTint)).disabled(message.question["status"].string != "open")
            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading).card(KS.coralTint)
        } else {
            HStack {
                if message.human { Spacer(minLength: 24) }
                if message.raw["author"]["kind"].string == "agent", let bot = model.openBot, bot.colorHex != nil {
                    Moji(seed: bot.avatarSeed, size: 22, colorHex: bot.colorHex)
                }
                VStack(alignment: .leading, spacing: 3) {
                    if !message.human, !message.raw["author"]["name"].string.isEmpty { Text(message.raw["author"]["name"].string).font(KS.body(12, .semibold)) }
                    ForEach(Array(message.raw["attachments"].array.enumerated()), id: \.offset) { _, attachment in
                        ChatAttachmentView(service: model.service, threadID: model.openBot?.threadID ?? "", messageID: message.id, attachment: attachment)
                    }
                    if !message.text.isEmpty || message.raw["attachments"].array.isEmpty { Text(message.text.isEmpty ? (message.kind == "answer" ? "Answer sent" : message.kind.capitalized) : message.text)
                        .font(KS.body(15)).lineSpacing(1).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                }.padding(.horizontal, 12).padding(.vertical, 9).foregroundStyle(message.human ? KS.paper : KS.ink).card(message.human ? KS.ink : .white)
                if !message.human { Spacer(minLength: 16) }
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
            }.padding(.horizontal, 12)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(filteredTasks.enumerated()), id: \.offset) { _, row in
                        Button {
                            if let bot = model.bots.first(where: { $0.id == row["bot_id"].string || $0.threadID == row["thread_id"].string }) { open(bot) }
                            else { sheet = .changes(row["objective"].string + "\n\n" + row["status"].string + "\n" + row["next_step"].string) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Eyebrow(row["status"].string.isEmpty ? row["label"].string : row["status"].string)
                                Text(row["objective"].string.isEmpty ? row["title"].string : row["objective"].string).font(KS.body(15, .semibold))
                                Text(taskDetail(row)).font(KS.body(13)).foregroundStyle(KS.soft)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(10).card(.white)
                        }.buttonStyle(PressStyle())
                    }
                    if filteredTasks.isEmpty { empty("Nothing here right now.") }
                }.padding(12)
            }.frame(maxHeight: .infinity)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 2) {
                ForEach(["All", "Needs you", "Working", "Done"], id: \.self) { item in
                    Button { filter = item } label: {
                        Text(item).font(.system(size: filterLabelSize, weight: .semibold))
                            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 32)
                            .background {
                                if filter == item {
                                    Capsule().fill(KS.lime)
                                        .matchedGeometryEffect(id: "task-filter", in: taskFilterSelection)
                                }
                            }
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityAddTraits(filter == item ? .isSelected : [])
                }
              }
              .animation(reduceMotion ? nil : KS.glide, value: filter)
              .padding(.horizontal, 4).card(.white, radius: 24)
              .padding(.horizontal, 12).padding(.vertical, 4)
            }.fixedSize(horizontal: false, vertical: true).buttonStyle(PressStyle())
                .overlay(alignment: .top) { Rectangle().fill(KS.ink.opacity(0.12)).frame(height: 1) }
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
        VStack(alignment: .leading, spacing: 4) {
            Text(String(format: "%02d", count)).font(KS.display(28)).monospacedDigit()
                .contentTransition(reduceMotion ? .identity : .numericText(value: Double(count)))
                .animation(reduceMotion ? nil : KS.glide, value: count)
            Text(name).font(KS.mono(9))
        }
            .frame(maxWidth: .infinity, alignment: .leading).padding(10).card(color, radius: 14)
    }
    private var usage: some View {
        VStack(spacing: 0) {
            header("Usage") { screen = .home }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    Text("Auto work follows your host’s routing policy and available quota.").foregroundStyle(KS.soft).fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(model.status["usage"].array.enumerated()), id: \.offset) { _, usage in
                        (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(spacing: 12))) {
                            ZStack {
                                Circle().stroke(KS.paper, lineWidth: 10)
                                Circle().trim(from: 0, to: max(0, min(1, (usage["headroom"].number ?? 0) / 100))).stroke(KS.tint(usage["provider"].string), lineWidth: 10).rotationEffect(.degrees(-90))
                                Circle().stroke(KS.ink, lineWidth: 2).padding(-5)
                                Circle().stroke(KS.ink, lineWidth: 2).padding(5)
                                Text(usage["headroom"].number.map { "\(Int($0))%" } ?? "—").font(.system(size: 16, weight: .bold, design: .rounded)).monospacedDigit()
                            }.frame(width: 48, height: 48).accessibilityLabel("\(usage["provider"].string), \(usage["headroom"].number.map { "\(Int($0)) percent left" } ?? "quota unavailable")")
                            VStack(alignment: .leading, spacing: 3) {
                                Text(usage["provider"].string.capitalized + " · " + usage["plan"].string.uppercased()).font(KS.body(15, .semibold))
                                ForEach(Array(usage["windows"].array.enumerated()), id: \.offset) { _, window in
                                    Text(windowText(window)).font(KS.body(13)).foregroundStyle(KS.soft)
                                }
                                if !usage["ok"].bool { Text("Quota reading unavailable").font(KS.body(14)) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(12).card(.white)
                    }
                    if model.status["usage"].array.isEmpty { empty("No quota readings from the host yet.") }
                    routingSummary.padding(.top, 10)
                }.padding(12)
            }
        }
    }
    private var routingSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
                Eyebrow("01 — Auto order, right now")
                Text(model.status["routing"]["reason"].string).font(KS.body(14))
                ForEach(["research", "patch", "review", "summary"], id: \.self) { kind in
                    let choice = model.status["routing"]["by_kind"][kind]
                    (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout())) {
                        Text(kind.capitalized).foregroundStyle(KS.soft)
                        if !textSize.isAccessibilitySize { Spacer() }
                        Text(choice["provider"].string.isEmpty ? "No eligible provider" : choice["provider"].string.capitalized).fontWeight(.semibold)
                    }.font(KS.body(14))
                }
                Button("Refresh usage") { Task { await model.refresh() } }.buttonStyle(Pill(primary: true)).disabled(model.loading)
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
    // Value-type parse strategies reuse Foundation's formatter cache across rows.
    (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))) ?? (try? Date(value, strategy: .iso8601))
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
        GeometryReader { geometry in
          ScrollView {
           VStack(alignment: .leading, spacing: 20) {
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
           .padding(20).frame(minHeight: geometry.size.height, alignment: .topLeading)
          }.scrollDismissesKeyboard(.interactively).scrollBounceBehavior(.basedOnSize)
        }.background(KS.paper)
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
    @Environment(\.dynamicTypeSize) private var textSize
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { CloseButton(action: close).accessibilityIdentifier("close-sheet"); Text("NEW BOT.").font(KS.display(32)) }
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("01 — Name", text: $draft.name, prompt: "e.g. Launch")
                    field("02 — What it does", text: $draft.job, prompt: "Plans each product launch…", lines: 2...3)
                    Eyebrow("03 — Project and lead")
                    (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16)) : AnyLayout(HStackLayout(spacing: 10))) {
                        VStack(alignment: .leading, spacing: 4) {
                        Eyebrow("Project")
                        Picker("Project", selection: $draft.project) { Text("Choose project").tag(""); ForEach(model.scopes, id: \.self) { Text($0.replacingOccurrences(of: "project:", with: "")).tag($0) } }.pickerStyle(.menu).padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: 44).card(.white, radius: 14).accessibilityIdentifier("project-picker")
                        }
                        VStack(alignment: .leading, spacing: 4) {
                        Eyebrow("Lead")
                        Picker("Lead", selection: $draft.lead) { Text("A new agent").tag(""); ForEach(model.agents.filter { $0["scope"].string == draft.project }, id: \.self) { Text($0["name"].string).tag($0["id"].string) } }.pickerStyle(.menu).padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: 44).card(.white, radius: 14).accessibilityIdentifier("lead-picker")
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
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(question["options"].array.map(\.string), id: \.self) { option in
                        Button {
                            if choices.contains(option) { choices.remove(option) }
                            else { if !question["multi"].bool { choices = [] }; choices.insert(option) }
                        } label: { HStack { Text(option); Spacer(); Image(systemName: choices.contains(option) ? "checkmark.circle.fill" : "circle") } }
                            .buttonStyle(Pill(fill: choices.contains(option) ? KS.lime : .white))
                    }
                    if question["free_text"].bool { field("Anything else", text: $text, prompt: "e.g. skip X this time") }
                }.padding(3)
            if let error { Text(error).font(KS.body(14)) }
            Button(saving ? "Sending…" : "Send answer") {
                saving = true
                Task {
                    defer { saving = false }
                    do {
                        guard let service = model.service else { return }
                        var input: [String: JSON] = ["question_id": question["id"], "choices": .strings(choices.sorted()), "idempotency_key": .string(requestID)]
                        // The service refuses an empty string: a blank note is no note.
                        let note = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !note.isEmpty { input["text"] = .string(note) }
                        _ = try await service.call("question_answer", input)
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
    @State private var confirmingDelete = false
    @State private var confirmName = ""
    private var savedBot: Bot { model.bots.first { $0.id == draft.id } ?? draft }
    @State private var error: String?
    @State private var saving = false
    @Environment(\.dynamicTypeSize) private var textSize
    init(model: AppModel, bot: Bot, close: @escaping () -> Void) { self.model = model; self.close = close; _draft = State(initialValue: bot) }
    private func string(_ key: String) -> Binding<String> { Binding(get: { draft.raw[key].string }, set: { draft.raw[key] = .string($0) }) }
    private func rule(_ key: String) -> Binding<Bool> { Binding(get: { draft.raw["rules"][key] == .null ? key != "require_tests" : draft.raw["rules"][key].bool }, set: { draft.raw["rules"][key] = .bool($0) }) }
    var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: 14) {
                HStack { CloseButton(action: close); Moji(seed: draft.avatarSeed, size: 40, colorHex: draft.colorHex); Text(draft.name.uppercased() + ".").font(KS.display(30)) }
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView {
                  VStack(alignment: .leading, spacing: 12) {
                    Text(draft.job).foregroundStyle(KS.soft).fixedSize(horizontal: false, vertical: true)
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
                        Eyebrow("Schedule")
                        TextField("Cron, e.g. 0 9 * * 1-5", text: Binding(get: { draft.raw["schedule"].string }, set: {
                            draft.raw["schedule"] = $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string($0)
                        })).textInputAutocapitalization(.never).autocorrectionDisabled().padding(12).card(.white, radius: 14)
                        Text("Optional CRON_TZ=Area/City prefix. Leave blank to clear.").font(KS.body(14)).foregroundStyle(KS.muted)
                        Toggle("Star this bot (your bottom-right shortcut)", isOn: Binding(get: { draft.starred }, set: { draft.raw["starred"] = .bool($0) })).frame(minHeight: 44)
                        Toggle("Ask me before anything public", isOn: rule("approve_public")).frame(minHeight: 44)
                        Toggle("Review every edit", isOn: rule("review_edits")).frame(minHeight: 44)
                        Toggle("Run tests before an edit is done", isOn: rule("require_tests")).frame(minHeight: 44)
                    }.padding(14).card(.white).padding(4)
                    if textSize.isAccessibilitySize { settingsActions }
                  }
                }.frame(maxHeight: .infinity).scrollDismissesKeyboard(.interactively)
                if !textSize.isAccessibilitySize { settingsActions }
            }.padding(16)
        }
        .alert("Delete bot permanently?", isPresented: $confirmingDelete) {
            TextField("Bot name", text: $confirmName).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Delete bot", role: .destructive) {
                saving = true
                Task {
                    defer { saving = false }
                    do { try await model.delete(savedBot, confirmName: confirmName); close() }
                    catch { self.error = safeError(error) }
                }
            }.disabled(confirmName != savedBot.name || saving)
        } message: {
            Text("This hides the bot and permanently deletes it and its chat. Type “" + savedBot.name + "” to confirm.")
        }
    }
    private var settingsActions: some View {
        VStack(alignment: .leading, spacing: 14) {
                if let error { Text(error).font(KS.body(14)) }
                Text("Changes apply from the next turn. Running work keeps its settings.").font(KS.body(14)).foregroundStyle(KS.muted)
                Button(saving ? "Saving…" : "Save changes") {
                    saving = true
                    Task { defer { saving = false }; do { try await model.save(draft); close() } catch { self.error = safeError(error) } }
                }.buttonStyle(Pill(fill: KS.lime, primary: true)).disabled(saving || model.isDemo || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 12)) : AnyLayout(HStackLayout(spacing: 12))) {
                    Button(savedBot.archived ? "Unhide" : "Hide bot") { changeVisibility() }
                        .buttonStyle(Pill(danger: !savedBot.archived)).frame(maxWidth: .infinity)
                    Button("Delete bot…") { confirmName = ""; confirmingDelete = true }
                        .buttonStyle(Pill(danger: true)).frame(maxWidth: .infinity)
                }.disabled(saving || model.isDemo)
        }
    }
    private func changeVisibility() {
        saving = true
        Task {
            defer { saving = false }
            do {
                if savedBot.archived { try await model.unarchive(savedBot) }
                else { try await model.archive(savedBot) }
                close()
            } catch { self.error = safeError(error) }
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
        if ProcessInfo.processInfo.arguments.contains("-appearance-demo") {
            bots[0].raw["avatar"] = .string("scout")
            bots[0].raw["color"] = .string("peach")
        }
        if ProcessInfo.processInfo.arguments.contains("-hidden-bot-demo") {
            bots[bots.count - 1].raw["archived"] = .bool(true)
        }
        if ProcessInfo.processInfo.arguments.contains("-new-user-demo") { bots = []; return }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .offset(x: offset)
                .simultaneousGesture(DragGesture(minimumDistance: 12, coordinateSpace: .global)
                    .onChanged { value in
                        guard value.startLocation.x < 28, value.translation.width > 0 else { return }
                        if !reduceMotion { offset = value.translation.width }
                    }
                    .onEnded { value in
                        guard value.startLocation.x < 28 else { return }
                        if value.translation.width > geo.size.width / 3 || value.predictedEndTranslation.width > geo.size.width * 0.6 {
                            if reduceMotion { action(); offset = 0; return }
                            withAnimation(.easeOut(duration: 0.18)) { offset = geo.size.width }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { action(); offset = 0 }
                        } else {
                            withAnimation(reduceMotion ? nil : .spring(duration: 0.25)) { offset = 0 }
                        }
                    })
        }
    }
}
extension View { func swipeBack(_ action: @escaping () -> Void) -> some View { modifier(SwipeBack(action: action)) } }


struct ScheduleCard: View {
    @Bindable var model: AppModel
    let message: Message
    var edit: () -> Void
    @State private var saving = false
    @State private var error: String?
    private var card: JSON { message.raw["ref"] }
    private var bot: Bot? { model.bots.first { $0.id == card["bot_id"].string && $0.threadID == message.raw["thread_id"].string } }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Eyebrow("Schedule")
            Text(card["description"].string.isEmpty ? message.text : card["description"].string).font(KS.body(15, .semibold))
            Text(card["timezone"].string).font(KS.mono(12))
            if card["paused"].bool { Text("Paused") }
            ForEach(card["next_runs"].array.map(\.string), id: \.self) { value in
                if let run = date(value) { Text(run, format: .relative(presentation: .named)) }
            }
            HStack {
                Button(card["paused"].bool ? "Resume" : "Pause") {
                    guard let bot, let service = model.service else { return }
                    saving = true; error = nil
                    Task {
                        defer { saving = false }
                        do {
                            let result = try await service.call("bot_update", ["bot_id": .string(bot.id), "expected_version": bot.raw["version"],
                                "rules": .object(["schedule_paused": .bool(!card["paused"].bool)])])
                            let updated = Bot(raw: result["bot"])
                            if let i = model.bots.firstIndex(where: { $0.id == updated.id }) { model.bots[i] = updated }
                            if model.openBot?.id == updated.id { model.openBot = updated }
                            try await model.readThread(updated)
                        } catch { self.error = safeError(error); await model.refresh() }
                    }
                }.buttonStyle(Pill(fill: KS.lime))
                    .disabled(saving || model.isDemo || bot == nil || card["cron"] == .null)
                Button("Edit") { if let bot { model.openBot = bot; edit() } }.buttonStyle(Pill()).disabled(bot == nil || saving)
            }
            if let error { Text(error).font(KS.body(14)) }
        }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading).card(.white)
    }
}

private struct ChatAttachmentView: View {
    let service: (any HostService)?
    let threadID: String
    let messageID: String
    let attachment: JSON
    @State private var image: UIImage?
    @State private var failed = false
    init(service: (any HostService)?, threadID: String, messageID: String, attachment: JSON) {
        self.service = service; self.threadID = threadID; self.messageID = messageID; self.attachment = attachment
        // A cached photo shows in the first frame: no spinner flash when a chat reopens.
        _image = State(initialValue: PhotoCache.data(attachment["sha256"].string).flatMap(UIImage.init(data:)))
    }
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 230, maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 10)).accessibilityLabel(attachment["name"].string) }
            else if failed { Button("Retry photo") { Task { await load() } }.frame(minHeight: 44) }
            else { ProgressView().frame(width: 100, height: 80) }
        }.task { await load() }
    }
    private func load() async {
        let sha = attachment["sha256"].string
        if let data = PhotoCache.data(sha), let cached = UIImage(data: data) { image = cached; failed = false; return }
        do {
            guard let service else { throw AppFailure.invalidResponse }
            let result = try await service.call("thread_attachment_get", ["thread_id": .string(threadID), "message_id": .string(messageID), "attachment_id": attachment["id"]])
            guard let data = Data(base64Encoded: result["attachment"]["data_base64"].string), data.count <= 160 * 1024, let decoded = UIImage(data: data) else { throw AppFailure.invalidResponse }
            image = decoded; failed = false
            PhotoCache.store(data, sha256: sha)
        } catch { failed = true }
    }
}
