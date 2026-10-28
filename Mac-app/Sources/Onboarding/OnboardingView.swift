import SwiftUI
import AppKit

struct OnboardingView: View {
    @ObservedObject var model: OnboardingModel
    var onFinish: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch model.page {
                    case .welcome: WelcomePage(model: model)
                    case .services: ServicesPage(model: model)
                    case .projects: ProjectsPage(model: model)
                    case .remote: RemotePage(model: model)
                    case .review: ReviewPage(model: model)
                    case .progress: ProgressPage(model: model)
                    case .summary: SummaryPage(model: model)
                    case .connect: ConnectPage(model: model)
                    case .connected: ConnectedPage(model: model)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(32)
            }
            Divider()
            footer
        }
        .frame(minWidth: 720, minHeight: 640)
    }

    /// Secondary actions sit left of the primary one, which is always bottom-right.
    private var footer: some View {
        HStack {
            if model.canGoBack {
                Button("Back") { model.goBack() }
                    .accessibilityLabel("Back to the previous step")
            }
            Spacer()
            switch model.page {
            case .summary, .connected:
                Button("Finish") { onFinish() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityLabel("Finish setup and start Swarmaa")
            case .progress:
                if model.failure != nil {
                    Button("Try Again") { model.retry() }.keyboardShortcut(.defaultAction)
                }
            case .connect:
                if model.failure != nil {
                    Button("Try Again") { model.retry() }.keyboardShortcut(.defaultAction)
                }
            case .welcome:
                Button("Skip for now") { model.skip(); onFinish() }
                    .accessibilityLabel("Skip setup and show usage only")
                Button(model.choice == .connectRemote ? "Connect" : "Continue") { model.goNext() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.welcomeActions.contains(.continue))
            default:
                Button(model.page == .review ? "Connect" : "Continue") { model.goNext() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canContinue)
            }
        }
        .padding(16)
    }
}

private struct PageHeader: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
            if let subtitle { Text(subtitle).font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
    }
}

private func chooseFolders(multiple: Bool, message: String) -> [URL] {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = multiple
    panel.message = message
    return panel.runModal() == .OK ? panel.urls : []
}

// MARK: - Pages

private struct WelcomePage: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        PageHeader(title: "Welcome to Swarmaa",
                   subtitle: "Swarmaa watches your coding agents from the notch: how much quota each has left, and what every chat and project is doing. Choose where your Swarmaa lives. You can also skip this and just see usage.")
        option(.setUpHere, "Set up Swarmaa on this Mac",
               model.bundledRuntime == nil
               ? "This build doesn't include the Swarmaa runtime. Choose another option, or skip."
               : "Installs the service, database and workers that come with this app. Nothing else to install.") {
            if model.installing { HStack { ProgressView().controlSize(.small); Text("Installing…") } }
        }
        option(.useService, "Use a Swarmaa service on this Mac",
               "For a development install. Point at its folder.") {
            HStack {
                TextField("Service folder", text: $model.serviceRoot)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Swarmaa service folder path")
                Button("Choose…") {
                    if let url = chooseFolders(multiple: false, message: "Choose the Swarmaa service folder").first {
                        model.serviceRoot = url.path
                    }
                }
            }
            if model.rootIsValid {
                if model.detecting {
                    HStack { ProgressView().controlSize(.small); Text("Looking at this Mac…") }
                } else if let error = model.detectionError {
                    Text(error).foregroundStyle(.red).font(.callout)
                    Button("Try Again") { model.retryDetection() }
                } else if model.detection != nil {
                    Label("Service found", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                }
            } else {
                Label("Not found", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
        }
        option(.connectRemote, "Connect to an existing Swarmaa",
               "For a second Mac. Signs in with your browser and passkey; nothing is installed here.") {
            TextField("https://api.swarmaa.com", text: $model.remoteAddress)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Swarmaa address")
        }
        if let error = model.welcomeError {
            Text(error).foregroundStyle(.red).font(.callout)
        }
    }

    private func option<Detail: View>(_ choice: WelcomeChoice, _ title: LocalizedStringKey, _ blurb: LocalizedStringKey,
                                      @ViewBuilder detail: () -> Detail) -> some View {
        let selected = model.choice == choice
        return GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Button { model.choice = choice } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title).font(.headline)
                            Text(blurb).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                if selected { detail() }
            }
            .padding(6)
        }
    }
}

