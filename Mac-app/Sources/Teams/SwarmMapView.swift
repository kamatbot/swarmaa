import Combine
import SwiftUI

/// Holds the reducer and feeds it every status the model publishes.
@MainActor
final class SwarmMapStore: ObservableObject {
    @Published private(set) var state = SwarmMapState()
    private var sub: AnyCancellable?
    func attach(_ model: TeamsModel) {
        guard sub == nil else { return }
        sub = model.$status.compactMap { $0 }.sink { [weak self, weak model] in
            guard let self else { return }
            self.state.ingest($0, at: Date())
            let todo = self.state.unpriced
            self.state.unpriced = []
            guard let model, !todo.isEmpty else { return }
            Task { @MainActor [weak self] in
                for job in todo.prefix(30) {
                    if let n = await model.taskTokens(id: job.id) { self?.state.addTokens(n, provider: job.provider, task: job.id) }
                }
            }
        }
    }
}

/// Live side panel: the hub, a station per provider, pulses as tasks move, and a feed.
struct SwarmMapPanel: View {
    @ObservedObject var model: TeamsModel
    @StateObject private var store = SwarmMapStore()

    var body: some View {
        GeometryReader { g in
            // Wide mode gives the map most of the panel; narrow keeps the card's shape and leaves the rest to the feed.
            let mapHeight = model.swarmMapWide ? max(320, g.size.height * 0.7) : min(g.size.width / 0.84, g.size.height * 0.62)
            content(mapHeight: mapHeight - KS.topBarHeight / 2)
        }
        .background(KS.paper)
        .overlay(alignment: .leading) { Rectangle().fill(KS.hairline).frame(width: 1) }
        .onAppear { store.attach(model) }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await model.refreshUsage()
            }
        }
    }

    private func content(mapHeight: CGFloat) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                KSLabel(L10n.t("Swarm map"))
                Spacer()
                Button { model.swarmMapWide.toggle() } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                    .help(L10n.t("Resize")).accessibilityLabel(L10n.t("Resize"))
                Button { model.showSwarmMap = false } label: { Image(systemName: "xmark") }
                    .help(L10n.t("Close")).accessibilityLabel(L10n.t("Close"))
            }
            .buttonStyle(.plain).foregroundStyle(KS.textMuted)
            .padding(.horizontal, 16).frame(height: KS.topBarHeight)
            .background(KS.topBar)
            .overlay(alignment: .bottom) { Rectangle().fill(KS.hairline).frame(height: 1) }
            // Animate only while a swarm is active (tasks running or a pulse in flight); otherwise paused, and a new
            // status still redraws it once. Unpaused at 60 fps this cost ~35% of a core at idle.
            let moving = store.state.runningCount > 0 || !store.state.pulses.isEmpty
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !moving)) { tl in
                Canvas { ctx, size in SwarmMapDrawing.draw(&ctx, size, store.state, model.openQuestions.count, tl.date) }
                    .padding(.top, 8)
            }
            .frame(height: mapHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(store.state.accessibilitySummary)
            Rectangle().fill(KS.hairline).frame(height: 1)
            feed
        }
    }

    private var feed: some View {
        let rows = store.state.feed
        return VStack(alignment: .leading, spacing: 0) {
            if let head = rows.first(where: { $0.kind == .running }) {
                Text(verbatim: "\(SwarmaCells.vendorName(head.provider)): \(head.objective ?? "—") · \(L10n.t("\(store.state.runningCount) running"))")
                    .font(KS.meta(.semibold)).lineLimit(1).padding(.horizontal, 16).padding(.vertical, 8)
            } else {
                Text(verbatim: L10n.t("Idle")).font(KS.meta(.semibold)).foregroundStyle(KS.textMuted)
                    .padding(.horizontal, 16).padding(.vertical, 8)
            }
            ScrollView {
                TimelineView(.periodic(from: .now, by: 1)) { tl in
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(rows) { row in
                            Text(verbatim: Self.line(row, now: tl.date)).font(KS.meta())
                                .foregroundStyle(row.kind == .failed ? KS.danger : row.kind == .running ? KS.ink : KS.textMuted)
                                .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.padding(.horizontal, 16).padding(.bottom, 12)
                }
            }
        }
    }

    private static func line(_ r: SwarmMapState.FeedRow, now: Date) -> String {
        let who = SwarmaCells.vendorName(r.provider), what = r.objective ?? "—"
        switch r.kind {
        case .running: return "● \(who)  \(what)  \(elapsed(r.startedAt.map { now.timeIntervalSince($0) }))"
        case .done: return "· \(who)  \(what)  \(elapsed(r.duration))"
        case .failed: return "✕ \(who)  \(what)  \(elapsed(r.duration))"
        case .handoff: return "⇄ \(SwarmaCells.vendorName(r.from ?? "")) → \(who) · \(what)"
        }
    }

    private static func elapsed(_ s: TimeInterval?) -> String {
        guard let s = s, s >= 0 else { return "" }
        let n = Int(s)
        return n < 60 ? "\(n)s" : "\(n / 60)m \(String(format: "%02d", n % 60))s"
    }
}

