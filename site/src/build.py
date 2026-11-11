# Builds public/index.html from src/index.template.html and public/favicon.svg from the brand mark.
# The brand mark is the "Hub" app icon (public/brand/swarmaa-mark.svg); it is inlined for {{MARK}} (nav and
# footer) as a decorative image and written out unchanged, minus its comment, as the favicon.
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
t = (root / 'src/index.template.html').read_text()
src = re.sub(r'<!--.*?-->', '', (root / 'public/brand/swarmaa-mark.svg').read_text(), flags=re.S).strip()
assert src.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
(root / 'public/favicon.svg').write_text(src + '\n')
mark = src.replace(' role="img" aria-label="Swarmaa"', ' aria-hidden="true"')
out = t.replace('{{MARK}}', mark)
assert '{{' not in out
(root / 'public/index.html').write_text(out)
print(len(out.encode()), 'bytes')
