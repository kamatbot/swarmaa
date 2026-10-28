import SwiftUI

/// Settings → Swarmaa → Routing: choose which service takes review and
/// research work, in what order, and when to move on.
struct RoutingSettingsView: View {
    @StateObject private var model: RoutingEditorModel

    init(service: RoutingService = SwarmaClient.shared) {
        _model = StateObject(wrappedValue: RoutingEditorModel(service: service))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                banner
                if model.phase != .unsupported, !isOffline {
                    preview
                    priorityList
                    fallbackPicker
                    footer
                }
            }
            .padding(20)
        }
        .task { await model.load() }
    }

    private var isOffline: Bool {
        if case .offline = model.phase { return true }
        return false
    }

    // MARK: States

    @ViewBuilder private var banner: some View {
        switch model.phase {
        case .readOnly:
            Label(RoutingEditorModel.forbiddenMessage, systemImage: "lock.fill")
                .font(.callout).foregroundStyle(.orange)
        case .offline(let text):
            VStack(alignment: .leading, spacing: 8) {
                Label(text, systemImage: "wifi.slash").font(.callout).foregroundStyle(.orange)
                Button(L10n.t("Try Again")) { Task { await model.load() } }
            }
        case .unsupported:
            Label(L10n.t("This Swarmaa service is too old to have routing rules. Update it to edit them."),
                  systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.secondary)
        case .loading, .ready:
            EmptyView()
        }
    }

    // MARK: Live preview

    private var preview: some View {
        VStack(alignment: .leading, spacing: 6) {
            previewLine(.review)
            previewLine(.research)
            previewLine(.patch)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
    }

    private func previewLine(_ kind: RoutingKind) -> some View {
        let next = switch kind {
        case .review: L10n.t("Next review")
        case .research: L10n.t("Next research")
        case .patch: L10n.t("Next edit")
        }
        return HStack(spacing: 6) {
            Text(verbatim: next + " →").foregroundStyle(.secondary)
            if let pick = model.preview(kind) {
                if let provider = pick.provider {
                    ProviderGlyphView(glyph: SwarmaCells.glyph(forProvider: provider), size: 14)
                    Text(verbatim: SwarmaCells.vendorName(provider)).fontWeight(.semibold)
                } else {
                    Text(L10n.t("No service available")).fontWeight(.semibold)
                }
                if !pick.reason.isEmpty { Text(verbatim: "· " + pick.reason).foregroundStyle(.secondary) }
            } else {
                Text(verbatim: "—").foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .lineLimit(2)
    }

    // MARK: Priority table

    private var priorityList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n.t("Priority — top is tried first"))
                .font(.headline)
            List {
                ForEach(Array(model.draft.providers.enumerated()), id: \.element.id) { index, rule in
                    RuleRow(rule: $model.draft.providers[index], index: index,
                            count: model.draft.providers.count,
                            fiveHourUsed: model.usedPercent(rule.provider, .fiveHour),
                            weeklyUsed: model.usedPercent(rule.provider, .weekly),
                            move: { model.draft.move(index, by: $0) })
                        .listRowSeparator(.visible)
                }
                .onMove { model.draft.move(fromOffsets: $0, toOffset: $1) }
            }
            .listStyle(.inset)
            .scrollDisabled(true)
            .frame(height: 3 * 125 + 12)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .disabled(!model.canEdit)
        }
    }

    private var fallbackPicker: some View {
        Picker(L10n.t("If no service qualifies"), selection: $model.draft.fallback) {
            Text(L10n.t("Use the one with most quota left")).tag(RoutingPolicy.fallbackMostHeadroom)
            Text(L10n.t("Wait")).tag(RoutingPolicy.fallbackNone)
        }
        .disabled(!model.canEdit)
    }

    private var footer: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if let problem = model.validationProblem {
                Text(verbatim: problem).font(.callout).foregroundStyle(.red)
            }
            if let message = model.message {
                Text(verbatim: message).font(.callout).foregroundStyle(.red)
            }
            HStack {
                Button(L10n.t("Reset to defaults")) { model.resetToDefaults() }
                    .disabled(!model.canEdit)
                Spacer()
                Button(L10n.t("Save")) { Task { await model.save() } }
                    .buttonStyle(SettingsButtonStyle(kind: .prominent))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canSave)
            }
        }
    }
}

