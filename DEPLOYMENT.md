# Arvoo Deployment Guide (Ubuntu 24.04 LTS)

Production deployment, operations and troubleshooting for the Arvoo control
plane. Everything here is automated by [`install.sh`](install.sh); the manual
commands are documented so you can verify, repair or reproduce any step.

* Target OS: **Ubuntu 24.04 LTS** (Debian 12 is close enough; older releases warn)
* Architecture: amd64 or arm64
* Needs root (the installer runs the package manager, systemd and PostgreSQL)
* Requires ~2 GB free disk, ~1 GB RAM and outbound HTTPS for packages

---

## 1. What the installer creates

| Item | Path / value |
| --- | --- |
| Application checkout | `/opt/arvoo` (owned by `arvoo:arvoo`) |
| Application user | `arvoo` (system user, no login shell) |
| Secrets + configuration | `/etc/arvoo.env` (mode `0640 root:arvoo`) |
| Backend service | `/etc/systemd/system/arvoo.service` → `127.0.0.1:4001` |
| Node agent service | `/etc/systemd/system/arvoo-agent.service` (installed, **not** enabled) |
| Nginx site | `/etc/nginx/sites-available/arvoo` (+ `/etc/nginx/snippets/arvoo-common.conf`) |
| PostgreSQL | database `arvoo`, role `arvoo_user`, loopback only |
| Migrations | `apps/api/src/migrations`, applied by the app |
| Backups | `/var/backups/arvoo` + `/etc/cron.d/arvoo-backup` (02:30, retention 14) |
| Node integration | `/etc/arvoo`, `/var/lib/arvoo` (mode 0700), `/etc/sysctl.d/99-arvoo.conf` |

Everything is idempotent: re-running `./install.sh` repairs an existing install
and never regenerates secrets that already exist.

## 2. Install

```bash
# On the server
sudo apt-get update && sudo apt-get install -y git
sudo git clone <your-repo-url> /opt/arvoo
cd /opt/arvoo
sudo ./install.sh
```

With HTTPS (DNS for the domain must already point at this host, and ports 80/443
must be reachable from the internet):

```bash
sudo ARVOO_DOMAIN=panel.example.com ARVOO_EMAIL=ops@example.com ./install.sh
```

The script prints a stage-by-stage log and finishes with a report:

```text
========================================
        ARVOO INSTALLATION COMPLETE
========================================

Application : OK
PostgreSQL  : OK
Migrations  : OK
Backend     : OK
Frontend    : OK
Nginx       : OK
...
Backend     : 127.0.0.1:4001 (loopback only)
Web         : http://SERVER_IP

Services:
  arvoo.service      active
  nginx.service      active
  postgresql.service active
```

If a stage fails, the script names the exact stage and stops; nothing after it
runs. Fix the cause and re-run — it resumes safely.

### Upgrading an existing SQLite-based checkout

There is nothing to migrate: the panel is PostgreSQL-native. Point
`DATABASE_URL` at a PostgreSQL server, run `sudo ./install.sh`, and the schema is
created by the migrations. Old SQLite files under `apps/*/data` are unused
artifacts and can be deleted once you no longer need them.

## 3. PostgreSQL

The installer provisions a dedicated cluster-role and database — it never uses
the `postgres` superuser for the application and never creates tables by hand.

What it does (idempotent, safe to re-run):

```sql
-- as the postgres superuser, via `su - postgres -c psql` (statements on stdin)
CREATE ROLE arvoo_user WITH LOGIN PASSWORD '<generated>';
CREATE DATABASE arvoo OWNER arvoo_user;
ALTER DATABASE arvoo OWNER TO arvoo_user;
REVOKE ALL ON DATABASE arvoo FROM PUBLIC;
GRANT CONNECT ON DATABASE arvoo TO arvoo_user;
GRANT ALL ON SCHEMA public TO arvoo_user;
```

and writes `DATABASE_URL` into `/etc/arvoo.env`:

