#!/bin/bash
# Xcode pre-build phase: copies the Swarmaa runtime (compiled service + Node + PostgreSQL, built by the service repo's
# scripts/bundle.sh) into Swarmaa.app/Contents/Resources/runtime and code-signs every Mach-O in it.
#
#   SWARMAA_RUNTIME_SRC   directory containing the built runtime (default: <swarma-bundle checkout>/build/runtime, i.e.
#                         $SRCROOT/../../../../Projects/swarma-bundle/build/runtime for the current worktree layout)
#
# Without a runtime the build still succeeds (the app then offers only the other onboarding choices).
# Signing: the app's identity. The hardened runtime is requested only for Developer ID signing; with an ad-hoc or
# development identity the nested libraries would fail library validation (no common Team ID). Only `node` gets
# entitlements (Scripts/node.entitlements).
set -euo pipefail
SRC=${SWARMAA_RUNTIME_SRC:-$SRCROOT/../../../../Projects/swarma-bundle/build/runtime}
DEST=$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/runtime
if [ ! -f "$SRC/RUNTIME_VERSION" ]; then
  echo "warning: no Swarmaa runtime at $SRC (set SWARMAA_RUNTIME_SRC, run scripts/bundle.sh in the service repo); building without it"
  rm -rf "$DEST"; exit 0
fi
ID=${EXPANDED_CODE_SIGN_IDENTITY:-}; [ -n "$ID" ] || ID=-
NAME=${EXPANDED_CODE_SIGN_IDENTITY_NAME:-}
MARK="$(cat "$SRC/RUNTIME_VERSION") $ID"
if [ -f "$DEST/.embedded" ] && [ "$(cat "$DEST/.embedded")" = "$MARK" ]; then exit 0; fi
rm -rf "$DEST"; mkdir -p "$(dirname "$DEST")"
ditto "$SRC" "$DEST"   # keeps the dylib symlinks

OPTS=(--force --sign "$ID")
case "$NAME$ID" in *"Developer ID"*) OPTS+=(--options runtime --timestamp);; esac
# Notarization wants a secure timestamp (Release); Debug builds skip the network round trip.
[ "${CONFIGURATION:-}" = Release ] || OPTS=("${OPTS[@]/--timestamp/--timestamp=none}")
# Apple's timestamp service drops requests now and then; retry each file before failing the build.
sign() { for n in 1 2 3 4 5; do codesign "$@" && return 0; sleep $n; done; return 1; }
count=0
while IFS= read -r -d '' f; do
  case "$(file -b "$f")" in *Mach-O*)
    if [ "$(basename "$f")" = node ] && [ "$f" = "$DEST/node" ]; then
      sign "${OPTS[@]}" --entitlements "$SRCROOT/Scripts/node.entitlements" "$f"
    else
      sign "${OPTS[@]}" "$f"
    fi
    count=$((count+1));;
  esac
done < <(find "$DEST" -type f -print0)
echo "$MARK" > "$DEST/.embedded"
echo "embedded runtime $(cat "$SRC/RUNTIME_VERSION"): signed $count Mach-O files with ${NAME:-$ID}"
