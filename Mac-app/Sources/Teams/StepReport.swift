import SwiftUI

/// A swarm step's four-part report (Result, Checks, Not checked, Files), read out of an agent's reply.
/// A part the reply left out is nil and shows as "Not stated".
struct StepReport: Equatable {
    enum Part: CaseIterable { case result, checks, unchecked, files }
    var parts: [Part: String] = [:]

    subscript(_ part: Part) -> String? { parts[part] }

    /// `Label:`, `**Label:**`, `**Label**:` or a `#`–`###` heading, case-insensitive. A heading may drop the colon.
    private static let label = #/^\s*(?<heading>#{1,3}\s+)?(?:\*\*)?(?<name>result|checks|not checked|files)(?:\*\*)?\s*(?<colon>:)?(?:\*\*)?\s*(?<rest>.*)$/#
        .ignoresCase()

    /// The report and the text before its first label, or nil unless the body has Result and at least one other part.
    static func parse(_ body: String) -> (lead: String, report: StepReport)? {
        guard body.range(of: "result", options: .caseInsensitive) != nil else { return nil }
        var lead: [Substring] = [], lines: [Part: [Substring]] = [:], current: Part?
        for line in body.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            if let m = try? label.wholeMatch(in: line),
               m.colon != nil || (m.heading != nil && m.rest.isEmpty) {
                let part: Part = switch m.name.lowercased() {
                case "result": .result
                case "checks": .checks
                case "not checked": .unchecked
                default: .files
                }
                current = part
                lines[part] = m.rest.isEmpty ? [] : [m.rest]
            } else if let current {
                lines[current, default: []].append(line)
            } else {
                lead.append(line)
            }
        }
        guard lines[.result] != nil, lines.count > 1 else { return nil }
        var report = StepReport()
        for (part, text) in lines {
            let joined = text.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { report.parts[part] = joined }
        }
        return (lead.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), report)
    }
}

/// The report as one raised card with four labelled rows. "Not checked" is tinted so it gets read.
struct StepReportCard: View {
    let report: StepReport

    private func title(_ part: StepReport.Part) -> String {
        switch part {
        case .result: L10n.t("Result")
        case .checks: L10n.t("Checks")
        case .unchecked: L10n.t("Not checked")
        case .files: L10n.t("Files")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(StepReport.Part.allCases.enumerated()), id: \.offset) { index, part in
                let flagged = part == .unchecked
                if index > 0 { Rectangle().fill(KS.hairline).frame(height: 1) }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(verbatim: title(part)).font(KS.secondary(.semibold))
                        .foregroundStyle(flagged ? KS.needsYouText : KS.textSoft)
                        .frame(width: 92, alignment: .leading)
                    Group {
                        if let text = report[part] { Text(MarkdownCache.text(text)).foregroundStyle(KS.ink) }
                        else { Text(verbatim: L10n.t("Not stated")).foregroundStyle(KS.textMuted) }
                    }
                    .font(KS.text()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(flagged ? KS.needsYouTint : .clear)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .frame(maxWidth: 640, alignment: .leading)
        .ksCard(radius: 12)
    }
}
