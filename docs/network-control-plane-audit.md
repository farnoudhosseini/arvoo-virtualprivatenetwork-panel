# Arvoo — Network Control Plane audit and phased plan

Audit date: 2026-10-08. Scope: the whole repository (control plane, agent, panel,
installer, migrations), measured against the Adaptive Node / Path / Transport
Intelligence spec. This document is deliberately blunt: it separates what is
real, what is partial, and what does not exist.

A rule for the whole document: **nothing below is marked "works" because a UI
toggles it.** Anything that needs real Linux state says so explicitly.

---

## 1. What is already real (verified by reading the code and running the suites)

| Area | Reality |
| --- | --- |
| Control plane | Fastify + PostgreSQL, versioned reversible SQL migrations (`apps/api/src/migrations`, runner in `apps/api/src/db/index.ts`), applied at boot and via CLI. |
| Node enrollment | `POST /nodes` issues a hashed, single-use, 10-minute token; the agent calls `hello` with it and receives a hashed node secret; an admin must approve before the node is usable (`apps/api/src/services/nodes.ts`). Tokens are never stored or logged in clear. |
| Node lifecycle | Real heartbeats with real telemetry, liveness sweep → `agent.down` alert, session capacities, capabilities recorded with a timestamp. |
| Agent | Real telemetry (CPU/RAM/disk/load, interfaces, cumulative counters, OpenVPN processes, GRE interfaces), capability probing (GRE, FOU, nftables, IPsec/swanctl, DCO, OpenVPN version, kernel), and ops executed with `execFile`: GRE create/delete/test, FOU and IPsec transport mode, OpenVPN deploy/restart/stop/kill-client through the management socket, firewall policy, benchmarks (ping/iperf3), reconciliation of persisted GRE specs after an outage. |
| Tunnels | GRE with capability gating (`tools` vs `fou` vs `ipsec` encapsulation), MTU engine with clamping and `advmss`, mesh creation. |
| Routing intelligence | Pure, unit-tested engine in `packages/shared/src/routing.ts` (candidate scoring, honest `null` metrics, hysteretic health states, node score normalisation, weights, diversity, hold-down, min-switch delta) plus API (`/routing/matrix`, `/place`, `/assignments`, `/events`, `/policies`, `/admin`, tunnel `benchmark`) and a Traffic Intelligence panel page. |
| Panel | Dashboard, Nodes + Node detail, Inbounds + detail + create, Clients + detail, Policies, Tunnels + detail, Topology, Traffic, Operations, Alerts, Audit, Activity, Settings. |
| Installer | Idempotent `install.sh`: install/repair, `--check`, `--update`, `--restart`, `--status`, `--backup`, `--uninstall`, `--purge`, optional HTTPS via Let's Encrypt when `ARVOO_DOMAIN` is set. |

## 2. Gaps against the spec

Status legend: **missing** = does not exist, **partial** = exists but not to spec,
**done** = implemented and tested.

