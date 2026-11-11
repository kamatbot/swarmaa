import Foundation

/// What one release changed, in the app's own words.
struct ReleaseNote: Equatable {
    /// Matched against `CFBundleShortVersionString`, so it has to be exactly
    /// the string `MARKETING_VERSION` is set to.
    let version: String
    /// One line under the title. What this release is *about*.
    let headline: String
    let changes: [Change]

    /// A title carries the change; the detail is optional, so a small fix can
    /// be a single line rather than a line padded out to match its neighbours.
    struct Change: Equatable {
        let title: String
        let detail: String

        init(title: String, detail: String = "") {
            self.title = title
            self.detail = detail
        }
    }
}

/// The release history the app ships with, from the move to the
/// `app.swarmaa.mac` identity onwards.
///
/// Written here rather than fetched from the appcast: it has to be there on a
/// first launch with no network, and it belongs to the build it describes.
/// Bumping `MARKETING_VERSION` without adding an entry is caught by
/// `testTheCurrentVersionHasANote`.
enum ReleaseNotes {
    static var all: [ReleaseNote] {
        [
            ReleaseNote(
                version: "1.27.0",
                headline: L10n.t("A fresh start as Swarmaa for Mac: the main window and the menu bar."),
                changes: [
                    ReleaseNote.Change(
                        title: L10n.t("One home"),
                        detail: L10n.t("Usage, bots, tasks and swarms live in the main window, with limits in the menu bar. The screen-edge overlay is gone.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Notifications as banners"),
                        detail: L10n.t("Finished sessions, limits reached and limits reset arrive in Notification Center.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Updates from swarmaa.com"),
                        detail: L10n.t("New versions are offered in a window and install when you choose Install Update.")
                    ),
                ]
            ),
            ReleaseNote(
                version: "1.26.0",
                headline: L10n.t("Bots: persistent swarms with their own crew, routing and rules."),
                changes: [
                    ReleaseNote.Change(
                        title: L10n.t("Bots home"),
                        detail: L10n.t("Bots with updates or questions sit at the top with a badge. Their messages, task cards and questions appear in the right pane.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Bot settings"),
                        detail: L10n.t("Pick which service researches, edits and reviews, set a quota floor, require tests, and run a bot on a schedule.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Usage in the sidebar"),
                        detail: L10n.t("Each service shows a usage ring in the left rail. Hover it for the 5-hour and weekly limits.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("A new look"),
                        detail: L10n.t("A calmer Kind Swarm design with a character for every agent.")
                    ),
                ]
            ),
            ReleaseNote(
                version: "1.25.0",
                headline: L10n.t("A main window for your agents: what needs you, their threads, swarms and questions."),
                changes: [
                    ReleaseNote.Change(
                        title: L10n.t("Needs you"),
                        detail: L10n.t("Questions to answer, work ready for review and failed runs, each with one button to deal with it.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Agents and threads"),
                        detail: L10n.t("Talk to persistent agents, switch which model runs them, and follow their swarms as live cards.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Tasks"),
                        detail: L10n.t("Everything in progress, ready, failed or resolved, with a checkbox to fold finished work away.")
                    ),
                    ReleaseNote.Change(
                        title: L10n.t("Setup checklist"),
                        detail: L10n.t("Shows which parts of Swarmaa are ready and how to fix the rest. Open it from Settings or the menu bar's Open Swarmaa.")
                    ),
                ]
            ),
        ]
    }

    static func note(for version: String) -> ReleaseNote? {
        all.first { $0.version == version }
    }

    /// The note worth showing on this launch, if there is one.
    ///
    /// `notes` is a parameter so the rule can be tested against a fixed history
    /// rather than against whatever the app happens to ship this week.
    static func unseen(in version: String,
                       lastSeen: String?,
                       notes: [ReleaseNote] = ReleaseNotes.all) -> ReleaseNote? {
        guard lastSeen != version else { return nil }
        return notes.first { $0.version == version }
    }
}
