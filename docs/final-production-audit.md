# Arvoo — production audit, hardening and CLI management

This is the report for the audit/hardening pass. It states what was verified on a real
system, what was verified by tests, and what could **not** be verified here. Nothing is
claimed as tested that was not run.

Verification environment for this pass: Windows development host (no systemd, no `ip`,
no `nftables`, no Ubuntu). Consequence: everything marked "not executed on Linux" below
must be run on an Ubuntu 24.04 VM before this is treated as production-ready.

---

## 1. Architecture changes

Four changes, each closing a gap where the product had a UI or a script but no real
mechanism behind it.

1. **Management access secret** — a second, independent factor for the most privileged
   operations, on top of the admin session and RBAC. Stored as a peppered HMAC only,
   returned exactly once to the caller that created it, rotatable on demand or on a
   6-hour schedule, with a grace window so a rotation cannot lock administrators out.
2. **One-command node enrollment** — the node installer now asks for the control plane
   URL and a one-time token, validates both, enrolls, writes the node identity, starts
   the agent and reports the final state. No development command is required, and the
   token never appears in `argv`, logs or job output.
3. **Management CLI** — a single `arvoo` command installed on both roles that manages the
   same system the panel manages, reusing the installer, the backup script and the API
   instead of reimplementing them. This is the emergency/terminal path the brief asks for.
4. **Public site** — a static, indexable, bilingual (Persian RTL / English LTR) site
   served by nginx, separate from the panel, with no panel links, no credential
   collection and no claims that cannot be checked.

## 2. Files changed

