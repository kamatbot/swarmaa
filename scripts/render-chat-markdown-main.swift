// Check harness: compiled with Shared/ChatMarkdown.swift by scripts/render-chat-markdown.sh (not part of any app target).
import SwiftUI
import AppKit

func plain(_ a: AttributedString) -> String { String(a.characters) }
func check(_ ok: Bool, _ msg: String) { if !ok { print("FAIL: \(msg)"); exit(1) }; print("ok: \(msg)") }

let b = ChatMarkdown.blocks("""
# Title
Line one
line two

- top
  - nested
1. first
2) second
```swift
let x = 1
  indented
```
| a | b |
|---|---|
| 1 | **2** |
> quoted
---
""")
check({ if case .heading(1, let s) = b[0] { return plain(s) == "Title" }; return false }(), "heading")
check({ if case .paragraph(let s) = b[1] { return plain(s) == "Line one\nline two" }; return false }(), "paragraph soft break")
check({ if case .item("•", 0, _) = b[2] { return true }; return false }(), "bullet")
check({ if case .item("•", 1, let s) = b[3] { return plain(s) == "nested" }; return false }(), "nested bullet")
check({ if case .item("1.", 0, _) = b[4] { return true }; return false }(), "numbered")
check({ if case .item("2)", 0, _) = b[5] { return true }; return false }(), "numbered paren")
check({ if case .code(let c) = b[6] { return c == "let x = 1\n  indented" }; return false }(), "fence verbatim")
check({ if case .table(let h, let r, _) = b[7] { return h.count == 2 && r.count == 1 && plain(r[0][1]) == "2" }; return false }(), "table")
check({ if case .quote = b[8] { return true }; return false }(), "quote")
check({ if case .rule = b[9] { return true }; return false }(), "rule")
check(b.count == 10, "block count \(b.count)")

let style = ChatMarkdownStyle(
    body: .system(size: 13.5), heading: .system(size: 15, weight: .semibold), mono: .system(size: 11.5, design: .monospaced),
    text: Color(red: 0xD3 / 255, green: 0xDC / 255, blue: 0xEB / 255), muted: Color(red: 0x8B / 255, green: 0x9C / 255, blue: 0xB6 / 255),
    codeBackground: .black.opacity(0.25), lineSpacing: 5, blockSpacing: 9)

MainActor.assumeIsolated {
    for path in CommandLine.arguments.dropFirst() {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { print("FAIL: read \(path)"); exit(1) }
        let view = ChatMarkdownView(text: text, style: style).padding(16).frame(width: 640)
            .background(Color(red: 0x0F / 255, green: 0x1A / 255, blue: 0x2E / 255)).environment(\.colorScheme, .dark)
        let r = ImageRenderer(content: view); r.scale = 2
        guard let img = r.nsImage, let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { print("FAIL: render \(path)"); exit(1) }
        let out = (path as NSString).deletingPathExtension + ".png"
        try! png.write(to: URL(fileURLWithPath: out))
        print("wrote \(out)")
    }
}
print("PASS")
