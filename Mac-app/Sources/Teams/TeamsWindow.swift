import AppKit
import SwiftUI

/// The Swarmaa main window: bots and their threads (docs/BOTS.md), tasks and
/// usage. One at a time; reopening brings it forward and refreshes.
@MainActor
final class TeamsWindowController: NSObject, NSWindowDelegate {
    private(set) var window: NSWindow?
    let model: TeamsModel
    private var trafficLightHomes: [NSWindow.ButtonType: (NSView, NSRect)] = [:]
    private var inFullScreen = false
    init(model: TeamsModel? = nil) { self.model = model ?? TeamsModel(); super.init() }

    /// `threadID` opens straight onto that thread (a notch swarm or question).
    func show(threadID: String? = nil, connect: Bool = true) {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                  backing: .buffered, defer: false)
            window.title = "Swarmaa"
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = false
            window.setAccessibilityElement(true)
            window.setAccessibilityRole(.window)
            window.setAccessibilityLabel("Swarmaa")
            window.minSize = NSSize(width: 900, height: 560)
            // Kind Swarm has one theme, paper; keep the window in it whatever the Mac's appearance.
            window.appearance = NSAppearance(named: .aqua)
            let host = TeamsHostingView(rootView: TeamsRootView(model: model))
            host.safeAreaRegions = []
            window.contentView = host
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.setFrameAutosaveName("SwarmaaTeamsWindow")
            if !window.setFrameUsingName("SwarmaaTeamsWindow") { window.center() }
            self.window = window
            // The first time the window opens, show the setup checklist if anything is wrong.
            if connect { Task { [model] in
                await model.runSetup()
                if model.setupRows.contains(where: { $0.state == .needsSetup }) { model.showSetup = true }
            } }
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        positionTrafficLights()
        model.isVisible = true
        if let threadID { model.select(threadID: threadID) }
        if connect { Task { await model.refresh() } }
    }

    // Position in content coordinates, including after AppKit rebuilds full-screen chrome.
    private func positionTrafficLights() {
        guard !inFullScreen, let window, !window.styleMask.contains(.fullScreen), let content = window.contentView else { return }
        for (index, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
            guard let button = window.standardWindowButton(kind) else { continue }
            // Keep native buttons above the content without a titlebar container
            // clipping their new position or covering the other columns.
            if button.superview !== content {
                if let parent = button.superview { trafficLightHomes[kind] = (parent, button.frame) }
                content.addSubview(button)
            }
            button.isHidden = false
            let top = content.isFlipped ? KS.topBarHeight / 2 : content.bounds.height - KS.topBarHeight / 2
            let centre = NSPoint(x: 16 + CGFloat(index) * 20, y: top)
            button.setFrameOrigin(NSPoint(x: centre.x - button.frame.width / 2, y: centre.y - button.frame.height / 2))
        }
    }

    func windowDidResize(_ notification: Notification) { positionTrafficLights() }
    func windowWillEnterFullScreen(_ notification: Notification) {
        inFullScreen = true
        // Return the buttons to AppKit for its full-screen, auto-hiding chrome.
        for (kind, home) in trafficLightHomes {
            guard let button = window?.standardWindowButton(kind) else { continue }
            home.0.addSubview(button)
            button.frame = home.1
        }
    }
    func windowDidExitFullScreen(_ notification: Notification) {
        inFullScreen = false
        positionTrafficLights()
    }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        inFullScreen = false
        positionTrafficLights()
    }
    func windowDidBecomeKey(_ notification: Notification) { model.isVisible = true }
    func windowDidResignKey(_ notification: Notification) { model.isVisible = false }
    func windowDidMiniaturize(_ notification: Notification) { model.isVisible = false }
    func windowDidDeminiaturize(_ notification: Notification) { model.isVisible = true }
    func windowWillClose(_ notification: Notification) {
        model.isVisible = false
        model.stopStream()
    }
}

/// Do not let AppKit turn content controls into window-drag targets.
final class TeamsHostingView<Content: View>: NSHostingView<Content> {
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A background only: foreground SwiftUI controls keep their own hit testing.
private struct TeamsTitlebarBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> TeamsTitlebarDragView { TeamsTitlebarDragView() }
    func updateNSView(_ view: TeamsTitlebarDragView, context: Context) {}
}