private struct ConnectPage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        PageHeader(title: "Approve in your browser",
                   subtitle: "Your browser opened Swarmaa's sign-in page. Approve this Mac with your passkey, then come back here.")
        if let failure = model.failure {
            Text(failure).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        } else {
            HStack { ProgressView().controlSize(.small); Text("Waiting for approval…") }
        }
    }
}

private struct ConnectedPage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        PageHeader(title: "You're connected",
                   subtitle: "This Mac now shows your Swarmaa agents and swarms in the notch. Nothing was installed on this Mac.")
        StarterPromptBox(text: StarterPrompt.text(projects: [], remoteMCP: (try? SwarmaOAuth.origin(model.remoteAddress)).map(SwarmaOAuth.resource)))
    }
}

/// The copy-ready prompt for the user's AI agent; the button is the page's only call to action.
struct StarterPromptBox: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Text("Get started").font(.headline)
        Text("Paste this into Claude Code, Codex or Antigravity:").foregroundStyle(.secondary)
        // The page already scrolls, so the prompt is shown in full rather than in a nested scroll area.
        Text(text).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.1)))
        Button(copied ? "Copied" : "Copy starter prompt") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
        }
        .buttonStyle(.borderedProminent)
        .accessibilityLabel("Copy starter prompt")
    }
}

private struct ServicesPage: View {
    @ObservedObject var model: OnboardingModel

    private static let rows: [(SetupHarness, String)] = [
        (.claude, "Claude Code"), (.codex, "Codex"), (.agy, "Antigravity"),
        (.grok, "Grok"), (.dot, "Dot"), (.notchtrader, "Swarmaa notch"),
    ]

    var body: some View {
        PageHeader(title: "Services", subtitle: "Choose which agents Swarmaa connects to.")
        ForEach(Self.rows, id: \.0) { harness, name in row(harness, name) }
    }

    private func row(_ h: SetupHarness, _ name: String) -> some View {
        let installed = model.isInstalled(h)
        let usable = OnboardingModel.canConnect(h, installed: installed)
        let binding = { (keyPath: WritableKeyPath<OnboardingModel.ServiceChoice, Bool>) in
            Binding(get: { model.choices[h]?[keyPath: keyPath] ?? false },
                    set: { model.choices[h, default: .init()][keyPath: keyPath] = $0 })
        }
        let connected = model.choices[h]?.connect ?? false
        return GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    VStack(alignment: .leading) {
                        Text(name).font(.headline)
                        Text(status(h, installed)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if h == .notchtrader {
                        Text("Always on").foregroundStyle(.secondary)
                    } else {
                        Toggle("Connect", isOn: binding(\.connect))
                            .disabled(!usable)
                            .accessibilityLabel("Connect \(name)")
                    }
                }
                if h != .notchtrader, connected {
                    HStack(spacing: 20) {
                        if OnboardingModel.hasWorker(h) {
                            Toggle("Background worker", isOn: binding(\.worker))
                                .accessibilityLabel("Run \(name) as a background worker")
                        }
                        if OnboardingModel.hasSharing(h) {
                            Toggle("Share chats", isOn: binding(\.share))
                                .accessibilityLabel("Share \(name) chats with Swarmaa")
                        }
                    }
                }
            }
            .padding(6)
        }
        .accessibilityElement(children: .contain)
    }

    private func status(_ h: SetupHarness, _ installed: Bool) -> String {
        switch h {
        case .grok, .dot: return "Hosted service. Needs remote access."
        case .notchtrader: return "This app"
        default: return installed ? "Installed" : "Not found on this Mac"
        }
    }
}

