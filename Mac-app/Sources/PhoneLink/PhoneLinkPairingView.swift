import SwiftUI
import CoreImage.CIFilterBuiltins
import CryptoKit
import Security
import UniformTypeIdentifiers

/// Writes a short-lived 6-digit relay pairing code into `<serviceRoot>/.local/relay-pairing.json`,
/// matching `scripts/relay-pair.ts` so the iOS app can pair either by scanning the QR code or
/// typing the 6-digit code.
enum RelayPairingCodeGenerator {
    struct Generated: Equatable {
        let code: String
        let expiresAt: Date
        var formatted: String {
            guard code.count == 6 else { return code }
            return "\(code.prefix(3)) \(code.suffix(3))"
        }
        var pairURL: String {
            "swarmaa://pair?code=\(code)"
        }
    }

    static func sha256Hex(_ value: String) -> String {
        let normalized = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        let digest = SHA256.hash(data: Data(normalized.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func generate(serviceRoot: String = UserDefaults.standard.string(forKey: Preferences.serviceRootKey) ?? Preferences.defaultSwarmaaServiceRoot,
                         now: Date = Date()) -> Generated? {
        let expanded = (serviceRoot as NSString).expandingTildeInPath
        let rootURL = URL(fileURLWithPath: expanded)
        guard FileManager.default.fileExists(atPath: rootURL.path) else { return nil }

        var raw: UInt32 = 0
        guard SecRandomCopyBytes(kSecRandomDefault, MemoryLayout<UInt32>.size, &raw) == errSecSuccess else {
            return nil
        }
        let code = String(format: "%06u", raw % 1_000_000)
        let expiresAt = now.addingTimeInterval(300)
        let expiresMs = Int64(expiresAt.timeIntervalSince1970 * 1000)

        let localDir = rootURL.appendingPathComponent(".local", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: localDir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let payload: [String: Any] = [
                "code_hash": sha256Hex(code),
                "expires_at": expiresMs,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload)
            let temp = localDir.appendingPathComponent("relay-pairing-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString).tmp")
            let target = localDir.appendingPathComponent("relay-pairing.json")
            try data.write(to: temp, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temp.path)
            _ = try FileManager.default.replaceItemAt(target, withItemAt: temp)
            return Generated(code: code, expiresAt: expiresAt)
        } catch {
            return nil
        }
    }
}

struct PhoneLinkPairingView: View {
    @ObservedObject var pairing: PhoneLinkPairing
    @ObservedObject var registry: PhoneLinkRegistry
    let port: Int
    @ObservedObject var serverStatus: PhoneLinkServerStatus

    @State private var relayCode: RelayPairingCodeGenerator.Generated?
    @State private var copiedLink = false
    @State private var copiedCode = false
    @State private var qrImage: NSImage?
    @State private var qrLink: String = ""
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    private static let ciContext = CIContext()

    private var advertisedPort: Int {
        if case .ready(let boundPort) = serverStatus.state { return boundPort }
        return port
    }

    private var lanLink: String {
        let hosts = PhoneLinkNetwork.getHosts().joined(separator: ",")
        let name = PhoneLinkNetwork.getComputerName()
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        let encodedName = name.addingPercentEncoding(withAllowedCharacters: allowed) ?? name
        return "swarmaa://pair?v=3&h=\(hosts)&p=\(String(advertisedPort))&c=\(pairing.currentCode ?? "")&n=\(encodedName)"
    }

    var link: String {
        if let relayCode, Date() < relayCode.expiresAt {
            return relayCode.pairURL
        }
        return lanLink
    }

    private var activeExpiresAt: Date? {
        if let relayCode, Date() < relayCode.expiresAt { return relayCode.expiresAt }
        return pairing.expiresAt
    }

    private var displayCode: String? {
        if let relayCode, Date() < relayCode.expiresAt { return relayCode.formatted }
        return pairing.currentCode
    }

    var body: some View {
        VStack(spacing: 14) {
            if let pd = pairing.lastPaired {
                Image(systemName: "checkmark.circle.fill")
                    .resizable()
                    .foregroundColor(.green)
                    .frame(width: 80, height: 80)
                    .transition(.opacity)

                Text(L10n.t("\(pd.name) is connected"))
                    .font(.headline)

                Button(L10n.t("Done")) {
                    NSApp.keyWindow?.close()
                }
                .keyboardShortcut(.defaultAction)

                Button(L10n.t("Connect another phone")) {
                    pairing.lastPaired = nil
                    refreshCodes()
                }
                .buttonStyle(.link)
            } else {
                let hosts = PhoneLinkNetwork.getHosts()
                let hasIP = hosts.first(where: { PhoneLinkNetwork.isPrivateIPv4($0) }) != nil
                let hasRelay = relayCode.map { Date() < $0.expiresAt } ?? false

                if !hasRelay && (!hasIP || serverStatus.state == .off || isFailed(serverStatus.state)) {
                    Text(L10n.t("Connect your phone"))
                        .font(.headline)
                    Text(L10n.t("This Mac isn't on a local network"))
                        .font(.subheadline)
                        .foregroundColor(.secondary)

                    if case .failed(let err) = serverStatus.state {
                        Text(err).foregroundColor(.red)
                    }

                    Button(L10n.t("Retry")) {
                        refreshCodes()
                    }
                } else if !hasRelay && !pairing.isOpen {
                    Text(L10n.t("Pairing code expired"))
                        .font(.headline)
                    Button(L10n.t("Generate a new code")) {
                        refreshCodes()
                    }
                } else {
                    Text(L10n.t("Connect your phone"))
                        .font(.headline)
                    Text(L10n.t("Scan this QR code or enter the code in the Swarmaa iOS app."))
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)

                    if let qrImage {
                        Image(nsImage: qrImage)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 210, height: 210)
                            .padding(12)
                            .background(Color.white)
                            .cornerRadius(12)
                            .transition(.opacity)
                            .id(qrLink)
                            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: qrLink)
                    }

                    if let displayCode {
                        HStack(spacing: 10) {
                            Text(displayCode)
                                .font(.system(relayCode != nil ? .title2 : .caption, design: .monospaced).weight(.semibold))
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .textSelection(.enabled)

                            Button(copiedCode ? L10n.t("Copied ✓") : L10n.t("Copy Code")) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(relayCode?.code ?? displayCode, forType: .string)
                                copiedCode = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copiedCode = false }
                            }
                        }
                        .padding(.horizontal)
                    }

                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        let diff = max(0, activeExpiresAt?.timeIntervalSinceNow ?? 0)
                        let min = Int(diff) / 60
                        let sec = Int(diff) % 60
                        Text(L10n.t("Expires in \(String(format: "%d:%02d", min, sec))"))
                            .font(.system(.body, design: .monospaced))
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text(link)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .textSelection(.enabled)

                        Button(copiedLink ? L10n.t("Copied ✓") : L10n.t("Copy Link")) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(link, forType: .string)
                            copiedLink = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copiedLink = false }
                        }
                    }
                    .padding(.horizontal)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n.t("1. Open Swarmaa on your iPhone or iPad"))
                        Text(L10n.t("2. Tap Scan QR Code, Paste Link, or type the 6-digit code"))
                        Text(L10n.t("3. Your phone connects directly to this Mac"))
                    }
                    .font(.footnote)
                    .padding(.top, 4)

                    if relayCode == nil {
                        Text(L10n.t("Your phone must be on the same Wi-Fi, or run `npm run relay:pair` for a 6-digit relay code."))
                            .font(.footnote)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }
                }
            }
        }
        .padding()
        .frame(width: 400)
        .onAppear {
            if relayCode == nil {
                relayCode = RelayPairingCodeGenerator.generate()
            }
            updateQR()
        }
        .onChange(of: link) { _, _ in
            updateQR()
        }
    }

    private func refreshCodes() {
        pairing.openWindow()
        relayCode = RelayPairingCodeGenerator.generate()
        updateQR()
    }

    private func updateQR() {
        let current = link
        guard current != qrLink else { return }
        qrLink = current
        qrImage = Self.generateQRCode(from: current)
    }

    private func isFailed(_ state: PhoneLinkServerState) -> Bool {
        if case .failed = state { return true }
        return false
    }

    private static func generateQRCode(from string: String) -> NSImage {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"

        if let outputImage = filter.outputImage,
           let cgImage = ciContext.createCGImage(outputImage, from: outputImage.extent) {
            return NSImage(cgImage: cgImage, size: NSSize(width: outputImage.extent.width, height: outputImage.extent.height))
        }
        return NSImage()
    }
}
