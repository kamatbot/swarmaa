#!/bin/bash
# Builds build/runtime/: a self-contained Swarmaa runtime (compiled service + prod node_modules + Node + PostgreSQL 17)
# for the macOS app to embed. darwin-arm64 only. Downloads are cached in build/cache and SHA-verified.
#   bash scripts/bundle.sh            (env: NODE_VERSION=24.21.0 PG_VERSION=17.11.0 to override)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=$ROOT/build/runtime CACHE=$ROOT/build/cache
NODE_VERSION=${NODE_VERSION:-$(node -p 'process.versions.node')}
PG_VERSION=${PG_VERSION:-17.11.0}
[ "$(uname -m)" = arm64 ] || { echo "darwin-arm64 only" >&2; exit 1; }
mkdir -p "$CACHE"

fetch() { # url dest
  [ -s "$2" ] || { echo "download $1"; curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }
}
sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }

# ---- Node (official tarball, checked against SHASUMS256.txt)
NODE_TGZ=node-v$NODE_VERSION-darwin-arm64.tar.gz
fetch "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TGZ" "$CACHE/$NODE_TGZ"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
want=$(awk -v f="$NODE_TGZ" '$2==f{print $1}' "$CACHE/SHASUMS256-$NODE_VERSION.txt")
[ -n "$want" ] && [ "$(sha256 "$CACHE/$NODE_TGZ")" = "$want" ] || { echo "Node SHA256 mismatch" >&2; rm -f "$CACHE/$NODE_TGZ"; exit 1; }

# ---- PostgreSQL (zonky embedded-postgres-binaries; .sha256 and .sha1 from Maven Central)
PG_BASE=https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-darwin-arm64v8/$PG_VERSION
PG_JAR=embedded-postgres-binaries-darwin-arm64v8-$PG_VERSION.jar
fetch "$PG_BASE/$PG_JAR" "$CACHE/$PG_JAR"
[ "$(sha256 "$CACHE/$PG_JAR")" = "$(curl -fsSL "$PG_BASE/$PG_JAR.sha256")" ] || { echo "PostgreSQL SHA256 mismatch" >&2; rm -f "$CACHE/$PG_JAR"; exit 1; }
[ "$(shasum -a 1 "$CACHE/$PG_JAR" | cut -d' ' -f1)" = "$(curl -fsSL "$PG_BASE/$PG_JAR.sha1")" ] || { echo "PostgreSQL SHA1 mismatch" >&2; exit 1; }

# ---- compiled service
rm -rf "$OUT" dist; mkdir -p "$OUT"
npm run -s build
rsync -a --exclude 'tests' --exclude '*.d.ts' --exclude '*.map' dist/ "$OUT/dist/"
mkdir -p "$OUT/db" "$OUT/scripts"
cp -R db/migrations "$OUT/db/"
cp -R clients "$OUT/clients"
# dist/src/capture imports ../../clients/hooks/*.mjs, which tsc does not emit; mirror it next to the compiled output.
mkdir -p "$OUT/dist/clients" && cp -R clients/hooks "$OUT/dist/clients/hooks"
cp scripts/onboarding.html "$OUT/scripts/"
cp package.json package-lock.json "$OUT/"
(cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$OUT/package-lock.json"

# ---- node binary (runtime/node)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar -xzf "$CACHE/$NODE_TGZ" -C "$TMP" "node-v$NODE_VERSION-darwin-arm64/bin/node"
cp "$TMP/node-v$NODE_VERSION-darwin-arm64/bin/node" "$OUT/node"

# ---- PostgreSQL (runtime/pg/{bin,lib,share})
unzip -q -o "$CACHE/$PG_JAR" '*.txz' -d "$TMP/pg"
mkdir -p "$OUT/pg"; tar -xJf "$TMP"/pg/*.txz -C "$OUT/pg"
[ -x "$OUT/pg/bin/initdb" ] && [ -x "$OUT/pg/bin/pg_ctl" ] && [ -x "$OUT/pg/bin/postgres" ] || { echo "PostgreSQL layout unexpected" >&2; exit 1; }

# The txz unpacks library symlinks as full copies (~170 MB of duplicates). Re-link identical files in lib/ to the longest-named one.
(cd "$OUT/pg/lib" && for f in $(ls -p | grep -v /); do [ -L "$f" ] || echo "$(shasum -a 256 "$f" | cut -d' ' -f1) ${#f} $f"; done | sort -k1,1 -k2,2nr |
  awk '{ if ($1==h) print "ln -sf " keep " " $3; else { h=$1; keep=$3 } }' | sh)

# The zonky binaries are universal (x86_64 + arm64); keep arm64 only (the original signatures are replaced when the app signs them anyway).
find "$OUT/pg" -type f | while read -r f; do
  if [ "$(lipo -archs "$f" 2>/dev/null)" = "x86_64 arm64" ]; then lipo -thin arm64 -output "$f.thin" "$f" && mv "$f.thin" "$f"; fi
done

# ---- version stamp: sortable build time + commit (the app copies a bundled runtime only when this is newer)
echo "$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)" > "$OUT/RUNTIME_VERSION"
echo "runtime: $OUT ($(cat "$OUT/RUNTIME_VERSION"), node $NODE_VERSION, postgres $PG_VERSION)"
du -sh "$OUT"; du -sh "$OUT"/* | sed 's|'"$OUT"'/|  |'