private final class TeamsTitlebarDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let distanceFromTop = isFlipped ? point.y : bounds.height - point.y
        guard distanceFromTop >= 0, distanceFromTop < KS.topBarHeight, let window else {
            super.mouseDown(with: event)
            return
        }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
        } else {
            window.performDrag(with: event)
        }
    }
}

struct TeamsConnectionStatus: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        if model.staleError != nil || model.streamState != "Live" {
            HStack(spacing: 8) {
                KSChip(model.staleError == nil ? L10n.t("Reconnecting") : L10n.t("Offline"),
                       fill: model.staleError == nil ? KS.butter : KS.coral)
                if let date = model.lastUpdated {
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        Text(verbatim: L10n.t("updated \(max(0, Int(context.date.timeIntervalSince(date) / 60))) min ago"))
                            .font(KS.body(13)).foregroundStyle(KS.textMuted).lineLimit(1)
                    }
                }
                Button(L10n.t("Retry")) { Task { await model.retryConnection() } }
                    .buttonStyle(.ks(.white, compact: true))
            }
            .fixedSize()
            .help(model.staleError ?? model.streamState)
        }
    }
}

struct TeamsRootView: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        HStack(spacing: 0) {
            TeamsRail(model: model)
            content
        }
        .frame(minWidth: 900, minHeight: 560)
        .background(alignment: .top) { TeamsTitlebarBackground().frame(height: KS.topBarHeight) }
        .background(KS.paper)
        .ignoresSafeArea(.container, edges: .top)
        .foregroundStyle(KS.ink)
        .tint(KS.ink)
        .environment(\.colorScheme, .light)
        .alert(L10n.t("Swarmaa"), isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button(L10n.t("OK")) { model.error = nil }
        } message: { Text(verbatim: model.error ?? "") }
        .sheet(item: Binding(get: { model.detailSwarmID.map(SwarmID.init) }, set: { model.detailSwarmID = $0?.id })) {
            SwarmDetailView(model: model, swarmID: $0.id)
        }
        .sheet(isPresented: $model.creatingBot) { NewBotSheet(model: model) }
        .sheet(isPresented: $model.showSetup) { SetupChecklistView(model: model) { model.showSetup = false } }
    }

    private struct SwarmID: Identifiable { let id: String }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .serviceTooOld:
            TeamsEmptyState(symbol: "arrow.triangle.2.circlepath",
                            title: L10n.t("Update the Swarmaa service"),
                            detail: L10n.t("This service has no bots or threads yet. Update it, then reopen this window."),
                            action: (L10n.t("Try again"), { Task { await model.refresh() } }))
        case .failed(let message):
            TeamsEmptyState(symbol: "exclamationmark.triangle", title: message, detail: nil,
                            action: (L10n.t("Try again"), { Task { await model.refresh() } }))
        case .ready:
            switch model.pane {
            case .bots: BotsHome(model: model)
            case .tasks: TasksPane(model: model)
            case .usage: UsagePane(model: model)
            }
        }
    }
}

// MARK: - Rail

