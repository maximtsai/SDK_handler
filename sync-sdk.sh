#!/usr/bin/env bash
#
# Copy the bridge into a game.
#
#   ./sync-sdk.sh <dest-js-dir> <platform>
#   ./sync-sdk.sh ../../mergeamansion/js crazygames
#
# Copies sdk-core.js plus EXACTLY ONE adapter. Shipping two in a build breaks
# YouTube certification (it greps the bundle as text) — so this refuses to leave
# a stale second adapter behind, and says so loudly if it finds one.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-}"
PLATFORM="${2:-}"

if [ -z "$DEST" ] || [ -z "$PLATFORM" ]; then
  echo "usage: ./sync-sdk.sh <dest-js-dir> <crazygames|youtube|yandex>" >&2
  exit 1
fi

ADAPTER="$SRC/platform-$PLATFORM.js"

if [ ! -f "$ADAPTER" ]; then
  echo "error: no adapter for '$PLATFORM' (looked for $ADAPTER)" >&2
  echo "available:" >&2
  ls "$SRC"/platform-*.js 2>/dev/null | sed 's|.*/platform-|  |; s|\.js$||' >&2
  exit 1
fi

if [ ! -d "$DEST" ]; then
  echo "error: destination '$DEST' is not a directory" >&2
  exit 1
fi

# Any adapter already there for a DIFFERENT platform has to go, or the build
# ends up with two.
for existing in "$DEST"/platform-*.js; do
  [ -e "$existing" ] || continue
  if [ "$(basename "$existing")" != "platform-$PLATFORM.js" ]; then
    echo "removing stale adapter: $(basename "$existing")"
    rm "$existing"
  fi
done

cp "$SRC/sdk-core.js" "$DEST/"
cp "$ADAPTER" "$DEST/"

VERSION=$(grep -m1 "const VERSION" "$SRC/sdk-core.js" | sed "s/.*'\(.*\)'.*/\1/")
echo "synced GameSDK v$VERSION ($PLATFORM) → $DEST"
echo
echo "index.html should load:"
if [ "$PLATFORM" = "youtube" ]; then
  # The only platform needing a vendor tag: it must be parser-blocking and sit
  # above core. CrazyGames and Yandex adapters load their own SDK.
  echo '  <script src="https://www.youtube.com/game_api/v1"></script>'
fi
echo '  <script src="js/sdk-core.js"></script>'
echo "  <script src=\"js/platform-$PLATFORM.js\"></script>"
