/// Phone link v3 wire constants, frozen by PHONE-LINK-V3.md and by the phone
/// client that pairs with this Mac (not in this repo). They keep the protocol's
/// original product name on purpose: changing any of them breaks pairing,
/// key derivation or response parsing on phones already in use.
enum PhoneLinkWire {
    static let name = "codenotch"
    static let source = "Codenotch"
    static let contentType = "application/\(name)-v3"
    static let pairScheme = "\(name)://pair"
    static let deviceKeyPrefix = "\(name)-device-v3"
    static func info(_ label: String) -> String { "\(name)/v3/\(label)" }
}
