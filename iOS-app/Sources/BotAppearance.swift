import Foundation

/// Characters a bot can adopt; `mark` is reserved for the app.
public let botAvatars: [String] = ["lead", "runner", "scout", "navigator", "clerk", "scribe", "badge-sun", "badge-peri", "badge-peach"]

/// Each character's body hue in degrees, measured from its image. A bot's colour turns the body to
/// that colour's hue; eyes and outlines are neutral, so a hue rotation leaves them as they are.
public let mojiBaseHue: [String: Double] = [
    "lead": 251, "runner": 248, "scout": 352, "navigator": 38, "clerk": 273,
    "scribe": 246, "badge-sun": 39, "badge-peri": 247, "badge-peach": 360
]

public func mojiHueShift(_ character: String, toHex hex: UInt32) -> Double {
    let r = Double((hex >> 16) & 255) / 255, g = Double((hex >> 8) & 255) / 255, b = Double(hex & 255) / 255
    let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
    guard d > 0, let base = mojiBaseHue[character] else { return 0 }
    var hue = mx == r ? (g - b) / d : mx == g ? (b - r) / d + 2 : (r - g) / d + 4
    hue = (hue * 60 + 360).truncatingRemainder(dividingBy: 360)
    return hue - base
}

public func mojiCharacter(_ seed: String) -> String {
    let kinds = botAvatars
    if kinds.contains(seed) { return seed }
    let hash = seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
    return kinds[Int(hash % UInt32(kinds.count))]
}

/// The Kind Swarm stage colours for bots.
public func botColorHex(_ name: String?) -> UInt32? {
    switch name {
    case "blue": 0x9CC8FF
    case "butter": 0xFFE08A
    case "peach": 0xFFC4A8
    case "lilac": 0xD6C2FF
    case "pink": 0xFFB8D9
    case "lime": 0xC9F26B
    case "sky": 0xA8E6FF
    case "orchid": 0xF2C4FF
    default: nil
    }
}