/// One service: name, on/off, how far to push it, and what it may take.
private struct RuleRow: View {
    @Binding var rule: RoutingPolicy.Rule
    let index: Int
    let count: Int
    let fiveHourUsed: Double?
    let weeklyUsed: Double?
    let move: (Int) -> Void

    private var name: String { SwarmaCells.vendorName(rule.provider) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "line.3.horizontal").foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                ProviderGlyphView(glyph: SwarmaCells.glyph(forProvider: rule.provider), size: 18)
                Text(verbatim: name).font(.headline)
                Spacer()
                Toggle(L10n.t("Enabled"), isOn: $rule.enabled)
                    .toggleStyle(.switch).controlSize(.small)
                    .accessibilityLabel(L10n.t("\(name), enabled"))
                Button { move(-1) } label: { Image(systemName: "chevron.up") }
                    .disabled(index == 0)
                    .accessibilityLabel(L10n.t("Move \(name) up"))
                Button { move(1) } label: { Image(systemName: "chevron.down") }
                    .disabled(index == count - 1)
                    .accessibilityLabel(L10n.t("Move \(name) down"))
            }
            Group {
                RoutingSlider(title: L10n.t("Switch away at 5-hour use"),
                              spoken: L10n.t("\(name), switch away at five-hour use"),
                              value: $rule.maxFiveHourPct, used: fiveHourUsed)
                RoutingSlider(title: L10n.t("Switch away at weekly use"),
                              spoken: L10n.t("\(name), switch away at weekly use"),
                              value: $rule.maxWeeklyPct, used: weeklyUsed)
                HStack(spacing: 16) {
                    kindToggle(.review)
                    kindToggle(.research)
                    kindToggle(.patch)
                }
                if rule.provider == "antigravity" {
                    Text(L10n.t("Antigravity: reviews and in-project edits — it cannot reach outside the project, so leave research off"))
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .disabled(!rule.enabled)
            .opacity(rule.enabled ? 1 : 0.45)
        }
        .padding(.vertical, 6)
    }

    private func kindToggle(_ kind: RoutingKind) -> some View {
        Toggle(kind.title, isOn: Binding(
            get: { rule.allows(kind) },
            set: { on in
                rule.kinds = RoutingKind.allCases.map(\.rawValue).filter {
                    $0 == kind.rawValue ? on : rule.kinds.contains($0)
                }
            }))
            .toggleStyle(.checkbox)
            .accessibilityLabel(L10n.t("\(name), \(kind.rawValue)"))
    }
}

/// A 5–100 slider in steps of 5 that shows where the provider's use is now as
/// a tick on the track, so the threshold can be judged against it.
struct RoutingSlider: View {
    static let range = 5.0...100.0

    let title: String
    let spoken: String
    @Binding var value: Int
    let used: Double?

    /// Where `percent` sits along the track, 0...1. Same scale as the slider.
    static func fraction(_ percent: Double) -> Double {
        (min(max(percent, range.lowerBound), range.upperBound) - range.lowerBound)
            / (range.upperBound - range.lowerBound)
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: title).font(.callout).frame(width: 170, alignment: .leading)
            Slider(value: Binding(get: { Double(value) }, set: { value = Int($0) }),
                   in: Self.range, step: 5)
                .overlay { marker }
                .accessibilityLabel(spoken)
                .accessibilityValue(L10n.t("\(value) percent"))
            Text(verbatim: "\(value)%").monospacedDigit().frame(width: 44, alignment: .trailing)
        }
    }

    /// The slider's thumb is ~16pt, so its centre travels `width - 16`.
    @ViewBuilder private var marker: some View {
        if let used {
            GeometryReader { proxy in
                Rectangle()
                    .fill(Double(value) <= used ? Color.red : Color.accentColor)
                    .frame(width: 2, height: 10)
                    .position(x: 8 + Self.fraction(used) * (proxy.size.width - 16), y: proxy.size.height / 2 - 9)
                    .help(L10n.t("Used now: \(Int(used.rounded()))%"))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}
