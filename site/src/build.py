# Builds public/index.html from src/index.template.html and public/favicon.svg from the brand mark.
# The shawarma-wrap logo (public/brand/swarmaa-mark.svg) is inlined still ({{MARK}}): its <style> and
# animation classes are dropped, so the nav and footer show the mark without motion.
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
t = (root / 'src/index.template.html').read_text()
src = re.sub(r'<!--.*?-->', '', (root / 'public/brand/swarmaa-mark.svg').read_text(), flags=re.S)
src = re.sub(r'\s*\n\s*', '', src).replace(' role="img" aria-label="Swarmaa"', ' aria-hidden="true"')
mark = re.sub(r' class="[^"]*"', '', re.sub(r'<style>.*?</style>', '', src, flags=re.S))
(root / 'public/favicon.svg').write_text(mark.replace(' aria-hidden="true"', ''))
out = t.replace('{{MARK}}', mark)
assert '{{' not in out
(root / 'public/index.html').write_text(out)
print(len(out.encode()), 'bytes')
