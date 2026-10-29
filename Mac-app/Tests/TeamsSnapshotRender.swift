import AppKit
import SwiftUI
import XCTest
@testable import Codenotch

/// Renders the main window's screens to PNGs off-screen (no Screen Recording
/// needed) from example data. Writes only when SWARMAA_SNAPSHOT_DIR is set.
@MainActor
final class TeamsSnapshotRender: XCTestCase {
    private func dec<T: Decodable>(_ t: T.Type, _ json: String) throws -> T {
        try SwarmaClient.decoder.decode(T.self, from: Data(json.utf8))
    }

    private func fixture() throws -> TeamsModel {
        let now = ISO8601DateFormatter().string(from: Date())
        let agents = try dec([TeamsAgent].self, """
        [{"id":"a1","name":"Atlas","role":"Team lead","scope":"project:swarma","main_thread_id":"m1","runner":{"mode":"auto"},"edits":false,"version":1},
         {"id":"a2","name":"Scout","role":"Research","scope":"project:swarma","main_thread_id":"m2","runner":{"mode":"auto"},"edits":false,"version":1},
         {"id":"a3","name":"Forge","role":"Builder","scope":"project:swarma","main_thread_id":"m3","runner":{"provider":"claude","effort":"high"},"edits":true,"version":1},
         {"id":"a4","name":"Pulse","role":"Signals","scope":"project:swarma","main_thread_id":"m4","runner":{"mode":"auto"},"edits":false,"version":1}]
        """)
        func bot(_ id: String, _ name: String, lead: String, members: [String], needs: Int, unread: Int, line: String, schedule: String? = nil) -> String {
            """
            {"id":"\(id)","scope":"project:swarma","name":"\(name)","job":"Plans and runs product launches: reads the brief, splits the work across the crew, drafts the copy and assets, and asks me before anything goes public.",
             "thread_id":"t\(id)","lead_agent_id":"\(lead)","member_agent_ids":\(members),"schedule":\(schedule.map { "\"\($0)\"" } ?? "null"),
             "routing":{"research":{"mode":"auto"},"patch":{"provider":"claude","effort":"high"},"review":{"mode":"different_from_author"},"summary":{"provider":"antigravity"}},
             "rules":{"quota_floor_pct":0,"approve_public":true,"review_edits":true,"require_tests":true},"version":2,
             "badges":{"unread":\(unread),"needs_you":\(needs),"latest":{"line":"\(line)","at":"\(now)"}},
             "routing_now":{"research":{"provider_now":"antigravity","reason":"most quota left"},"patch":{"provider_now":"claude","reason":"named runner"},
                            "review":{"provider_now":"codex","reason":"different from the author"},"summary":{"provider_now":"antigravity","reason":"named runner"}}}
            """
        }
        let bots = try dec([TeamsBot].self, "[" + [
            bot("1", "Launch", lead: "a1", members: ["a2", "a3", "a4"], needs: 1, unread: 0, line: "Atlas: which channels should we use?"),
            bot("2", "Pricing fix", lead: "a3", members: ["a2"], needs: 0, unread: 1, line: "Forge: ready for review · 3 files"),
            bot("3", "Competitor watch", lead: "a2", members: [], needs: 1, unread: 0, line: "Failed: Codex quota. Retry routes to Claude.", schedule: "0 8 * * *"),
            bot("4", "Signals", lead: "a4", members: [], needs: 0, unread: 0, line: "Mentions of agent teams are up this week.", schedule: "0 * * * *"),
            bot("5", "Release notes", lead: "a1", members: ["a3"], needs: 0, unread: 0, line: "Drafted notes for 1.25.0."),
        ].joined(separator: ",") + "]")
        let messages = try dec([TeamsMessage].self, """
        [{"id":"x1","thread_id":"t1","seq":1,"author":{"kind":"human"},"kind":"text","body":"Plan Friday's launch across the team. Keep me in the loop on anything public.","created_at":"\(now)"},
         {"id":"x2","thread_id":"t1","seq":2,"author":{"kind":"agent","id":"a1"},"kind":"text","body":"On it. Scout reads the brief, Forge drafts the banner, Pulse checks the timing. I will ask before anything goes out.","created_at":"\(now)"},
         {"id":"x3","thread_id":"t1","seq":3,"author":{"kind":"system"},"kind":"swarm","ref":{"swarm_id":"s1"},
          "swarm":{"id":"s1","title":"Friday's launch, split across the team.","status":"waiting_on_you","thread_id":"t1","progress":{"done":3,"total":5},
           "steps":[{"id":"st1","title":"Read the launch brief and this week's updates","assignee_agent_id":"a2","status":"done"},
                    {"id":"st2","title":"Draft the banner and release notes","assignee_agent_id":"a3","status":"done"},
                    {"id":"st3","title":"Check nobody else launches that day","assignee_agent_id":"a4","status":"done"},
                    {"id":"st4","title":"Pick the launch channels","assignee_agent_id":"a1","status":"waiting_on_you"},
                    {"id":"st5","title":"Schedule the posts","assignee_agent_id":"a4","status":"pending"}]}},
         {"id":"x4","thread_id":"t1","seq":4,"author":{"kind":"system"},"kind":"handoff","body":"Atlas gave Forge: draft the banner"},
         {"id":"x5","thread_id":"t1","seq":5,"author":{"kind":"system"},"kind":"task","body":"Forge finished the launch banner · tests pass","ref":{"task_id":"k1"},
          "task":{"id":"k1","title":"Draft the launch banner","kind":"patch","status":"completed","resolved":false,"branch":"swarmaa/claude/4f1e","changed_files":7,"served":{"provider":"claude"},"check":{"status":"passed"}}},
         {"id":"x6","thread_id":"t1","seq":6,"author":{"kind":"system"},"kind":"task","body":"Pulse's first try hit the Codex weekly limit","ref":{"task_id":"k2"},
          "task":{"id":"k2","title":"Check the launch calendar","kind":"research","status":"failed","resolved":false,"failure":{"code":"quota_exhausted","detail":"Codex weekly limit"}}},
         {"id":"x7","thread_id":"t1","seq":7,"author":{"kind":"agent","id":"a1"},"kind":"question","ref":{"question_id":"q1"},
          "question":{"id":"q1","prompt":"Which channels should the launch use?","options":["Blog and changelog","X","LinkedIn","Product Hunt"],"multi":true,"free_text":true,"status":"open"}}]
        """)
        let status = try dec(SwarmaStatus.self, """
        {"usage":[
          {"provider":"antigravity","ok":true,"headroom":83,"windows":[{"name":"5h","used_percent":18,"resets_at":"2026-10-28T10:57:00Z"},{"name":"weekly","used_percent":12,"resets_at":"2026-11-01T10:10:00Z"}]},
          {"provider":"claude","ok":true,"headroom":80,"plan":"Max","windows":[{"name":"5h","used_percent":20,"resets_at":"2026-10-28T08:19:00Z"},{"name":"weekly","used_percent":13,"resets_at":"2026-11-02T02:59:00Z"}]},
          {"provider":"codex","ok":true,"headroom":12,"windows":[{"name":"weekly","used_percent":88,"resets_at":"2026-11-02T13:53:00Z"}]}],
         "routing":{"providers":[{"provider":"claude","headroom":80,"live_worker":true},{"provider":"antigravity","headroom":83,"live_worker":true},{"provider":"codex","headroom":12,"live_worker":true}]},
         "scopes":[{"scope":"project:swarma"}]}
        """)
        let attention = try dec([TeamsAttentionItem].self, """
        [{"kind":"question","id":"q1","title":"Which channels should the launch use?","state":"open","next_step":"Needs input · Atlas asked which channels to use","at":"\(now)"},
         {"kind":"task","id":"k1","title":"Draft the launch banner","state":"completed","next_step":"Ready for review · branch swarmaa/claude/4f1e · 7 files","at":"\(now)"},
         {"kind":"task","id":"k9","title":"Fix the plan limits on the pricing page","state":"completed","next_step":"Ready for review · branch swarmaa/codex/9b20 · 3 files","at":"\(now)"},
         {"kind":"task","id":"k2","title":"Summarise competitor pricing","state":"failed","next_step":"Failed · quota_exhausted on Codex","at":"\(now)"}]
        """)
        let model = TeamsModel()
        model.loadFixture(agents: agents, bots: bots, messages: ["t1": messages], status: status, attention: attention, select: "t1")
        return model
    }

