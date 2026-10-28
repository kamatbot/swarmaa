// Run on macOS to rasterize the repository's existing SVG characters; no package dependency.
import AppKit
let source = URL(fileURLWithPath: "../Mac-app/Sources/Teams/Moji")
let output = URL(fileURLWithPath: "Resources")
for url in try FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: nil) where url.pathExtension == "svg" {
    guard let image = NSImage(contentsOf: url) else { fatalError("Cannot decode SVG") }
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 400, pixelsHigh: 400, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(x: 0, y: 0, width: 400, height: 400))
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(url.deletingPathExtension().lastPathComponent + ".png"))
}
