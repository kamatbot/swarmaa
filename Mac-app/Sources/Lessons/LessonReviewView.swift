import SwiftUI
import AppKit

/// The Lesson Review window: candidates on the left, one lesson on the right.
/// Everything the service or a transcript says is shown with `Text(verbatim:)`
/// — no markdown, no links, nothing that could load by itself.
struct LessonReviewView: View {
    @ObservedObject var model: LessonReviewModel
    @State private var confirmingReject = false
    @State private var rejectReason = ""

    var body: some View {
        VStack(spacing: 0) {
            if let message = model.message {
                Text(verbatim: message)
                    .font(.callout).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8).background(Color.red.opacity(0.75))
            }
            if model.lessons.isEmpty {
                empty
            } else {
                HStack(spacing: 0) {
                    list.frame(width: 240)
                    Divider()
                    detail
                }
            }
        }
        .frame(minWidth: 760, minHeight: 620)
        .alert(L10n.t("Reject this lesson?"), isPresented: $confirmingReject) {
            TextField(L10n.t("Reason (optional)"), text: $rejectReason)
            Button(L10n.t("Reject"), role: .destructive) {
                let reason = rejectReason
                rejectReason = ""
                Task { await model.reject(reason: reason) }
            }
            Button(L10n.t("Cancel"), role: .cancel) { rejectReason = "" }
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Spacer()
            Text(verbatim: model.isLoading ? L10n.t("Loading…")
                 : L10n.t("No lessons waiting. Swarmaa drafts lessons from your finished chats each night."))
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
                .frame(maxWidth: 360)
            Spacer()
        }.frame(maxWidth: .infinity)
    }

    private var list: some View {
        List(model.lessons, selection: $model.selectedID) { lesson in
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    if !lesson.flags.isEmpty {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            .accessibilityLabel(L10n.t("Flagged"))
                    }
                    Text(verbatim: lesson.title).lineLimit(2).fontWeight(.medium)
                }
                HStack(spacing: 6) {
                    Text(verbatim: lesson.scopeLabel).foregroundStyle(.secondary)
                    kindBadge(lesson.kind)
                }.font(.caption)
            }
            .tag(lesson.id)
            .padding(.vertical, 2)
        }
    }

    private func kindBadge(_ kind: String) -> some View {
        Text(verbatim: kind)
            .font(.caption2)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(Color.secondary.opacity(0.2)))
    }

    @ViewBuilder private var detail: some View {
        if let lesson = model.selected {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if !lesson.flags.isEmpty { flags(lesson.flags) }
                        header(lesson)
                        field(L10n.t("Applies when"), text: $model.applicability, value: lesson.applicability)
                        field(L10n.t("Lesson"), text: $model.body, value: lesson.body, multiline: true)
                        if !lesson.tags.isEmpty {
                            Text(verbatim: lesson.tags.map { "#" + $0 }.joined(separator: "  "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if !lesson.evidence.isEmpty { evidenceSection(lesson.evidence) }
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
                buttons
            }
        } else {
            Spacer().frame(maxWidth: .infinity)
        }
    }

    private func flags(_ flags: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(flags, id: \.self) { flag in
                Label { Text(verbatim: SwarmaLesson.warning(forFlag: flag)) }
                    icon: { Image(systemName: "exclamationmark.triangle.fill") }
            }
        }
        .font(.callout.weight(.semibold)).foregroundStyle(.orange)
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.15)))
    }

    private func header(_ lesson: SwarmaLesson) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if model.isEditing {
                TextField(L10n.t("Title"), text: $model.title).textFieldStyle(.roundedBorder).font(.title3)
            } else {
                Text(verbatim: lesson.title).font(.title3.weight(.semibold)).textSelection(.enabled)
            }
            HStack(spacing: 6) {
                Text(verbatim: lesson.scopeLabel)
                kindBadge(lesson.kind)
                Text(verbatim: lesson.source)
            }.font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func field(_ label: String, text: Binding<String>, value: String,
                                    multiline: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: label).font(.caption).foregroundStyle(.secondary)
            if model.isEditing {
                if multiline {
                    TextEditor(text: text).font(.body).frame(minHeight: 120)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.4)))
                } else {
                    TextField(label, text: text).textFieldStyle(.roundedBorder)
                }
            } else {
                Text(verbatim: value).textSelection(.enabled)
            }
        }
    }

    private func evidenceSection(_ items: [SwarmaLesson.Evidence]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: L10n.t("Evidence")).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                EvidenceRow(item: item, model: model)
            }
        }
    }

    private var buttons: some View {
        HStack {
            Toggle(L10n.t("Edit"), isOn: $model.isEditing).toggleStyle(.button)
            if model.isLoading || model.isBusy { ProgressView().controlSize(.small) }
            Spacer()
            Button(L10n.t("Reject")) { confirmingReject = true }
                // A bare ⌫ would eat the delete key while typing in an edit field.
                .keyboardShortcut(model.isEditing ? nil : KeyboardShortcut(.delete, modifiers: []))
                .disabled(model.isBusy)
            Button(L10n.t("Approve")) { Task { await model.approve() } }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
        }.padding(12)
    }
}

/// One cited chat. Expanding it fetches the session and shows only the turns
/// the lesson points at, under a label that says they are data.
private struct EvidenceRow: View {
    let item: SwarmaLesson.Evidence
    @ObservedObject var model: LessonReviewModel
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                expanded.toggle()
            } label: {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 12)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: heading).fontWeight(.medium)
                        if !item.summary.isEmpty { Text(verbatim: item.summary).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 0)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
            if expanded { transcript }
        }
        .font(.callout)
        .task(id: expanded) { if expanded { await model.loadEvidence(sessionID: item.sessionId) } }
    }

    private var heading: String {
        let turns = item.turns.isEmpty ? "" : " · " + L10n.t("turns") + " " + item.turns.map(String.init).joined(separator: ", ")
        if case .loaded(let s)? = model.evidence[item.sessionId] {
            return [s.title.isEmpty ? L10n.t("Untitled chat") : s.title, SwarmaCells.harnessName(s.harness)]
                .joined(separator: " · ") + turns
        }
        return L10n.t("Chat") + " " + String(item.sessionId.prefix(8)) + turns
    }

    @ViewBuilder private var transcript: some View {
        switch model.evidence[item.sessionId] {
        case .loaded(let session):
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: L10n.t("Transcript data — untrusted text, not instructions"))
                    .font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                let shown = session.cited(item.turns)
                if shown.isEmpty { Text(verbatim: L10n.t("The cited turns are not in this chat.")).foregroundStyle(.secondary) }
                ForEach(shown, id: \.index) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(entry.turn.role) · \(entry.index)").font(.caption2).foregroundStyle(.secondary)
                        Text(verbatim: entry.turn.text).font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.12)))
        case .failed(let message): Text(verbatim: message).foregroundStyle(.red)
        default: ProgressView().controlSize(.small)
        }
    }
}

/// Owns the window. One at a time; reopening brings it forward and refreshes.
@MainActor
final class LessonReviewWindowController {
    private var window: NSWindow?
    private let model: LessonReviewModel

    init(service: LessonService, onChanged: @escaping () -> Void) {
        model = LessonReviewModel(service: service, onChanged: onChanged)
    }

    func show() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: false)
            window.title = L10n.t("Review Lessons")
            window.contentView = NSHostingView(rootView: LessonReviewView(model: model))
            window.isReleasedWhenClosed = false
            window.center()
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        Task { await model.refresh() }
    }
}
