# Smarthole deployment runbook (Lightsail)

## Architecture

- **Host:** shared Lightsail instance (Amazon Linux, eu-west-1, 1 GB RAM /
  2 vCPU / 40 GB disk), also running Grimoire and Tracker. SSH:
  `ssh ec2-user@34.251.161.194 -i ~/.ssh/LightsailDefaultKey-eu-west-1.pem`
- **DNS:** `smarthole.cathalanddad.com` is a Route53 A record (TTL 300) at the
  instance's static IP. DNS for this domain is in Route53, not Lightsail DNS.
- **TLS:** certbot `--nginx` on the server; certs in
  `/etc/letsencrypt/live/smarthole.cathalanddad.com/`, auto-renewed.
- **Frontend:** `smarthole-client/dist` built locally and rsynced to
  `/home/ec2-user/smarthole/smarthole-client/dist/`, served by the backend
  itself at `/` (same-origin `/api`). No S3/CloudFront. Nginx is a plain
  reverse proxy, like Grimoire's `api.conf`.
- **Backend:** uvicorn on `127.0.0.1:8003` (single worker), systemd unit
  `smarthole`, nginx reverse-proxy for everything.
- **Storage:** MongoDB Atlas only, database `smarthole_prod` (same cluster
  as Grimoire, separate database).
- **Secrets:** `/home/ec2-user/smarthole/.env` on the server (`0600`), never
  in the repo, never overwritten by deploys.

## Port / file ownership (shared box)

| Owner    | Loopback ports | nginx conf                  | systemd unit | Remote dir              |
|----------|----------------|-----------------------------|--------------|-------------------------|
| Grimoire | 8000, 8001     | `/etc/nginx/conf.d/api.conf`      | `fastapi`  | `/home/ec2-user/app`      |
| Tracker  | 8002           | `/etc/nginx/conf.d/tracker.conf`  | `tracker`  | `/home/ec2-user/tracker`  |
| Smarthole| 8003           | `/etc/nginx/conf.d/smarthole.conf`| `smarthole`| `/home/ec2-user/smarthole`|

Never take another row's port or edit its conf/unit. nginx reloads affect
all apps: every deploy healthchecks Grimoire and Tracker too.

## One-time setup (in order)

1. DNS: `A smarthole.cathalanddad.com 300 -> 34.251.161.194` in the Route53
   zone (done 2026-11-07 via `aws route53 change-resource-record-sets`).
   Verify: `aws route53 list-resource-record-sets --hosted-zone-id
   Z102462912W4NHCQ089PL` shows the record, and public DNS resolves it.
2. Atlas: database `smarthole_prod`, a user with `readWrite` on
   `smarthole_prod`, and the Lightsail static IP in Network Access. Same
   cluster/user pattern as Grimoire (`myAtlasDBUser`); see tracker's
   `docs/mongo.md` for the field-level checklist.
3. Production env: keep the values in repo-root `.env.prod` (git-ignored,
   never committed, content never in chat). The deploy script copies it to
   `/home/ec2-user/smarthole/.env` (`0600`) on every run. Required keys:
   `ENV=prod`, `MONGO_PWD` (Atlas password), `GOOGLE_CLIENT_ID` (add
   `https://smarthole.cathalanddad.com` to its authorized origins in the
   Google Cloud console for production sign-in).
4. First deploy: `bash scripts/deploy_lightsail.sh` from the repo root.
5. First TLS: on the server,
   `sudo certbot --nginx -d smarthole.cathalanddad.com`, then reload and
   verify `https://smarthole.cathalanddad.com/api/config`.
6. Commit-back (required): copy the server's certbot-modified
   `/etc/nginx/conf.d/smarthole.conf` over `deploy/smarthole.conf` and
   commit. The deploy script refuses to overwrite a TLS-enabled live conf
   with a non-TLS repo conf.

## Deploying

Deploys run from GitHub Actions (`.github/workflows/deploy.yml`): every push
to `master` — or a manual **Run workflow** dispatch — runs the gates and then
`scripts/deploy_lightsail.sh` on the runner. Required repository secrets:

- `LIGHTSAIL_SSH_KEY` — contents of `~/.ssh/LightsailDefaultKey-eu-west-1.pem`
- `PROD_ENV_FILE` — contents of `.env.prod` (production env for the server)

The workflow writes both secrets to the paths the script already expects
(the key to `~/.ssh/LightsailDefaultKey-eu-west-1.pem`, the env to
`.env.prod`) and adds the server's host key, so the script itself is
unchanged. Local fallback still works:

```bash
bash scripts/deploy_lightsail.sh   # from the repo root
```

The script runs `uv lock --check`, the backend test suite, and the frontend
build locally (any failure aborts); rsyncs backend + built `dist` +
manifests + deploy files, ships `.env.prod` as the server `.env`
(renamed on arrival); then on the server runs
`uv sync --locked`, installs the nginx conf with validate-before-reload and
automatic restore, restarts the `smarthole` service, and healthchecks
smarthole (`:8003/api/config`) plus Grimoire (`:8000/healthcheck`) and
tracker (`:8002/health`) over loopback.

Post-deploy smoke from your laptop:

```bash
curl -s https://smarthole.cathalanddad.com/api/config
curl -sI http://smarthole.cathalanddad.com/ | head -1   # 301 to https
curl -s https://api.cathalanddad.com/healthcheck       # Grimoire alive
curl -s https://tracker.cathalanddad.com/health        # Tracker alive
```

Then sign in once in the browser (email + Google) and import a small deck.

## Ops

- Logs: `journalctl -u smarthole -e` (app), `/var/log/nginx/` (access/error).
- Restart: `sudo systemctl restart smarthole`; enable-on-boot is on
  (`WantedBy=multi-user.target`), as is nginx. Re-verify all three
  healthchecks after any reboot.
- Memory: the box idles with ~160 MB free and no swap. Keep imports modest;
  if OOMs appear, the fix is a bigger Lightsail plan or a swapfile,
  not code tuning.
- Backups: app data lives in Atlas (use Atlas backups/retention). The
  `smarthole-client/dist` on the server is disposable; rebuild with a
  deploy. The server `.env` has no backup — keep its values in a password
  manager.
- Cost: no new AWS resources beyond the existing instance; re-check the
  Lightsail plan size and Atlas tier in the consoles if usage grows.

## Rollback

- Bad deploy: `git checkout <last-good> -- src smarthole-client deploy
  scripts` (or `git revert`), re-run the deploy script. The nginx
  auto-restore covers conf-only failures without a redeploy.
- No data migrations run on deploy, so there is no data rollback step;
  documents written after a bad deploy stay valid across versions.

## Troubleshooting

- `502` from nginx: `journalctl -u smarthole -e` (usually missing/bad
  server `.env`, or Atlas unreachable — check the IP allowlist and that
  the app user has `readWrite` on `smarthole_prod`).
- `/api/config` returns 500 with "Database not connected": Atlas
  credentials or Network Access — same failure shape as local dev without
  `MONGO_PWD`.
- `413` on import: `client_max_body_size` in `deploy/smarthole.conf`.
- `https://` stops working after a deploy: the commit-back step was missed
  and TLS was overwritten — re-run certbot, then commit the live conf back.
- Grimoire/tracker `502`s after a smarthole deploy: their services/confs
  were untouched by design — check `systemctl status fastapi tracker`
  and `sudo nginx -t`; restore their confs from their repo copies if needed.
- Google sign-in fails in production only: the production origin is not in
  the OAuth client's authorized origins (Google Cloud console).
