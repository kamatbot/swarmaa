import SwiftUI
import UIKit

/// The Swarm map's brain, ported from the Mac (Mac-app/Sources/Teams/SwarmMap.swift): diffs one
/// `swarm_status` snapshot against the last and keeps what the panel draws. Pure value type.
struct SwarmMapState {
    struct Run: Equatable { let id, provider: String; let objective: String?; let startedAt: Date? }
    enum PulseKind: Equatable { case out, back, failed, handoff }
    struct Pulse: Equatable { let id: String; let kind: PulseKind; let from, to: String; let startedAt: Date }
    enum FeedKind: Equatable { case running, done, failed, handoff }
    struct FeedRow: Equatable, Identifiable {
        let id: String
        var kind: FeedKind
        let provider: String
        var from: String? = nil
        let objective: String?
        let at: Date
        var startedAt: Date?
        var duration: TimeInterval?
    }
    static let pulseLife: TimeInterval = 1
    static let feedLimit = 16

    private(set) var stations: [String] = []
    private(set) var offline: Set<String> = []
    private(set) var running: [String: [Run]] = [:]
    private(set) var finished: [String: Int] = [:]
    private(set) var failures: [String: Int] = [:]
    private(set) var tokens: [String: Int] = [:]
    /// Finished tasks whose token use is still to be looked up; the store drains it.
    var unpriced: [(id: String, provider: String)] = []
    private var priced = Set<String>()
    private(set) var queued = 0
    private(set) var pulses: [Pulse] = []
    /// Newest first.
    private(set) var feed: [FeedRow] = []
    private var previous: [String: Run]?

    var runningCount: Int { running.values.reduce(0) { $0 + $1.count } }

    mutating func addTokens(_ n: Int, provider: String, task: String) {
        guard priced.insert(task).inserted else { return }
        tokens[provider, default: 0] += n
    }

    mutating func ingest(_ status: JSON, at now: Date) {
        var current: [String: Run] = [:]
        var seen = Set(stations), live = Set<String>()
        for w in status["workers"].array {
            let providers = w["providers"].array.map(\.string).filter { !$0.isEmpty }
            for p in providers { seen.insert(p); if w["live"].bool { live.insert(p) } }
            guard let provider = providers.first else { continue }
            for r in w["running"].array where !r["task_id"].string.isEmpty {
                let id = r["task_id"].string, objective = r["objective"].string
                current[id] = Run(id: id, provider: provider, objective: objective.isEmpty ? nil : objective, startedAt: isoDate(r["started_at"].string))
            }
        }
        stations = seen.sorted()
        offline = seen.subtracting(live)
        queued = status["scopes"].array.reduce(0) { $0 + $1["queued"].int }
        running = Dictionary(grouping: current.values, by: \.provider).mapValues { $0.sorted { $0.id < $1.id } }
        let recent = status["recent"].array

        if let previous {
            for run in current.values.sorted(by: { $0.id < $1.id }) {
                if let old = previous[run.id] {
                    guard old.provider != run.provider else { continue }
                    pulses.append(Pulse(id: run.id + "-handoff", kind: .handoff, from: old.provider, to: run.provider, startedAt: now))
                    push(FeedRow(id: run.id + "-handoff", kind: .handoff, provider: run.provider, from: old.provider, objective: run.objective, at: now))
                    markRunning(run, at: now)
                } else {
                    pulses.append(Pulse(id: run.id + "-out", kind: .out, from: "hub", to: run.provider, startedAt: now))
                    markRunning(run, at: now)
                }
            }
            for old in previous.values.sorted(by: { $0.id < $1.id }) where current[old.id] == nil {
                let state = recent.first { $0["id"].string == old.id }?["status"].string
                if state == "queued" { feed.removeAll { $0.id == old.id }; continue }  // requeued, not finished
                let failed = state == "failed"
                pulses.append(Pulse(id: old.id + (failed ? "-failed" : "-back"), kind: failed ? .failed : .back, from: old.provider, to: "hub", startedAt: now))
                if failed { failures[old.provider, default: 0] += 1 } else { finished[old.provider, default: 0] += 1 }
                unpriced.append((old.id, old.provider))
                let row = FeedRow(id: old.id, kind: failed ? .failed : .done, provider: old.provider, objective: old.objective,
                                  at: now, startedAt: old.startedAt, duration: old.startedAt.map { now.timeIntervalSince($0) })
                if let i = feed.firstIndex(where: { $0.id == old.id }) { feed[i] = row } else { push(row) }
            }
        } else {
            for run in current.values.sorted(by: { $0.id < $1.id }) { markRunning(run, at: now) }
            // Seed token totals from the recent finished tasks, so the map is not empty on open.
            for row in recent where ["completed", "failed"].contains(row["status"].string) && !row["provider"].string.isEmpty {
                unpriced.append((row["id"].string, row["provider"].string))
            }
        }
        previous = current
        pulses.removeAll { now.timeIntervalSince($0.startedAt) > Self.pulseLife }
    }

