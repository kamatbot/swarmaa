# Builds public/index.html from src/index.template.html, reusing the Kind Swarm characters, SVG defs
# and self-hosted @font-face rules from public/guide.html so the landing page and guide share one source.
import json, random, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
g = (root / 'public/guide.html').read_text()
t = (root / 'src/index.template.html').read_text()
fonts = '\n'.join(re.findall(r"@font-face\{[^}]+\}", g))
defs = re.search(r'<svg id="ks-defs".*?</svg>', g, re.S).group(0)
m = re.findall(r'<svg class="ks-moji ks-d\d".*?</svg>', g, re.S)
assert len(m) == 4 and fonts and defs
blue, sun, peach, lilac = m
dot = re.sub(r'<path d="M104 30q-4-16 8-20q12-2 10 10"[^>]*></path>', '', blue).replace('url(#ks-blue)', 'url(#ks-peri)').replace('ks-d1', 'ks-d2')
cast = [('Claude Code', sun), ('Codex', blue), ('Antigravity', peach), ('Grok', lilac), ('Dot', dot)]
agents = '<div class="marquee-group">' + ''.join(f'<span class="agent"><span>{svg}</span>{name}</span>' for name, svg in cast) + '</div>'
mark = '<svg viewBox="0 0 200 200" aria-hidden="true"><path d="M100 22C112 22 118 28 128 38L166 76C176 86 182 94 182 104S176 122 166 132L128 170C118 180 112 186 100 186S82 180 72 170L34 132C24 122 18 114 18 104S24 86 34 76L72 38C82 28 88 22 100 22Z" fill="#D4FF3A" stroke="#15111F" stroke-width="12"/><circle cx="76" cy="101" r="13" fill="#15111F"/><circle cx="124" cy="101" r="13" fill="#15111F"/></svg>'
rng = random.Random(7)  # fixed seed: the matrix pattern stays the same between builds
matrix = ''.join('<i class="on"></i>' if rng.random() < .45 else '<i></i>' for _ in range(48))
out = (t.replace('{{FONTS}}', fonts).replace('{{DEFS}}', defs).replace('{{AGENTS}}', agents)
        .replace('{{MATRIX}}', matrix).replace('{{MARK_JS}}', json.dumps(mark)).replace('{{MARK}}', mark))
assert '{{' not in out
(root / 'public/index.html').write_text(out)
print(len(out.encode()), 'bytes')