```env
DATABASE_URL=postgresql://arvoo_user:STRONG_PASSWORD@127.0.0.1:5432/arvoo
```

It then **verifies the credentials over TCP** (password passed via
`PGPASSWORD`, never on a command line) and only rotates the password when the
stored connection string cannot authenticate — for example when
`/etc/arvoo.env` was deleted. It also pins `listen_addresses = '127.0.0.1'` so
the database port is unreachable from outside the host.

Manual equivalent if you prefer your own database (managed PostgreSQL, another
host, …): create the role/database yourself and edit `DATABASE_URL`, then run
`sudo ./install.sh` — the installer detects a non-loopback host and leaves your
credentials untouched.

Connection pooling is configured in `apps/api/src/db/index.ts`: `ARVOO_POOL_MAX`
(default 10), 30 s idle timeout, 10 s connect timeout, 30 s statement timeout,
UTC sessions and an idle-client error handler so a database restart cannot take
the API down.

## 4. Environment configuration

All secrets and machine-local configuration live in `/etc/arvoo.env`
(production) or `.env` (development). Nothing is hardcoded in the repository;
`.env.example` documents every variable.

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_ENV` | yes | `production` enables fail-fast secret validation |
| `DATABASE_URL` | yes | `postgresql://arvoo_user:…@127.0.0.1:5432/arvoo` |
| `ARVOO_APP_SECRET` | yes | AES-256-GCM key for stored secrets **and** session/JWT signing |
| `ARVOO_ADMIN_USER` / `ARVOO_ADMIN_PASSWORD` | yes (first boot) | Bootstrap admin; ignored once an admin exists |
| `HOST` / `PORT` | yes | `127.0.0.1` / `4001` — never expose `PORT` publicly |
| `ARVOO_POOL_MAX` | no | PostgreSQL pool size (default 10) |
| `ARVOO_MIGRATIONS_DIR` | no | Override the migrations directory |
| `ARVOO_CORS_ORIGINS` | no | Only needed if the UI is served from another origin |
| `ARVOO_CONTROL_PLANE_URL` | nodes | URL agents use to reach this panel |
| `ARVOO_JWT_TTL_SEC` | no | Session lifetime in seconds (default 12 h) |
| `ARVOO_HEARTBEAT_OFFLINE_SEC` | no | Heartbeat gap before a node is marked offline (default 90) |
| `ARVOO_HEALTH_RETENTION_DAYS` | no | Health-sample retention (default 14) |
| `ARVOO_LOG_LEVEL` | no | `error` \| `warn` \| `info` \| `debug` |
| `ARVOO_BACKUP_KEEP` | no | Number of dumps kept by the backup job (default 14) |

Rules the installer enforces:

* `HOST` is forced to `127.0.0.1` (a warning is printed if you changed it).
* File mode is `0640 root:arvoo`; only root writes it, only the service reads it.
* Existing secrets are never regenerated; operator tuning is never overwritten.

After editing the file, restart the backend:

```bash
sudo systemctl restart arvoo && sudo ./install.sh --status
```

Generate a secret if you need one by hand: `openssl rand -hex 32`.

## 5. Migrations

Migrations are versioned SQL files in `apps/api/src/migrations`, applied exactly
once, in filename order, each in its own transaction, under a PostgreSQL
advisory lock (so two processes starting at the same time cannot race). The
`_migrations` table records what has been applied.

```bash
cd /opt/arvoo
sudo -u arvoo npm run db:migrate                     # apply everything pending
sudo -u arvoo npm run db:migrate -- --status         # list applied/pending + reversibility
sudo -u arvoo npm run db:migrate -- --down 1 --force # revert the newest migration
```

* The API also applies pending migrations at startup, so a deploy never serves
  traffic against an old schema.
* Re-running an upgrade is a no-op (`[db] schema is up to date`).
* `--down` requires `--force` and a matching `NNNN_name.down.sql`; a migration
  without a reverse file is refused rather than guessed at. Take a backup first
  (`sudo ./install.sh --backup`) — a downgrade can drop tables and rows.

