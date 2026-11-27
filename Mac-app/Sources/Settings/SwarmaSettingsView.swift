import SwiftUI

/// Settings pane for Swarmaa, the local multi-agent network whose workers and
/// project scopes surface status and routing controls.
struct SwarmaSettingsView: View {
    @ObservedObject var preferences: Preferences
    @ObservedObject private var navigator = SettingsNavigator.shared
    @State private var tab = Tab.general
    @StateObject private var setup = TeamsModel()

    enum Tab { case general, routing, setup }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text(L10n.t("General")).tag(Tab.general)
                Text(L10n.t("Routing")).tag(Tab.routing)
                Text(L10n.t("Setup")).tag(Tab.setup)
            }
            .pickerStyle(.segmented).labelsHidden()
            .frame(maxWidth: 320)
            .padding(.vertical, 10)
            .accessibilityLabel(L10n.t("Swarmaa settings section"))
            switch tab {
            case .general: general
            case .routing: RoutingSettingsView()
            case .setup: ScrollView { SetupChecklistView(model: setup) }
            }
        }
        .onAppear {
            if let requested = navigator.requestedSwarmaTab {
                tab = requested
                navigator.requestedSwarmaTab = nil
            }
        }
        .onChange(of: navigator.requestedSwarmaTab) { requested in
            guard let requested else { return }
            tab = requested
            navigator.requestedSwarmaTab = nil
        }
    }

    private var general: some View {
        Form {
            Section("Swarmaa") {
                Toggle("Show Swarmaa workers and swarms", isOn: $preferences.swarmaEnabled)

                Text("Track each active worker's quota and current task alongside each project scope's running, queued, and completed work. Entries appear and disappear automatically as workers connect.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Toggle("Show active chats", isOn: $preferences.swarmaShowsChats)
                    .disabled(!preferences.swarmaEnabled)
                Text("Show each provider with a chat in the last 15 minutes: Claude Code, Codex, Antigravity, Grok, or Dot. Entries clear once chats go idle.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section("Connection") {
                LabeledContent("Service URL") {
                    TextField(Preferences.defaultSwarmaServiceURL, text: $preferences.swarmaServiceURL)
                        .textFieldStyle(.roundedBorder)
                }
                if let problem = urlProblem {
                    Text(problem)
                        .font(.callout)
                        .foregroundStyle(Color.red)
                }

                LabeledContent("Token file") {
                    TextField(Preferences.defaultSwarmaTokenPath, text: $preferences.swarmaTokenPath)
                        .textFieldStyle(.roundedBorder)
                }
                Text(tokenFileExists
                     ? L10n.t("Token file found. Its contents are only ever sent to the service URL above.")
                     : L10n.t("No file at that path yet."))
                    .font(.callout)
                    .foregroundStyle(tokenFileExists ? Color.secondary : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                LabeledContent {
                    Button(L10n.t("Change connection…")) { NotificationCenter.default.post(name: .swarmaaRunSetup, object: nil) }
                } label: {
                    Text(L10n.t("Connect to another Mac, or sign in again with a different identity."))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    private var tokenFileExists: Bool {
        FileManager.default.fileExists(atPath: (preferences.swarmaTokenPath as NSString).expandingTildeInPath)
    }

    /// Plain http is accepted for this Mac only; anything else must be https.
    private var urlProblem: String? {
        do {
            _ = try SwarmaClient.endpoint(preferences.swarmaServiceURL, tool: "swarm_status")
            return nil
        } catch let failure as SwarmaClient.Failure {
            return failure.message
        } catch {
            return nil
        }
    }
}