| File | Change |
| --- | --- |
| [cli/arvoo](../cli/arvoo) | New. The `arvoo` CLI: 22 interactive menu entries, 20 non-interactive commands, `--json`/`--yes`/`--quiet`, root enforcement for state changes, confirmation before destructive work. |
| [install.sh](../install.sh) | Menu aligned to the six documented options; `ask_domain`/`validate_domain_dns`; certificate read-back and renewal-timer verification; `install_cli`; `install_public_site`; `enroll_agent` (URL + one-time token); `mode_repair`; enrollment checks in diagnostics; uninstall removes the new nginx site and (on purge) the site content. |
| [apps/api/src/services/management-secret.ts](../apps/api/src/services/management-secret.ts) | New. Hash-only storage, constant-time verification, grace rollover, policy, scheduled rotation, root-only recovery file. |
| [apps/api/src/routes/index.ts](../apps/api/src/routes/index.ts) | `GET`/`POST /api/v1/system/management`; `requireManagement` gate applied to user administration, node approve/revoke and session-secret rotation; management metadata added to `/system/security`. |
| [apps/api/src/index.ts](../apps/api/src/index.ts) | Periodic scheduler (5-minute tick, unref'd, cleared on shutdown) for scheduled rotation. |
| [packages/shared/src/types.ts](../packages/shared/src/types.ts) | Four new audit actions for the management secret. |
| [apps/api/test/api.test.ts](../apps/api/test/api.test.ts) | New suite: gate enforcement, one-time display, hash-only storage, grace window, hard rotation, scheduled rotation and safe rollover, disable path, posture endpoint. |
| [site/index.html](../site/index.html), [site/assets/site.css](../site/assets/site.css), [site/assets/site.js](../site/assets/site.js), [site/robots.txt](../site/robots.txt), [site/sitemap.xml](../site/sitemap.xml) | New. The public site, two languages in the served HTML, no external requests. |

Earlier passes in this work stream (session secret, CSRF, response headers, session idle
window, source-map and noindex handling, GRE/MTU engine, routing intelligence, node detail
data) are unchanged by this pass and remain covered by their tests.

## 3. Database / migrations

**No new migration.** The management secret is a single row in the existing `settings`
table under `security.managementSecret`:

```json
{
  "enabled": true,
  "hash": "<hmac-sha256(appSecret, secret)>",
  "previousHash": "<…>",
  "rotatedAt": "…", "previousValidUntil": "…", "nextRotationAt": "…",
  "autoRotateHours": 6, "graceMinutes": 30, "version": 3
}
```

The plaintext value is never stored, so a database dump does not reveal it. Schema
versions remain `0001_init`, `0002_tunnel_encap_capabilities`,
`0003_routing_intelligence`; `apps/api/test/migrations.test.ts` still applies, reverts and
re-applies the initial schema successfully.

## 4. Installer changes

* Menu is exactly the documented six options: Master, Node Agent, Repair, Update,
  Diagnostics, Uninstall. Repair detects the installed role instead of asking.
* Domain/IP branch before the environment file is written, so one answer drives nginx,
  ACME, CORS and the agent's control plane URL. DNS is resolved and compared with the
  host's public address; a mismatch warns, a non-resolving name is reported before certbot
  is attempted. Choosing IP prints the actual limitation (no TLS, credentials cross the
  network in clear) rather than a generic warning.
* Certificate handling verifies what the server presents (`openssl s_client` read-back,
  days remaining) and whether `certbot.timer` is enabled — renewal is only reported as
  configured when it is actually armed.
* `arvoo` is installed to `/usr/local/bin` on both roles.
* The public site is installed to `/var/www/arvoo-site` with a hard-coded nginx block:
  its own `server_name` when `ARVOO_SITE_DOMAIN` is set, otherwise the default virtual host
  so an IP-only installation still has a public page. `nginx -t` gates the change; on
  failure the site block is removed and the panel is left untouched.
* Node installs the agent environment file (`/etc/arvoo/agent.env`, mode 0640, no secrets),
  enrolls, starts the service and fails loudly if the agent does not come up.

## 5. Node enrollment

```
one-time bootstrap token  →  enrollment  →  node identity  →  authenticated control channel
```

* The installer validates the control plane (`GET /health`) before spending the token.
* The token is passed through the environment (`ARVOO_ENROLLMENT_TOKEN`), never on the
  command line, is never echoed, and is single-use server-side with a short TTL; a failed
  attempt tells the operator to generate a new one.
* The identity (`/var/lib/arvoo/agent-state.json`, mode 0600, root only) is created by the
  agent and verified by the installer before the service starts; "enrollment reported
  success but no identity was written" aborts instead of continuing.
* A newly enrolled node appears as *awaiting approval*; approval, revocation and rotation
  are audited, and a revoked node is refused at the API (`enrollment_state !== 'approved'`).
* Capabilities are reported by the agent's own probes on heartbeat, so the panel only
  offers what the node actually confirms.

## 6. CLI management

Commands: `status`, `health`, `start`, `stop`, `restart`, `reload`, `diagnostics`,
`logs [--component] [--follow]`, `node status`, `tunnel status`, `secret rotate`,
`management status|enable|rotate|disable`, `cert status|renew`, `repair`, `update`,
`backup`, `restore --file`, `security-audit`, `config`, `version`, `help`.

Rules the implementation keeps:

* read-only commands need no privileges; anything that changes state requires root and
  exits `77` with the exact command to re-run;
* destructive work (stop, restore, repair, update, secret rotation) asks first, and in a
  non-interactive shell refuses unless `--yes` is given;
* `--json` emits a single object for scripting; `--quiet` suppresses everything but
  problems;
* secrets are never printed, never passed as arguments and never written to logs; the
  management secret is read from the root-only file and a rotated value is written back
  there;
* a command that cannot apply to the host says so and exits non-zero instead of pretending
  success (verified: every Linux-only command exits `2` with an explicit platform message
  on a non-Linux host).

The CLI is a client of existing components: systemd units, `install.sh`, `scripts/backup.sh`
and the same API endpoints the panel calls, so the CLI and the panel cannot drift.

## 7. Security hardening

* **Second factor for privileged operations.** When enabled, user administration, node
  approval/revocation and session-secret rotation require `x-arvoo-management` in addition
  to a valid admin session. Changing or disabling the gate itself requires the current
  secret, so a stolen admin session cannot remove its own second factor.
* **Rotation without lockout.** The previous value stays valid for the grace window
  (default 30 minutes) after any rotation. A *scheduled* rotation always leaves at least
  the default grace, even if the policy was set to zero — a timer must never be the reason
  an administrator is locked out. Both behaviours are asserted by tests.
* **Recovery path.** Each rotation writes the new value to `/etc/arvoo/management-secret`,
  mode 0600, root only, so access can be recovered from the terminal even if every
  administrator loses it. `arvoo security-audit` checks that mode.
* **Exposure.** The panel keeps `X-Robots-Tag: noindex, nofollow, noarchive`, `nosniff`,
  `DENY`, `no-referrer`, `no-store`, `noindex` in the app shell and no source maps in
  production builds. The public site is indexable on purpose, ships `robots.txt` and
  `sitemap.xml`, and its nginx block sets a restrictive CSP, `nosniff` and a referrer
  policy; it has no login form and collects nothing.
* **Secrets in logs.** Auditing records the rotation with actor, time and reason; the
  value, its hash and the recovery-file contents never appear in an audit entry, a
  response body (except the single creation response) or a journal line.

## 8. GRE / network changes

No changes were made to the GRE, MTU, OpenVPN or routing implementation in this pass, and
nothing here should be read as re-verifying it. What exists and is covered by unit tests
that ran in this pass: the MTU/overhead engine (`packages/shared/src/mtu.test.ts`,
`encap.test.ts`), the tunnel controller and desired-vs-actual state
(`controller.test.ts`), endpoint sharing (`endpoint-sharing.test.ts`) and agent-side
operation validation including kill/encapsulation handling
(`apps/agent/test/kill-and-encap.test.ts`, `validate-op.test.ts`). Tunnel creation still
requires real deployment verification through the agent (interfaces, routes, packet
delivery), which needs Linux hosts — see §10.

## 9. Browser tests

Verified in a real browser (screenshots, EN and FA):

* `GET /` → 200, `assets/site.css` → 200, `assets/site.js` → 200;
* English layout renders (hero, schematic, services, platform, regions, status,
  documentation, contact, footer);
* pressing the language control switches the document to Persian: `dir="rtl"`,
  `lang="fa"`, Persian text throughout, mirrored layout, button label and `<title>`
  updated, URL becomes `?lang=fa`; 50 Persian strings are present in the served HTML;
* console and network logs are empty (no errors, no failed requests, no third-party
  requests).

Panel browser flows were exercised at the API layer in this pass (login, enrollment,
approval, inbounds, clients, GRE tunnels, routing, session-secret rotation, and the new
management-secret suite — 43 tests). A browser walkthrough of the panel was **not** re-run
in this pass; the earlier session's panel walkthrough stands, and the full §33 list
(including "Rotate credentials → verify revoked credentials fail" and "CLI corresponds to
panel state") should be re-run on a Linux host together with §10.

## 10. Linux / network verification

Executed here:

* `bash -n` on `install.sh` and `cli/arvoo` (both parse clean);
* `cli/arvoo --help`, `--version`, unknown command (exit 64), unknown option (exit 64),
  Linux-only command on a non-Linux host (exit 2) — all behave as documented;
* the secret-extraction and recovery-file path of `management_show_response` driven with a
  real response body: value captured, written, metadata parsed;
* the public site served over HTTP and rendered in a browser (§9);
* the full test suite, which boots a **real** PostgreSQL server (embedded binaries) and
  applies the real migrations: 187 tests, 12 files, all passing.

**Not executed on Linux** (no Ubuntu host in this environment): systemd unit behaviour,
nginx configuration validation, `ip`/`nftables`/OpenVPN/IPsec inspection, certificate
issuance and renewal, agent enrollment against a live control plane, reboot persistence,
`arvoo start/stop/restart/logs/diagnostics/backup/restore` against real services. These are
the acceptance tests to run on an Ubuntu 24.04 VM:

```bash
sudo ./install.sh                     # menu 1 (Master)  → then 5 (Diagnostics)
sudo ./install.sh                     # menu 3 (Repair)  → idempotent, data preserved
arvoo status ; arvoo diagnostics ; arvoo security-audit
sudo arvoo backup && sudo arvoo restore --file /var/backups/arvoo/<newest>.dump
# on a second VM: menu 2 (Node Agent) with control plane URL + one-time token
# then: approve in the panel, check the node page, create a GRE tunnel, deploy, verify
ip -d link show type gre ; ip route ; ping -M do -s <mtu-28> <peer-inside-address>
systemctl reboot && arvoo health
```

## 11. Performance measurements

Measured in this pass:

| Measurement | Result |
| --- | --- |
| Full test suite (187 tests, 12 files, incl. booting a real PostgreSQL and applying migrations) | 9.09 s wall clock |
| Migration apply/revert/re-apply test | 0.46 s |
| API test file (43 endpoint tests against real PostgreSQL) | 7.7 s |
| TypeScript project build (`tsc --build`, 4 packages) | clean, no output |

Not measured (needs Linux nodes): tunnel throughput and latency, the effect of the MTU/MSS
calculation on packet delivery, panel page load and API latency at realistic row counts,
database query plans at scale. The measurement plan is concrete because the mechanisms
exist: `iperf3` is installed and driven by the agent's benchmark operation (which settles
into `path_health`), so before/after throughput through a tunnel is a supported
measurement rather than an anecdote; `EXPLAIN ANALYZE` on the node/tunnel/client listings
and a Lighthouse run against the public site (it has no external requests and no JS beyond
the language toggle) are the next steps. No speedup is claimed here.

## 12. Security findings fixed

| Finding | Resolution |
| --- | --- |
| Privileged operations protected only by one factor | Management access secret gate on user administration, node approve/revoke and session-secret rotation. |
| Rotation could lock administrators out | Grace window on every rotation; scheduled rotations always keep the default grace; both asserted by tests. |
| A stolen admin session could silently remove the second factor | Rotating/disabling the gate requires the current secret. |
| Secret could be recovered from the database | Only a peppered HMAC is stored; the test reads the settings row and asserts the plaintext does not appear. |
| Secret could be exposed in metadata responses | Status endpoints return metadata only; a test asserts the value never appears in status or posture responses. |
| Management secret with no terminal recovery | Root-only recovery file (0600), checked by `arvoo security-audit`. |
| Production node install required a development command | Installer performs enrollment end to end. |
| Enrollment token visible in the process list | Passed via environment only, never `argv`; unset immediately after use; never echoed. |
| Node could keep running unenrolled while reporting healthy | Installer aborts if the identity file was not written and if the agent is not active afterwards. |
| Public marketing surface could expose internal implementation | Public site describes capabilities and operations only — no tunnelling, keying or encapsulation internals — and links to nothing internal. |
| Marketing page could become a credential-collection surface | No login, no forms, no external requests; stated explicitly in the footer. |
| Panel could be indexed / cached | `noindex` headers, `no-store`, app-shell `noindex` (in place from the earlier pass, re-asserted by tests). |
| Token accepted with no idle clock (`jsonwebtoken` drops `iat` when timestamps are disabled) | Fixed in the earlier pass: `verifySessionToken` rejects tokens that cannot prove their window; covered by a test. |

## 13. Remaining risks

1. **Not verified on Linux in this pass.** Installer, systemd, nginx, certificates,
   enrollment against a live control plane, backup/restore and every CLI command that
   touches services are unverified until the §10 checklist runs on Ubuntu. This is the
   largest open risk and it is a verification gap, not a known defect.
2. **Node identity is a per-node secret, not mTLS.** The brief prefers certificates. The
   current model is a random node secret over TLS, scoped to one node, refused unless
   approved, revocable, and rotatable; the CA/PKI tables exist and client certificates are
   already issued for VPN clients. Migrating node authentication to mTLS with rotation and
   revocation is the next security milestone.
3. **The management secret has no panel UI by design.** It is managed from the CLI or the
   API, because a compromised panel session must not be able to rotate or disable its own
   second factor, and because the value must not be rendered into HTML. Operators who
   prefer a UI control will need a dedicated, separately authenticated flow.
4. **MFA is readiness, not implementation.** Roles, session lifetimes, CSRF, rate limits
   and audit exist; a second human factor (TOTP/WebAuthn) does not.
5. **Scheduled-rotation value delivery.** The 6-hour schedule keeps the previous value
   valid and writes the new one to a root-only file; if the operator never reads that file
   and the grace window passes, only a fresh rotation (with an admin session) restores
   access. Documented, but worth an operator note in the settings screen.
6. **Public-site substitution.** Domain and contact address are substituted at install
   time from `ARVOO_SITE_DOMAIN` / `ARVOO_CONTACT_EMAIL`; when neither is set the page uses
   the host's public IP and `support@<ip>`, which is honest but not a brand address. Set
   both before publishing.
7. **Session-secret rotation logs everyone out.** That is the safe direction (no window
   with two accepted secrets) and the CLI warns before doing it, but it is a real
   operational impact on multi-administrator installations.
8. **Concurrency.** Approval, rotation and deployment paths are guarded and audited, but
   two administrators editing the same node or tunnel simultaneously can still produce a
   last-writer-wins outcome; optimistic concurrency on those forms is not implemented.

---

# Final completion pass (requirements §38–§50)

This section records the last pass: full client editing, OpenVPN credentials, inbound
domains, load balancing, dual-transport OpenVPN, the managed UFW buttons, the API
reference and the release cleanup. The rule is unchanged from the sections above: a claim
is only written here if it is backed by a test that ran or by an explicitly named gap.

## 14. What was added

| Requirement | Implementation |
| --- | --- |
| §38 Full client editing | [apps/web/src/pages/ClientDetail.tsx](../apps/web/src/pages/ClientDetail.tsx) now edits identity, limits, OpenVPN credentials, placement/routing and inbound assignment in place; [apps/api/src/services/clients.ts](../apps/api/src/services/clients.ts) validates, updates transactionally, bumps the inbound config version and re-applies it on the node. |
| §39 OpenVPN username/password | Separate identity from the panel account and the node secret. The password is bcrypt-hashed, never returned and never logged; a password-authenticating inbound generates `auth-user-pass-verify` that asks `POST /agent/openvpn-auth` on every connection, so the node stores no credential. Rename reissues the certificate and disconnects sessions. |
| §40 Inbound domain | Optional `domain` on every inbound, validated (RFC 1123, no IP literals), resolved on save/deploy and stored with its answer (`verified` / `mismatch` / `unresolved`); a mismatch must be forced explicitly and is never hidden. Generated `.ovpn` profiles dial the domain and fall back to the node address; the address stays authoritative for health checks and deployment, and goes into the certificate SAN. Editable after creation, with `GET /inbounds/:id/domain` and `POST /inbounds/:id/domain-check`. |
| §41 Load balancing | New `lb_groups` / `lb_members` / `lb_events` tables (migration `0004_full_management`), [apps/api/src/services/loadbalancer.ts](../apps/api/src/services/loadbalancer.ts) and [apps/web/src/pages/LoadBalancing.tsx](../apps/web/src/pages/LoadBalancing.tsx). Health, latency, loss and session counts are read from recorded probes and the session table; an unprobed member is **unknown** with a reason, never healthy. Draining a node member also sets the node's administrative state, which is what the routing engine reads. |
| §43 One-click installs | README documents both real raw-GitHub commands (`install.sh` with no arguments for the master, `--node --token <token>` for a node) and the checkout path. |
| §44 API documentation | [docs/API.md](API.md) covers auth, RBAC, rate limits, every endpoint group, the error shape and a worked example; `GET /api/v1/system/routes` (admin) returns the live route inventory from the running Fastify instance so it can never list an endpoint that does not exist. |
| §46 OpenVPN TCP + UDP | Inbound `transport` selects `proto udp` or `proto tcp-server` on the server and `proto udp` / `proto tcp-client` in generated profiles, with the MTU/MSS values appropriate to each; the transport is carried through deployment, health checks and generated configuration rather than being a dropdown. |
| UFW buttons | **Config & Enable UFW** and **Update UFW** in [apps/web/src/pages/Firewall.tsx](../apps/web/src/pages/Firewall.tsx), backed by [apps/api/src/services/firewall.ts](../apps/api/src/services/firewall.ts), [apps/agent/src/ufw.ts](../apps/agent/src/ufw.ts) and the root helper [apps/agent/src/firewall-cli.ts](../apps/agent/src/firewall-cli.ts). The plan is derived from what actually exists (SSH ports, panel ports, every active inbound's port and transport, GRE/FOU/IPsec tunnel ports, loopback and established traffic) and applied by the host itself — the unprivileged API drops a request file into `/var/lib/arvoo/firewall-spool`, `deploy/arvoo-ufw-apply.path` starts `deploy/arvoo-ufw-apply.service`, and the helper writes back its real output. Update recomputes the plan and applies the difference (add and delete rules); `arvoo firewall status\|plan\|enable\|update\|disable` reuses the same code path. |

## 15. Verification actually performed

| Check | Command | Result |
| --- | --- | --- |
| Type check (all workspaces) | `npm run typecheck` | exit 0 |
| Test suite | `npx vitest run` | 14 files, **249 tests passed**, exit 0 |
| Migrations from scratch | `apps/api/test/migrations.test.ts` | applies, reverts and re-applies `0001`–`0004`; second run applies 0 |
| Client editing / credentials / domain / LB / firewall API | `apps/api/test/api.test.ts` | covered, including refusal of an unresolvable domain, forced mismatch, credential change impact, drain/restore and management-gate enforcement |
| Firewall planning | `packages/shared/src/firewall.test.ts` | plan contents, diff/apply, risky-input rejection |
| Load-balancer selection | `packages/shared/src/lb.test.ts` | weighting, health gating, failover, drain |
| Frontend production build | `cd apps/web && npx vite build` | exit 0, 2514 modules, 288 kB gzip |
| Repository scan | `grep -rn "TODO\|FIXME\|mock\|placeholder"` | only HTML input placeholders and the SQL placeholder translator |

## 16. Not verified here (requires Ubuntu 24.04)

Honest list of what this Windows host cannot execute. Each item is a verification gap, not
a known defect, and each has a corresponding command in §10/§49 above:

1. Installer end to end, on a clean master and a clean node.
2. `arvoo-ufw-apply` working through the systemd path unit, including the helper's real
   `ufw` output and the panel reporting it.
3. Real OpenVPN listeners (UDP and TCP), authentication over both transports, reconnect
   behaviour and MTU/MSS on real packets.
4. GRE links: interface, key, MTU, routes, return path, persistence across reboot.
5. Node enrollment against a live control plane, revocation and credential rotation.
6. certbot issuance/renewal, nginx reload, reboot persistence, backup and restore.

## 17. Release state

* Working tree is clean of generated databases (`apps/api/data`, `apps/data` were removed
  from the index and are ignored), temporary snippet files, debug endpoints and test
  credentials; `.gitignore` covers build output, local databases, environment files and
  the root-only helper state.
* No secret is committed: `/etc/arvoo.env` is generated by the installer, the example file
  carries placeholders only, and certificate material is encrypted at rest with
  `ARVOO_APP_SECRET`.
* Both install commands in the README point at
  `https://raw.githubusercontent.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel/main/install.sh`,
  which will resolve once the repository is pushed.
* Remaining known limitations are the ones listed in §13 plus the six verification gaps in
  §16. The product is not claimed to be verified on Linux until §16 runs.
