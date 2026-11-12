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
        if !ProcessInfo.processInfo.arguments.contains("-demo") {
            Runtime.model.onConnectionChanged = {
                WatchBridge.shared.changed()
                if Runtime.model.connected {
                    LiveActivityManager.shared.start(model: Runtime.model)
                }
            }
            WatchBridge.shared.changed()
        }
        Runtime.model.onFirstBotList = {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            }
            guard Runtime.model.connected else { return }
            UIApplication.shared.registerForRemoteNotifications()
            LiveActivityManager.shared.start(model: Runtime.model)
        }
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await Runtime.model.registerPushToken(deviceToken) }
    }
    // Completion-handler forms, answered on the main thread. The async forms return on a background
    // executor, and UIKit's tap handling then asserts it is off the main thread: tapping a push crashed.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let id = PushNotification.botID(notification.request.content.userInfo)
        nonisolated(unsafe) let done = completionHandler
        DispatchQueue.main.async {
            MainActor.assumeIsolated { done(id != nil && id == Runtime.model.visibleThreadBotID ? [] : [.banner, .sound, .badge]) }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let tapped = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        let id = PushNotification.botID(response.notification.request.content.userInfo)
        nonisolated(unsafe) let done = completionHandler
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if tapped, let id { Runtime.model.receivePushTap(["bot_id": id]) }
                done()
            }
        }
    }
}

@main struct SwarmaaApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    var body: some Scene {
        WindowGroup {
            RootView(model: Runtime.model)
                .preferredColorScheme(.dark)
                .tint(KS.signal)
                .onOpenURL { url in
                    if url.scheme == "swarmaa" {
                        if url.host == "bot" {
                            let botId = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                            if !botId.isEmpty {
                                Runtime.model.receivePushTap(["bot_id": botId])
                            }
                        } else if url.host == "pair" || (url.query?.contains("code=") ?? false) {
                            Task { try? await Runtime.model.handlePairingURL(url) }
                        }
                    }
                }
        }
    }
}

// Swarmaa navy: the same workspace palette as the Mac app and swarmaa.com.
enum KS {
    /// Screen ground, grouped/sheet ground, cards, inset wells, chips.
    static let ground = Color(hex: 0x0B182D), grouped = Color(hex: 0x0D1C33), surface = Color(hex: 0x12233E)
    static let inset = Color(hex: 0x081326), chip = Color(hex: 0x182C4D), mine = Color(hex: 0x1B3155)
    static let hairline = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255).opacity(0.08)
    static let optionLine = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255).opacity(0.14)
    /// Text: body, titles and names, secondary.
    static let ink = Color(hex: 0xE3E9F2), strong = Color(hex: 0xF2F5FA), muted = Color(hex: 0x8B9CB6), soft = Color(hex: 0xB3C1D4)
    /// Signal blue: primary buttons, progress, running. Text on it is navy.
    static let signal = Color(hex: 0x8FB8FF), onSignal = Color(hex: 0x0A1830), signalTint = Color(hex: 0x8FB8FF).opacity(0.14)
    static let needsTint = Color(hex: 0xE0A77A).opacity(0.16), needsText = Color(hex: 0xECC09A)
    static let readyTint = Color(hex: 0xB9C9A2).opacity(0.16), readyText = Color(hex: 0xCDDCB8)
    static let failedTint = Color(hex: 0xE0896A).opacity(0.16), failedText = Color(hex: 0xE0896A)
    /// A card that needs you: the card warmed a touch toward amber.
    static let attentionSurface = Color(hex: 0x1E2C42)
    static let neutralTint = chip
    static let online = Color(hex: 0xCDDCB8)

    // One type scale, on text styles so Dynamic Type keeps working.
    /// 22 semibold: screen and sheet titles.
    static func title() -> Font { .system(.title2, design: .default, weight: .semibold) }
    /// 16 semibold: card titles, row names.
    static func headline() -> Font { .system(.callout, design: .default, weight: .semibold) }
    /// 15: body copy, messages, buttons.
    static func body(_ weight: Font.Weight = .regular) -> Font { .system(.subheadline, design: .default, weight: weight) }
    /// 13: meta lines and captions.
    static func secondary(_ weight: Font.Weight = .regular) -> Font { .system(.footnote, design: .default, weight: weight) }
    /// 11 semibold, upper case and tracked (see Eyebrow).
    static func label() -> Font { .system(.caption2, design: .default, weight: .semibold) }
    /// 12 mono: times, durations, branches, counts.
    static func mono(_ weight: Font.Weight = .regular) -> Font { .system(.caption, design: .monospaced, weight: weight) }

    static func tint(_ provider: String) -> Color {
        switch provider { case "claude": Color(hex: 0xC99D72); case "codex": Color(hex: 0xAEB6BD); case "antigravity": Color(hex: 0x7AA7F2); default: chip }
    }
    static func monogram(_ provider: String) -> String {
        switch provider { case "claude": "CL"; case "codex": "CX"; case "antigravity": "AG"; default: String(provider.prefix(2)).uppercased() }
    }
    // Short, interaction-driven motion; no ambient work while reading a thread.
    static let settle = Animation.spring(response: 0.28, dampingFraction: 0.78)
    static let glide = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.28)
}
extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}
extension View {
    /// Navy cards part by tone and a hairline, not shadow.
    func card(_ color: Color = KS.surface, radius: CGFloat = 12) -> some View {
        background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(KS.hairline, lineWidth: 1).allowsHitTesting(false))
    }
    /// Agent messages are cards; yours are right-aligned bubbles.
    func bubble(human: Bool = false) -> some View {
        card(human ? KS.mine : KS.surface)
    }
}
struct StatusChip: View {
    var text: String
    init(_ text: String) { self.text = text }
    private var needs: Bool { text.lowercased().hasPrefix("needs") || text == "open" }
    private var ready: Bool { ["ready for review", "resolved", "completed", "done"].contains(text.lowercased()) }
    private var running: Bool { ["running", "queued", "working"].contains(text.lowercased()) }
    private var failed: Bool { ["failed", "blocked"].contains(text.lowercased()) }
    var body: some View {
        Text(text.prefix(1).uppercased() + text.dropFirst())
            .font(KS.secondary(.semibold))
            .foregroundStyle(failed ? KS.failedText : needs ? KS.needsText : ready ? KS.readyText : running ? KS.signal : KS.soft)
            .padding(.horizontal, 8).frame(minHeight: 22)
            .background(failed ? KS.failedTint : needs ? KS.needsTint : ready ? KS.readyTint : running ? KS.signalTint : KS.neutralTint, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .fixedSize(horizontal: false, vertical: true)
    }
}
struct Pill: ButtonStyle {
    var fill: Color = KS.chip
    var primary = false
    /// Hide and delete use the destructive tint.
    var danger = false
    var answerOption = false
    @Environment(\.isEnabled) var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        let pressed = enabled && configuration.isPressed
        let filled = primary || fill == KS.signal
        configuration.label.font(KS.body(.semibold)).foregroundStyle(danger ? KS.failedText : filled ? KS.onSignal : KS.ink)
            .padding(.horizontal, 14).padding(.vertical, 6).frame(minHeight: primary ? 48 : 36)
            .frame(maxWidth: primary || danger ? .infinity : nil)
            .background(danger ? KS.failedTint : primary ? KS.signal : fill, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay { if !filled && !danger { RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(answerOption ? KS.optionLine : KS.hairline, lineWidth: 1).allowsHitTesting(false) } }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : KS.settle, value: pressed)
    }
}
/// Feedback for rows and icon controls without adding a second visual container.
struct PressStyle: ButtonStyle {
    var icon = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        let pressed = enabled && configuration.isPressed
        configuration.label
            .background { if icon && pressed { Circle().fill(KS.chip).frame(width: 36, height: 36) } }
            .opacity(pressed ? 0.8 : 1)
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : KS.settle, value: pressed)
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
                Text(needsYou > 0 ? "Needs you" : "\(unread)").font(KS.mono(.semibold)).foregroundStyle(needsYou > 0 ? KS.needsText : KS.onSignal).padding(.horizontal, 7)
                    .frame(minWidth: 22, minHeight: 22).background(needsYou > 0 ? KS.needsTint : KS.signal, in: Capsule())
                    .accessibilityLabel(needsYou > 0 ? "Needs you" : "\(unread) unread")
            }
        }
        .keyframeAnimator(initialValue: CGFloat(1), trigger: pop) { content, scale in
            content.scaleEffect(reduceMotion ? 1 : scale)
        } keyframes: { _ in
            SpringKeyframe(1.15, duration: 0.12)
            SpringKeyframe(1, duration: 0.18)
        }
        .onChange(of: [unread, needsYou]) { old, new in
            if !reduceMotion && shouldPopHomeBadge(oldUnread: old[0], oldNeedsYou: old[1], unread: new[0], needsYou: new[1]) { pop += 1 }
        }
    }
}
/// A monogram circle: a bot's initials in its chosen colour, or an agent's provider (CL, CX, AG).
struct Avatar: View {
    var name: String
    var size: CGFloat = 32
    var colorHex: UInt32?
    var provider = ""
    private var letters: String {
        if !provider.isEmpty { return KS.monogram(provider) }
        let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let text = words.count > 1 ? String(words[0].prefix(1) + words[1].prefix(1)) : String(name.prefix(2))
        return text.isEmpty ? "?" : text.uppercased()
    }
    var body: some View {
        let fill = !provider.isEmpty ? KS.tint(provider) : colorHex.map { Color(hex: $0) } ?? KS.chip
        let filled = !provider.isEmpty || colorHex != nil
        Text(letters).font(.system(size: size * 0.34, weight: .bold, design: .monospaced))
            .foregroundStyle(filled ? KS.onSignal : KS.ink)
            .frame(width: size, height: size)
            .background(fill, in: Circle())
            .overlay { if !filled { Circle().strokeBorder(KS.optionLine, lineWidth: 1) } }
            .accessibilityHidden(true)
    }
}
struct Eyebrow: View {
    var text: String
    var color: Color = KS.muted
    init(_ text: String, color: Color = KS.muted) { self.text = text; self.color = color }
    var body: some View { Text(text.uppercased()).font(KS.label()).tracking(0.9).foregroundStyle(color).fixedSize(horizontal: false, vertical: true) }
}
struct CloseButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(KS.ink)
                .frame(width: 32, height: 32).background(KS.chip, in: Circle()).frame(width: 44, height: 44).contentShape(Rectangle())
        }
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
            .background(KS.grouped).foregroundStyle(KS.ink).tint(KS.signal)
            .presentationDetents([.height(measured)])
            .presentationDragIndicator(.hidden).presentationCornerRadius(20)
            .presentationBackground(KS.grouped)
    }
}