/// The ink rail: Bots, Tasks, Usage, then one usage ring per provider (hover
/// for the windows, like the notch), then Settings.
struct TeamsRail: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        VStack(spacing: 8) {
            KSMoji(seed: "swarmaa", size: 42, kind: .mark).padding(.top, KS.topBarHeight + 14).padding(.bottom, 8)
            item("person.2.fill", L10n.t("Bots"), .bots, badge: model.botsWithUpdates)
            item("checklist", L10n.t("Tasks"), .tasks, badge: 0)
            item("chart.bar.fill", L10n.t("Usage"), .usage, badge: 0)
            Spacer(minLength: 12)
            if case let usage = model.allUsage, !usage.isEmpty {
                Text(verbatim: L10n.t("USAGE")).font(KS.mono(9)).tracking(1).foregroundStyle(KS.onInkMuted)
                ForEach(usage, id: \.provider) { UsageRingButton(model: model, usage: $0) }
            }
            Button { AppDelegate.shared?.openSettings() } label: {
                Image(systemName: "gearshape").font(.system(size: 18)).frame(width: 46, height: 46)
            }
            .buttonStyle(RailButtonStyle()).foregroundStyle(KS.onInkSoft)
            .help(L10n.t("Settings")).accessibilityLabel(L10n.t("Settings"))
            .padding(.bottom, 12)
        }
        .frame(width: 72)
        .frame(maxHeight: .infinity)
        .background(KS.ink)
    }

    private func item(_ symbol: String, _ title: String, _ pane: TeamsModel.Pane, badge: Int) -> some View {
        let on = model.pane == pane
        return Button { model.pane = pane } label: {
            Image(systemName: symbol).font(.system(size: 17, weight: .semibold))
                .frame(width: 46, height: 46)
                .background(Circle().fill(on ? KS.lime : .clear))
                .foregroundStyle(on ? KS.ink : KS.onInkSoft)
                .overlay(alignment: .topTrailing) { if badge > 0 { KSBadge(count: badge).offset(x: 6, y: -4) } }
                .contentShape(Circle())
        }
        .buttonStyle(RailButtonStyle())
        .help(title)
        .accessibilityLabel(badge > 0 ? title + ", " + L10n.t("\(badge) with updates") : title)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct RailButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RailButtonFace(configuration: configuration)
    }

    private struct RailButtonFace: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovered = false
        var body: some View {
            configuration.label
                .background(Circle().fill(KS.paper.opacity(configuration.isPressed ? 0.18 : hovered ? 0.10 : 0)))
                .onHover { hovered = $0 }
        }
    }
}

/// A provider's ring; hovering shows its windows, resets and where routing sends work.
struct UsageRingButton: View {
    @ObservedObject var model: TeamsModel
    let usage: SwarmaStatus.Usage
    @State private var hovering = false
    @State private var pinned = false

    private var name: String { SwarmaCells.vendorName(usage.provider) }
    private var left: Double? { usage.headroom.map { min(max($0, 0), 100) } }

    var body: some View {
        Button { pinned.toggle() } label: {
            ZStack {
                Circle().stroke(KS.inkLine, lineWidth: 4.5)
                if let left {
                    Circle().trim(from: 0, to: left / 100)
                        .stroke(KS.providerTint(usage.provider), style: StrokeStyle(lineWidth: 4.5, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                }
                Text(verbatim: TeamsCopy.providerShort(usage.provider)).font(KS.mono(10, .bold)).foregroundStyle(KS.paper)
            }
            .frame(width: 34, height: 34).frame(width: 46, height: 42).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .popover(isPresented: Binding(get: { hovering || pinned }, set: { if !$0 { hovering = false; pinned = false } }),
                 arrowEdge: .trailing) {
            UsageCard(model: model, usage: usage).environment(\.colorScheme, .light)
        }
        .accessibilityLabel(name + ", " + (left.map { L10n.t("\(Int($0)) percent left") } ?? L10n.t("no reading")))
        .accessibilityHint(L10n.t("Shows usage"))
    }
}

/// The hover card: one bar per window with its reset, then the routing line.
struct UsageCard: View {
    @ObservedObject var model: TeamsModel
    let usage: SwarmaStatus.Usage

    private var routing: SwarmaStatus.Routing.Provider? {
        model.status?.routing?.providers.first { $0.provider == usage.provider }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(verbatim: SwarmaCells.vendorName(usage.provider)).font(KS.body(18, .bold)).foregroundStyle(KS.paper)
                Spacer()
                if let h = usage.headroom { KSChip("\(Int(h))% " + L10n.t("left"), fill: KS.providerTint(usage.provider)) }
            }
            if let error = usage.error { Text(verbatim: error).font(KS.body(13)).foregroundStyle(KS.coral) }
            ForEach(Array(usage.windows.enumerated()), id: \.offset) { _, w in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(verbatim: TeamsCopy.windowName(w.name)).font(KS.body(14)).foregroundStyle(KS.paper)
                        Spacer()
                        Text(verbatim: w.usedPercent.map { "\(Int($0))% " + L10n.t("used") } ?? "—")
                            .font(KS.mono(12, .semibold)).foregroundStyle(KS.paper)
                    }
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(KS.inkLine)
                            Capsule().fill(KS.providerTint(usage.provider))
                                .frame(width: g.size.width * min(max((w.usedPercent ?? 0) / 100, 0), 1))
                        }
                    }.frame(height: 8)
                    if let reset = w.resetsAt {
                        Text("Resets \(reset, format: .relative(presentation: .named))").font(KS.body(12)).foregroundStyle(KS.onInkSoft)
                    }
                }
            }
            Rectangle().fill(KS.inkLine).frame(height: 2)
            HStack {
                Text(verbatim: routing.map { $0.liveWorker ? L10n.t("Live worker ready") : L10n.t("No live worker") } ?? L10n.t("Not routed"))
                    .font(KS.body(12)).foregroundStyle(KS.onInkSoft)
                Spacer()
                Button(L10n.t("Usage")) { model.pane = .usage }.buttonStyle(.ks(.primary, compact: true))
            }
        }
        .padding(16).frame(width: 290)
        .background(KS.ink)
    }
}

