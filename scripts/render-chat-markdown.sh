#!/bin/bash
# Usage: render-chat-markdown.sh [file.md ...] — asserts the parser and renders each file to <name>.png.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$root/scripts/render-chat-markdown-main.swift" "$tmp/main.swift"
swiftc -o "$tmp/render" "$root/Shared/ChatMarkdown.swift" "$tmp/main.swift"
"$tmp/render" "$@"