enum Screen: String { case home, thread, tasks, usage, connect, settings }
enum Sheet: Identifiable {
    case you, question(JSON), newBot, changes(String), memos, transactions
    var id: String {
        switch self { case .you: "you"; case .question(let q): "question-" + q["id"].string; case .newBot: "newBot"; case .changes: "changes"; case .memos: "memos"; case .transactions: "transactions" }
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
    @Environment(\.horizontalSizeClass) private var sizeClass
    @FocusState private var searchFocused: Bool
    @FocusState private var composerFocused: Bool
    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                if model.connected || model.isDemo {
                    // A stack, like a navigation controller: home stays put underneath, deeper screens
                    // slide in from the right over it and slide back out, so going back reveals home.
                    ZStack {
                        if sizeClass == .regular {
                            // iPad (or any regular-width window): the Mac's three columns. Compact keeps the stack below.
                            IPadWorkspace(model: model, screen: $screen, sheet: $sheet, search: $search, open: open,
                                          threadBody: { threadBody }, tasksBody: { tasksView(embedded: true) }, usageBody: { usageView(embedded: true) })
                                .accessibilityHidden(![.home, .thread, .tasks, .usage].contains(screen)).allowsHitTesting([.home, .thread, .tasks, .usage].contains(screen))
                        } else {
                        home.accessibilityHidden(screen != .home).allowsHitTesting(screen == .home)
                        if screen == .thread || (screen == .settings && model.openBot != nil) {
                            thread.swipeBack { screen = .home; model.openBot = nil }
                                .background(KS.ground).transition(.move(edge: .trailing))
                                .accessibilityHidden(screen != .thread)
                        }
                        }
                        if screen == .tasks && sizeClass != .regular { tasksView().swipeBack { screen = .home }.background(KS.ground).transition(.move(edge: .trailing)) }
                        if screen == .usage && sizeClass != .regular { usageView().swipeBack { screen = .home }.background(KS.ground).transition(.move(edge: .trailing)) }
                        if screen == .connect {
                            ConnectView(model: model) { screen = .home }.swipeBack { screen = .home }.background(KS.ground).transition(.move(edge: .trailing))
                        }
                        if screen == .settings {
                            Group {
                                if let bot = model.openBot ?? model.starred { SettingsView(model: model, bot: bot) { screen = model.openBot == nil ? .home : .thread }.swipeBack { screen = model.openBot == nil ? .home : .thread } }
                                else { empty("Open a bot to change its settings.") }
                            }.background(KS.ground).transition(.move(edge: .trailing))
                        }
                    }
                } else { ConnectView(model: model) { screen = .home } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(KS.ground).foregroundStyle(KS.ink)
            .font(KS.body()).tint(KS.signal)
            .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.9), value: screen)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let error = model.error {
                    HStack { Text(error).font(KS.body()).foregroundStyle(KS.strong); Spacer(minLength: 8); Button("Dismiss") { model.error = nil }.font(KS.body(.semibold)).foregroundStyle(KS.signal).frame(minHeight: 44) }
                        .padding(.horizontal, 20).background(KS.attentionSurface).overlay(alignment: .top) { Rectangle().fill(KS.failedText).frame(height: 1) }.accessibilityIdentifier("error")
                }
            }
        }
        .sheet(item: $sheet) { item in
            if case .newBot = item {
                NewBotView(model: model) { sheet = nil }
                    .padding(20).background(KS.grouped).foregroundStyle(KS.ink).tint(KS.signal)
                    .presentationDetents([.large]).presentationDragIndicator(.hidden).presentationCornerRadius(20).presentationBackground(KS.grouped)
            } else { ContentSheet {
                switch item {
                case .you: you
                case .memos: PhoneMemosView { sheet = nil }
                case .transactions: PhoneTransactionReviewsView { sheet = nil }
                case .question(let question): AnswerView(model: model, question: question) { sheet = nil }
                case .newBot: NewBotView(model: model) { sheet = nil }
                case .changes(let changes):
                    VStack(alignment: .leading, spacing: 14) {
                        CloseButton { sheet = nil }; Text("Changes").font(KS.title()).foregroundStyle(KS.strong)
                        ScrollView { Text(changes).font(KS.mono()).foregroundStyle(KS.ink).frame(maxWidth: .infinity, alignment: .leading).padding(12) }.frame(maxHeight: 300).card(KS.inset)
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
        .onChange(of: sizeClass) { _, _ in updateVisibleThread() }
        // On iPad another bot opens without leaving .home, so follow the open bot too.
        .onChange(of: model.openBot?.id) { _, _ in updateVisibleThread(); model.clearVisibleUnread() }
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
            if !model.isDemo && !ProcessInfo.processInfo.arguments.contains("-demo") { WatchBridge.shared.changed() }
            Task { await model.refresh() }
            if Runtime.openStarRequested, model.openBot != nil { screen = .thread; Runtime.openStarRequested = false }
            openPushBot()
        }
    }
    private func updateVisibleThread() {
        let shown = screen == .thread || (sizeClass == .regular && screen == .home)
        model.visibleThreadBotID = shown && sheet == nil ? model.openBot?.id : nil
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
            Text(title).font(KS.title()).foregroundStyle(KS.strong).minimumScaleFactor(0.7).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.vertical, 4)
    }
    /// A new user's list: one big item that starts their first bot chat, pinned above the bottom bar.
    private var firstBotCard: some View {
        Button { sheet = .newBot } label: {
            HStack(spacing: 14) {
                Image(systemName: "plus").font(.system(size: 20, weight: .semibold)).foregroundStyle(KS.onSignal)
                    .frame(width: 44, height: 44).background(KS.signal, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text("Make your first bot").font(KS.headline()).foregroundStyle(KS.strong)
                    Text("A bot keeps one chat for one job, like research, a launch or your releases.").font(KS.body()).foregroundStyle(KS.soft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading).card()
        }.buttonStyle(PressStyle()).accessibilityIdentifier("new-bot-card")
    }
    private func empty(_ text: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "tray").font(.system(size: 28, weight: .light)).accessibilityHidden(true)
            Text(text).font(KS.body()).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }.foregroundStyle(KS.muted).padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func barIcon(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 17, weight: .medium)).foregroundStyle(KS.ink)
            .frame(width: 44, height: 44).background(KS.chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
    private var home: some View {
        let bots = model.sortedBots.filter(matches)
        let hidden = model.hiddenBots.filter(matches)
        let needsYou = model.sortedBots.filter { $0.needsYou > 0 }.count
        let newUser = search.isEmpty && model.sortedBots.isEmpty && model.hiddenBots.isEmpty && !model.loading
        return VStack(spacing: 0) {
            // Read-only up top: host state and the title. Every control lives in the bottom bar.
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Circle().fill(model.online ? KS.online : KS.failedText).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(model.isDemo ? "Mac Studio" : "Your Mac").font(KS.secondary(.semibold)).foregroundStyle(KS.soft).lineLimit(1)
                    Text(model.online ? "Online" : model.lastSeen.map { "Seen " + $0.formatted(.relative(presentation: .numeric)) } ?? "Offline")
                        .font(KS.mono()).foregroundStyle(KS.muted).lineLimit(1)
                }.accessibilityElement(children: .combine)
                (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))) {
                    Text("Bots").font(KS.title()).foregroundStyle(KS.strong).accessibilityAddTraits(.isHeader)
                    Text(needsYou == 0 ? "All caught up" : "\(needsYou) need you").font(KS.body()).foregroundStyle(needsYou == 0 ? KS.muted : KS.needsText)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
            if model.loading { ProgressView("Loading your bots").tint(KS.signal).foregroundStyle(KS.muted).padding() }
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
                        row(bot)
                            .opacity(reduceMotion || homeAppeared || index >= 10 ? 1 : 0)
                            .offset(y: reduceMotion || homeAppeared || index >= 10 ? 0 : 8)
                            .animation(reduceMotion || index >= 10 ? nil : .easeOut(duration: 0.3).delay(Double(index) * 0.035), value: homeAppeared)
                    }
                    if !hidden.isEmpty {
                        Button {
                            withAnimation(reduceMotion ? nil : KS.glide) { model.showHidden.toggle() }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold))
                                    .rotationEffect(.degrees(model.showHidden ? 90 : 0))
                                Eyebrow("Hidden · \(hidden.count)")
                                Spacer()
                            }.foregroundStyle(KS.muted).frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(PressStyle()).padding(.horizontal, 4).padding(.top, 4)
                            .accessibilityLabel("Hidden bots, \(hidden.count)").accessibilityIdentifier("hidden-section")
                        if model.showHidden {
                            ForEach(hidden) { bot in
                                row(bot)
                                    .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: -6)))
                            }
                        }
                    }
                    if bots.isEmpty && hidden.isEmpty && !model.loading {
                        if newUser { empty("Your bots will appear here, with what each one is doing and anything that needs you.") }
                        else { empty("No bots match “\(search)”. Try another name or job.") }
                    }
                }.padding(.horizontal, 16).padding(.bottom, 8)
            }.scrollDismissesKeyboard(.interactively)
                .task(id: bots.isEmpty) {
                    // Root state survives navigation; refresh and search never replay this entrance.
                    if !bots.isEmpty && !homeAppeared { homeAppeared = true }
                }
            VStack(spacing: 10) {
                if newUser { firstBotCard }
                HStack(spacing: 10) {
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .medium)).foregroundStyle(KS.muted)
                        TextField("", text: $search, prompt: Text("Search bots").foregroundStyle(KS.muted)).focused($searchFocused).accessibilityLabel("Search bots").submitLabel(.search)
                            .onSubmit { searchFocused = false }
                        if !search.isEmpty {
                            Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(KS.muted).frame(minWidth: 44, minHeight: 44) }
                                .buttonStyle(PressStyle()).accessibilityLabel("Clear search")
                        }
                    }
                        .padding(.horizontal, 14).frame(minHeight: 48).card(KS.inset)
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(searchFocused ? KS.signal.opacity(0.7) : .clear, lineWidth: 1).allowsHitTesting(false))
                    if let starred = model.starred {
                        Button { open(starred) } label: {
                            Avatar(name: starred.name, size: 36, colorHex: starred.colorHex).frame(width: 48, height: 48).card()
                                .overlay(alignment: .bottomLeading) { Image(systemName: "star.fill").font(.system(size: 9, weight: .bold)).foregroundStyle(KS.onSignal).padding(4).background(KS.needsText, in: Circle()).offset(x: -3, y: 3) }
                        }.buttonStyle(PressStyle()).accessibilityLabel("Open starred bot").accessibilityIdentifier("starred-shortcut")
                    }
                }
                HStack(spacing: 8) {
                    Button { sheet = .you } label: { barIcon("person.crop.circle") }.accessibilityLabel("You")
                    Button { screen = .tasks; perform { try await model.loadTasks() } } label: {
                        barIcon("list.bullet")
                            .overlay(alignment: .topTrailing) {
                                if model.sortedBots.reduce(0, { $0 + $1.needsYou }) > 0 {
                                    Text("\(model.sortedBots.reduce(0, { $0 + $1.needsYou }))").font(KS.mono(.semibold)).foregroundStyle(KS.onSignal)
                                        .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 20).background(KS.needsText, in: Capsule()).offset(x: 6, y: -6)
                                }
                            }
                    }.accessibilityLabel("Tasks")
                    Button { screen = .usage } label: { barIcon("chart.pie") }.accessibilityLabel("Usage")
                    Spacer(minLength: 0)
                    // New users get the big card above instead; this is the quick way for everyone else.
                    if !model.sortedBots.isEmpty || !model.hiddenBots.isEmpty {
                        Button { sheet = .newBot } label: { Label("New bot", systemImage: "plus") }.buttonStyle(Pill(fill: KS.signal))
                            .accessibilityLabel("New bot").accessibilityIdentifier("new-bot-header")
                    }
                }.buttonStyle(PressStyle())
            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8).background(KS.grouped)
                .overlay(alignment: .top) { Rectangle().fill(KS.hairline).frame(height: 1) }
        }
    }
    private func matches(_ bot: Bot) -> Bool {
        search.isEmpty || (bot.name + " " + bot.job).localizedCaseInsensitiveContains(search)
    }
    private func row(_ bot: Bot) -> some View {
        Button { open(bot) } label: {
            HStack(alignment: .top, spacing: 12) {
                Avatar(name: bot.name, size: 36, colorHex: bot.colorHex)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(bot.name).font(KS.headline()).foregroundStyle(KS.strong).lineLimit(2).layoutPriority(1)
                        if bot.starred { Image(systemName: "star.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(KS.needsText).accessibilityLabel("Starred") }
                        Spacer()
                        if !textSize.isAccessibilitySize { Text(time(bot.activity)).font(KS.mono()).foregroundStyle(KS.muted).fixedSize() }
                    }
                    HStack(alignment: .top) {
                        Text(bot.line.isEmpty ? bot.job : bot.line).lineLimit(textSize.isAccessibilitySize ? 3 : 2).font(KS.body()).foregroundStyle(KS.soft)
                        Spacer()
                        HomeBadge(unread: bot.unread, needsYou: bot.needsYou)
                    }
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .card(bot.needsYou > 0 ? KS.attentionSurface : KS.surface)
                .overlay(alignment: .leading) { if bot.needsYou > 0 { UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12).fill(KS.needsText).frame(width: 2) } }
                .contentShape(Rectangle())
        }.buttonStyle(PressStyle()).opacity(bot.archived ? 0.55 : 1).accessibilityIdentifier("bot-" + bot.id)
    }
    private var thread: some View {
        VStack(spacing: 0) {
            // Back is the only control up top; chat options sit beside the composer, in thumb reach.
            HStack(spacing: 10) {
                Button { screen = .home; model.openBot = nil } label: { Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold)).foregroundStyle(KS.ink).frame(width: 32, height: 32).background(KS.chip, in: Circle()).frame(width: 44, height: 44).contentShape(Rectangle()) }
                    .buttonStyle(PressStyle()).accessibilityLabel("Back to bots")
                Avatar(name: model.openBot?.name ?? "Bot", size: 32, colorHex: model.openBot?.colorHex)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.openBot?.name ?? "Bot").font(KS.headline()).foregroundStyle(KS.strong).lineLimit(1)
                    if let job = model.openBot?.job, !job.isEmpty { Text(job).font(KS.secondary()).foregroundStyle(KS.muted).lineLimit(1) }
                }.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
            }.padding(.horizontal, 8).padding(.vertical, 4).background(KS.ground)
                .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
            threadBody
        }
    }
    /// Messages and composer; the iPhone puts its back header above, the iPad its bot header and tabs.
    private var threadBody: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    // Not lazy: a lazy stack keeps the bottom anchor on estimated row heights, and when the column
                    // width changes (iPad map, sidebar) the offset lands past the real content: a blank thread.
                    // A thread page is at most a few hundred rows, so measuring them all is cheap.
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(threadRows(model.messages)) { row in
                            if row.folded {
                                let threadID = model.openBot?.threadID ?? ""
                                DisclosureGroup(isExpanded: Binding(
                                    get: { model.expandedWorkingNotes[threadID, default: []].contains(row.id) },
                                    set: { if $0 { model.expandedWorkingNotes[threadID, default: []].insert(row.id) }
                                           else { model.expandedWorkingNotes[threadID]?.remove(row.id) } }
                                )) {
                                    ForEach(row.messages) { messageView($0).id($0.id) }
                                } label: { Text(row.label).font(KS.secondary()).foregroundStyle(KS.muted).frame(minHeight: 44) }
                            } else if let message = row.messages.first {
                                messageView(message).id(message.id)
                            }
                        }
                        ForEach(Array(model.typing.enumerated()), id: \.offset) { _, typing in
                            let agent = model.replyingAgent(typing)
                            HStack(alignment: .top, spacing: 10) {
                                Avatar(name: agent.name, size: 28, provider: provider(agent.id))
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(agent.name).font(KS.body(.semibold)).foregroundStyle(KS.strong)
                                        Text("Replying live").font(KS.mono()).foregroundStyle(KS.signal)
                                    }
                                    Text(typing["text"].string.isEmpty ? "Thinking…" : typing["text"].string).font(KS.body()).foregroundStyle(KS.soft).lineSpacing(1).fixedSize(horizontal: false, vertical: true)
                                }.padding(12).frame(maxWidth: .infinity, alignment: .leading).bubble()
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
                                .overlay(alignment: .topTrailing) { Button { photos.removeAll { $0.id == photo.id } } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(KS.strong).padding(5).background(KS.inset, in: Circle()).frame(width: 44, height: 44) }.accessibilityLabel("Remove photo") }
                        }
                    } } }
                }
                HStack(alignment: .bottom, spacing: 6) {
                Menu {
                    Button("Earlier messages") { perform { try await model.olderMessages() } }
                    Button("Bot settings") { screen = .settings }
                } label: { Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).foregroundStyle(KS.ink).frame(width: 44, height: 44).background(KS.chip, in: RoundedRectangle(cornerRadius: 12, style: .continuous)).contentShape(Rectangle()) }
                    .accessibilityLabel("Chat options").accessibilityIdentifier("chat-options")
                HStack(alignment: .bottom, spacing: 6) {
                    if !model.hasOpenApproval {
                    PhotosPicker(selection: $selections, maxSelectionCount: max(1, 2 - photos.count), matching: .images) { Image(systemName: "plus").font(.system(size: 17)).foregroundStyle(KS.soft).frame(width: 44, height: 44) }.disabled(photos.count >= 2 || preparingPhotos || dictation.isRecording || dictationStarting).accessibilityLabel("Add photo") }
                    TextField("", text: $composer, prompt: Text(model.hasOpenApproval ? "Answer the approval above to continue" : "Ask your bot…").foregroundStyle(KS.muted), axis: .vertical).font(KS.body()).foregroundStyle(KS.ink).lineLimit(1...4).focused($composerFocused).padding(.vertical, 8).padding(.leading, model.hasOpenApproval ? 14 : 0).frame(minHeight: 44).disabled(dictation.isRecording || dictationStarting).accessibilityIdentifier("composer")
                    if !model.hasOpenApproval {
                    Button {
                        if dictation.isRecording || dictationStarting { dictation.stop(); dictationToken = UUID(); dictationStarting = false }
                        else { composerFocused = false; dictationStarting = true; let token = UUID(); dictationToken = token; let prefix = composer.isEmpty ? "" : composer + " "; Task { await dictation.start { utterance in composer = prefix + utterance }; if dictationToken == token { dictationStarting = false } } }
                    } label: { Image(systemName: (dictation.isRecording || dictationStarting) ? "stop.fill" : "mic").foregroundStyle((dictation.isRecording || dictationStarting) ? KS.onSignal : KS.soft).background { if dictation.isRecording || dictationStarting { Circle().fill(KS.signal).frame(width: 32, height: 32) } }.frame(width: 44, height: 44) }.accessibilityLabel((dictation.isRecording || dictationStarting) ? "Stop dictation" : "Dictate message")
                    }
                    Button {
                        dictation.stop(); dictationToken = UUID(); dictationStarting = false
                        let text = composer, selected = photos, thread = model.openBot?.threadID, botID = model.openBot?.id
                        perform { try await model.post(text, photos: selected); if let botID, let draft = drafts[botID], draft.text == text && draft.photos == selected { drafts[botID] = nil }; if model.openBot?.threadID == thread && composer == text && photos == selected { composer = ""; photos = [] } }
                    } label: { Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).foregroundStyle(KS.onSignal).frame(width: 36, height: 36).background(KS.signal.opacity(composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty ? 0.3 : 1), in: RoundedRectangle(cornerRadius: 9, style: .continuous)).frame(width: 44, height: 44).contentShape(Rectangle()) }.disabled((composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty) || model.busy || preparingPhotos).accessibilityLabel("Send message")
                }.buttonStyle(PressStyle(icon: true)).padding(.horizontal, 2)
                    .disabled(model.hasOpenApproval)
                    .card(KS.inset)
                }
                if let error = dictation.error { Text(error).font(KS.secondary()).foregroundStyle(KS.soft) }
            }.padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6).background(KS.ground)
                .overlay(alignment: .top) { Rectangle().fill(KS.hairline).frame(height: 1) }

        }
    }
    @ViewBuilder private func messageView(_ message: Message) -> some View {
        if message.kind == "schedule" {
            ScheduleCard(model: model, message: message) { screen = .settings }
        } else if message.kind == "task" {
            let task = message.raw["task"]
            VStack(alignment: .leading, spacing: 5) {
                StatusChip(task["resolved"].bool ? "Resolved" : task["status"].string == "completed" ? "Ready for review" : task["status"].string)
                Text(task["title"].string).font(KS.headline()).foregroundStyle(KS.strong)
                HStack(spacing: 6) {
                    if !task["served"]["provider"].string.isEmpty { Avatar(name: "", size: 20, provider: task["served"]["provider"].string) }
                    Text(task["served"]["provider"].string + " · " + task["branch"].string).font(KS.mono()).foregroundStyle(KS.muted)
                }
                (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))) {
                    Button("Approve") { perform { try await model.resolve(task["id"].string) } }.buttonStyle(Pill(fill: KS.signal)).disabled(task["status"].string != "completed" || task["resolved"].bool || task["check"]["status"].string == "failed" || model.busy)
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
            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading).card(task["status"].string == "failed" ? KS.attentionSurface : KS.surface)
        } else if message.kind == "swarm", message.raw["swarm"] != .null {
            SwarmCard(swarm: message.raw["swarm"], agents: model.agents)
        } else if message.kind == "question", let action = ApprovalAction(message.question) {
            ApprovalCard(model: model, question: message.question, action: action)
        } else if message.kind == "question" {
            VStack(alignment: .leading, spacing: 5) {
                StatusChip("Needs your input")
                Text(message.question["prompt"].string).font(KS.headline()).foregroundStyle(KS.strong)
                Button("Answer question") { sheet = .question(message.question) }.buttonStyle(Pill()).disabled(message.question["status"].string != "open")
            }.padding(.horizontal, 12).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading).card(message.question["status"].string == "open" ? KS.attentionSurface : KS.surface)
        } else if let report = message.report {
            VStack(alignment: .leading, spacing: 6) {
                if !report.lead.isEmpty || !message.raw["attachments"].array.isEmpty { bubble(message, text: report.lead) }
                ReportCard(report: report, author: report.lead.isEmpty && message.raw["attachments"].array.isEmpty ? message.raw["author"]["name"].string : "")
            }
        } else { bubble(message, text: message.text) }
    }
    /// The provider that runs an agent, when the host says so (CL, CX, AG monograms).
    private func provider(_ agentID: String) -> String {
        model.agents.first { $0["id"].string == agentID }?["runner"]["provider"].string ?? ""
    }
    @ViewBuilder private func bubble(_ message: Message, text: String) -> some View {
        let author = message.raw["author"]["name"].string
        let runner = provider(message.raw["author"]["id"].string)
        let stamp = time(message.raw["created_at"].string)
        let content = VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(message.raw["attachments"].array.enumerated()), id: \.offset) { _, attachment in
                ChatAttachmentView(service: model.service, threadID: model.openBot?.threadID ?? "", messageID: message.id, attachment: attachment)
            }
            if !text.isEmpty || message.raw["attachments"].array.isEmpty { ChatMarkdownView(text: text.isEmpty ? (message.kind == "answer" ? "Answer sent" : message.kind.capitalized) : text, style: .init(
                body: KS.body(), heading: KS.headline(), mono: KS.mono(), text: message.human ? KS.strong : KS.ink, muted: KS.muted,
                codeBackground: KS.inset, lineSpacing: 2, blockSpacing: 8)).equatable() }
        }
        let system = message.raw["author"]["kind"].string == "system"
        let actions = HStack(spacing: 0) {
            CopyButton(text: message.text)
            if system {
                Button { perform { try await model.dismissMessage(message) } } label: {
                    Image(systemName: "xmark").font(.caption).foregroundStyle(KS.muted).frame(minWidth: 32, minHeight: 32)
                }.buttonStyle(.plain).accessibilityLabel("Dismiss")
            }
        }
        if message.human {
            VStack(alignment: .trailing, spacing: 0) {
                HStack {
                    Spacer(minLength: 48)
                    content.padding(.horizontal, 14).padding(.vertical, 10).bubble(human: true)
                }
                actions
            }.frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                Avatar(name: author.isEmpty ? (model.openBot?.name ?? "Bot") : author, size: 28,
                       colorHex: runner.isEmpty ? model.openBot?.colorHex : nil, provider: runner)
                VStack(alignment: .leading, spacing: 6) {
                    if !author.isEmpty || !stamp.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if !author.isEmpty { Text(author).font(KS.body(.semibold)).foregroundStyle(KS.strong).lineLimit(1) }
                            if !runner.isEmpty { Text(runner.capitalized).font(KS.secondary()).foregroundStyle(KS.muted).lineLimit(1) }
                            Spacer(minLength: 4)
                            if !stamp.isEmpty { Text(stamp).font(KS.mono()).foregroundStyle(KS.muted).fixedSize() }
                        }
                    }
                    content
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading).bubble()
            }
            actions
            }
        }
    }
    /// `embedded`: inside the iPad's Tasks pane, which has no close header.
    private func tasksView(embedded: Bool = false) -> some View {
        VStack(spacing: 0) {
            if !embedded { header("Tasks") { screen = .home } }
            HStack {
                countCard("Need you", count: model.attention.count, color: KS.needsText)
                countCard("Working", count: model.tasks.filter { ["running", "queued"].contains($0["status"].string) }.count, color: KS.signal)
                countCard("Done", count: model.tasks.filter { $0["status"].string == "completed" }.count, color: KS.readyText)
            }.padding(.horizontal, 16)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(filteredTasks.enumerated()), id: \.offset) { _, row in
                        Button {
                            if let bot = model.bots.first(where: { $0.id == row["bot_id"].string || $0.threadID == row["thread_id"].string }) { open(bot) }
                            else { sheet = .changes(row["objective"].string + "\n\n" + row["status"].string + "\n" + row["next_step"].string) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                StatusChip(row["status"].string.isEmpty ? row["label"].string : row["status"].string)
                                Text(row["objective"].string.isEmpty ? row["title"].string : row["objective"].string).font(KS.headline()).foregroundStyle(KS.strong)
                                Text(taskDetail(row)).font(KS.secondary()).foregroundStyle(KS.muted)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(12).card(["failed", "open"].contains(row["status"].string) ? KS.attentionSurface : KS.surface)
                        }.buttonStyle(PressStyle())
                    }
                    if filteredTasks.isEmpty { empty("Nothing here right now.") }
                }.padding(16)
            }.frame(maxHeight: .infinity)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 2) {
                ForEach(["All", "Needs you", "Working", "Done"], id: \.self) { item in
                    Button { filter = item } label: {
                        Text(item).font(.system(size: filterLabelSize, weight: .semibold)).foregroundStyle(filter == item ? KS.onSignal : KS.soft)
                            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 32)
                            .background {
                                if filter == item {
                                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(KS.signal)
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
              .padding(.horizontal, 4).card(KS.inset)
              .padding(.horizontal, 16).padding(.vertical, 8)
            }.fixedSize(horizontal: false, vertical: true).buttonStyle(PressStyle()).background(KS.grouped)
                .overlay(alignment: .top) { Rectangle().fill(KS.hairline).frame(height: 1) }
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
            Text(String(format: "%02d", count)).font(.system(.title2, design: .monospaced, weight: .medium)).foregroundStyle(count == 0 ? KS.muted : color)
                .contentTransition(reduceMotion ? .identity : .numericText(value: Double(count)))
                .animation(reduceMotion ? nil : KS.glide, value: count)
            Eyebrow(name)
        }
            .frame(maxWidth: .infinity, alignment: .leading).padding(12).card()
            .accessibilityElement(children: .combine)
    }
    private func usageView(embedded: Bool = false) -> some View {
        VStack(spacing: 0) {
            if !embedded { header("Usage") { screen = .home } }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    Text("Auto work follows your host’s routing policy and available quota.").font(KS.body()).foregroundStyle(KS.soft).fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(model.status["usage"].array.enumerated()), id: \.offset) { _, usage in
                        let provider = usage["provider"].string
                        let left = usage["headroom"].number
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                Avatar(name: provider, size: 28, provider: provider)
                                Text(provider.capitalized).font(KS.headline()).foregroundStyle(KS.strong)
                                if !usage["plan"].string.isEmpty { StatusChip(usage["plan"].string.uppercased()) }
                                Spacer(minLength: 4)
                                Text(left.map { "\(Int($0))% left" } ?? "—").font(KS.mono(.semibold)).foregroundStyle(KS.ink)
                            }
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(KS.chip)
                                    Capsule().fill(KS.tint(provider)).frame(width: geo.size.width * max(0, min(1, (left ?? 0) / 100)))
                                }
                            }.frame(height: 6).accessibilityHidden(true)
                            ForEach(Array(usage["windows"].array.enumerated()), id: \.offset) { _, window in
                                Text(windowText(window)).font(KS.mono()).foregroundStyle(KS.muted)
                            }
                            if !usage["ok"].bool { Text("Quota reading unavailable").font(KS.secondary()).foregroundStyle(KS.needsText) }
                        }.padding(14).card()
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(provider), \(left.map { "\(Int($0)) percent left" } ?? "quota unavailable")")
                    }
                    if model.status["usage"].array.isEmpty { empty("Quota readings for Claude, Codex and Antigravity will appear here once your host reports them.") }
                    routingSummary.padding(.top, 10)
                }.padding(16)
            }
            Button("Refresh usage") { Task { await model.refresh() } }.buttonStyle(Pill(primary: true)).disabled(model.loading)
                .padding(.horizontal, 16).padding(.vertical, 8).background(KS.grouped)
                .overlay(alignment: .top) { Rectangle().fill(KS.hairline).frame(height: 1) }
        }
    }
    private var routingSummary: some View {
        VStack(alignment: .leading, spacing: 10) {
                Eyebrow("Auto order, right now")
                Text(model.status["routing"]["reason"].string).font(KS.mono()).foregroundStyle(KS.soft)
                ForEach(["research", "patch", "review", "summary"], id: \.self) { kind in
                    let choice = model.status["routing"]["by_kind"][kind]
                    (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout())) {
                        Text(kind.capitalized).foregroundStyle(KS.soft)
                        if !textSize.isAccessibilitySize { Spacer() }
                        HStack(spacing: 6) {
                            if !choice["provider"].string.isEmpty { Avatar(name: "", size: 20, provider: choice["provider"].string) }
                            Text(choice["provider"].string.isEmpty ? "No eligible provider" : choice["provider"].string.capitalized).fontWeight(.semibold).foregroundStyle(KS.ink)
                        }
                    }.font(KS.body())
                }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).card()
    }
    private func windowText(_ window: JSON) -> String {
        let used = window["used_percent"].number.map { "\(Int($0))% used" } ?? "unavailable"
        let reset = date(window["resets_at"].string).map { ", resets " + $0.formatted(.relative(presentation: .numeric)) } ?? ""
        return window["name"].string + ": " + used + reset
    }
    private var you: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) { CloseButton { sheet = nil }; Text("You").font(KS.title()).foregroundStyle(KS.strong) }
            Spacer(minLength: 0)
            Button { sheet = .newBot } label: { menuRow("New bot", "Or ask your starred bot to make one", icon: "plus") }.buttonStyle(Pill(fill: KS.signal, primary: true))
            Button { sheet = nil; screen = .connect } label: { menuRow("Hosts and devices", model.online ? "Host online · pair another host" : "Host offline · pair another host", icon: "desktopcomputer") }.buttonStyle(Pill(fill: KS.surface))
            Button {
                sheet = nil
                if let bot = model.starred { model.openBot = bot; screen = .settings }
                else { model.error = "Open a bot’s thread, then choose Bot settings." }
            } label: { menuRow("Bot settings", "Crew, chat replies and your starred shortcut", icon: "slider.horizontal.3") }.buttonStyle(Pill(fill: KS.surface))
            Button { sheet = .transactions } label: { menuRow("Watch transactions", "Review transaction previews", icon: "list.bullet.rectangle") }.buttonStyle(Pill(fill: KS.surface)).disabled(model.isDemo)
            Button { sheet = .memos } label: { menuRow("Watch memos", "Play and share recordings saved on this iPhone", icon: "waveform") }.buttonStyle(Pill(fill: KS.surface)).disabled(model.isDemo)
            Button("Sign out of this host") { perform { try await model.signOut(); sheet = nil; screen = .connect } }.font(KS.body(.semibold)).foregroundStyle(KS.failedText).frame(maxWidth: .infinity, minHeight: 44).disabled(model.isDemo)
        }
    }
    private func menuRow(_ title: String, _ subtitle: String, icon: String) -> some View {
        HStack(spacing: 12) { Image(systemName: icon).frame(width: 24); VStack(alignment: .leading, spacing: 2) { Text(title).font(KS.headline()); Text(subtitle).font(KS.secondary()).opacity(0.8) }; Spacer() }.padding(.vertical, 8)
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
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 22, weight: .semibold)).foregroundStyle(KS.onSignal)
                    .frame(width: 48, height: 48).background(KS.signal, in: RoundedRectangle(cornerRadius: 12, style: .continuous)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your swarm").font(KS.title()).foregroundStyle(KS.strong).accessibilityAddTraits(.isHeader)
                    Text("in your pocket").font(KS.body()).foregroundStyle(KS.muted)
                }
            }
            Text("Your agents run on your Mac. This phone talks to them through the Swarmaa relay, from anywhere.").font(KS.body()).foregroundStyle(KS.soft)
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow("On your Mac, run")
                Text("npm run relay:pair").font(KS.mono(.semibold)).foregroundStyle(KS.signal).textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading).card(KS.inset, radius: 8)
                Text("Type the 6-digit code it shows. It works once, for five minutes.").font(KS.body()).foregroundStyle(KS.ink)
            }.padding(14).card()
            Spacer(minLength: 0)
            Eyebrow("Pairing code")
            TextField("", text: $code, prompt: Text("000 000").foregroundStyle(KS.muted))
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.system(.largeTitle, design: .monospaced, weight: .medium)).foregroundStyle(KS.strong).multilineTextAlignment(.center)
                .padding(.vertical, 14).frame(maxWidth: .infinity).card(KS.inset)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(focused ? KS.signal.opacity(0.7) : .clear, lineWidth: 1).allowsHitTesting(false))
                .focused($focused).privacySensitive()
                .accessibilityLabel("6-digit pairing code")
                .onChange(of: code) { _, value in
                    let clean = String(value.filter(\.isNumber).prefix(6))
                    if clean != value { code = clean }
                    if clean.count == 6 { connect() }
                }
            if let error { Text(error).font(KS.body()).foregroundStyle(KS.failedText) }
            Button(connecting ? "Connecting…" : "Connect", action: connect)
                .buttonStyle(Pill(fill: KS.signal, primary: true))
                .disabled(connecting || model.isDemo || digits.count < 6)
        }
           .padding(20).frame(minHeight: geometry.size.height, alignment: .topLeading)
          }.scrollDismissesKeyboard(.interactively).scrollBounceBehavior(.basedOnSize)
        }.background(KS.ground)
        .onAppear { focused = !model.isDemo }
    }
}