    private mutating func markRunning(_ run: Run, at now: Date) {
        let row = FeedRow(id: run.id, kind: .running, provider: run.provider, objective: run.objective, at: now, startedAt: run.startedAt)
        if let i = feed.firstIndex(where: { $0.id == run.id }) { feed[i] = row } else { push(row) }
    }
    private mutating func push(_ row: FeedRow) {
        feed.insert(row, at: 0)
        if feed.count > Self.feedLimit { feed.removeLast(feed.count - Self.feedLimit) }
    }

    var accessibilitySummary: String {
        stations.map { p in
            let n = running[p]?.count ?? 0
            return vendorName(p) + (n > 0 ? " \(n) running" : offline.contains(p) ? " offline" : " idle")
        }.joined(separator: ", ")
    }
}

func isoDate(_ value: String) -> Date? {
    (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))) ?? (try? Date(value, strategy: .iso8601))
}
func vendorName(_ provider: String) -> String { provider.prefix(1).uppercased() + provider.dropFirst() }
func tokenText(_ value: Int) -> String {
    value < 1000 ? String(value) : String(format: "%.1fk", locale: Locale(identifier: "en_US_POSIX"), Double(value) / 1000)
}
func elapsedText(_ s: TimeInterval?) -> String {
    guard let s, s >= 0 else { return "" }
    let n = Int(s)
    return n < 60 ? "\(n)s" : n < 3600 ? "\(n / 60)m \(String(format: "%02d", n % 60))s" : "\(n / 3600)h \(n / 60 % 60)m"
}

/// Token use of one finished task: from its card when the card carries it, else one `task_get`, once per launch.
@MainActor enum TaskTokens {
    static var cache: [String: Int] = [:]
    static var missing = Set<String>()
    static func lookup(_ model: AppModel, id: String, card: JSON = .null) async -> Int? {
        func sum(_ u: JSON) -> Int? { u == .null ? nil : u["input_tokens"].int + u["output_tokens"].int }
        if let n = cache[id] { return n }
        if let n = sum(card["result"]["usage"]) { cache[id] = n; return n }
        guard !missing.contains(id), let service = model.service, !model.isDemo else { return nil }
        if let task = try? await service.call("task_get", ["task_id": .string(id)])["task"], let n = sum(task["result"]["usage"]) {
            cache[id] = n; return n
        }
        missing.insert(id); return nil
    }
}

/// Holds the reducer and feeds it every status the model publishes.
@MainActor @Observable final class SwarmMapStore {
    var state = SwarmMapState()
    func ingest(_ status: JSON, model: AppModel) {
        guard status != .null else { return }
        state.ingest(status, at: Date())
        let todo = state.unpriced
        state.unpriced = []
        guard !todo.isEmpty else { return }
        Task { [weak self] in
            for job in todo.prefix(30) {
                let card = model.tasks.first { $0["id"].string == job.id } ?? .null
                if let n = await TaskTokens.lookup(model, id: job.id, card: card) { self?.state.addTokens(n, provider: job.provider, task: job.id) }
            }
        }
    }
}

