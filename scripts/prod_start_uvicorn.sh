#!/bin/bash
# Production uvicorn for smarthole. Runs under systemd with
# WorkingDirectory=/home/ec2-user/smarthole. Single worker by design:
# the shared 1 GB box idles with ~160 MB free; concurrent workers would
# risk OOM during large .apkg/.colpkg imports.
"$(dirname "$0")/rebuild_client_if_stale.sh" "$(cd "$(dirname "$0")/.." && pwd)"
exec uv run python -m uvicorn smarthole.app:app --host 127.0.0.1 --port 8003
