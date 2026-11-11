import SwiftUI

/// Who is waiting on whom in a swarm (handover brief, part 5). Pure, so tests need no model.
enum HandoverStatus {
    enum Kind { case you, waiting, blocked }

    /// Step id → "Scout is waiting on Forge · Draft the banner".
    static func lines(for swarm: TeamsSwarm, name: (String?) -> String) -> [String: String] {
        let byID = Dictionary(swarm.steps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return swarm.steps.reduce(into: [:]) { out, s in out[s.id] = line(s, byID, name)?.text }
    }

    /// The first "waiting on you" line, else the first "waiting on" line.
    static func headline(for swarm: TeamsSwarm, name: (String?) -> String) -> String? {
        let byID = Dictionary(swarm.steps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let all = swarm.steps.compactMap { line($0, byID, name) }
        return (all.first { $0.kind == .you } ?? all.first { $0.kind == .waiting })?.text
    }

    static func line(_ step: TeamsSwarm.Step, _ byID: [String: TeamsSwarm.Step], _ name: (String?) -> String) -> (kind: Kind, text: String)? {
        let who = name(step.assigneeAgentID)
        if step.status == "waiting_on_you" { return (.you, L10n.t("\(who) is waiting on you")) }
        guard ["pending", "blocked"].contains(step.status) else { return nil }
        let needs = step.needs.compactMap { byID[$0] }
        if let dead = needs.first(where: { ["failed", "cancelled"].contains($0.status) }) {
            return (.blocked, L10n.t("\(who) is blocked: \(dead.title) failed"))
        }
        guard let open = needs.first(where: { $0.status != "done" }) else { return nil }
        return (.waiting, L10n.t("\(who) is waiting on \(name(open.assigneeAgentID)) · \(open.title)"))
    }

    /// Agent id → name, "A crew member" when unknown.
    @MainActor static func names(_ model: TeamsModel) -> (String?) -> String {
        { model.agent(id: $0)?.name ?? L10n.t("A crew member") }
    }

    /// Dependency depth: 0 with no needs, else 1 + the deepest need. Cycles and unknown ids count as no need.
    static func columns(for swarm: TeamsSwarm) -> [String: Int] {
        let byID = Dictionary(swarm.steps.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var memo: [String: Int] = [:], visiting: Set<String> = []
        func depth(_ id: String) -> Int {
            if let d = memo[id] { return d }
            guard let s = byID[id], visiting.insert(id).inserted else { return -1 }
            let d = 1 + (s.needs.map(depth).max() ?? -1)
            visiting.remove(id); memo[id] = d
            return d
        }
        for s in swarm.steps { _ = depth(s.id) }
        return memo
    }

    /// One crew member: the steps they own, placed at their earliest step's column.
    struct Member: Identifiable {
        let id: String
        var agentID: String? { id.isEmpty ? nil : id }
        var steps: [TeamsSwarm.Step]
        var column: Int
        var active: Bool { steps.contains { ["running", "waiting_on_you"].contains($0.status) } }
        var status: String {
            for s in ["waiting_on_you", "running", "failed", "blocked", "pending"] where steps.contains(where: { $0.status == s }) { return s }
            return steps.allSatisfy { $0.status == "cancelled" } ? "cancelled" : "done"
        }
    }

    /// Crew in column order, plus owner → owner edges for each need.
    static func crew(for swarm: TeamsSwarm) -> (members: [Member], edges: [(from: String, to: String)]) {
        let cols = columns(for: swarm)
        var members: [Member] = []
        for s in swarm.steps {
            let key = s.assigneeAgentID ?? "", c = cols[s.id] ?? 0
            if let i = members.firstIndex(where: { $0.id == key }) {
                members[i].steps.append(s); members[i].column = min(members[i].column, c)
            } else { members.append(Member(id: key, steps: [s], column: c)) }
        }
        let owner = Dictionary(swarm.steps.map { ($0.id, $0.assigneeAgentID ?? "") }, uniquingKeysWith: { a, _ in a })
        var seen: Set<String> = [], edges: [(from: String, to: String)] = []
        for s in swarm.steps {
            let to = s.assigneeAgentID ?? ""
            for n in s.needs {
                guard let from = owner[n], from != to, seen.insert(from + "→" + to).inserted else { continue }
                edges.append((from, to))
            }
        }
        // Stable sort: column, then first appearance.
        return (members.enumerated().sorted { ($0.element.column, $0.offset) < ($1.element.column, $1.offset) }.map(\.element), edges)
    }
}

private struct HandoverAnchors: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue()) { $1 }
    }
}

/// Left-to-right map of a swarm: one card per crew member, lines from whoever hands over to whoever picks up.
struct HandoverMap: View {
    @ObservedObject var model: TeamsModel
    let swarm: TeamsSwarm

