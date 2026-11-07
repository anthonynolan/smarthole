set -x
export MONGO_DB_NAME="${MONGO_DB_NAME:-smarthole_dev}"
uv run python -m uvicorn smarthole.app:app \
--reload \
--host 0.0.0.0 \
--port 8123
