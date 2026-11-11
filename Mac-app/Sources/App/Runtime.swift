import Foundation

/// Whether this process is an `xcodebuild test` host rather than a Swarmaa
/// somebody launched.
///
/// The unit bundle is hosted by the app itself, so a test run *is* a running
/// Swarmaa — and anything that would reach outside the process has to ask
/// first. Without the check every test run put a live request on the usage
/// endpoint.
enum Runtime {
    static let isUnderTest: Bool =
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || NSClassFromString("XCTestCase") != nil
}
