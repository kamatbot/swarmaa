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
# The shawarma-wrap logo (public/brand/swarmaa-mark.svg). Inlined, its classes and keyframes get an sw- prefix so
# they can't clash with the page's own (.pop, @keyframes blink...). LOGO animates; MARK (chat avatars) and the favicon are still.
src = re.sub(r'<!--.*?-->', '', (root / 'public/brand/swarmaa-mark.svg').read_text(), flags=re.S)
src = re.sub(r'\s*\n\s*', '', src).replace(' role="img" aria-label="Swarmaa"', ' aria-hidden="true"')
logo = re.sub(r'\b(pop|bob|look|blink|eyes|a[123])\b', r'sw-\1', src).replace('*{animation:none', '[class^=sw-],.sw-eyes ellipse{animation:none')
mark = re.sub(r'<style>.*?</style>', '', src, flags=re.S)
mark = re.sub(r' class="[^"]*"', '', mark)
(root / 'public/favicon.svg').write_text(mark.replace(' aria-hidden="true"', ''))
rng = random.Random(7)  # fixed seed: the matrix pattern stays the same between builds
matrix = ''.join('<i class="on"></i>' if rng.random() < .45 else '<i></i>' for _ in range(48))
out = (t.replace('{{FONTS}}', fonts).replace('{{DEFS}}', defs).replace('{{AGENTS}}', agents)
        .replace('{{MATRIX}}', matrix).replace('{{MARK_JS}}', json.dumps(mark)).replace('{{LOGO}}', logo).replace('{{MARK}}', mark))
assert '{{' not in out
(root / 'public/index.html').write_text(out)
print(len(out.encode()), 'bytes')
