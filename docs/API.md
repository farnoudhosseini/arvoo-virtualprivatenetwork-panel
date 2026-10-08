# Arvoo remote management API

Every capability of the panel is available over the same HTTP API the panel
itself uses. There is no separate "admin-only" back door and no endpoint that
only writes database rows: an endpoint that changes infrastructure queue a typed
operation for a node agent (or, for the panel host's firewall, a request for the
privileged helper), and the change is reported as done only after the host
confirms it.

* **Live route inventory:** `GET /api/v1/system/routes` (admin) returns every
  route the running server actually registered, generated from
  `fastify.printRoutes()`. This document explains the shapes, auth, limits and
  semantics. It is a reference, **not** a generated OpenAPI schema — the route
  list is generated, the prose is maintained by hand.
* **Base URL:** `https://<panel-host>/api/v1` (behind nginx). The API itself
  listens on `127.0.0.1:4001` and is never exposed publicly by default.
* **CLI:** `arvoo firewall …`, `arvoo security-audit`, `arvoo management …` use
  these same endpoints, so the CLI can never drift from the panel's behaviour.

## Authentication and authorization

| Mechanism | Header | Notes |
| --- | --- | --- |
| Session token (JWT) | `Authorization: Bearer <token>` | Issued by `POST /auth/login`; alternatively the `arvoo_session` cookie |
| CSRF (cookie mode only) | `x-arvoo-csrf: <value of arvoo_csrf cookie>` | Required on POST/PUT/PATCH/DELETE when the session comes from a cookie |
| Node identity | `Authorization: Bearer arvoo-node <nodeId>:<nodeSecret>` | Agent endpoints only; the secret is compared as a SHA-256 hash |
| Management access secret | `x-arvoo-management: <secret>` | Second factor for the most privileged operations when enabled |

Roles are `admin`, `operator` and `viewer`; each route requires one of them
(`viewer` for reads, `operator` for infrastructure changes, `admin` for identity
and security operations). Privileged operations additionally pass the management
gate when it is enabled, and every mutation is written to `audit_logs`.

Rate limits (per source address, enforced by `@fastify/rate-limit`):

| Endpoint group | Limit |
| --- | --- |
| `POST /auth/login` | 10 / minute |
| Agent hello, heartbeat, status ingest | 300–900 / minute |
| `POST /agent/openvpn-auth` (per VPN connection attempt) | 600 / minute |
| `POST /agent/authorize` | 120 / minute |
| Everything else | default (100 / minute) |

Sessions: absolute lifetime `ARVOO_JWT_TTL_SEC` (12 h) **and** an idle window
`ARVOO_SESSION_IDLE_SEC` (30 min); a stale session is rejected even while its
token is still in date.

## Endpoint groups

### Health

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health`, `/api/v1/health` | none | Application + PostgreSQL state; `503` when the database is unreachable |

### Users and settings

| Method | Path | Role |
| --- | --- | --- |
| GET | `/users` | viewer |
| POST | `/users` | admin |
| PATCH | `/users/:id` | admin |
| GET/PATCH | `/settings` | viewer / admin |
| GET | `/system/security` | admin |
| GET | `/system/routes` | admin |
| GET/POST | `/system/management` | admin (+ management secret to change) |
| POST | `/system/rotate-session-secret` | admin |
| POST | `/maintenance/retention-sweep` | admin |

### Nodes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/nodes`, `/nodes/:id` | Inventory and detail with real telemetry |
| POST | `/nodes` | Register a node (starts `not_enrolled`) |
| PATCH | `/nodes/:id` | Name, region, role, tags, description, SSH port, capacity, bandwidth, admin state (enable/disable/drain) |
| DELETE | `/nodes/:id` | Remove a node |
| POST | `/nodes/:id/enrollment-token` | One-time, short-lived enrollment token |
| POST | `/nodes/:id/approve` \| `/revoke` | Approve or revoke the agent identity |
| GET | `/nodes/:id/capabilities` | Reported GRE/FOU/IPsec/OpenVPN/kernel facts |
| GET | `/metrics/nodes/:id/health` | Recorded health samples |

Agent-facing: `POST /agent/hello`, `POST /agent/heartbeat`,
`GET /agent/operations`, `POST /agent/operations/:id/progress`,
`POST /agent/operations/:id/result`, `POST /agent/authorize`,
`POST /agent/openvpn-auth`, `POST /agent/disconnect`.

### Inbounds (OpenVPN)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/inbounds`, `/inbounds/:id` | Inventory, generated config, versions, deployments |
| POST | `/inbounds` | Create (with structured config: port, transport UDP/TCP, TLS mode, cipher, MTU, auth mode, domain) |
| PATCH | `/inbounds/:id` | Edit any config field, including `domain` and `authMode`; `allowUnverifiedDomain` forces a name whose DNS does not match yet (recorded, never hidden) |
| POST | `/inbounds/validate` | Validate a candidate configuration without saving |
| POST | `/inbounds/:id/deploy` | Queue `CreateOpenVPNInbound` (requires an approved, online agent) |
| POST | `/inbounds/:id/rollback` | Create a new version from an older one |
| POST | `/inbounds/:id/restart` \| `/stop` | Queue the corresponding operation |
| GET | `/inbounds/:id/domain` | Domain, DNS status, resolved addresses, node address |
| POST | `/inbounds/:id/domain-check` | Re-resolve DNS now and store the result |
| DELETE | `/inbounds/:id` | Revoke PKI material and queue removal on the node |

