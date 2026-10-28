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

    func testRenderScreens() throws {
        let model = try fixture()
        try render(TeamsRootView(model: model), "1-bots-home", size: CGSize(width: 1440, height: 900))
        model.editingBotID = "1"
        try render(TeamsRootView(model: model), "2-bot-settings", size: CGSize(width: 1440, height: 900))
        model.editingBotID = nil
        model.pane = .tasks
        model.taskSort = .state
        try render(TeamsRootView(model: model), "3-tasks", size: CGSize(width: 1440, height: 900))
        model.pane = .usage
        try render(TeamsRootView(model: model), "4-usage", size: CGSize(width: 1440, height: 900))
        try render(UsageCard(model: model, usage: model.status!.usage[1]), "5-usage-hover-card", size: CGSize(width: 290, height: 300))
    }
}