    var body: some View {
        let crew = HandoverStatus.crew(for: swarm)
        let lines = HandoverStatus.lines(for: swarm, name: HandoverStatus.names(model))
        let columns = Array(Set(crew.members.map(\.column))).sorted()
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 44) {
                ForEach(columns, id: \.self) { col in
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(crew.members.filter { $0.column == col }) { m in
                            HandoverMemberCard(model: model, member: m, lines: lines)
                                .anchorPreference(key: HandoverAnchors.self, value: .bounds) { [m.id: $0] }
                        }
                    }
                }
            }
            .padding(.leading, 6).padding(.trailing, 36).padding(.vertical, 8)
            .backgroundPreferenceValue(HandoverAnchors.self) { anchors in
                GeometryReader { proxy in
                    let rects = anchors.mapValues { proxy[$0] }
                    Canvas { ctx, _ in
                        for e in crew.edges {
                            guard let a = rects[e.from], let b = rects[e.to] else { continue }
                            let (path, head, back) = Self.connector(a, b)
                            ctx.stroke(path, with: .color(KS.ink.opacity(0.28)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: back ? [4, 4] : []))
                            ctx.fill(head, with: .color(KS.ink.opacity(0.45)))
                        }
                    }
                }
            }
        }
        .scrollIndicators(.automatic)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t("Handover map"))
    }

    /// Forward: header to header, trailing to leading. Backward (a later step handed back to an
    /// earlier column): dashed, bottom to bottom so it never sits on a forward line. Same column: loops right.
    static func connector(_ a: CGRect, _ b: CGRect) -> (path: Path, head: Path, back: Bool) {
        let dx: CGFloat = 28
        let top = { (r: CGRect) in r.minY + min(26, r.height / 2) }, low = { (r: CGRect) in r.maxY - min(18, r.height / 2) }
        let start: CGPoint, end: CGPoint, c1: CGPoint, c2: CGPoint
        let back = b.maxX <= a.minX
        if b.minX >= a.maxX {
            start = CGPoint(x: a.maxX, y: top(a)); end = CGPoint(x: b.minX, y: top(b))
            c1 = CGPoint(x: start.x + dx, y: start.y); c2 = CGPoint(x: end.x - dx, y: end.y)
        } else if back {
            start = CGPoint(x: a.minX, y: low(a)); end = CGPoint(x: b.maxX, y: low(b))
            c1 = CGPoint(x: start.x - dx, y: start.y); c2 = CGPoint(x: end.x + dx, y: end.y)
        } else {
            start = CGPoint(x: a.maxX, y: a.midY); end = CGPoint(x: b.maxX, y: b.midY)
            let x = max(a.maxX, b.maxX) + dx
            c1 = CGPoint(x: x, y: start.y); c2 = CGPoint(x: x, y: end.y)
        }
        var path = Path()
        path.move(to: start); path.addCurve(to: end, control1: c1, control2: c2)
        // A small arrowhead along the last tangent.
        let len = max(hypot(end.x - c2.x, end.y - c2.y), 0.001)
        let ux = (end.x - c2.x) / len, uy = (end.y - c2.y) / len
        var head = Path()
        head.move(to: end)
        head.addLine(to: CGPoint(x: end.x - ux * 7 - uy * 4, y: end.y - uy * 7 + ux * 4))
        head.addLine(to: CGPoint(x: end.x - ux * 7 + uy * 4, y: end.y - uy * 7 - ux * 4))
        head.closeSubpath()
        return (path, head, back)
    }
}

private struct HandoverMemberCard: View {
    @ObservedObject var model: TeamsModel
    let member: HandoverStatus.Member
    let lines: [String: String]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        let agent = model.agent(id: member.agentID)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                KSMoji(seed: agent?.avatar ?? (member.agentID ?? "crew"), size: 28)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: agent?.name ?? L10n.t("A crew member")).font(KS.text(.semibold)).lineLimit(1)
                    Text(verbatim: TeamsCopy.swarmStatus(member.status)).font(KS.secondary()).foregroundStyle(KS.textMuted)
                }
            }
            ForEach(member.steps) { s in
                let (icon, color) = SwarmStepRow.symbol(s.status)
                let hot = ["running", "waiting_on_you"].contains(s.status)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: icon).font(KS.glyph(11)).foregroundStyle(color)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: s.title).font(KS.secondary(hot ? .semibold : .regular))
                            .foregroundStyle(hot ? KS.ink : KS.textSoft).lineLimit(2)
                        if let line = lines[s.id] {
                            Text(verbatim: line).font(KS.secondary()).foregroundStyle(KS.textMuted).lineLimit(2)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 210, alignment: .leading)
        .ksCard(fill: member.active ? KS.sageTint : KS.white, radius: 12)
        .overlay {
            if member.active {
                RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(KS.lime, lineWidth: 2)
                    .opacity(pulse ? 0.45 : 1)
            }
        }
        .onAppear {
            guard member.active, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { pulse = true }
        }
        .onChange(of: reduceMotion) { _, on in if on { pulse = false } }
        .accessibilityElement(children: .combine)
    }
}

/// The swarm card's mini map: crew faces in dependency order, joined by arrows.
struct HandoverStrip: View {
    @ObservedObject var model: TeamsModel
    let swarm: TeamsSwarm

    var body: some View {
        let members = HandoverStatus.crew(for: swarm).members
        FlowLayout(spacing: 4) {
            ForEach(Array(members.enumerated()), id: \.element.id) { i, m in
                let agent = model.agent(id: m.agentID)
                HStack(spacing: 4) {
                    if i > 0 {
                        Image(systemName: "arrow.right").font(KS.glyph(10, .semibold)).foregroundStyle(KS.textMuted)
                            .accessibilityHidden(true)
                    }
                    HStack(spacing: 5) {
                        KSMoji(seed: agent?.avatar ?? (m.agentID ?? "crew"), size: 18)
                        Text(verbatim: agent?.name ?? L10n.t("A crew member")).font(KS.secondary(m.active ? .semibold : .regular))
                    }
                    .padding(.leading, 3).padding(.trailing, 8).frame(height: 24)
                    .background(Capsule().fill(m.active ? KS.selected : KS.neutralTint))
                }
            }
        }
    }
}