### Clients

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/clients`, `/clients/:id` | Inventory / detail (sessions, devices, usage, policies) |
| POST | `/clients` | Create, optionally with `ovpnUsername`, `ovpnPassword`, placement and inbound assignment |
| PATCH | `/clients/:id` | Display name, description, notes, group, tags, multiplier, all limits, placement fields, password-auth toggle |
| POST | `/clients/:id/username` | Rename (admin + management secret): reissues the certificate, disconnects sessions, audits |
| PUT | `/clients/:id/credentials` | Change OpenVPN username and/or password (admin + management secret) |
| GET | `/clients/:id/credential-impact` | Which password-authenticating inbounds verify this client |
| POST | `/clients/:id/placement` | Preferred node/region/transport, fallback inbound, sticky, failover |
| PUT | `/clients/:id/inbounds` | Replace the inbound assignment set |
| POST | `/clients/:id/config` | Generate an `.ovpn` profile for one assigned inbound |
| POST | `/clients/:id/suspend` \| `/resume` \| `/revoke` \| `/rotate` | Lifecycle |
| POST | `/clients/:id/devices/:deviceId/revoke` | Revoke a device (HWID) |

Credentials are never returned. `ovpnPasswordSetAt` tells you when the password
last changed; the hash exists only on the server.

### Policies, tunnels and routing

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/policies` | List / create policy rules |
| PATCH/DELETE | `/policies/:id` | Update / delete |
| GET/POST | `/tunnels` | List / create GRE tunnels (with FOU/IPsec encapsulation) |
| POST | `/tunnels/mesh` | Create a mesh between node groups |
| POST | `/tunnels/:id/deploy` \| `/test` \| `/benchmark` | Deploy, probe, measure (all real Linux operations) |
| DELETE | `/tunnels/:id` | Delete |
| GET | `/tunnels/mtu-advice` | MTU recommendation from the encapsulation stack |
| GET | `/routing/matrix`, `/routing/probes`, `/routing/assignments`, `/routing/events` | Real path/transport state |
| POST | `/routing/probes/run` | Run probes now |
| POST | `/routing/place` | Explainable placement decision |
| GET/PUT | `/routing/policies` | Routing policy |
| PATCH | `/routing/admin` | Administrative (enable/disable/drain) |

### Load balancing

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/lb/groups` | Every group with members, measured health, reasons, shares and sessions |
| POST | `/lb/groups` | Create (mode, health requirements, failover policy) |
| GET/PATCH/DELETE | `/lb/groups/:id` | Read / update / delete |
| POST | `/lb/groups/:id/members` | Add an inbound or node member (weight, priority, enabled) |
| PATCH/DELETE | `/lb/members/:memberId` | Update weights/priority/enabled / remove |
| POST | `/lb/members/:memberId/drain` \| `/restore` | Drain (no new sessions; existing stay) or restore |
| POST | `/lb/groups/:id/choose` | Which member the next session would use, and why |
| GET | `/lb/groups/:id/events` | Administrative and failover history |
| POST | `/lb/reconcile` | Apply auto-drain/auto-restore policy to measured health |

### Firewall (UFW)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/firewall` | Policy + every host with applied/enabled/in-sync state, ports, warnings, last apply |
| GET | `/firewall/plan?host=<self\|nodeId>` | The plan that would be applied, the exact `ufw` argv arrays, and the diff against what is applied |
| PATCH | `/firewall/policy` | SSH ports, administrative sources, panel ports, ICMP, inactive-inbound behaviour, API exposure, extra rules |
| POST | `/firewall/apply` | `{ host, action: enable \| update \| disable }` — the "Config & Enable UFW" / "Update UFW" buttons |
| GET | `/firewall/history` | Apply history with the real output/error per attempt |

### Operations, audit, alerts

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/operations`, `/operations/:id` | Operation queue with per-step logs |
| GET | `/audit` | Audit log (filterable) |
| GET | `/alerts`, `POST /alerts/:id/resolve` | Alerts and acknowledgement |
| GET | `/dashboard`, `/topology` | Aggregates for the panel |

## Errors

All errors share one shape, with an HTTP status that matches the failure
(never a 200 for a failed change):

```json
{ "error": { "message": "Human readable reason", "details": { "...": "optional" } } }
```

`400` invalid request, `401` unauthenticated, `403` unauthorized/CSRF/management
secret required, `404` not found, `409` conflict (duplicate name/username),
`422` validation failed, `429` rate limited, `503` dependency unavailable
(PostgreSQL or a node that must be online).

## Example

```bash
# Log in and keep the token
TOKEN=$(curl -fsS -X POST https://panel.example.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' | jq -r .token)

# Create a client with a dedicated OpenVPN identity
curl -fsS -X POST https://panel.example.com/api/v1/clients \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"username":"acme.alice","ovpnUsername":"alice.vpn","ovpnPassword":"Str0ngPassw0rd","inboundIds":[]}'

# Open every VPN port of a node and enable UFW there
curl -fsS -X POST https://panel.example.com/api/v1/firewall/apply \
  -H "Authorization: Bearer $TOKEN" -H "x-arvoo-management: $MANAGEMENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"host":"<node-id>","action":"enable"}'
```
