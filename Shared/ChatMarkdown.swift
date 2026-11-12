import SwiftUI

/// Line-based block markdown for chat messages: headings, lists, fences, quotes, tables, rules, paragraphs.
/// Inline spans (bold, italic, `code`, links) are parsed by Foundation. Parsed once per body and kept.
enum ChatMarkdown {
    enum Block: Equatable {
        case heading(Int, AttributedString)
        case paragraph(AttributedString)
        case item(marker: String, level: Int, AttributedString)
        case code(String)
        case quote(AttributedString)
        case table(header: [AttributedString], rows: [[AttributedString]], raw: String)
        case rule
    }

    private final class Box: @unchecked Sendable { let blocks: [Block]; init(_ blocks: [Block]) { self.blocks = blocks } }
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = { let c = NSCache<NSString, Box>(); c.countLimit = 2000; return c }()

    static func blocks(_ text: String) -> [Block] {
        if let hit = cache.object(forKey: text as NSString) { return hit.blocks }
        let parsed = parse(text)
        cache.setObject(Box(parsed), forKey: text as NSString)
        return parsed
    }

    private static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    private static func cells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }
    private static func isSeparator(_ line: String) -> Bool {
        line.contains("-") && line.contains("|") && line.allSatisfy { "|-: \t".contains($0) }
    }
    private static func matches(_ s: String, _ pattern: String) -> [String]? {
        guard let m = s.firstMatch(of: try! Regex(pattern)) else { return nil }
        return m.output.map { $0.substring.map(String.init) ?? "" }
    }

    private static func parse(_ text: String) -> [Block] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [Block] = []
        var para: [String] = [], quote: [String] = []
        func flush() {
            if !para.isEmpty { out.append(.paragraph(inline(para.joined(separator: "\n")))); para = [] }
            if !quote.isEmpty { out.append(.quote(inline(quote.joined(separator: "\n")))); quote = [] }
        }
        var i = 0
        while i < lines.count {
            let line = lines[i], t = line.trimmingCharacters(in: .whitespaces)
            i += 1
            if t.hasPrefix("```") {
                flush()
                var code: [String] = []
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
                i += 1
                out.append(.code(code.joined(separator: "\n")))
            } else if t.isEmpty { flush()
            } else if let m = matches(t, #"^(#{1,6})\s+(.*)$"#) {
                flush(); out.append(.heading(min(m[1].count, 3), inline(m[2])))
            } else if matches(t, #"^([-*_])(\s*\1){2,}$"#) != nil {
                flush(); out.append(.rule)
            } else if t.hasPrefix(">") {
                if !para.isEmpty { flush() }
                quote.append(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else if t.contains("|"), i < lines.count, isSeparator(lines[i]) {
                flush()
                var raw = [t, lines[i].trimmingCharacters(in: .whitespaces)]
                i += 1
                var rows: [[AttributedString]] = []
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    raw.append(lines[i].trimmingCharacters(in: .whitespaces)); rows.append(cells(lines[i]).map(inline)); i += 1
                }
                out.append(.table(header: cells(t).map(inline), rows: rows, raw: raw.joined(separator: "\n")))
            } else if let m = matches(line, #"^(\s*)([-*•]|\d+[.)])\s+(.*)$"#) {
                flush()
                let marker = m[2].first!.isNumber ? m[2] : "•"
                out.append(.item(marker: marker, level: m[1].count >= 2 ? 1 : 0, inline(m[3])))
            } else if line.first?.isWhitespace == true, para.isEmpty, quote.isEmpty, case .item(let mk, let lv, let prev)? = out.last {
                // ponytail: an indented line after a list item continues that item; deeper structure is not parsed.
                out[out.count - 1] = .item(marker: mk, level: lv, prev + AttributedString("\n") + inline(t))
            } else {
                if !quote.isEmpty { flush() }
                para.append(line)
            }
        }
        flush()
        return out
    }
}

struct ChatMarkdownStyle: Equatable {
    var body: Font, heading: Font, mono: Font
    var text: Color, muted: Color, codeBackground: Color
    var lineSpacing: CGFloat = 3, blockSpacing: CGFloat = 8
}

struct ChatMarkdownView: View, Equatable {
    let text: String
    let style: ChatMarkdownStyle

    var body: some View {
        let blocks = ChatMarkdown.blocks(text)
        VStack(alignment: .leading, spacing: style.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in view(block) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(_ s: AttributedString, _ font: Font? = nil) -> some View {
        Text(s).font(font ?? style.body).foregroundStyle(style.text).lineSpacing(style.lineSpacing)
            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    private func codeBlock(_ code: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(verbatim: code).font(style.mono).foregroundStyle(style.text)
                .textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
        }
        .padding(10).background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(style.codeBackground))
    }

    @ViewBuilder private func view(_ block: ChatMarkdown.Block) -> some View {
        switch block {
        case .heading(let level, let s):
            label(s, level == 1 ? style.heading.bold() : style.body.bold()).padding(.top, 2)
        case .paragraph(let s): label(s)
        case .item(let marker, let level, let s):
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(verbatim: marker).font(style.body).foregroundStyle(style.muted).frame(width: 22, alignment: .trailing)
                label(s)
            }.padding(.leading, CGFloat(level) * 18)
        case .code(let code): codeBlock(code)
        case .quote(let s):
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(style.muted).frame(width: 2)
                label(s).foregroundStyle(style.muted)
            }.fixedSize(horizontal: false, vertical: true)
        case .table(let header, let rows, let raw):
            if header.count > 4 { codeBlock(raw) } else {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow { ForEach(Array(header.enumerated()), id: \.offset) { _, c in label(c, style.body.bold()) } }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        Divider().overlay(style.muted.opacity(0.3)).gridCellColumns(header.count)
                        GridRow { ForEach(Array(row.prefix(header.count).enumerated()), id: \.offset) { _, c in label(c) } }
                    }
                }
            }
        case .rule: Rectangle().fill(style.muted.opacity(0.4)).frame(height: 1)
        }
    }
}
