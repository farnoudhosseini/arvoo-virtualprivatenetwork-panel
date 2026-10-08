# Arvoo — VPN Infrastructure Control Plane

Arvoo is a web panel for running a multi-node OpenVPN + GRE network: it manages
nodes, VPN inbounds, clients, PKI, policies and tunnels from one control plane,
and pushes every change to the target machine through an agent that validates
and verifies each step.

Everything the panel shows is real: node status comes from agent heartbeats,
deployments are confirmed by the node itself (systemd + listening socket), and
the panel never reports success for work the node did not do.

---

## Architecture

```text
                    Browser
                       │  HTTPS (or HTTP before a certificate exists)
                       ▼
                ┌──────────────┐
                │    Nginx     │  :80 / :443  (only public entry point)
                └──────┬───────┘
                       │  /api/ → 127.0.0.1:4001
                       ▼
                ┌──────────────┐        ┌────────────────┐
                │ Fastify API  │───────▶│  PostgreSQL    │ 127.0.0.1:5432
                │ (apps/api)   │        │  (arvoo DB)    │
                └──────┬───────┘        └────────────────┘
                       │ typed operations (HTTPS, node secret)
                       ▼
                ┌──────────────┐
                │ Node agent   │  (apps/agent, privileged, one per node)
                │ (apps/agent) │
                └──────┬───────┘
                       ▼
             Node Management · OpenVPN · GRE · background jobs
```

* The **backend port and PostgreSQL are never exposed** to the internet: Nginx
  serves the built frontend and reverse-proxies `/api/`.
* The **control plane API is unprivileged** — it queues typed operations. Only
  the node agent touches networking, and it runs `execFile` with argument
  arrays (never a shell string), so the panel cannot inject a command line.
* **PostgreSQL is the only datastore.** The schema is owned by the application
  through versioned SQL migrations.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/api` | Fastify + PostgreSQL control-plane API (auth, nodes, inbounds, clients, tunnels, operations, audit) |
| `apps/web` | React + Vite + Tailwind panel UI (built to `apps/web/dist`) |
| `apps/agent` | Node agent that executes privileged operations on a managed node |
| `packages/shared` | Types, OpenVPN/GRE config generation, MTU math and validation shared by API, agent and web |
| `deploy/` | Production systemd units, Nginx site + snippet, sysctl drop-in |
| `scripts/` | `backup.sh` (pg_dump + retention), `seed.ts` (seed real entities through the API) |
| `install.sh` | Ubuntu 24.04 installer and maintenance CLI |
| `DEPLOYMENT.md` | Full production deployment, operations and troubleshooting guide |

## Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js ≥ 22.5 (ESM, TypeScript 5.6) |
| Backend | Fastify 4, `pg` (node-postgres) pool, JWT session cookie, Zod validation, bcrypt |
| Database | PostgreSQL 16 (Ubuntu 24.04) with versioned SQL migrations |
| Frontend | React 18, React Router 6, TanStack Query 5, Tailwind 3, Vite 5 |
| Node agent | Node.js, `execFile`-only privileged execution, CAP-limited systemd sandbox |
| Web server | Nginx (static build + reverse proxy, security headers, gzip) |
| TLS | Let's Encrypt via certbot (optional, automatic renewal) |
| Process manager | systemd (journald logging, restart policy, hardening) |
| Backups | `pg_dump` to `/var/backups/arvoo` with retention + daily cron |

## One-line install (Ubuntu 24.04 LTS)

Official repository: <https://github.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel>

### Master + panel (complete stack)

```bash
curl -fsSL https://raw.githubusercontent.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel/main/install.sh | bash -s --
```

### Node only (enroll a VPN node)

Generate an enrollment token in the panel (Nodes → Add node → enrollment token),
then on the new Ubuntu 24.04 machine:

```bash
curl -fsSL https://raw.githubusercontent.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel/main/install.sh | bash -s -- --node --token <ENROLLMENT_TOKEN>
```

Piping an installer into a root shell is convenient but opaque. If you prefer to
read it first (recommended):

```bash
curl -fsSL -o arvoo-install.sh https://raw.githubusercontent.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel/main/install.sh
less arvoo-install.sh          # review
sudo bash arvoo-install.sh     # or: sudo bash arvoo-install.sh --node --token <TOKEN>
```

The node-only path installs **no** PostgreSQL, **no** panel and **no** nginx: it
installs the agent, enrolls the node with the one-time token, stores the node
identity in `/etc/arvoo` (root only), verifies connectivity to the master and
checks the Linux networking capabilities the node needs (IP forwarding, GRE,
iptables, OpenVPN). It prints exactly what passed and what did not.

## Production install (from a checkout)

```bash
sudo git clone https://github.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel /opt/arvoo
cd /opt/arvoo
sudo ./install.sh                            # installs everything, idempotent
```

The installer provisions system packages, Node.js 22, PostgreSQL, a dedicated
database + role, `/etc/arvoo.env` (mode 0640), the build, migrations, systemd
services, Nginx and a daily backup job — then runs a health check and prints a
summary with the first login credentials.

```bash
sudo ./install.sh --check      # verify prerequisites without changing anything
sudo ./install.sh --status     # services, health, listeners, database, backups
sudo ./install.sh --update     # git pull + rebuild + migrate + restart (+ rollback)
sudo ./install.sh --restart    # restart the backend, reload Nginx
sudo ./install.sh --backup     # run a PostgreSQL backup now
sudo ./install.sh --help       # every command and environment override
```

Enable HTTPS by passing a domain (DNS must already point at the host):

```bash
sudo ARVOO_DOMAIN=panel.example.com ARVOO_EMAIL=ops@example.com ./install.sh
```

Deployment details, the node-agent enrollment flow, backup/restore, updates and
troubleshooting live in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Local development

```bash
npm ci                                   # install workspace dependencies
export DATABASE_URL=postgresql://arvoo_user:arvoo_user@127.0.0.1:5432/arvoo
npm run db:migrate                       # apply migrations
npm run dev                              # API :4001 + Vite dev server :5173
```

`npm run dev` runs both apps; the Vite dev server proxies `/api` to the API.
Configuration is read from `.env` in development — copy `.env.example` and fill
in `DATABASE_URL`, `ARVOO_APP_SECRET` and `ARVOO_ADMIN_PASSWORD`. In production
the same variables come from `/etc/arvoo.env` via systemd.

Any PostgreSQL 14+ server works for development; the test suite boots its own
real PostgreSQL instance (`embedded-postgres`), so no local database is needed
for `npm test`.

| Command | What it does |
| --- | --- |
| `npm run dev` | API + web dev servers |
| `npm run build` | Build shared, API, agent and web |
| `npm test` | Run every workspace test suite |
| `npm run typecheck` | Project-wide TypeScript build check |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate -- --status` | Show applied/pending migrations |
| `npm run db:migrate -- --down 1 --force` | Revert the newest migration (destructive) |
| `node --import tsx scripts/seed.ts` | Seed example nodes/inbound/client through the API |