private let replyModels = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "gemini-3.8-flash-high", "off"]
private let replyNames = ["Haiku 5.5", "Sonnet 5.5", "Opus 5.5", "Gemini Flash", "Agent’s own model"]
struct ReplyPicker: View {
    @Binding var value: String
    var body: some View {
        Picker("Chat replies", selection: $value) { ForEach(Array(zip(replyModels, replyNames)), id: \.0) { id, name in Text(name).tag(id) } }
            .pickerStyle(.menu).tint(KS.ink).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 4).card(KS.inset)
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
            HStack { CloseButton(action: close).accessibilityIdentifier("close-sheet"); Text("New bot").font(KS.title()).foregroundStyle(KS.strong) }
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("01 — Name", text: $draft.name, prompt: "e.g. Launch")
                    field("02 — What it does", text: $draft.job, prompt: "Plans each product launch…", lines: 2...3)
                    Eyebrow("03 — Project and lead")
                    (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16)) : AnyLayout(HStackLayout(spacing: 10))) {
                        VStack(alignment: .leading, spacing: 4) {
                        Eyebrow("Project")
                        Picker("Project", selection: $draft.project) { Text("Choose project").tag(""); ForEach(model.scopes, id: \.self) { Text($0.replacingOccurrences(of: "project:", with: "")).tag($0) } }.pickerStyle(.menu).padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: 44).tint(KS.ink).card(KS.inset).accessibilityIdentifier("project-picker")
                        }
                        VStack(alignment: .leading, spacing: 4) {
                        Eyebrow("Lead")
                        Picker("Lead", selection: $draft.lead) { Text("A new agent").tag(""); ForEach(model.agents.filter { $0["scope"].string == draft.project }, id: \.self) { Text($0["name"].string).tag($0["id"].string) } }.pickerStyle(.menu).padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: 44).tint(KS.ink).card(KS.inset).accessibilityIdentifier("lead-picker")
                        }
                    }
                    Eyebrow("04 — Chat replies"); ReplyPicker(value: $draft.firstReply)
                }.padding(3)
            }.frame(maxHeight: .infinity).accessibilityIdentifier("new-bot-fields")
            Text(error ?? draft.missing ?? "Your bot is ready to make.").font(KS.body()).foregroundStyle(KS.muted)
            Button(saving ? "Making bot…" : "Make bot") {
                saving = true
                Task {
                    defer { saving = false }
                    do { try await model.create(draft); close() } catch { self.error = safeError(error) }
                }
            }.buttonStyle(Pill(fill: KS.signal, primary: true)).disabled(draft.missing != nil || saving || model.isDemo)
        }.onChange(of: draft.project) { _, _ in draft.lead = "" }
    }
}
@MainActor private func field(_ label: String, text: Binding<String>, prompt: String, lines: ClosedRange<Int> = 1...1) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        Eyebrow(label)
        TextField("", text: text, prompt: Text(prompt).foregroundStyle(KS.muted), axis: .vertical).lineLimit(lines).foregroundStyle(KS.ink).padding(12).frame(minHeight: 48).card(KS.inset).accessibilityLabel(label)
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
            Text(question["prompt"].string).font(KS.title()).foregroundStyle(KS.strong).fixedSize(horizontal: false, vertical: true)
            // A secret is stored in the Mac's Keychain, so from the phone the only answer is "Not now".
            let credential = question["credential"].string
            Text(!credential.isEmpty ? "It needs \(credential). Add it in Swarmaa on your Mac: it is saved to the Mac's Keychain and never sent through chat." : question["multi"].bool ? "Pick any. Nothing is posted until you approve the drafts." : "Choose one answer.").font(KS.body()).foregroundStyle(KS.soft)
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(question["options"].array.map(\.string).filter { credential.isEmpty || $0 == "Not now" }, id: \.self) { option in
                        Button {
                            if choices.contains(option) { choices.remove(option) }
                            else { if !question["multi"].bool { choices = [] }; choices.insert(option) }
                        } label: { HStack { Text(option); Spacer(); Image(systemName: choices.contains(option) ? "checkmark.circle.fill" : "circle") } }
                            .buttonStyle(Pill(fill: choices.contains(option) ? KS.signal : KS.surface, answerOption: true))
                    }
                    if question["free_text"].bool { field("Anything else", text: $text, prompt: "e.g. skip X this time") }
                }.padding(3)
            if let error { Text(error).font(KS.body()) }
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
            }.buttonStyle(Pill(fill: KS.signal, primary: true)).disabled(!valid || saving || model.isDemo)
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
                HStack(spacing: 10) { CloseButton(action: close); Avatar(name: draft.name, size: 36, colorHex: draft.colorHex); Text(draft.name).font(KS.title()).foregroundStyle(KS.strong).lineLimit(2) }
                    .fixedSize(horizontal: false, vertical: true)
                ScrollView {
                  VStack(alignment: .leading, spacing: 12) {
                    Text(draft.job).font(KS.body()).foregroundStyle(KS.soft).fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: 14) {
                        field("Name", text: string("name"), prompt: "Bot name")
                        field("What it does", text: string("job"), prompt: "Job", lines: 2...3)
                        Eyebrow("01 — Chat replies")
                        ReplyPicker(value: Binding(get: { draft.raw["rules"]["first_reply"].string.isEmpty ? replyModels[0] : draft.raw["rules"]["first_reply"].string }, set: { draft.raw["rules"]["first_reply"] = .string($0) }))
                        Eyebrow("02 — Crew")
                        Picker("Lead", selection: string("lead_agent_id")) {
                            ForEach(model.agents.filter { $0["scope"].string == draft.scope }, id: \.self) { agent in Text(agent["name"].string).tag(agent["id"].string) }
                        }.tint(KS.ink).frame(minHeight: 44)
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
                            }.tint(KS.ink).frame(minHeight: 44)
                        }
                        Eyebrow("04 — Schedule")
                        TextField("Cron, e.g. 0 9 * * 1-5", text: Binding(get: { draft.raw["schedule"].string }, set: {
                            draft.raw["schedule"] = $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string($0)
                        })).textInputAutocapitalization(.never).autocorrectionDisabled().font(KS.mono()).padding(12).card(KS.inset)
                        Text("Optional CRON_TZ=Area/City prefix. Leave blank to clear.").font(KS.body()).foregroundStyle(KS.muted)
                        Toggle("Star this bot (your bottom-right shortcut)", isOn: Binding(get: { draft.starred }, set: { draft.raw["starred"] = .bool($0) })).frame(minHeight: 44)
                        Toggle("Ask me before anything public", isOn: rule("approve_public")).frame(minHeight: 44)
                        Toggle("Review every edit", isOn: rule("review_edits")).frame(minHeight: 44)
                        Toggle("Run tests before an edit is done", isOn: rule("require_tests")).frame(minHeight: 44)
                    }.padding(14).card().padding(4)
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
                if let error { Text(error).font(KS.body()).foregroundStyle(KS.failedText) }
                Text("Changes apply from the next turn. Running work keeps its settings.").font(KS.body()).foregroundStyle(KS.muted)
                Button(saving ? "Saving…" : "Save changes") {
                    saving = true
                    Task { defer { saving = false }; do { try await model.save(draft); close() } catch { self.error = safeError(error) } }
                }.buttonStyle(Pill(fill: KS.signal, primary: true)).disabled(saving || model.isDemo || draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.job.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
        .object(["id": .string(id), "objective": .string(title), "title": .string(title), "bot_id": .string("launch"), "scope": .string("project:swarma"), "status": .string(state), "served": .object(["provider": .string(provider)]), "branch": .string("swarmaa/claude/demo"), "changed_files": .number(7), "version": .number(1), "resolved": .bool(false),
                 "result": .object(["usage": .object(["input_tokens": .number(Double(title.count * 4100)), "output_tokens": .number(Double(title.count * 310))])])])
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
        // UI tests of push taps: ask for notification permission the way a real first bot list does.
        if ProcessInfo.processInfo.arguments.contains("-push-demo") { didLoadBots = true; Task { await onFirstBotList?() } }
        openBot = bots[0]
        agents = [JSON.object(["id": .string("launch"), "name": .string("Atlas"), "scope": .string("project:swarma"), "runner": .object(["provider": .string("claude")])]), .object(["id": .string("scout"), "name": .string("Scout"), "scope": .string("project:swarma")]), .object(["id": .string("forge"), "name": .string("Forge"), "scope": .string("project:swarma")])]
        tasks = [Demo.task("banner", "Draft the launch banner", "completed", "claude"), Demo.task("pricing", "Summarise competitor pricing", "failed", "codex"), Demo.task("calendar", "Check the launch calendar", "running", "antigravity"), Demo.task("limits", "Fix the plan limits on the pricing page", "running", "claude")]
        attention = Array(tasks.prefix(2))
        messages = [Demo.message("m1", 1, "text", .string("Plan Friday’s launch. Ask me before anything goes public."), human: true), Demo.message("m2", 2, "text", .string("On it. Scout reads the brief, Forge drafts the banner. I’ll ask before anything goes out.")), Demo.message("m3", 3, "task", tasks[0]), Demo.message("m4", 4, "question", Demo.question)]
        typing = [.object(["agent_id": .string("scout"), "task_id": .string("demo-turn"), "text": .string("I’m checking the launch calendar…")])]
        if ProcessInfo.processInfo.arguments.contains("-working-notes-demo") {
            var first = Demo.message("note1", 2, "notice", .string("Checking the launch brief"))
            var last = Demo.message("note2", 3, "handoff", .string("Handed off to the launch crew"))
            first.raw["created_at"] = .string("2026-10-28T10:00:00Z")
            last.raw["created_at"] = .string("2026-10-28T10:03:00Z")
            messages.insert(contentsOf: [first, last], at: 1)
        }
        if ProcessInfo.processInfo.arguments.contains("-long-thread-demo") {
            // A thread taller than the screen, for layout tests; the last message is "Demo reply 100".
            // Uneven heights, like real replies: most short, every seventh a long report.
            messages += (5...104).map { i in Demo.message("long\(i)", i, "text", .string(i == 104 ? "Demo reply 100" : "Demo reply \(i - 4): " + String(repeating: "a longer line that wraps differently at each column width. ", count: i % 7 == 0 ? 40 : 1 + i % 3)), human: i % 3 == 0) }
            typing = []
        }
        if ProcessInfo.processInfo.arguments.contains("-handover-demo") {
            func step(_ id: String, _ title: String, _ who: String, _ status: String, needs: [String] = [], check: String) -> JSON {
                .object(["id": .string(id), "title": .string(title), "assignee_agent_id": .string(who), "status": .string(status), "needs": .strings(needs), "check": .string(check)])
            }
            var swarm = Demo.message("swarm1", 5, "swarm", .string(""))
            swarm.raw["swarm"] = .object(["id": .string("demo-swarm"), "title": .string("Friday launch"), "status": .string("waiting_on_you"), "progress": .object(["done": .number(1), "total": .number(3)]), "steps": .array([
                step("s1", "Read the launch brief", "scout", "done", check: "A five-point summary is posted in the thread"),
                step("s2", "Draft the launch banner", "forge", "waiting_on_you", needs: ["s1"], check: "A 1200×630 banner PNG is attached"),
                step("s3", "Schedule the launch posts", "launch", "pending", needs: ["s2"], check: "Posts are queued for Friday 9:00 in the calendar")])])
            let report = Demo.message("report1", 6, "text", .string("Scout finished the brief.\n\n**Result:** Summarised the launch brief in five points.\n**Checks:** Compared every date against the brief; all match.\n**Not checked:** Whether the pricing page is live yet.\n**Files:** docs/launch/brief-summary.md"))
            let approval = Demo.message("approval1", 7, "question", .object(["id": .string("demo-approval"), "prompt": .string("Deploy the launch site?"), "options": .strings(["Approve", "Deny"]), "status": .string("open"), "action": .object(["kind": .string("command"), "summary": .string("Deploy the launch site to production"), "detail": .string("npm run build && npm run deploy:site -- --prod --tag launch-friday"), "where": .string("~/Projects/swarma")])]))
            messages += [swarm, report, approval]
            typing = []
        }
        let providers = ["antigravity", "claude", "codex"]
        // Workers (iPad Agents section and swarm map): two tasks running now.
        func worker(_ provider: String, _ running: [(String, String, Double)]) -> JSON {
            .object(["name": .string("mac-studio-" + provider), "live": .bool(true), "providers": .strings([provider]), "running": .array(running.map { id, objective, ago in
                .object(["task_id": .string(id), "objective": .string(objective), "started_at": .string(Date().addingTimeInterval(-ago).formatted(.iso8601))]) })])
        }
        status = .object(["workers": .array([worker("claude", [("limits", "Fix the plan limits on the pricing page", 252)]), worker("codex", []), worker("antigravity", [("calendar", "Check the launch calendar", 71)])]),
                          "scopes": .array([.object(["scope": .string("project:swarma"), "queued": .number(1)])]), "usage": .array(zip(providers, [79, 61, 11]).map { provider, left in
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
            StatusChip("Schedule")
            Text(card["description"].string.isEmpty ? message.text : card["description"].string).font(KS.headline()).foregroundStyle(KS.strong)
            Text(card["timezone"].string).font(KS.mono()).foregroundStyle(KS.muted)
            if card["paused"].bool { Text("Paused").font(KS.secondary(.semibold)).foregroundStyle(KS.needsText) }
            ForEach(card["next_runs"].array.map(\.string), id: \.self) { value in
                if let run = date(value) { Text(run, format: .relative(presentation: .named)).font(KS.mono()).foregroundStyle(KS.soft) }
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
                }.buttonStyle(Pill(fill: KS.signal))
                    .disabled(saving || model.isDemo || bot == nil || card["cron"] == .null)
                Button("Edit") { if let bot { model.openBot = bot; edit() } }.buttonStyle(Pill()).disabled(bot == nil || saving)
            }
            if let error { Text(error).font(KS.body()).foregroundStyle(KS.failedText) }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

/// Who has which step, who waits on whom, and what "done" means for each step.
struct SwarmCard: View {
    let swarm: JSON
    let agents: [JSON]
    static func symbol(_ status: String) -> (String, Color) {
        switch status {
        case "done": ("checkmark.circle.fill", KS.readyText)
        case "failed", "blocked", "cancelled": ("xmark.circle.fill", KS.failedText)
        case "waiting_on_you": ("questionmark.circle.fill", KS.needsText)
        case "running": ("circle.dotted", KS.signal)
        default: ("circle", KS.muted)
        }
    }
    var body: some View {
        let steps = swarmSteps(swarm), crew = swarmCrew(steps, agents: agents), status = swarm["status"].string
        let total = swarm["progress"]["total"] == .null ? steps.count : swarm["progress"]["total"].int
        let done = swarm["progress"]["done"] == .null ? steps.filter { $0["status"].string == "done" }.count : swarm["progress"]["done"].int
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    StatusChip(status == "waiting_on_you" ? "Needs you" : status.isEmpty ? "Swarm" : status.replacingOccurrences(of: "_", with: " "))
                    Text(swarm["title"].string.isEmpty ? "Swarm" : swarm["title"].string).font(KS.headline()).foregroundStyle(KS.strong)
                }
                Spacer()
                Text("\(done)/\(total)").font(.system(.title3, design: .monospaced, weight: .medium)).foregroundStyle(KS.ink)
            }
            if total > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(KS.chip)
                        Capsule().fill(KS.signal).frame(width: geo.size.width * min(1, Double(done) / Double(total)))
                    }
                }.frame(height: 4).accessibilityHidden(true)
            }
            if let line = swarmHeadline(steps, agents: agents) {
                Text(line).font(KS.body(.semibold)).foregroundStyle(line.hasSuffix("waiting on you") ? KS.needsText : KS.soft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !crew.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Array(crew.enumerated()), id: \.offset) { i, member in
                            if i > 0 { Image(systemName: "arrow.right").font(.system(size: 9, weight: .bold)).foregroundStyle(KS.muted) }
                            HStack(spacing: 4) { Avatar(name: member.name, size: 18); Text(member.name).font(KS.secondary(.semibold)).foregroundStyle(member.active ? KS.onSignal : KS.ink).lineLimit(1) }
                                .padding(.leading, 4).padding(.trailing, 8).frame(minHeight: 24)
                                .background(member.active ? KS.signal : KS.neutralTint, in: Capsule())
                        }
                    }
                }.accessibilityElement(children: .ignore)
                    .accessibilityLabel("Crew: " + crew.map { $0.name + ($0.active ? ", active" : "") }.joined(separator: ", then "))
            }
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                let (icon, color) = Self.symbol(step["status"].string)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: icon).font(.system(size: 13)).foregroundStyle(color)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step["title"].string).font(KS.body()).foregroundStyle(KS.ink).fixedSize(horizontal: false, vertical: true)
                        if let line = waitingLine(step, in: steps, agents: agents) { Text(line).font(KS.secondary()).foregroundStyle(KS.needsText) }
                        if !step["check"].string.isEmpty { Text("Done when: " + step["check"].string).font(KS.secondary()).foregroundStyle(KS.muted).fixedSize(horizontal: false, vertical: true) }
                    }
                }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .card(["waiting_on_you", "blocked"].contains(status) ? KS.attentionSurface : KS.surface)
    }
}