Adding a migration: create `NNNN_description.sql` (and `.down.sql` if it must be
reversible), keep each file self-contained and idempotent where practical
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), then
`sudo ./install.sh --update`.

## 6. Services (systemd)

```bash
sudo systemctl status arvoo            # backend (Fastify + PostgreSQL)
sudo systemctl status nginx            # web server / reverse proxy
sudo systemctl status postgresql       # database

sudo systemctl restart arvoo           # restart the backend
sudo systemctl reload nginx            # reload the web server configuration
sudo ./install.sh --restart            # both, followed by a health check
```

`arvoo.service` in short:

* `User=arvoo` / `Group=arvoo`, `WorkingDirectory=/opt/arvoo`
* `EnvironmentFile=/etc/arvoo.env`
* `ExecStart=/usr/bin/node /opt/arvoo/apps/api/dist/index.js`
* `Restart=always`, `RestartSec=5`, `TimeoutStopSec=30`
* `After=/Wants=network-online.target`, `Requires=postgresql.service`
* `StartLimitIntervalSec=300` + `StartLimitBurst=30` so a slow boot does not
  permanently give up on the service
* Hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  `PrivateTmp`, `PrivateDevices`, `ProtectKernel*=`, `RestrictNamespaces`,
  `RestrictAddressFamilies`, `RestrictSUIDSGID`, `LockPersonality`, `UMask=0027`
  — the API writes nothing to disk, so no `ReadWritePaths` exception is needed

Change the unit only in `deploy/arvoo.service`, then apply it with
`sudo ./install.sh` (or `--update`), which reinstalls and reloads the units.
Validate a unit before/after installing:

```bash
systemd-analyze verify /etc/systemd/system/arvoo.service
```

## 7. Nginx

```bash
sudo nginx -t                          # validate the configuration
sudo systemctl reload nginx            # apply changes
```

The vhost (`/etc/nginx/sites-available/arvoo`) and the shared snippet
(`/etc/nginx/snippets/arvoo-common.conf`) do the following:

* serve `/opt/arvoo/apps/web/dist` with SPA fallback (`try_files … /index.html`),
  30-day immutable caching for hashed assets
* reverse-proxy `/api/` to `http://arvoo_api` (`127.0.0.1:4001`, keepalive 32)
  with `X-Real-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`
* expose `GET /health` (used by `install.sh` and uptime monitors)
* set `client_max_body_size 8m` (the API accepts 4 MB JSON) and 10 s/60 s
  proxy timeouts