## Database

* Dedicated database `arvoo`, dedicated role `arvoo_user` — the application
  never connects as the `postgres` superuser.
* `DATABASE_URL` comes from the environment (`/etc/arvoo.env` in production).
* Connection pooling is configured in `apps/api/src/db/index.ts`
  (`ARVOO_POOL_MAX`, idle/connect/statement timeouts, UTC sessions, idle-client
  error isolation).
* Schema changes are **only** made by versioned migrations in
  `apps/api/src/migrations` (`NNNN_name.sql` + optional `NNNN_name.down.sql`),
  applied under an advisory lock at startup and by `install.sh`. Tables are
  never created by hand in the installer.

## Managed firewall (UFW)

The panel has a **Firewall** section with two actions per host:

* **Config & Enable UFW** — builds a plan from the ports that actually exist on
  that host (SSH, the panel behind nginx, **every deployed inbound's protocol and
  port**, GRE protocol 47 and IPsec/FOU ports for every tunnel that terminates
  there, optionally ICMP) and applies it with `ufw`;
* **Update UFW** — recomputes the plan and applies the difference: ports that are
  no longer needed are withdrawn, new ones are added. Rules you added by hand are
  never touched, because Arvoo only withdraws the rule ids it applied itself.

Nothing is assumed: after every apply the host's real `ufw status verbose` output
is parsed, and a rule that ufw did not actually install is reported as a failure.
The panel shows per host: active/inactive, in-sync/out-of-date, public ports, the
last apply (who, when, result) and the warnings (for example "SSH is allowed from
any address").

How it runs without giving the panel privileges:

* on a **node**, the change is a normal typed operation executed by the node agent
  (whose sandbox is extended to `/etc/ufw` and `/var/lib/ufw`);
* on the **panel host**, the unprivileged API writes the plan into
  `/var/lib/arvoo/firewall-spool` and the systemd path unit
  `arvoo-ufw-apply.path` runs `arvoo-ufw-apply.service`, a root oneshot unit that
  applies it with `ufw` and writes the real result back for the panel to display.

The same code path is available on the command line:

```bash
sudo arvoo firewall status                 # per-host state, ports and last apply
sudo arvoo firewall plan                   # the exact ufw command lines
sudo arvoo firewall enable                 # Config & Enable UFW on the panel host
sudo arvoo firewall update                 # Update UFW after adding/removing an inbound
sudo arvoo firewall enable --host <node-id> # target a node explicitly
sudo arvoo firewall enable --local         # build the plan and apply it on this host directly
```

## Client management (full editing)

Every meaningful property of a client is editable from the panel (Clients → a
client → **Edit**), and every one of them has an API endpoint:

| Property | Where |
| --- | --- |
| Client username (rename) | Edit → Details → Rename (reissues the certificate) |
| Display name, description, notes, tags | `PATCH /api/v1/clients/:id` |
| OpenVPN username and password | Edit → OpenVPN credentials → `PUT /api/v1/clients/:id/credentials` |
| Expiry, start, traffic quota, time quota | `PATCH /api/v1/clients/:id` (`limits`) |
| Device (HWID), IP and concurrent-session limits | `limits` |
| Upload/download caps | `limits.downloadSpeedKbps` / `uploadSpeedKbps` |
| Usage multiplier | `baseMultiplier` |
| Assignments | `PUT /api/v1/clients/:id/inbounds` |
| Preferred node / region / transport, fallback inbound | `POST /api/v1/clients/:id/placement` |
| Routing preferences (sticky, fallback on failure, excluded nodes) | same endpoint |
| Suspend / resume / revoke / certificate rotation | dedicated endpoints |

**OpenVPN credentials are a separate identity.** They are not the Arvoo panel
account and not the node secret. The password is stored as a bcrypt hash, never
returned by any API response and never written to a log; an inbound that
authenticates clients by password generates an `auth-user-pass-verify` hook that
asks the control plane on every connection, so the node holds no credential and
changing a password takes effect immediately (existing sessions of that client
are disconnected, because they authenticated with the old value).

## Inbound domains

An OpenVPN inbound can carry a public domain (`vpn.example.com`). It is validated
(RFC 1123 syntax, no IP literals), resolved at save/deploy time, and stored with
the answer: `verified`, `mismatch` (resolves elsewhere) or `unresolved`. A name
that does not resolve is refused unless you deliberately force it — a mismatch is
never hidden, it stays on the inbound page with the resolved addresses. Generated
`.ovpn` profiles dial the domain when it is set and fall back to the node address
otherwise; the address remains authoritative for health checks and deployments,
and the server certificate carries the domain in its SAN.

## Load balancing

A dedicated **Load balancing** section (not buried in node or client settings)
provides groups of inbounds or nodes with:

* weights and failover priority per member;
* health requirements (minimum probe success rate, maximum latency, maximum loss,
  node must be reporting);
* enable / drain / restore per member and a failover policy (redirect new
  sessions, keep existing ones, optional auto-drain/auto-restore);
* a real "where would the next session go" decision and an event log.

Every displayed value is measured: probe success rate, latency and loss come
from the recorded path-health samples, session counts and traffic come from the
session table. A member that was never probed is shown as **unknown** with the
reason "No health probe has run for this member yet" — never as healthy. Draining
a node member also sets that node's administrative state, which is what the
routing engine reads, so the effect is real rather than a table flag.

## Security model

* The API runs as the unprivileged `arvoo` system user, bound to `127.0.0.1`,
  with no writable filesystem (`ProtectSystem=strict`) and no privileges.
* Secrets live in `/etc/arvoo.env` (mode 0640 `root:arvoo`); no secret is ever
  committed, logged or placed on a command line.
* Stored certificate/TLS key material is encrypted at rest with AES-256-GCM
  (`ARVOO_APP_SECRET`).
* Login is rate-limited; every mutating action is written to the audit log.
* Nginx adds HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` and `Permissions-Policy`, hides its version, and is the only
  publicly reachable component.
* The node agent validates every privileged payload again (names, ports,
  addresses, MTU, sizes) before it reaches a path, a unit name or a command
  argument, so a compromised panel cannot make it write outside its own
  directories. Its systemd sandbox is limited to `/etc/arvoo`,
  `/etc/systemd/system`, `/var/lib/arvoo` and `/run`.

## License

Proprietary — internal Arvoo project.
