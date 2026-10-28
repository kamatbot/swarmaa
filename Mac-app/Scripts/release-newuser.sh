#!/bin/bash
# Builds a notarized, self-contained Swarmaa.app (bundled Node + PostgreSQL + service) and zips it to
# ~/Desktop/Swarmaa-newuser.zip for installing on another Mac. Each stage is time-boxed and prints a
# "== stage" line so a stuck step is easy to spot.
#   SWARMA_DIR   service checkout to bundle (default ~/Projects/swarma)
set -euo pipefail
cd "$(dirname "$0")/.."
SWARMA_DIR=${SWARMA_DIR:-$HOME/Projects/swarma}
ID="Developer ID Application: Mayur Kamat (B4F73U5RGR)"
OUT=$HOME/Desktop/Swarmaa-newuser.zip
stamp() { echo "== $1 $(date +%H:%M:%S)"; }
# Apple's timestamp service drops requests now and then; retry before giving up.
sign() { for n in 1 2 3 4 5; do codesign --force --options runtime --timestamp --sign "$ID" "$@" >/dev/null 2>&1 && return 0; sleep $((n * 2)); done; echo "sign failed: ${*: -1}"; return 1; }

stamp "runtime: bundling $(git -C "$SWARMA_DIR" log --oneline -1)"
(cd "$SWARMA_DIR" && timeout 900 bash scripts/bundle.sh) | tail -3
export SWARMAA_RUNTIME_SRC=$SWARMA_DIR/build/runtime
[ -f "$SWARMAA_RUNTIME_SRC/RUNTIME_VERSION" ] || { echo "no runtime at $SWARMAA_RUNTIME_SRC"; exit 1; }
echo "runtime $(cat "$SWARMAA_RUNTIME_SRC/RUNTIME_VERSION")"

stamp "build: Release"
make gen >/dev/null 2>&1
SIGNFLAGS=$(grep -m1 "^DEV_SIGN" Makefile | sed 's/^DEV_SIGN *[:?]*= *//')
eval timeout 900 xcodebuild -project Codenotch.xcodeproj -scheme Codenotch -destination "'platform=macOS'" -configuration Release "$SIGNFLAGS" build 2>&1 | grep -E "BUILD (SUCCEEDED|FAILED)" || true
APP=$(xcodebuild -project Codenotch.xcodeproj -scheme Codenotch -configuration Release -showBuildSettings 2>/dev/null | awk -F' = ' '/ BUILT_PRODUCTS_DIR/ {print $2; exit}')/Swarmaa.app
[ -x "$APP/Contents/Resources/runtime/node" ] || { echo "build has no embedded runtime"; exit 1; }
W=$(mktemp -d); A=$W/Swarmaa.app; ditto "$APP" "$A"

stamp "sign: inside-out"
codesign -d --entitlements :- "$A" 2>/dev/null > "$W/ent.plist"
/usr/libexec/PlistBuddy -c "Delete :com.apple.security.get-task-allow" "$W/ent.plist" 2>/dev/null || true
{ find "$A/Contents" -type f \( -perm +111 -o -name "*.dylib" -o -name "*.so" -o -name "*.node" \) -exec sh -c 'file -b "$1" | grep -q Mach-O && echo "$1"' _ {} \;
  find "$A/Contents" -type d \( -name "*.xpc" -o -name "*.app" -o -name "*.framework" -o -name "*.bundle" \); } \
  | sort -u | awk '{print gsub("/","/"), $0}' | sort -rn | cut -d' ' -f2- > "$W/list"
echo "signing $(wc -l < "$W/list" | tr -d ' ') items"
fails=0
while read -r p; do
  if [ "$p" = "$A/Contents/Resources/runtime/node" ]; then sign --entitlements "$PWD/Scripts/node.entitlements" "$p" || fails=$((fails + 1))
  else sign "$p" || fails=$((fails + 1)); fi
done < "$W/list"
sign --entitlements "$W/ent.plist" "$A" || fails=$((fails + 1))
[ "$fails" = 0 ] || { echo "$fails items failed to sign"; exit 1; }
codesign --verify --deep --strict "$A" && echo "signature ok"
"$A/Contents/Resources/runtime/node" -e 'console.log("node runs after signing")'

stamp "notarize: upload and wait"
set -a; . ~/.appstoreconnect/asc.env; set +a
KEY=$(ls ~/.appstoreconnect/private_keys/AuthKey_*.p8 | head -1); KID=$(basename "$KEY" .p8 | sed 's/AuthKey_//')
ditto -c -k --keepParent "$A" "$W/submit.zip"
timeout 1800 xcrun notarytool submit "$W/submit.zip" --key "$KEY" --key-id "${ASC_KEY_ID:-$KID}" --issuer "$ASC_ISSUER_ID" --wait 2>&1 | grep -E "status:|  id:" | tail -2
xcrun stapler staple "$A" 2>&1 | tail -1
spctl -a -vv "$A" 2>&1 | head -2

stamp "zip"
rm -f "$OUT"; ditto -c -k --keepParent "$A" "$OUT"; ls -la "$OUT"
echo "app $(defaults read "$A/Contents/Info" CFBundleShortVersionString) · commit $(git log --oneline -1 | cut -c1-7) · runtime $(cat "$SWARMAA_RUNTIME_SRC/RUNTIME_VERSION")"
stamp done