| Spec area | Status | Notes |
| --- | --- | --- |
| Automatic health measurement (§11, §32, §34, §70) | **done (this change)** | `apps/api/src/services/health-engine.ts` plans probes with state-dependent intervals (healthy 300s … down 45s, never-measured 15s), skips tunnels that are not deployed or are administratively disabled, refuses to stack a second probe while one is in flight, and uses light ICMP probes only. Wired into the background job loop, exposed as `GET /routing/probes` (plan + reason per path) and `POST /routing/probes/run` (audited operator sweep), rendered as the "Path probing" card on the Traffic page. |
| Continuous telemetry of *utilisation* (§2: network utilisation, bandwidth capacity) | partial | Cumulative rx/tx counters exist, but no rate/utilisation metric is computed, and the node score honestly reports `bandwidthUtilisationPct: null` rather than inventing it. |
| Node diagnostics wizard (§60, §61) | partial | The agent has a thin `collectDiagnostics`; there is no API route, no stored result, no per-check UI, no guided "why is my node not connecting". |
| Persian UI + RTL, i18n architecture (§41, §42, §43) | missing | No i18n layer at all; UI strings are English literals. LTR only. |
| Adaptive UDP/TCP inbound profile (§15, §16, §86) | missing | An inbound carries one transport. There is no "Adaptive" mode, no background UDP recovery, no TCP fallback for new connections. |
| Transport / protocol registry, pluggable transports (§22, §23, §87) | partial | The engine scores transports as data, but the tunnel↔transport relation is still derived from a single encapsulation; there is no registry that third-party transports plug into. |
| Secure overlay transport (§7, §18, §21) | missing | GRE is protected only via FOU/IPsec; no independent authenticated, replay-resistant overlay layer. |
| mTLS node identity, certificate enrollment and rotation (§12, §73) | partial | Node auth is a bearer secret, not certificate enrollment. There is a PKI service for OpenVPN client material, which is a different concern. |
| Endpoint pools (§36) | partial | Table `node_endpoints` exists with administrative state; no API, no UI, no independent health checks yet. |
| Blueprint that deploys (§46) | missing | Topology is a read-only visualisation; there is no drag-to-connect → plan → deployment pipeline. |
| Desired vs actual reconciliation, snapshots/rollback (§47, §48) | partial | The agent reconciles persisted GRE specs after downtime and OpenVPN inbounds keep versions with rollback, but there is no controller-driven drift detection/repair loop with last-known-good snapshots for all networking state. |
| Node roles as Ingress/Egress/Relay/Transit/Hybrid (§54) | partial | Roles are `vpn/edge/gateway/transit/custom`; the routing engine treats region class + role, not a first-class ingress/egress taxonomy. |
| Per-client routing policy in the UI (§38) | partial | The engine supports `scope = client`; the panel only exposes the global policy. |
| Packet-level multipath | done by omission | It is not implemented anywhere, which matches the requirement that it must not be the default. |
| Real traffic E2E tests (§65–§69, §95) | missing | No environment with real nodes was available in this session. All verification below is unit/API level; Linux state changes were not exercised end-to-end. |

## 3. Phased plan

Ordered by value per unit of risk. Each phase is independently shippable.

- **Phase A — continuous health (done in this change).** Scheduler-driven probes
  so the routing engine and the panel always see recent reality.
- **Phase B — node diagnostics vertical.** Richer agent checks (DNS, gateway,
  firewall, TUN, DCO, GRE/FOU/IPsec, master connectivity, tunnel reachability),
  stored per run, exposed as API, rendered as a checklist with actionable
  failures, and a guided "why is my node not connecting" flow.
- **Phase C — transport abstraction + adaptive UDP/TCP.** A transport registry
  in the shared package, a real `Adaptive` inbound profile (UDP preferred, TCP
  for new connections when UDP is unhealthy, background UDP recovery), and
  capability-gated availability so the panel can never offer a transport the
  node does not support.
- **Phase D — Persian/RTL + i18n.** `fa`/`en` resource files, RTL layout, bidi
  handling for IPs/CIDR/ports/code, a fixed terminology glossary, no hard-coded
  strings.
- **Phase E — endpoint pools + secure overlay.** Independent endpoint health,
  and a real encrypted overlay transport behind the Phase C registry.
- **Phase F — blueprint → deployment, drift reconcile, mTLS.** Blueprint becomes
  desired state, the controller plans tunnels/transports from it, reconciles
  drift with snapshots and rollback, and node identity moves to certificates.

## 4. What was verified in this change

- `npm run typecheck` — clean.
- `npx vitest run apps/api/test/api.test.ts` — 31 passing, up from 26 (5 new:
  interval/unmeasured rules, one-probe-per-path sweep, probe result settling into
  path health plus disabled-path handling, the probe API and audit entry, and
  the matrix policy contract).
- `npm test` — 162 passing across 11 files.
- `npm run build` — panel builds.
- **Live stack**: an embedded PostgreSQL, the real API and the real Vite dev
  server, with three fixture nodes and two `up` tunnels. The background job
  queued one health probe per path on its own (operations attributed to
  `health-engine`, correct tunnel IPs, one probe in flight per path), the probe
  plan reported both paths as "never measured", and the panel rendered the
  Traffic page with the probing card, "2 path(s) due now" and honest `0/2
  healthy paths`. Clicking "Probe due paths" produced
  `routing.probe | Ran a path health sweep: 0 probe(s) queued, 2 skipped` in the
  audit log — the dedup guard observed from the browser.
- The browser run found two real defects, both fixed: the Traffic page crashed
  when no routing policy row existed (`policy: null`), and local development
  claimed "database degraded" because the Vite dev proxy did not forward
  `/health` (Nginx does in production).

Not verified (and not claimed): any real Linux state change, any real GRE/IPsec
link or real traffic path, failover under real loss, and Persian rendering (it
does not exist yet). The fixture rows represent what an agent *would* report;
they are not evidence of a working tunnel.