* add security headers (HSTS on HTTPS, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`),
  `server_tokens off` and gzip for text/JSON/SVG/fonts
* keep `/api/` and `/health` access-logged; static assets are not

The backend port is never published — verify with:

```bash
sudo ss -ltnp | grep -E ':(80|443|4001|5432) '
# 4001 and 5432 must show 127.0.0.1 only
```

If the firewall (`ufw`) is already active, the installer allows "Nginx Full"
and OpenSSH; it never enables a firewall or opens the database/backend ports.

## 8. HTTPS

```bash
sudo ARVOO_DOMAIN=panel.example.com ARVOO_EMAIL=ops@example.com ./install.sh
```

The installer requests a certificate with certbot's nginx plugin, writes an
HTTPS vhost with `TLSv1.2/TLSv1.3`, HTTP→HTTPS redirect and HSTS, enables
`certbot.timer` for automatic renewal, and keeps `/.well-known/acme-challenge/`
working.

* No domain yet? The install is still complete and serves plain HTTP. Add the
  domain later by re-running the command above.
* Certificate renewal is handled by the systemd timer; check with
  `systemctl list-timers | grep certbot` and `sudo certbot renew --dry-run`.
* Without a certificate, treat the panel as an internal tool: keep it behind a
  firewall or a VPN instead of exposing port 80 to the internet.

## 9. Backups

```bash
sudo ./install.sh --backup          # or: sudo scripts/backup.sh
```

* `pg_dump` (custom-free plain SQL, gzip -6, no owner/privileges) to
  `/var/backups/arvoo/arvoo-YYYYMMDD-HHMMSS.sql.gz`, mode 0640 — outside the
  PostgreSQL data directory.
* The connection string is read from `/etc/arvoo.env` and passed via the
  environment (`DATABASE_URL`), so the password never appears in the process
  list. Credentials are never printed.
* Retention keeps the newest `ARVOO_BACKUP_KEEP` (default 14) dumps.
* Cron entry: `/etc/cron.d/arvoo-backup`, daily at 02:30 as root, appending to
  `/var/log/arvoo-backup.log`.

Restore into a fresh database:

```bash
sudo systemctl stop arvoo
sudo -u postgres createdb -O arvoo_user arvoo_restore
sudo -u postgres psql -d arvoo_restore -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c /var/backups/arvoo/arvoo-<timestamp>.sql.gz | \
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d arvoo_restore
# then point DATABASE_URL at arvoo_restore (or rename the databases) and
sudo systemctl start arvoo && sudo ./install.sh --status
```

Copy backups off the host (`rsync`/object storage) — a dump on the same disk
does not survive a disk failure. Test a restore regularly.

## 10. Updates

```bash
cd /opt/arvoo
sudo ./install.sh --update
```

The workflow is ordered so a failure cannot silently serve a broken panel:

```text
record current revision
      ↓  git fetch + fast-forward merge (only if the checkout is a git repo)
install dependencies (npm ci) + build (api, agent, web)
      ↓  fail here → services keep running the previous build
run pending database migrations
      ↓  fail here → migrations run in a transaction, so the schema is unchanged
reinstall units + Nginx config, restart the backend
      ↓  health check (status:ok + database:ok)
   success → done
   failure → automatically roll the code back to the recorded revision,
             rebuild, restart and health-check again, then exit 1 and tell you
             that the schema was NOT reverted (migrations are forward-only)
```

Disable the automatic rollback with `ARVOO_AUTO_ROLLBACK=0` if you prefer to
inspect the new revision first; recover manually with:

```bash
sudo git -C /opt/arvoo reset --hard <previous-revision>
sudo ./install.sh --restart
```

Build/migration failures happen **before** the restart, so a broken build leaves
the old revision serving traffic. The database is never left half-migrated: each
migration file runs inside a transaction and only successful files are recorded.

## 11. Node agent (OpenVPN / GRE nodes)

The panel drives nodes through `apps/agent`. Prerequisites on a node host
(installed automatically on the panel host by `install.sh`): `openvpn`,
`iptables`, `iproute2`, systemd, and the application checkout with a built agent.

```bash
# 1. In the panel: Nodes → create node → copy the enrollment token (10 min, single use)
# 2. On the node:
sudo /opt/arvoo/apps/agent/dist/index.js enroll <token>   # writes /var/lib/arvoo/agent-state.json
# 3. In the panel: Nodes → Approve
sudo systemctl enable --now arvoo-agent
```

* `arvoo-agent.service` runs as root because `systemctl`, `/proc/sys` writes and
  `iptables` genuinely require it — this is the documented exception to the
  "no root" rule. It is a separate unit with its own sandbox: read-only
  filesystem except `/etc/arvoo`, `/etc/systemd/system`, `/var/lib/arvoo` and
  `/run`; no home directories; private `/tmp`.
* The agent executes commands with `execFile` and an argv array, never a shell
  string, so nothing from the panel can be injected into a command line.
* Every privileged payload is re-validated on the node (names, ports, IPs, CIDRs,
  MTU, payload sizes) before it reaches a path, a unit name or an argument. Path
  traversal in an inbound or interface name is rejected.
* IPv4 forwarding is enabled persistently by the installer
  (`/etc/sysctl.d/99-arvoo.conf`), so it survives a reboot; the agent only reads
  the value and tries to set it as a fallback.
* Deployments are verified on the node: the service must become `active` **and**
  the port must actually be listening (checked per protocol, TCP or UDP).
* The agent is intentionally not allowed to run a package manager: if OpenVPN is
  missing it reports an actionable error instead of installing it inside the
  sandbox. Install it on the node with `apt-get install -y openvpn`.

Node connectivity: the agent needs outbound HTTPS to
`ARVOO_CONTROL_PLANE_URL` (default: the panel's public URL) and the control
plane keeps no inbound connection to nodes.

## 12. Logs

```bash
sudo journalctl -u arvoo -f              # backend (application logs, errors)
sudo journalctl -u arvoo -n 200 --no-pager
sudo journalctl -u arvoo-agent -f        # node agent (on a node)
sudo journalctl -u nginx -n 100          # web server
sudo tail -f /var/log/nginx/access.log   # API requests
sudo tail -f /var/log/nginx/error.log    # proxy/static errors
sudo journalctl -u postgresql -n 100     # database
sudo tail -f /var/log/arvoo-backup.log   # nightly backups
```

Application logs never contain passwords, tokens or private keys: secrets live
only in `/etc/arvoo.env` and encrypted values are never logged. `LOG_LEVEL`
controls verbosity (`info` in production); journald rotation is configured by
`/etc/systemd/journald.conf`.

Useful one-liners:

```bash
sudo journalctl -u arvoo --since "1 hour ago" -p err      # recent errors only
sudo journalctl -u arvoo -o cat | grep '\[db\]'            # migration output
```

## 13. Verification checklist

Run this after every install or update:

```bash
sudo ./install.sh --check                 # prerequisites
sudo ./install.sh --status                # services + health + listeners + DB
curl -fsS http://127.0.0.1:4001/health    # {"status":"ok","database":"ok",...}
curl -fsS http://127.0.0.1:4001/api/v1/health
systemctl status arvoo nginx postgresql   # three active services
sudo ss -ltnp | grep -E ':(4001|5432) '   # loopback only
```

Then in the browser (through Nginx, not the backend port):

1. `http://SERVER_IP` (or your domain) loads the login page
2. Sign in with the admin credentials from the install report
3. Dashboard shows live data (no placeholder/fake telemetry)
4. Create a node → approve its agent → node becomes online after the first heartbeat
5. Create an inbound (OpenVPN) → deploy → status reflects what the node confirmed
6. Create a GRE tunnel between two approved nodes → deploy → verify latency/loss
7. Create a client → download its `.ovpn` profile → connect
8. `Audit` shows each action; `Operations` shows the queue and results

## 14. Troubleshooting

| Symptom | Diagnosis | Fix |
| --- | --- | --- |
| Installer stops at a stage | The failing stage is named, with the reason | Fix the cause and re-run `sudo ./install.sh` (idempotent) |
| `nginx` returns 502 | Backend down or unhealthy | `sudo journalctl -u arvoo -n 100`; `curl 127.0.0.1:4001/health`; `sudo ./install.sh --restart` |
| `/health` returns 503 | Database unreachable (`database:"error"`) | `sudo systemctl status postgresql`; check `DATABASE_URL`; re-run `sudo ./install.sh` to repair credentials |
| `password authentication failed for user "arvoo_user"` | `/etc/arvoo.env` out of sync with the cluster (e.g. restored cluster) | Re-run `sudo ./install.sh` — it verifies and rotates the password |
| `DATABASE_URL is not set` in the API log | Env file missing/edited | Check `/etc/arvoo.env` (mode 0640), then `sudo systemctl restart arvoo` |
| Panel unreachable but service is `active` | Nginx not listening, or DNS/firewall | `sudo nginx -t`, `systemctl status nginx`, check ports 80/443 and cloud firewall |
| Login fails after install | Wrong password, or admin already existed | The bootstrap password applies only on first boot: `sudo ./install.sh` prints it once; otherwise create a user directly in PostgreSQL or reset via `PATCH /api/v1/users/:id` as an admin |
| `certbot` fails | DNS/ports not ready | Fix DNS + port 80, re-run with `ARVOO_DOMAIN=…`; HTTP stays available meanwhile |
| Agent stays `pending` | Not enrolled/approved, or cannot reach the panel | Check `journalctl -u arvoo-agent` on the node; confirm `ARVOO_CONTROL_PLANE_URL` and approve in Nodes |
| Deployment never leaves `queued` | Node agent offline | `journalctl -u arvoo-agent`; verify heartbeat in Nodes → node detail |
| Deploy fails: "port already occupied" | Another service holds the port | Choose another port, or stop the conflicting service |
| Deploy fails: "IPv4 forwarding is disabled" | `sysctl` write blocked and forwarding off | `echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-arvoo.conf && sudo sysctl --system` |
| `EACCES` when Nginx serves the panel | Build not readable by the nginx worker | `sudo ./install.sh --update` (fixes ownership/modes) |
| Disk filling up | Journal, backups or WAL | `journalctl --disk-usage`, `ls -lh /var/backups/arvoo`, lower `ARVOO_BACKUP_KEEP` |

## 15. Maintenance commands

```bash
sudo ./install.sh                # install or repair (idempotent)
sudo ./install.sh --check        # verify prerequisites (read-only, exit 1 if unmet)
sudo ./install.sh --status       # services, health, listeners, DB size, backups
sudo ./install.sh --update       # git pull + rebuild + migrate + restart
sudo ./install.sh --restart      # restart backend + reload Nginx
sudo ./install.sh --backup       # PostgreSQL dump now
sudo ./install.sh --uninstall    # stop + remove services, keep database and data
sudo ./install.sh --purge        # also delete database, secrets and backups (asks twice)
```

`--uninstall` removes the systemd units, the Nginx site and the backup cron job,
and preserves the database, role, `/etc/arvoo.env`, the application files and
every backup. Neither `--uninstall` nor `--purge` runs without an explicit
confirmation (and `--purge` requires typing `DELETE ARVOO`; use
`ARVOO_FORCE=1` only for automated teardown).

## 16. Manual deployment (without the installer)

```bash
sudo apt-get install -y nginx postgresql postgresql-contrib libpq-dev git iproute2 iptables openvpn
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

sudo useradd --system --home-dir /opt/arvoo --shell /usr/sbin/nologin --no-create-home arvoo
sudo git clone <your-repo-url> /opt/arvoo && sudo chown -R arvoo:arvoo /opt/arvoo
cd /opt/arvoo && sudo -u arvoo npm ci && sudo -u arvoo npm run build

sudo -u postgres psql -c "CREATE ROLE arvoo_user WITH LOGIN PASSWORD 'CHANGE_ME'"
sudo -u postgres psql -c "CREATE DATABASE arvoo OWNER arvoo_user"

sudo install -m 0640 -o root -g arvoo /dev/null /etc/arvoo.env
sudo tee /etc/arvoo.env >/dev/null <<'ENV'
APP_ENV=production
HOST=127.0.0.1
PORT=4001
DATABASE_URL=postgresql://arvoo_user:CHANGE_ME@127.0.0.1:5432/arvoo
ARVOO_APP_SECRET=CHANGE_ME_openssl_rand_hex_32
ARVOO_ADMIN_USER=admin
ARVOO_ADMIN_PASSWORD=CHANGE_ME
ENV

# Apply the schema: the env file is readable by the arvoo user (0640 root:arvoo).
cd /opt/arvoo && sudo -u arvoo sh -c 'set -a; . /etc/arvoo.env; set +a; node apps/api/dist/migrate.js'

sudo ./install.sh                 # still the recommended way to install units + nginx
```