/// The map as a side panel, or (`monitor`) a full-screen board meant to be left open and read from across the room.
struct SwarmMapPanel: View {
    @Bindable var model: AppModel
    var monitor = false
    var expand: () -> Void
    var close: () -> Void
    @State private var store = SwarmMapStore()

    private var needYou: Int { model.sortedBots.reduce(0) { $0 + $1.needsYou } }
    /// Which bot a running task belongs to, when the task list knows it.
    private func botName(_ taskID: String) -> String? {
        guard let task = model.tasks.first(where: { $0["id"].string == taskID }) else { return nil }
        return model.bots.first { $0.id == task["bot_id"].string || $0.threadID == task["thread_id"].string }?.name
    }

    var body: some View {
        let s = store.state
        VStack(spacing: 0) {
            bar(s)
            if monitor {
                HStack(spacing: 0) {
                    map(s).frame(maxWidth: .infinity, maxHeight: .infinity)
                    Rectangle().fill(KS.hairline).frame(width: 1)
                    VStack(alignment: .leading, spacing: 0) {
                        feed(s).frame(maxHeight: .infinity)
                        Rectangle().fill(KS.hairline).frame(height: 1)
                        tokens(s).padding(20)
                    }.frame(width: 380)
                }
            } else {
                GeometryReader { g in
                    VStack(spacing: 0) {
                        map(s).frame(height: min(g.size.width / 0.84, g.size.height * 0.62))
                        Rectangle().fill(KS.hairline).frame(height: 1)
                        feed(s)
                    }
                }
            }
        }
        .background(KS.ground)
        .onChange(of: model.status, initial: true) { _, status in store.ingest(status, model: model) }
        .task {
            // The Mac polls its local service every 3 s; over the relay every 5 s, only while the map is on screen.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await model.refreshStatus()
            }
        }
        .onAppear { if monitor { UIApplication.shared.isIdleTimerDisabled = true } }
        .onDisappear { if monitor { UIApplication.shared.isIdleTimerDisabled = false } }
    }

    private func bar(_ s: SwarmMapState) -> some View {
        HStack(spacing: 12) {
            if monitor {
                Text("Swarm monitor").font(KS.title()).foregroundStyle(KS.strong).accessibilityAddTraits(.isHeader)
                Text("\(s.runningCount) running · \(s.queued) queued · \(needYou) need you").font(KS.mono(.semibold))
                    .foregroundStyle(needYou > 0 ? KS.needsText : KS.soft)
                Spacer()
                Button(action: close) { Label("Exit monitor", systemImage: "arrow.down.right.and.arrow.up.left") }
                    .buttonStyle(Pill()).keyboardShortcut(.cancelAction).accessibilityIdentifier("exit-monitor")
            } else {
                Eyebrow("Swarm map")
                Spacer()
                Button(action: expand) { Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44) }
                    .accessibilityLabel("Open swarm monitor").accessibilityIdentifier("swarm-monitor")
                Button(action: close) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                    .accessibilityLabel("Close swarm map")
            }
        }
        .buttonStyle(PressStyle(icon: true)).foregroundStyle(KS.muted)
        .padding(.horizontal, monitor ? 24 : 12).frame(minHeight: monitor ? 64 : 48)
        .background(KS.grouped)
        .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
    }

    private func map(_ s: SwarmMapState) -> some View {
        // Animate only while a swarm is active (tasks running or a pulse in flight); otherwise paused, and a new
        // status still redraws it once. Idle or closed costs no CPU.
        let moving = s.runningCount > 0 || !s.pulses.isEmpty
        let questions = needYou
        return TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !moving)) { tl in
            Canvas { ctx, size in
                SwarmMapDrawing.draw(&ctx, size, s, questions, tl.date, monitor: monitor, botName: botName)
            }
        }
        .padding(.top, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Swarm map. " + (s.stations.isEmpty ? "No workers connected" : s.accessibilitySummary))
    }

    private func feed(_ s: SwarmMapState) -> some View {
        let rows = s.feed
        return VStack(alignment: .leading, spacing: 0) {
            if let head = rows.first(where: { $0.kind == .running }) {
                Text("\(vendorName(head.provider)): \(head.objective ?? "—") · \(s.runningCount) running")
                    .font(monitor ? KS.headline() : KS.secondary(.semibold)).foregroundStyle(KS.ink).lineLimit(1)
                    .padding(.horizontal, 16).padding(.vertical, 10)
            } else {
                Text("Idle").font(monitor ? KS.headline() : KS.secondary(.semibold)).foregroundStyle(KS.muted)
                    .padding(.horizontal, 16).padding(.vertical, 10)
            }
            if monitor { Eyebrow("Recent events").padding(.horizontal, 16).padding(.bottom, 6) }
            ScrollView {
                // Running rows count up each second; a static list when nothing runs.
                TimelineView(.periodic(from: .now, by: 1)) { tl in
                    VStack(alignment: .leading, spacing: monitor ? 8 : 4) {
                        ForEach(rows) { row in
                            Text(Self.line(row, now: tl.date, bot: botName(row.id)))
                                .font(monitor ? .system(.body, design: .monospaced) : KS.mono())
                                .foregroundStyle(row.kind == .failed ? KS.failedText : row.kind == .running ? KS.ink : KS.muted)
                                .lineLimit(monitor ? 2 : 1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if rows.isEmpty && monitor { Text("Events appear here as tasks start and finish.").font(KS.body()).foregroundStyle(KS.muted) }
                    }.padding(.horizontal, 16).padding(.bottom, 12)
                }
            }
        }
    }

    private func tokens(_ s: SwarmMapState) -> some View {
        let order = s.tokens.sorted { $0.value > $1.value }
        return VStack(alignment: .leading, spacing: 10) {
            Eyebrow("Tokens per agent")
            if order.isEmpty { Text("Token use appears as tasks finish").font(KS.body()).foregroundStyle(KS.muted) }
            ForEach(order, id: \.key) { p, n in
                HStack(spacing: 10) {
                    Avatar(name: p, size: 28, provider: p)
                    Text(vendorName(p)).font(KS.body()).foregroundStyle(KS.soft)
                    Spacer()
                    Text(tokenText(n)).font(.system(.title3, design: .monospaced, weight: .medium)).foregroundStyle(KS.strong)
                }.accessibilityElement(children: .combine)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    static func line(_ r: SwarmMapState.FeedRow, now: Date, bot: String?) -> String {
        let who = vendorName(r.provider), what = (bot.map { $0 + " · " } ?? "") + (r.objective ?? "—")
        switch r.kind {
        case .running: return "● \(who)  \(what)  \(elapsedText(r.startedAt.map { now.timeIntervalSince($0) }))"
        case .done: return "· \(who)  \(what)  \(elapsedText(r.duration))"
        case .failed: return "✕ \(who)  \(what)  \(elapsedText(r.duration))"
        case .handoff: return "⇄ \(vendorName(r.from ?? "")) → \(who) · \(what)"
        }
    }
}

private enum SwarmMapDrawing {
    static let line = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255)
    static let station = Color(hex: 0x0F1F38)
    static let caption = Color(hex: 0xC9D5E6)
    static let messageSeconds = 3.5

    static func circle(_ p: CGPoint, _ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)) }

    struct Note { let text: String; let color: Color }
    /// What a station is doing: each running task (in monitor: bot · objective · elapsed), and for a few
    /// seconds after a task ends, a done or failed note.
    static func notes(_ n: String, _ s: SwarmMapState, _ date: Date, monitor: Bool, botName: (String) -> String?) -> [Note] {
        let ended = s.feed.filter { $0.provider == n && ($0.kind == .done || $0.kind == .failed) && date.timeIntervalSince($0.at) < 4 }
            .map { Note(text: ($0.kind == .failed ? "✕ " : "✓ ") + brief($0.objective), color: $0.kind == .failed ? KS.failedText : KS.readyText) }
        let running = (s.running[n] ?? []).map { run -> Note in
            guard monitor else { return Note(text: "› " + brief(run.objective), color: caption) }
            // Only the objective is shortened, so the bot and the elapsed time always show.
            func cut(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 1)) + "…" : s }
            let parts = [botName(run.id).map { cut($0, 14) }, cut(brief(run.objective), 24), elapsedText(run.startedAt.map { date.timeIntervalSince($0) })].compactMap { $0 }.filter { !$0.isEmpty }
            return Note(text: parts.joined(separator: " · "), color: caption)
        }
        return ended + running
    }
    static func brief(_ objective: String?) -> String {
        ((objective ?? "Working").split(whereSeparator: \.isNewline).first.map(String.init) ?? "Working").trimmingCharacters(in: .whitespaces)
    }
    static func fit(_ text: String, _ width: CGFloat, _ k: CGFloat) -> String {
        let n = max(8, Int(width / (5.5 * k)))
        return text.count > n ? String(text.prefix(n - 1)) + "…" : text
    }

    /// Caption pills under a station. Side panel: one at a time, sliding through. Monitor: every running task, stacked.
    static func pills(_ ctx: inout GraphicsContext, _ notes: [Note], at: CGPoint, width: CGFloat, k: CGFloat, monitor: Bool, date: Date) {
        guard !notes.isEmpty else { return }
        let font = Font.system(size: 9 * k, weight: .medium, design: .monospaced)
        let room = monitor ? width - 28 : min(220 * k, width * 0.40 - 14)
        func pill(_ note: Note, _ y: CGFloat, alpha: Double) {
            let text = ctx.resolve(Text(monitor ? note.text : fit(note.text, room, k)).font(font).foregroundColor(note.color))
            let m = text.measure(in: CGSize(width: room + 40, height: 40))
            let w = m.width + 14 * k, h = m.height + 8 * k
            let x = min(max(at.x, w / 2 + 14), width - w / 2 - 14)
            var c = ctx; c.opacity = alpha
            let box = Path(roundedRect: CGRect(x: x - w / 2, y: y - h / 2, width: w, height: h), cornerRadius: h / 2)
            c.fill(box, with: .color(KS.surface)); c.stroke(box, with: .color(line.opacity(0.10)), lineWidth: 1)
            c.draw(text, at: CGPoint(x: x, y: y))
        }
        if monitor {
            for (i, note) in notes.prefix(4).enumerated() { pill(note, at.y + CGFloat(i) * 22 * k, alpha: 1) }
            if notes.count > 4 {
                ctx.draw(Text("+\(notes.count - 4) more").font(.system(size: 8 * k, design: .monospaced)).foregroundColor(KS.muted), at: CGPoint(x: at.x, y: at.y + 4 * 22 * k))
            }
            return
        }
        let slot = date.timeIntervalSinceReferenceDate / messageSeconds
        let note = notes[Int(slot) % notes.count], phase = slot - slot.rounded(.down)
        let alpha = notes.count == 1 ? 1 : min(1, phase / 0.15, (1 - phase) / 0.15)
        pill(note, at.y + (notes.count == 1 ? 0 : 3 - 6 * phase), alpha: alpha)
    }

    static func draw(_ ctx: inout GraphicsContext, _ size: CGSize, _ s: SwarmMapState, _ questions: Int, _ date: Date,
                     monitor: Bool, botName: (String) -> String?) {
        // Taller than wide: the room under the bottom station holds its messages. The monitor leaves more room below.
        let side = min(size.width, size.height * (monitor ? 0.78 : 0.84))
        let c = CGPoint(x: size.width / 2, y: size.height / 2 - side * (monitor ? 0.08 : 0.05))
        let k = max(0.8, side / 360)
        func mono(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font { .system(size: size * k, weight: weight, design: .monospaced) }
        func sans(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font { .system(size: size * k, weight: weight) }
        let ring = side * 0.31, r = side * 0.058, hub = side * 0.085
        let t = date.timeIntervalSinceReferenceDate
        let names = ["you"] + s.stations
        var pos: [String: CGPoint] = ["hub": c]
        for (i, n) in names.enumerated() {
            let a = -Double.pi / 2 + 2 * Double.pi * Double(i) / Double(names.count)
            pos[n] = CGPoint(x: c.x + ring * cos(a), y: c.y + ring * sin(a))
        }

        let card = Path(roundedRect: CGRect(origin: .zero, size: size).insetBy(dx: 12, dy: 6), cornerRadius: 12)
        ctx.fill(card, with: .color(KS.grouped))
        ctx.stroke(card, with: .color(line.opacity(0.07)), lineWidth: 1)
        for f in [0.55, 1.0] {
            ctx.stroke(circle(c, ring * f), with: .color(line.opacity(0.10)), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
        // Spokes: hairline, worn thicker and warmer by finished work.
        for n in names {
            var path = Path(); path.move(to: c); path.addLine(to: pos[n]!)
            let worn = Double(min(s.finished[n] ?? 0, 12))
            ctx.stroke(path, with: .color(line.opacity(0.14)), lineWidth: 1)
            if worn > 0 { ctx.stroke(path, with: .color(KS.tint(n).opacity(0.25 + worn * 0.04)), lineWidth: 0.8 + worn * 0.35) }
        }
        // Hub: a navy disc in a white outline; a sweeping arc while anything runs.
        ctx.fill(circle(c, hub), with: .color(KS.ground))
        ctx.stroke(circle(c, hub), with: .color(Color(hex: 0xEEF2F8).opacity(0.8)), lineWidth: 1.5)
        if s.runningCount > 0 {
            var arc = Path()
            let start = (t * 90).truncatingRemainder(dividingBy: 360)
            arc.addArc(center: c, radius: hub + 5, startAngle: .degrees(start), endAngle: .degrees(start + 110), clockwise: false)
            ctx.stroke(arc, with: .color(KS.signal.opacity(0.8)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
        ctx.draw(Text("SWARMAA").font(mono(10, .semibold)).tracking(1.5).foregroundColor(KS.strong), at: CGPoint(x: c.x, y: c.y - 3 * k))
        ctx.draw(Text(s.runningCount > 0 ? "\(s.runningCount) running" : "Idle").font(mono(7.5)).foregroundColor(KS.muted), at: CGPoint(x: c.x, y: c.y + 9 * k))
        if s.queued > 0 {
            ctx.draw(Text("\(s.queued) queued").font(mono(8)).foregroundColor(KS.muted), at: CGPoint(x: c.x, y: c.y + hub + 16 * k))
        }
        if s.stations.isEmpty {
            ctx.draw(Text("No workers connected").font(sans(10, .regular)).foregroundColor(KS.muted), at: CGPoint(x: c.x, y: c.y + ring + 40 * k))
        }

        for n in names {
            let p = pos[n]!
            let label = CGPoint(x: p.x, y: p.y + r + 11 * k)
            if n == "you" {
                if questions > 0 { ctx.fill(circle(p, r + 8), with: .color(KS.needsText.opacity(0.14 + 0.06 * sin(t * 3)))) }
                ctx.fill(circle(p, r), with: .color(station))
                ctx.stroke(circle(p, r), with: .color(questions > 0 ? KS.needsText : line.opacity(0.18)), lineWidth: questions > 0 ? 2 : 1)
                var person = ctx.resolve(Image(systemName: "person"))
                person.shading = .color(questions > 0 ? KS.needsText : KS.muted)
                ctx.draw(person, in: CGRect(x: p.x - r * 0.45, y: p.y - r * 0.45, width: r * 0.9, height: r * 0.9))
                ctx.draw(Text("You").font(sans(12)).foregroundColor(KS.strong), at: label)
                if questions > 0 {
                    ctx.draw(Text("\(questions) waiting").font(mono(9)).foregroundColor(KS.needsText), at: CGPoint(x: label.x, y: label.y + 13 * k))
                }
                continue
            }
            let tint = KS.tint(n), runs = s.running[n] ?? []
            var cx = ctx
            if s.offline.contains(n) { cx.opacity = 0.35 }
            if !runs.isEmpty { cx.fill(circle(p, r + 9), with: .color(tint.opacity(0.14 + 0.06 * sin(t * 3)))) }
            cx.fill(circle(p, r), with: .color(station))
            cx.stroke(circle(p, r), with: .color(runs.isEmpty ? line.opacity(0.18) : tint), lineWidth: runs.isEmpty ? 1 : 2)
            cx.draw(Text(KS.monogram(n)).font(mono(11, .bold)).foregroundColor(tint), at: p)
            cx.draw(Text(vendorName(n)).font(sans(12)).foregroundColor(KS.strong), at: label)
            let done = s.finished[n] ?? 0, used = s.tokens[n] ?? 0
            if done > 0 || used > 0 {
                let text = [done > 0 ? "\(done) done" : nil, used > 0 ? tokenText(used) + " tok" : nil].compactMap { $0 }.joined(separator: " · ")
                cx.draw(Text(text).font(mono(9)).foregroundColor(KS.muted), at: CGPoint(x: label.x, y: label.y + 13 * k))
            }
            // Clock hand: the oldest running task, one turn per minute.
            if let oldest = runs.compactMap(\.startedAt).min() {
                let f = date.timeIntervalSince(oldest).truncatingRemainder(dividingBy: 60) / 60
                var arc = Path()
                arc.addArc(center: p, radius: r + 4, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * max(f, 0)), clockwise: false)
                cx.stroke(arc, with: .color(tint), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            }
            for i in runs.indices {
                let a = t * 1.2 + 2 * Double.pi * Double(i) / Double(runs.count), o = r + 9
                cx.fill(circle(CGPoint(x: p.x + o * cos(a), y: p.y + o * sin(a)), 2.5 * k), with: .color(tint))
            }
            if runs.count > 1 {
                let b = CGPoint(x: p.x + r * 0.8, y: p.y - r * 0.8)
                cx.fill(circle(b, 9 * k), with: .color(KS.ground)); cx.stroke(circle(b, 9 * k), with: .color(tint), lineWidth: 1.2)
                cx.draw(Text("×\(runs.count)").font(mono(8, .bold)).foregroundColor(KS.strong), at: b)
            }
            pills(&cx, notes(n, s, date, monitor: monitor, botName: botName), at: CGPoint(x: label.x, y: label.y + 32 * k), width: size.width, k: k, monitor: monitor, date: date)
            if let f = s.failures[n], f > 0 {
                let b = CGPoint(x: p.x - r * 0.8, y: p.y - r * 0.8)
                cx.fill(circle(b, 8 * k), with: .color(KS.failedText))
                cx.draw(Text("\(f)").font(mono(8, .bold)).foregroundColor(KS.onSignal), at: b)
            }
        }
        // Pulses, with a short fading trail.
        for pulse in s.pulses {
            let k0 = date.timeIntervalSince(pulse.startedAt) / (pulse.kind == .handoff ? 0.9 : 0.6)
            guard k0 >= 0, k0 <= 1.15, let a = pos[pulse.from], let b = pos[pulse.to] else { continue }
            let q = CGPoint(x: (a.x + b.x) / 2 * 0.5 + c.x * 0.5, y: (a.y + b.y) / 2 * 0.5 + c.y * 0.5)
            let tint = pulse.kind == .failed ? KS.failedText : KS.tint(pulse.from == "hub" ? pulse.to : pulse.from)
            if pulse.kind == .handoff {
                var curve = Path(); curve.move(to: a); curve.addQuadCurve(to: b, control: q)
                ctx.stroke(curve, with: .color(tint.opacity(0.35 * max(0, 1 - k0))), lineWidth: 1.2)
            }
            for j in 0..<5 {
                let f = min(1, k0) - Double(j) * 0.05
                guard f >= 0 else { continue }
                let u = 1 - f
                let pt = pulse.kind == .handoff
                    ? CGPoint(x: u * u * a.x + 2 * u * f * q.x + f * f * b.x, y: u * u * a.y + 2 * u * f * q.y + f * f * b.y)
                    : CGPoint(x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f)
                ctx.fill(circle(pt, (4.5 - CGFloat(j) * 0.7) * k), with: .color(tint.opacity(1 - Double(j) * 0.18)))
            }
        }
    }
}