// MARK: - Shared

/// Kept for the cards and lists that predate the Kind Swarm restyle.
struct TeamsAvatar: View {
    let seed: String
    let name: String
    var isChannel = false
    var size: CGFloat = 32
    var body: some View {
        if isChannel {
            Text(verbatim: "#").font(KS.display(size * 0.55)).frame(width: size, height: size)
                .ksCard(fill: KS.lime, radius: size * 0.3, line: 2).accessibilityHidden(true)
        } else {
            KSMoji(seed: seed, size: size)
        }
    }
}

struct RoleBadge: View {
    let role: String
    var body: some View { KSChip(role) }
}

struct TeamsEmptyState: View {
    let symbol: String
    let title: String
    let detail: String?
    let action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 30, weight: .semibold)).foregroundStyle(KS.ink)
                .frame(width: 72, height: 72).ksCard(fill: KS.lime, radius: 24, shadow: true)
            Text(verbatim: title).font(KS.body(20, .bold)).multilineTextAlignment(.center)
            if let detail { Text(verbatim: detail).font(KS.body(15)).foregroundStyle(KS.textSoft).multilineTextAlignment(.center).frame(maxWidth: 420) }
            if let action { Button(action.0, action: action.1).buttonStyle(.ks(.primary)) }
        }
        .padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Bottom action bar used by every pane: actions sit at the bottom, pinned.
struct KSBottomBar<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: 10) { content }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .background(KS.white)
            .overlay(alignment: .top) { Rectangle().fill(KS.ink).frame(height: 2.5) }
    }
}

// MARK: - Usage

struct UsagePane: View {
    @ObservedObject var model: TeamsModel

    var body: some View {
        VStack(spacing: 0) {
            KSTopBar {
                Text(verbatim: L10n.t("USAGE.")).font(KS.display(24)).fixedSize()
                Text(verbatim: L10n.t("What each subscription has left, and where auto routing sends work next."))
                    .font(KS.body(13)).foregroundStyle(KS.textSoft).lineLimit(1)
                Spacer(minLength: 0)
                TeamsConnectionStatus(model: model)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if case let usage = model.allUsage, !usage.isEmpty {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 22, alignment: .top)], alignment: .leading, spacing: 22) {
                            ForEach(usage, id: \.provider) { u in UsageProviderCard(usage: u) }
                        }
                        if let routed = model.status?.usage, !routed.isEmpty { RoutingOrderBand(usage: routed) }
                    } else {
                        TeamsEmptyState(symbol: "chart.bar", title: L10n.t("No usage readings yet"),
                                        detail: L10n.t("Swarmaa shows each provider's quota once a worker reports it."), action: nil)
                    }
                }
                .padding(28)
            }
            KSBottomBar {
                Text(verbatim: model.lastUpdated.map { L10n.t("Updated ") + $0.formatted(.relative(presentation: .named)) } ?? "")
                    .font(KS.body(14)).foregroundStyle(KS.textMuted)
                Spacer()
                Button(L10n.t("Routing rules")) { AppDelegate.shared?.openSettings() }.buttonStyle(.ks(.paper))
                Button(L10n.t("Refresh all")) { Task { await model.refresh() } }.buttonStyle(.ks(.primary))
            }
        }
    }
}

