import SwiftUI

/// What appears under the menu bar item while the mouse rests on it: the same
/// readings the bar summarises, with the words and bars it has no room for.
struct StatusItemHoverCard: View {
    let snapshots: [ProviderSnapshot]
    /// The summary's label per provider id (set only when two share a mark).
    let labels: [String: String?]
    let showingRemaining: Bool
    var format: ResetTimeFormat = .automatic
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(snapshots, id: \.id) { snapshot in section(snapshot) }
        }
        .padding(12)
        .frame(width: 260, alignment: .leading)
    }

    private func section(_ snapshot: ProviderSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                ProviderGlyphView(glyph: snapshot.glyph, customIconFilename: snapshot.customIconFilename, size: 14)
                Text(snapshot.displayName).font(.system(size: 13, weight: .semibold))
                if let label = labels[snapshot.id] ?? nil {
                    Text(label).font(.caption).foregroundStyle(.secondary)
                }
            }
            // The five-hour window, or whatever the account meters instead (Codex
            // can report only its weekly limit), then the weekly one if different.
            let windows = [snapshot.fiveHourWindow ?? snapshot.headline, snapshot.weeklyLimitWindow]
                .compactMap { $0 }
                .reduce(into: [LimitWindow]()) { list, w in if !list.contains(where: { $0.id == w.id }) { list.append(w) } }
            let rows = windows.compactMap { row($0, title: $0.isFiveHour ? L10n.t("5-hour") : $0.label) }
            if rows.isEmpty {
                Text(snapshot.statusMessage ?? L10n.t("No reading"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(rows.indices, id: \.self) { rows[$0] }
            if snapshot.status.isStale, let since = snapshot.status.staleSince, since != .distantPast {
                Text(L10n.t("Stale — \(ElapsedCopy.ago(since: since, now: now))"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// Nil when the window is over or has no figure, so the caller can say why.
    private func row(_ window: LimitWindow, title: String) -> AnyView? {
        let isOver = window.resetsAt.map { $0 <= now } ?? false
        guard !isOver, let used = window.usedFraction, used.isFinite else { return nil }
        let shown = min(max(Percent.metered(used, showingRemaining: showingRemaining), 0), 1)
        let percent = Percent.whole(for: Percent.metered(used, showingRemaining: showingRemaining))
        let figure = showingRemaining ? L10n.t("\(percent)% left") : L10n.t("\(percent)% used")
        let reset = window.resetsAt.map { ResetCopy.text(for: $0, now: now, format: format) }
        return AnyView(VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(title).font(.caption)
                Spacer()
                Text(figure).font(.caption.monospacedDigit())
            }
            ProgressView(value: shown).progressViewStyle(.linear).controlSize(.small)
            if let reset {
                Text(reset).font(.caption2).foregroundStyle(.secondary)
            }
        })
    }
}
