#!/bin/bash
# Rebuild the React client bundle when its sources are newer than dist.
# Usage: rebuild_client_if_stale.sh <repo-root>
# Never fails: warns and exits 0 so the server still starts.
set -u

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
CLIENT_DIR="$ROOT/smarthole-client"
DIST="$CLIENT_DIR/dist/index.html"

needs_build=0
if [ ! -f "$DIST" ]; then
  needs_build=1
elif [ -n "$(find "$CLIENT_DIR/src" "$CLIENT_DIR/package.json" "$CLIENT_DIR/vite.config.ts" -newer "$DIST" -print 2>/dev/null)" ]; then
  needs_build=1
fi

if [ "$needs_build" -eq 0 ]; then
  echo "Client bundle is up to date."
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "WARNING: npm not found; serving existing client bundle." >&2
  exit 0
fi

echo "Client sources are newer than the bundle; rebuilding…"
if (cd "$CLIENT_DIR" && npm run build); then
  echo "Client bundle rebuilt."
else
  echo "WARNING: client build failed; serving existing bundle." >&2
fi
exit 0