private enum SwarmMapDrawing {
    /// On navy the provider tints read as strokes and pulses as they are.
    static func accent(_ provider: String) -> Color { KS.providerTint(provider) }
    static let line = Color(red: 200 / 255, green: 218 / 255, blue: 245 / 255)
    static let station = Color(hex: 0x0F1F38)
    static let caption = Color(hex: 0xC9D5E6)

    static let messageSeconds = 3.5
    /// The drawing's scale against the 380 pt panel it was designed in; set at the start of each draw.
    /// ponytail: a static set per frame; fine while one map draws at a time on the main thread.
    static var k: CGFloat = 1
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font { KS.glyph(size * k, weight, mono: true) }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font { KS.glyph(size * k, weight) }

    /// What a station is doing, as short notes: each running task's objective, and for a few seconds
    /// after a task ends, a done or failed note. One shows at a time, sliding up and fading in and out.
    static func notes(_ n: String, _ s: SwarmMapState, _ date: Date) -> [(text: String, color: Color)] {
        let ended = s.feed.filter { $0.provider == n && ($0.kind == .done || $0.kind == .failed) && date.timeIntervalSince($0.at) < 4 }
            .map { ($0.kind == .failed ? "✕ " : "✓ ") + brief($0.objective) }
        let running = (s.running[n] ?? []).map { "› " + brief($0.objective) }
        return ended.map { ($0, $0.hasPrefix("✕") ? KS.danger : KS.readyText) } + running.map { ($0, caption) }
    }

    static func brief(_ objective: String?) -> String {
        let line = (objective ?? "Working").split(whereSeparator: \.isNewline).first.map(String.init) ?? "Working"
        return line.trimmingCharacters(in: .whitespaces)
    }

    /// Mono 9 pt is about 5.5 pt a character: cut to what the bubble's width holds.
    static func fit(_ text: String, _ width: CGFloat) -> String {
        let n = max(8, Int(width / (5.5 * k)))
        return text.count > n ? String(text.prefix(n - 1)) + "…" : text
    }

    static func messages(_ ctx: inout GraphicsContext, _ n: String, _ s: SwarmMapState, _ at: CGPoint, width: CGFloat, date: Date) {
        let all = notes(n, s, date)
        guard !all.isEmpty else { return }
        let t = date.timeIntervalSinceReferenceDate, slot = t / messageSeconds
        let note = all[Int(slot) % all.count], phase = slot - slot.rounded(.down)
        // Ease in over the first 15%, out over the last 15%; drift up 6 pt across the slot.
        let alpha = all.count == 1 ? 1 : min(1, phase / 0.15, (1 - phase) / 0.15)
        // Side stations share the row with each other: each bubble keeps to its own 40% of the card.
        let room = min(220 * k, width * 0.40 - 14)
        let text = ctx.resolve(Text(verbatim: fit(note.text, room)).font(mono(9)).foregroundColor(note.color))
        let m = text.measure(in: CGSize(width: room + 40, height: 20))
        let w = m.width + 14, h = m.height + 8
        let x = min(max(at.x, w / 2 + 14), width - w / 2 - 14), y = at.y + (all.count == 1 ? 0 : 3 - 6 * phase)
        var bubble = ctx
        bubble.opacity = alpha
        let box = Path(roundedRect: CGRect(x: x - w / 2, y: y - h / 2, width: w, height: h), cornerRadius: h / 2)
        bubble.fill(box, with: .color(KS.white))
        bubble.stroke(box, with: .color(line.opacity(0.10)), lineWidth: 1)
        bubble.draw(text, at: CGPoint(x: x, y: y))
        if all.count > 1 {
            bubble.draw(Text(verbatim: "\(Int(slot) % all.count + 1)/\(all.count)").font(mono(7)).foregroundColor(KS.textMuted),
                        at: CGPoint(x: x, y: y + h / 2 + 7))
        }
    }

