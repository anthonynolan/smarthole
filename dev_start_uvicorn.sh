#!/bin/bash
set -x
ROOT="$(cd "$(dirname "$0")" && pwd)"
export MONGO_DB_NAME="${MONGO_DB_NAME:-smarthole_dev}"
"$ROOT/scripts/rebuild_client_if_stale.sh" "$ROOT"
uv run python -m uvicorn smarthole.app:app \
--reload \
--host 0.0.0.0 \
--port 8123
