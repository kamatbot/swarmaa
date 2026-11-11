import Foundation
import Sparkle

/// Keeps the app up to date with Sparkle's own update window.
///
/// Checks at launch and on Sparkle's schedule, without the first-launch
/// permission prompt Sparkle otherwise shows (`SUEnableAutomaticChecks` is set
/// in the Info.plist). What it finds is offered in Sparkle's standard window —
/// release notes, Install Update, Remind Me Later — and never downloaded unasked.
///
/// One thing it cannot do, which is macOS rather than Sparkle: the app has to
/// be writable by the user installing the update — true for a normal drag to
/// /Applications, false if it was copied there with `sudo`.
@MainActor
final class Updater: NSObject, ObservableObject, SPUUpdaterDelegate {
    /// What the last check came to, in words the settings sheet can show.
    ///
    /// Sparkle's own answer to a failed check is a modal saying "an error
    /// occurred in retrieving update information" — true, and useless: it names
    /// no cause and offers nothing to do. Keeping the outcome here lets the one
    /// place a user goes to think about updates say what actually happened.
    enum Outcome: Equatable {
        case idle
        case checking
        case upToDate(Date)
        case found(String)
        case unreachable
        case failed(String)

        var message: String? {
            switch self {
            case .idle:          return nil
            case .checking:      return L10n.t("Checking…")
            case .upToDate:      return L10n.t("Swarmaa is up to date.")
            case .found(let v):  return L10n.t("Version \(v) is available.")
            case .unreachable:
                // The one people actually hit, and the one Sparkle's wording
                // hides: nothing is wrong with the app or the machine.
                return L10n.t("Couldn't reach the update server. Swarmaa will try again on its own — nothing is wrong with this copy.")
            case .failed(let why): return why
            }
        }
    }

    @Published private(set) var outcome: Outcome = .idle

    /// **A newer version there to be had**, and not installed — put off with
    /// Remind Me Later, or closed. What the red dot on the General tab says;
    /// gone once it installs, or a check finds none.
    @Published private(set) var pending: String?

    /// The one waiting, offered again.
    func reoffer() { checkNow() }

    private lazy var driver = SPUStandardUserDriver(hostBundle: .main, delegate: nil)
    private lazy var sparkle = SPUUpdater(hostBundle: .main, applicationBundle: .main,
                                          userDriver: driver, delegate: self)

    /// Mirrors the preference, so switching it off really does stop the checks
    /// rather than only hiding them. Never downloads unasked.
    var automatic: Bool {
        get { sparkle.automaticallyChecksForUpdates }
        set { sparkle.automaticallyChecksForUpdates = newValue }
    }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    var lastChecked: Date? { sparkle.lastUpdateCheckDate }

    /// Starts the scheduled checks, and checks now — so an update out since it
    /// last ran is offered as it launches. Deliberately not in `init`: the
    /// updater is lazy so that `self` exists before it is handed over as the
    /// delegate.
    func start() {
        guard !started else { return }
        started = true
        sparkle.automaticallyDownloadsUpdates = false
        do {
            try sparkle.start()
        } catch {
            outcome = .failed(error.localizedDescription)
            return
        }
        if sparkle.automaticallyChecksForUpdates {
            sparkle.checkForUpdatesInBackground()
        }
    }
    private var started = false

    /// The manual path, for someone who does not want to wait for the schedule.
    /// This one *does* show UI — it was asked for, so silence would read as a
    /// broken button.
    func checkNow() {
        start()
        outcome = .checking
        sparkle.checkForUpdates()
        // Never left on "Checking…". Sparkle reports every ending it knows
        // about below, but a copy whose updater cannot reach its own helper —
        // a damaged install, a helper macOS blocked — reports nothing at all.
        let started = checkGeneration &+ 1
        checkGeneration = started
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.checkTimeout) { [weak self] in
            guard let self, self.checkGeneration == started else { return }
            self.outcome = Self.outcome(afterTimeoutFrom: self.outcome)
        }
    }

    /// How long a check may stay unanswered before it is called stalled.
    static let checkTimeout: TimeInterval = 45
    private var checkGeneration = 0

    /// Pure, so both endings can be tested without Sparkle.
    static func outcome(afterTimeoutFrom current: Outcome) -> Outcome {
        guard current == .checking else { return current }
        return .failed(L10n.t("The update check didn't finish. Try again, or download the latest Swarmaa from swarmaa.com."))
    }

    /// A cycle that ended without saying found or not found — the person
    /// closed Sparkle's window, or a download already in progress answered the
    /// request — must not leave the status reading "Checking…".
    static func outcome(afterCycleFrom current: Outcome, errorCode: Int?) -> Outcome {
        guard current == .checking else { return current }
        guard let errorCode else { return .idle }
        return isUnreachable(errorCode) ? .unreachable : .idle
    }

    // MARK: - SPUUpdaterDelegate

    nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        Task { @MainActor in
            self.outcome = .upToDate(Date())
            self.pending = nil
        }
    }

    nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        Task { @MainActor in
            self.outcome = .found(version)
            self.pending = version
        }
    }

    nonisolated func updater(_ updater: SPUUpdater,
                             didFinishUpdateCycleFor updateCheck: SPUUpdateCheck,
                             error: Error?) {
        let code = error.map { ($0 as NSError).code }
        Task { @MainActor in
            self.outcome = Self.outcome(afterCycleFrom: self.outcome, errorCode: code)
        }
    }

    nonisolated func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let code = (error as NSError).code
        Task { @MainActor in
            // A feed that cannot be fetched is the ordinary failure — offline,
            // or the server is down — and it is not the user's problem to
            // solve. Anything else is reported as itself.
            self.outcome = Self.isUnreachable(code)
                ? .unreachable
                : .failed(error.localizedDescription)
        }
    }

    /// Sparkle folds every "could not load the feed" case into one code.
    static func isUnreachable(_ code: Int) -> Bool {
        code == Int(SUError.appcastError.rawValue)
    }
}