    static func circle(_ p: CGPoint, _ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)) }

    static func draw(_ ctx: inout GraphicsContext, _ size: CGSize, _ s: SwarmMapState, _ questions: Int, _ date: Date) {
        // Taller than wide: the room under the bottom station holds its messages.
        let side = min(size.width, size.height * 0.84), c = CGPoint(x: size.width / 2, y: size.height / 2 - side * 0.05)
        k = max(0.8, side / 360)
        let ring = side * 0.31, r = side * 0.058, hub = side * 0.085
        let t = date.timeIntervalSinceReferenceDate
        let names = ["you"] + s.stations
        var pos: [String: CGPoint] = ["hub": c]
        for (i, n) in names.enumerated() {
            let a = -Double.pi / 2 + 2 * Double.pi * Double(i) / Double(names.count)
            pos[n] = CGPoint(x: c.x + ring * cos(a), y: c.y + ring * sin(a))
        }

        // Card and dotted orbits.
        let card = Path(roundedRect: CGRect(origin: .zero, size: size).insetBy(dx: 12, dy: 6), cornerRadius: 12)
        ctx.fill(card, with: .color(KS.paperDeep))
        ctx.stroke(card, with: .color(line.opacity(0.07)), lineWidth: 1)
        for k in [0.55, 1.0] {
            ctx.stroke(circle(c, ring * k), with: .color(line.opacity(0.10)), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        }
        // Spokes: hairline, worn thicker and warmer by finished work.
        for n in names {
            var path = Path(); path.move(to: c); path.addLine(to: pos[n]!)
            let worn = Double(min(s.finished[n] ?? 0, 12))
            ctx.stroke(path, with: .color(line.opacity(0.14)), lineWidth: 1)
            if worn > 0 { ctx.stroke(path, with: .color(accent(n).opacity(0.25 + worn * 0.04)), lineWidth: 0.8 + worn * 0.35) }
        }
        // Hub: a navy disc in a white outline; a sweeping arc while anything runs.
        ctx.fill(circle(c, hub), with: .color(KS.paper))
        ctx.stroke(circle(c, hub), with: .color(Color(hex: 0xEEF2F8).opacity(0.8)), lineWidth: 1.5)
        if s.runningCount > 0 {
            var arc = Path()
            let start = (t * 90).truncatingRemainder(dividingBy: 360)
            arc.addArc(center: c, radius: hub + 5, startAngle: .degrees(start), endAngle: .degrees(start + 110), clockwise: false)
            ctx.stroke(arc, with: .color(KS.signal.opacity(0.8)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
        ctx.draw(Text(verbatim: "SWARMAA").font(mono(10, .semibold)).tracking(1.5).foregroundColor(KS.strong), at: CGPoint(x: c.x, y: c.y - 3 * k))
        ctx.draw(Text(verbatim: "\(s.runningCount) running").font(mono(7.5)).foregroundColor(KS.textMuted), at: CGPoint(x: c.x, y: c.y + 9 * k))
        if s.queued > 0 {
            ctx.draw(Text(verbatim: "\(s.queued) queued").font(mono(8)).foregroundColor(KS.textMuted), at: CGPoint(x: c.x, y: c.y + hub + 16))
        }

        for n in names {
            let p = pos[n]!
            let label = CGPoint(x: p.x, y: p.y + r + 11 * k)
            if n == "you" {
                let you = questions > 0 ? KS.needsYouText : line.opacity(0.18)
                if questions > 0 { ctx.fill(circle(p, r + 8), with: .color(KS.needsYouText.opacity(0.14 + 0.06 * sin(t * 3)))) }
                ctx.fill(circle(p, r), with: .color(station))
                ctx.stroke(circle(p, r), with: .color(you), lineWidth: questions > 0 ? 2 : 1)
                var person = ctx.resolve(Image(systemName: "person"))
                person.shading = .color(questions > 0 ? KS.needsYouText : KS.textMuted)
                ctx.draw(person, at: p)
                ctx.draw(Text(verbatim: L10n.t("You")).font(sans(12)).foregroundColor(KS.strong), at: label)
                if questions > 0 {
                    ctx.draw(Text(verbatim: L10n.t("\(questions) waiting")).font(mono(9)).foregroundColor(KS.needsYouText),
                             at: CGPoint(x: label.x, y: label.y + 13 * k))
                }
                continue
            }
            let tint = accent(n), runs = s.running[n] ?? []
            var cx = ctx
            if s.offline.contains(n) { cx.opacity = 0.35 }
            if !runs.isEmpty { cx.fill(circle(p, r + 9), with: .color(tint.opacity(0.14 + 0.06 * sin(t * 3)))) }
            cx.fill(circle(p, r), with: .color(station))
            cx.stroke(circle(p, r), with: .color(runs.isEmpty ? line.opacity(0.18) : tint), lineWidth: runs.isEmpty ? 1 : 2)
            cx.draw(Text(verbatim: TeamsCopy.providerShort(n)).font(mono(11, .bold)).foregroundColor(tint), at: p)
            cx.draw(Text(verbatim: SwarmaCells.vendorName(n)).font(sans(12)).foregroundColor(KS.strong), at: label)
            let done = s.finished[n] ?? 0, used = s.tokens[n] ?? 0
            if done > 0 || used > 0 {
                let line = [done > 0 ? "\(done) done" : nil, used > 0 ? TeamsTaskBulk.tokens(used) + " tok" : nil].compactMap { $0 }.joined(separator: " · ")
                cx.draw(Text(verbatim: line).font(mono(9)).foregroundColor(KS.textMuted), at: CGPoint(x: label.x, y: label.y + 13 * k))
            }
            // Clock hand: the oldest running task, one turn per minute.
            if let oldest = runs.compactMap(\.startedAt).min() {
                let f = date.timeIntervalSince(oldest).truncatingRemainder(dividingBy: 60) / 60
                var arc = Path()
                arc.addArc(center: p, radius: r + 4, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * max(f, 0)), clockwise: false)
                cx.stroke(arc, with: .color(tint), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            }
            // Each running task circles its station.
            for i in runs.indices {
                let a = t * 1.2 + 2 * Double.pi * Double(i) / Double(runs.count), o = r + 9
                cx.fill(circle(CGPoint(x: p.x + o * cos(a), y: p.y + o * sin(a)), 2.5), with: .color(tint))
            }
            if runs.count > 1 {
                let b = CGPoint(x: p.x + r * 0.8, y: p.y - r * 0.8)
                cx.fill(circle(b, 9), with: .color(KS.paper)); cx.stroke(circle(b, 9), with: .color(tint), lineWidth: 1.2)
                cx.draw(Text(verbatim: "×\(runs.count)").font(mono(8, .bold)).foregroundColor(KS.strong), at: b)
            }
            messages(&cx, n, s, CGPoint(x: label.x, y: label.y + 32 * k), width: size.width, date: date)
            if let f = s.failures[n], f > 0 {
                let b = CGPoint(x: p.x - r * 0.8, y: p.y - r * 0.8)
                cx.fill(circle(b, 8), with: .color(KS.danger))
                cx.draw(Text(verbatim: "\(f)").font(mono(8, .bold)).foregroundColor(KS.onSignal), at: b)
            }
        }
        // Pulses, with a short fading trail.
        for pulse in s.pulses {
            let k0 = date.timeIntervalSince(pulse.startedAt) / (pulse.kind == .handoff ? 0.9 : 0.6)
            guard k0 >= 0, k0 <= 1.15, let a = pos[pulse.from], let b = pos[pulse.to] else { continue }
            let q = CGPoint(x: (a.x + b.x) / 2 * 0.5 + c.x * 0.5, y: (a.y + b.y) / 2 * 0.5 + c.y * 0.5)
            let tint = pulse.kind == .failed ? KS.danger : accent(pulse.from == "hub" ? pulse.to : pulse.from)
            if pulse.kind == .handoff {
                var curve = Path(); curve.move(to: a); curve.addQuadCurve(to: b, control: q)
                ctx.stroke(curve, with: .color(tint.opacity(0.35 * max(0, 1 - k0))), lineWidth: 1.2)
            }
            for j in 0..<5 {
                let k = min(1, k0) - Double(j) * 0.05
                guard k >= 0 else { continue }
                let u = 1 - k
                let pt = pulse.kind == .handoff
                    ? CGPoint(x: u * u * a.x + 2 * u * k * q.x + k * k * b.x, y: u * u * a.y + 2 * u * k * q.y + k * k * b.y)
                    : CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
                ctx.fill(circle(pt, 4.5 - CGFloat(j) * 0.7), with: .color(tint.opacity(1 - Double(j) * 0.18)))
            }
        }
    }
}
