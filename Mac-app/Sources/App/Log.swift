import os

/// An agent app has no window to print into, so anything worth diagnosing has
/// to go somewhere you can read it:
///
///     log stream --predicate 'subsystem == "app.swarmaa.notch"' --level debug
enum Log {
    static let usage = Logger(subsystem: "app.swarmaa.notch", category: "usage")
    static let sessions = Logger(subsystem: "app.swarmaa.notch", category: "sessions")
}