private struct ProjectsPage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        PageHeader(title: "Projects",
                   subtitle: "Add the folders your agents work in. Each becomes a project scope that tasks and memory are kept under. The scope project:demo is created automatically.")
        ForEach($model.projects) { $project in
            HStack {
                TextField("Scope name", text: $project.name)
                    .textFieldStyle(.roundedBorder).frame(width: 180)
                    .accessibilityLabel("Scope name for \(project.path)")
                Text(project.path).font(.callout).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Remove") { model.projects.removeAll { $0.id == project.id } }
                    .accessibilityLabel("Remove \(project.name)")
            }
        }
        if let problem = model.projectsProblem {
            Text(problem).foregroundStyle(.red).font(.callout)
        }
        Button("Add Folder…") {
            model.addFolders(chooseFolders(multiple: true, message: "Choose project folders"))
        }
    }
}

private struct RemotePage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        PageHeader(title: "Remote access",
                   subtitle: "Grok and Dot run in the cloud, so they reach Swarmaa through a public hostname.")
        Toggle("Set up now", isOn: $model.setUpRemoteNow)
            .accessibilityLabel("Set up remote access now")
        TextField("Hostname", text: $model.hostname)
            .textFieldStyle(.roundedBorder)
            .disabled(!model.setUpRemoteNow)
            .accessibilityLabel("Remote access hostname")
    }
}

private struct StepRow: View {
    let step: SetupStep
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            switch step.status {
            case .running: ProgressView().controlSize(.small)
            case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .skipped: Image(systemName: "minus.circle").foregroundStyle(.secondary)
            case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(step.label)
                if let note = step.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(step.label), \(step.status.rawValue)\(step.note.map { ", \($0)" } ?? "")")
    }
}

private struct ReviewPage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        PageHeader(title: "Review", subtitle: "Nothing has been changed yet. This is what Connect will do.")
        Toggle("Start Swarmaa at login", isOn: $model.autostart)
            .accessibilityLabel("Start the Swarmaa service at login")
        Text("Starts the Swarmaa service when you log in.").font(.caption).foregroundStyle(.secondary)
        Divider()
        if model.busy && model.steps.isEmpty {
            HStack { ProgressView().controlSize(.small); Text("Preparing the plan…") }
        }
        ForEach(model.steps) { StepRow(step: $0) }
        if let failure = model.failure {
            Text(failure).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            Button("Try Again") { model.runPreview() }
        }
        if let warnings = model.preview?.warnings, !warnings.isEmpty {
            ForEach(warnings, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
        }
    }
}

private struct ProgressPage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        PageHeader(title: "Connecting", subtitle: nil)
        ForEach(model.steps) { StepRow(step: $0) }
        if model.busy && model.steps.isEmpty { ProgressView() }
        if let failure = model.failure {
            Text(failure).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        }
        DisclosureGroup("Log") {
            Text(model.log.joined(separator: "\n"))
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct SummaryPage: View {
    @ObservedObject var model: OnboardingModel
    var body: some View {
        let s = model.summary ?? SetupSummary()
        PageHeader(title: "You're connected", subtitle: nil)
        line("Connected", s.agents)
        line("Background workers", s.workers)
        line("Chat sharing", s.sharing)
        line("Projects", s.projects.map { "\($0.scope)" })
        if let mcp = s.mcpUrl {
            HStack {
                Text("MCP URL").font(.headline)
                Text(mcp).textSelection(.enabled).font(.system(.callout, design: .monospaced))
                Button("Copy") { model.copyMCPURL() }.accessibilityLabel("Copy MCP URL")
            }
        }
        ForEach(s.warnings, id: \.self) { Label($0, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
        if !s.nextSteps.isEmpty {
            Text("Next steps").font(.headline)
            ForEach(s.nextSteps, id: \.self) { Text("• \($0)") }
        }
        if s.ok { StarterPromptBox(text: StarterPrompt.text(projects: s.projects.map(\.scope))) }
    }

    @ViewBuilder private func line(_ title: LocalizedStringKey, _ values: [String]) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.headline)
            Text(values.isEmpty ? "None" : values.joined(separator: ", ")).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