/// A step's four-part report; "Not checked" is never hidden.
struct ReportCard: View {
    let report: StepReport
    var author = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !author.isEmpty { Text(author).font(KS.body(.semibold)).foregroundStyle(KS.strong) }
            ForEach([("result", "Result"), ("checks", "Checks"), ("not checked", "Not checked"), ("files", "Files")], id: \.0) { key, label in
                let missing = (report.parts[key] ?? "").isEmpty
                VStack(alignment: .leading, spacing: 2) {
                    Eyebrow(label, color: key == "not checked" ? KS.needsText : KS.muted)
                    Text(missing ? "Not stated" : report.parts[key]!).font(KS.body()).foregroundStyle(missing ? KS.muted : KS.ink)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }.frame(maxWidth: .infinity, alignment: .leading)
                    .padding(key == "not checked" ? 8 : 0)
                    .background(key == "not checked" ? KS.needsTint : .clear, in: RoundedRectangle(cornerRadius: 10))
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

/// An approval: the exact action on top, the choices at the bottom of the card within thumb reach.
struct ApprovalCard: View {
    @Bindable var model: AppModel
    let question: JSON
    let action: ApprovalAction
    @State private var sending = false
    @State private var error: String?
    @State private var detailHeight: CGFloat = 1
    @Environment(\.dynamicTypeSize) private var textSize
    var body: some View {
        let open = question["status"].string == "open"
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) { StatusChip(open ? "Needs you" : "Answered"); StatusChip(action.kind) }
            if open { Text("Waiting for your approval").font(KS.secondary(.semibold)).foregroundStyle(KS.needsText) }
            Text(action.summary.isEmpty ? question["prompt"].string : action.summary).font(KS.headline()).foregroundStyle(KS.strong).fixedSize(horizontal: false, vertical: true)
            if !action.detail.isEmpty {
                ScrollView {
                    Text(action.detail).font(KS.mono()).foregroundStyle(KS.ink).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { detailHeight = $0 }
                }.frame(height: min(detailHeight, 180)).scrollBounceBehavior(.basedOnSize)
                    .card(KS.inset, radius: 8)
            }
            if !action.where_.isEmpty { Text("Where: " + action.where_).font(KS.secondary()).foregroundStyle(KS.muted).fixedSize(horizontal: false, vertical: true) }
            if let error { Text(error).font(KS.body()).foregroundStyle(KS.failedText) }
            if open {
                (textSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(alignment: .top, spacing: 10))) {
                    ForEach(question["options"].array.map(\.string), id: \.self) { option in
                        let sub = option == "Approve" ? "Runs this once" : option == "Deny" ? "The bot won’t do this" : ""
                        Button {
                            sending = true; error = nil
                            Task {
                                defer { sending = false }
                                do { try await model.answer(question, choice: option) } catch { self.error = safeError(error) }
                            }
                        } label: {
                            VStack(spacing: 1) {
                                Text(option)
                                if !sub.isEmpty { Text(sub).font(KS.secondary()).opacity(0.8) }
                            }.frame(maxWidth: .infinity)
                        }.buttonStyle(Pill(primary: option == "Approve", danger: option == "Deny", answerOption: !["Approve", "Deny"].contains(option)))
                    }
                }.disabled(sending).padding(.top, 4)
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .card(open ? KS.attentionSurface : KS.surface)
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

/// Copies a message's raw body; the icon flips to a checkmark for a moment.
struct CopyButton: View {
    let text: String
    @State private var done = false
    var body: some View {
        Button {
            UIPasteboard.general.string = text
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            done = true
            Task { try? await Task.sleep(for: .seconds(1.2)); done = false }
        } label: {
            Image(systemName: done ? "checkmark" : "doc.on.doc").font(.caption).foregroundStyle(KS.muted).frame(minWidth: 32, minHeight: 32)
        }.buttonStyle(.plain).accessibilityLabel("Copy message")
    }
}