struct UsageProviderCard: View {
    let usage: SwarmaStatus.Usage
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(verbatim: SwarmaCells.vendorName(usage.provider)).font(KS.body(19, .bold))
                Spacer()
                if let plan = usage.plan, !plan.isEmpty { KSChip(plan) }
            }
            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Text(verbatim: usage.headroom.map { "\(Int($0))%" } ?? "—").font(KS.display(46))
                KSLabel(L10n.t("left"))
            }
            if let error = usage.error { Text(verbatim: error).font(KS.body(13)).foregroundStyle(KS.textSoft) }
            ForEach(Array(usage.windows.enumerated()), id: \.offset) { _, w in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(verbatim: TeamsCopy.windowName(w.name)).font(KS.body(14))
                        Spacer()
                        Text(verbatim: w.usedPercent.map { "\(Int($0))% " + L10n.t("used") } ?? "—").font(KS.mono(12, .semibold))
                    }
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(KS.paper)
                            Capsule().fill(KS.providerTint(usage.provider))
                                .frame(width: g.size.width * min(max((w.usedPercent ?? 0) / 100, 0), 1))
                        }
                        .overlay(Capsule().stroke(KS.ink, lineWidth: 2))
                    }.frame(height: 10)
                    if let reset = w.resetsAt {
                        Text("Resets \(reset, format: .relative(presentation: .named))").font(KS.body(12)).foregroundStyle(KS.textMuted)
                    }
                }
            }
        }
        .padding(18).ksCard(radius: 22)
    }
}

/// Providers in the order auto routing would try them now: most quota left first.
struct RoutingOrderBand: View {
    let usage: [SwarmaStatus.Usage]
    var body: some View {
        let order = usage.filter { $0.headroom != nil }.sorted { ($0.headroom ?? 0) > ($1.headroom ?? 0) }
        VStack(alignment: .leading, spacing: 12) {
            KSLabel(L10n.t("01 — Auto routing order, right now"), color: KS.onInkSoft)
            HStack(spacing: 10) {
                ForEach(Array(order.enumerated()), id: \.element.provider) { i, u in
                    if i > 0 { Text(verbatim: "→").foregroundStyle(KS.onInkMuted) }
                    KSChip("\(i + 1)", fill: i == 0 ? KS.lime : KS.white)
                    Text(verbatim: SwarmaCells.vendorName(u.provider)).font(KS.body(15, .semibold)).foregroundStyle(KS.paper)
                }
            }
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(KS.ink))
    }
}

enum TeamsCopy {
    static func swarmStatus(_ status: String) -> String {
        switch status {
        case "planning": return L10n.t("Planning")
        case "running": return L10n.t("Running")
        case "waiting_on_you": return L10n.t("Waiting on you")
        case "blocked": return L10n.t("Blocked")
        case "done": return L10n.t("Done")
        case "cancelled": return L10n.t("Cancelled")
        case "failed": return L10n.t("Failed")
        case "pending": return L10n.t("Pending")
        default: return status
        }
    }

    /// Two letters, so Claude and Codex differ in the rail.
    static func providerShort(_ provider: String) -> String {
        switch provider {
        case "claude": return "CL"
        case "codex": return "CX"
        case "antigravity": return "AG"
        case "grok": return "GK"
        default: return String(SwarmaCells.vendorName(provider).prefix(2)).uppercased()
        }
    }

    static func windowName(_ name: String?) -> String {
        switch name {
        case "5h": return L10n.t("Session · 5 h")
        case "weekly": return L10n.t("Week")
        case nil: return L10n.t("Window")
        case let n? where n.hasPrefix("weekly_"):  // per-model weekly caps, e.g. weekly_fable
            let model = n.dropFirst(7).replacingOccurrences(of: "_", with: " ")
            return L10n.t("Week") + " · " + model.prefix(1).uppercased() + model.dropFirst()
        default: return name!.prefix(1).uppercased() + name!.dropFirst()
        }
    }
}