    private func render<V: View>(_ view: V, _ name: String, size: CGSize) throws {
        guard let dir = ProcessInfo.processInfo.environment["SWARMAA_SNAPSHOT_DIR"] else { throw XCTSkip("set SWARMAA_SNAPSHOT_DIR") }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height).environment(\.colorScheme, .light))
        host.frame = NSRect(origin: .zero, size: size)
        host.appearance = NSAppearance(named: .aqua)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return XCTFail("no bitmap") }
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }

    func testRenderTaskSelectionAndDetails() throws {
        let model = try fixture()
        let items = (1...3).map { TeamsAttentionItem(kind: "task", id: "selected-\($0)", title: "Review launch task \($0)", state: "completed", nextStep: "Ready for review") }
        model.loadFixture(agents: model.agents, bots: model.bots, messages: model.messages, status: model.status,
                          attention: items + [TeamsAttentionItem(kind: "task", id: "running", title: "Prepare launch", state: "running", nextStep: "Working")], select: nil)
        model.pane = .tasks; model.selectingTasks = true; model.taskSelection = Set(items.map(\.id))
        try render(TasksPane(model: model), "task-selection-three", size: CGSize(width: 1000, height: 650))
        model.selectingTasks = false; model.taskSelection = []
        model.taskDetailID = "detail"
        model.taskDetail = try TaskDetailsTests.detail()
        try render(TasksPane(model: model), "task-detail-usage", size: CGSize(width: 1100, height: 1600))
        model.taskDetail = try TaskDetailsTests.detail(usage: false)
        try render(TasksPane(model: model), "task-detail-no-usage", size: CGSize(width: 1100, height: 1600))
        try render(TasksPane(model: model), "task-detail-compact", size: CGSize(width: 900, height: 650))
    }

    func testRenderBotsSidebarBar() throws {
        let model = try fixture()
        model.setBotsForTesting(Array(model.bots.prefix(2)))
        XCTAssertEqual(model.bots.count, 2)
        XCTAssertTrue(model.search.isEmpty)
        try render(BotsSidebar(model: model), "1f-bots-sidebar-bar", size: CGSize(width: 300, height: 500))
    }

    func testRenderScreens() throws {
        let model = try fixture()
        try render(TeamsRootView(model: model), "1-bots-home", size: CGSize(width: 1440, height: 900))
        try render(TeamsRootView(model: model), "1b-bots-compact", size: CGSize(width: 900, height: 650))
        let empty = TeamsModel()
        empty.phase = .ready
        try render(TeamsRootView(model: empty), "1c-empty", size: CGSize(width: 900, height: 650))
        let failed = TeamsModel()
        failed.phase = .failed("Could not load bots")
        try render(TeamsRootView(model: failed), "1d-error", size: CGSize(width: 900, height: 650))
        model.editingBotID = "1"
        try render(TeamsRootView(model: model), "2-bot-settings", size: CGSize(width: 1440, height: 900))
        try render(TeamsRootView(model: model), "2b-bot-settings-compact", size: CGSize(width: 900, height: 650))
        model.editingBotID = nil
        model.pane = .tasks
        model.taskSort = .state
        try render(TeamsRootView(model: model), "3-tasks", size: CGSize(width: 1440, height: 900))
        try render(TeamsRootView(model: model), "3b-tasks-compact", size: CGSize(width: 900, height: 650))
        model.pane = .usage
        try render(TeamsRootView(model: model), "4-usage", size: CGSize(width: 1440, height: 900))
        try render(TeamsRootView(model: model), "4b-usage-compact", size: CGSize(width: 900, height: 650))
        try render(UsageCard(model: model, usage: model.status!.usage[1]), "5-usage-hover-card", size: CGSize(width: 290, height: 300))
    }

    func testRenderTasksTopBar() throws {
        let model = try fixture()
        model.pane = .tasks
        try render(TeamsRootView(model: model), "6-tasks-top-bar", size: CGSize(width: 1280, height: 820))
        model.taskSearch = "launch"
        try render(TeamsRootView(model: model), "6b-tasks-top-bar-search", size: CGSize(width: 900, height: 650))
        let reconnecting = TeamsModel()
        reconnecting.phase = .ready
        reconnecting.pane = .tasks
        try render(TeamsRootView(model: reconnecting), "6c-tasks-reconnecting", size: CGSize(width: 900, height: 650))
        reconnecting.pane = .usage
        try render(TeamsRootView(model: reconnecting), "6d-usage-reconnecting", size: CGSize(width: 900, height: 650))
    }

    /// Dispatch through a real titled window: a borderless render cannot detect
    /// titlebar interception. Probe the shared responder in all three columns.
    func testTopRowReceivesClicks() throws {
        let controller = TeamsWindowController(model: try fixture())
        controller.show(connect: false)
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertTrue(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titleVisibility, .hidden)
        let content = try XCTUnwrap(window.contentView)
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            let button = try XCTUnwrap(window.standardWindowButton(kind))
            let rect = content.convert(button.bounds, from: button)
            let top = content.isFlipped ? rect.midY : content.bounds.height - rect.midY
            XCTAssertEqual(top, KS.topBarHeight / 2, accuracy: 1)
        }
        var clicks = [0, 0, 0]
        let probe = TeamsHostingView(rootView: HStack(spacing: 0) {
            ForEach(0..<3) { column in
                KSTopBar {
                    KSBarButton(symbol: "plus", label: "Probe") { clicks[column] += 1 }
                    Spacer()
                    TextField("Search", text: .constant("")).textFieldStyle(.plain).frame(width: 100)
                }.frame(width: 240)
            }
        })
        probe.safeAreaRegions = []
        let originY = content.isFlipped ? 0 : content.bounds.height - KS.topBarHeight
        probe.frame = NSRect(x: 72, y: originY, width: 720, height: KS.topBarHeight)
        content.addSubview(probe)
        defer { probe.removeFromSuperview() }
        probe.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        func click(_ point: NSPoint) throws {
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
                window.sendEvent(event)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        for column in 0..<3 {
            try click(probe.convert(NSPoint(x: CGFloat(column) * 240 + 28, y: 26), to: nil))
            XCTAssertEqual(clicks[column], 1, "Column \(column) button must receive titlebar-region clicks")
            try click(probe.convert(NSPoint(x: CGFloat(column) * 240 + 180, y: 26), to: nil))
            XCTAssertTrue(window.firstResponder is NSTextView, "Search must become the field editor")
        }
    }

    func testRenderThreadBars() throws {
        if let dir = ProcessInfo.processInfo.environment["SWARMAA_SNAPSHOT_DIR"] {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        let model = try fixture()
        let bot = try XCTUnwrap(model.bot(id: "1"))
        var messages = model.messages[bot.threadID] ?? []
        messages.append(try dec(TeamsMessage.self, """
        {"id":"active","thread_id":"t1","seq":8,"author":{"kind":"system"},"kind":"task",
         "task":{"id":"active-task","title":"Prepare launch","status":"running","resolved":false}}
        """))
        model.loadFixture(agents: model.agents, bots: model.bots, messages: [bot.threadID: messages],
                          status: model.status, select: bot.threadID)
        XCTAssertEqual(model.botActiveTaskCount(bot), 1)
        XCTAssertEqual(model.botNeedsYou(bot), 1)
        try render(BotThreadHeader(model: model, bot: bot), "thread-bar-default", size: CGSize(width: 1000, height: KS.topBarHeight))
        try render(BotThreadHeader(model: model, bot: bot), "thread-bar-narrow", size: CGSize(width: 460, height: KS.topBarHeight))
        model.editingBotID = bot.id
        try render(BotThreadHeader(model: model, bot: bot), "thread-bar-settings-open", size: CGSize(width: 1000, height: KS.topBarHeight))
    }

    /// The real titled window, title bar included: the borderless renders above draw no traffic lights.
    func testRenderWindowChrome() throws {
        guard let dir = ProcessInfo.processInfo.environment["SWARMAA_SNAPSHOT_DIR"] else { throw XCTSkip("set SWARMAA_SNAPSHOT_DIR") }
        let controller = TeamsWindowController(model: try fixture())
        controller.show(connect: false)
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        window.setContentSize(NSSize(width: 1280, height: 820))
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        let frame = try XCTUnwrap(window.contentView?.superview)
        frame.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
        frame.cacheDisplay(in: frame.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: dir).appendingPathComponent("0-window-chrome.png"))
    }

    func testRenderBotAppearance() throws {
        let model = try fixture()
        var bot = try XCTUnwrap(model.bot(id: "1"))
        bot.avatar = "scout"
        bot.color = "peach"
        model.setBotsForTesting([bot])
        let message = try XCTUnwrap(model.messages[bot.threadID]?.first { $0.author.id == bot.leadAgentID })
        for width: CGFloat in [460, 1000] {
            try render(VStack(spacing: 20) {
                BotThreadHeader(model: model, bot: bot)
                BotRow(model: model, bot: bot).frame(width: 300)
                TextBubble(model: model, message: message).padding(.horizontal, 16)
                TypingBubble(model: model, typing: TeamsTyping(taskID: "preview", agentID: bot.leadAgentID,
                             text: "Now wearing peach.", updatedAt: nil), threadID: bot.threadID).padding(.horizontal, 16)
            }.padding(.vertical, 12).background(KS.paper),
                       "bot-appearance-\(Int(width))", size: CGSize(width: width, height: 360))
        }
        bot.color = nil
        model.setBotsForTesting([bot])
        try render(VStack(spacing: 20) {
            BotThreadHeader(model: model, bot: bot)
            BotRow(model: model, bot: bot).frame(width: 300)
            TextBubble(model: model, message: message).padding(.horizontal, 16)
        }.background(KS.paper),
                   "bot-appearance-no-color", size: CGSize(width: 460, height: 280))
    }

    func testRenderBotRowHover() throws {
        let model = try fixture()
        let bot = try XCTUnwrap(model.bot(id: "1"))
        try render(VStack(spacing: 6) {
            BotRow(model: model, bot: bot)
            BotRow(model: model, bot: bot, hovered: true)
        }.padding(12).background(KS.paperDeep), "1g-bot-row-hover", size: CGSize(width: 300, height: 190))
    }

    /// The chat must sit still once it has settled: a bottom-pinned thread re-correcting for changing
    /// row heights bounced up and down every frame in a real window.
    func testThreadScrollPositionSettles() throws {
        let model = try fixture()
        // Like a real bot thread: several long markdown replies, whose heights change once rendered.
        let threadID = try XCTUnwrap(model.selectedThreadID)
        var messages = model.messages[threadID] ?? []
        let long = (1...40).map { i in i % 8 == 0 ? "## Section \(i)" : "- **Item \(i):** `value` with some *formatting* and a longer explanation that wraps across the bubble." }.joined(separator: "\\n")
        for i in 0..<8 {
            messages.append(try dec(TeamsMessage.self, """
            {"id":"long\(i)","thread_id":"\(threadID)","seq":\(100 + i),"author":{"kind":"agent","id":"a1"},"kind":"text","body":"\(long)"}
            """))
        }
        model.loadFixture(agents: model.agents, bots: model.bots, messages: [threadID: messages], status: model.status, select: threadID)
        let controller = TeamsWindowController(model: model)
        controller.show(connect: false)
        let window = try XCTUnwrap(controller.window)
        defer { window.close() }
        window.setContentSize(NSSize(width: 1280, height: 820))
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        func scrollViews(_ view: NSView) -> [NSScrollView] { ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews) }
        let thread = try XCTUnwrap(scrollViews(try XCTUnwrap(window.contentView)).max { $0.frame.width < $1.frame.width })
        var offsets: [CGFloat] = []
        for _ in 0..<20 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            offsets.append(thread.contentView.bounds.origin.y)
        }
        XCTAssertLessThan((offsets.max() ?? 0) - (offsets.min() ?? 0), 1, "thread kept moving: \(offsets)")
    }

    func testRenderPhotoComposer() throws {
        let model = try fixture()
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 80, pixelsHigh: 60, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let bytes = try XCTUnwrap(bitmap.bitmapData)
        for y in 0..<60 { for x in 0..<80 {
            let offset = y * bitmap.bytesPerRow + x * 4
            bytes[offset] = y < 35 ? 166 : 122
            bytes[offset + 1] = y < 35 ? 204 : 166
            bytes[offset + 2] = y < 35 ? 230 : 89
            bytes[offset + 3] = 255
        } }
        let photoData = try XCTUnwrap(bitmap.representation(using: .jpeg, properties: [:]))
        XCTAssertNotNil(NSImage(data: photoData))
        model.photoDrafts["t1"] = [ChatPhoto(id: UUID(), name: "photo.jpg", data: photoData)]
        model.drafts["t1"] = "A photo for the launch"
        try render(TeamsRootView(model: model), "1e-photo-composer-compact", size: CGSize(width: 900, height: 650))
    }
}
