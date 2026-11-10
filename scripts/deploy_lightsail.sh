#!/bin/bash
set -euo pipefail
# Deploy smarthole to the shared Lightsail instance. Run from the repo root:
#   bash scripts/deploy_lightsail.sh
# Local gates, rsync code (never .env), validate/reload nginx with
# restore, restart the systemd service, then loopback healthchecks for
# smarthole AND Grimoire.
#
# First-deploy order: DNS (done: A smarthole.cathalanddad.com -> static IP)
# -> Atlas smarthole_prod access for the app user (docs/deploy.md)
# -> this script (ships .env.prod as the server .env) ->
# `sudo certbot --nginx -d smarthole.cathalanddad.com` on the server ->
# copy the server's /etc/nginx/conf.d/smarthole.conf back to
# deploy/smarthole.conf and commit, so redeploys keep TLS.

DEPLOY_USER=ec2-user
DEPLOY_HOST=34.251.161.194
REMOTE_DIR=/home/ec2-user/smarthole
SSH_KEY_PATH="$HOME/.ssh/LightsailDefaultKey-eu-west-1.pem"
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=yes -i $SSH_KEY_PATH"

test -f pyproject.toml || { echo "run from the smarthole repo root" >&2; exit 1; }
test -f .env.prod || { echo "missing .env.prod (production env source)" >&2; exit 1; }

echo "==> local gates: lockfile, tests, frontend build"
uv lock --check
uv run --group test pytest -q
(cd smarthole-client && npm ci && npm run build)

echo "==> rsync backend + manifests + deploy files"
rsync -avz -e "ssh $SSH_OPTS" \
    --exclude='__pycache__/' --exclude='*.pyc' \
    --exclude='.venv/' --exclude='node_modules/' \
    --exclude='.env*' \
    --exclude='tests/' \
    --exclude='smarthole-client/node_modules/' \
    --exclude='smarthole-client/src/' --exclude='smarthole-client/tests/' \
    --include='src/***' \
    --include='smarthole-client/dist/***' \
    --include='pyproject.toml' \
    --include='uv.lock' \
    --include='README.md' \
    --include='scripts/prod_start_uvicorn.sh' \
    --include='deploy/smarthole.conf' \
    --include='deploy/smarthole.service' \
    --include='scripts/' --include='deploy/' \
    --include='src/' --include='smarthole-client/' --include='smarthole-client/dist/' \
    --exclude='*' \
    ./ "$DEPLOY_USER@$DEPLOY_HOST:$REMOTE_DIR/"

echo "==> install production .env from .env.prod (renamed on arrival)"
scp $SSH_OPTS .env.prod "$DEPLOY_USER@$DEPLOY_HOST:$REMOTE_DIR/.env"

echo "==> remote: install deps, nginx, service, healthchecks"
ssh -T $SSH_OPTS "$DEPLOY_USER@$DEPLOY_HOST" 'bash -s' <<'EOF'
set -euo pipefail
cd /home/ec2-user/smarthole

export PATH="/home/ec2-user/.local/bin:$PATH"
chmod 600 .env
test -s .env || { echo "Missing production .env in /home/ec2-user/smarthole" >&2; exit 1; }
uv sync --locked --no-default-groups

NGINX_CONFIG=/etc/nginx/conf.d/smarthole.conf
NGINX_BACKUP=$(mktemp)
NGINX_CONFIG_EXISTED=0
trap 'rm -f "$NGINX_BACKUP"' EXIT

if sudo test -f "$NGINX_CONFIG"; then
    sudo cp "$NGINX_CONFIG" "$NGINX_BACKUP"
    NGINX_CONFIG_EXISTED=1
fi

# Never wipe certbot TLS: if the live conf has it, the shipped one must too.
if sudo grep -q "managed by Certbot" "$NGINX_CONFIG" 2>/dev/null \
    && ! grep -q "managed by Certbot" deploy/smarthole.conf; then
    echo "Server nginx conf has certbot TLS but deploy/smarthole.conf does not;" >&2
    echo "copy the server conf back into the repo first (docs/deploy.md)." >&2
    exit 1
fi

restore_nginx_config() {
    if [ "$NGINX_CONFIG_EXISTED" -eq 1 ]; then
        sudo cp "$NGINX_BACKUP" "$NGINX_CONFIG"
    else
        sudo rm -f "$NGINX_CONFIG"
    fi
}

sudo install -m 0644 deploy/smarthole.conf "$NGINX_CONFIG"
if ! sudo nginx -t; then
    restore_nginx_config
    echo "Nginx validation failed; restored previous config." >&2
    exit 1
fi
if ! sudo systemctl reload nginx; then
    restore_nginx_config
    sudo nginx -t
    sudo systemctl reload nginx
    echo "Nginx reload failed; restored and reloaded previous config." >&2
    exit 1
fi

chmod +x scripts/prod_start_uvicorn.sh
sudo install -m 0644 deploy/smarthole.service /etc/systemd/system/smarthole.service
sudo systemctl daemon-reload
sudo systemctl enable smarthole
sudo systemctl restart smarthole
sudo systemctl status smarthole --no-pager
# /api/config is unauthenticated and passes through the DB-connection
# middleware, so it proves both the app and Atlas reachability.
curl --fail --silent --show-error --retry 12 --retry-delay 5 --retry-connrefused \
    --connect-timeout 5 --max-time 10 http://127.0.0.1:8003/api/config
sudo systemctl is-active --quiet smarthole

# Shared box: prove Grimoire survived the nginx reload + deploy.
curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:8000/healthcheck
echo "smarthole + grimoire healthchecks passed"
EOF
