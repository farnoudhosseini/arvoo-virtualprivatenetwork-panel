# Arvoo — shared endpoint (web + existing inbound): inspection, rules, and verdict

Date: 2026-10-08. Scope: whether a legitimate Arvoo HTTP/HTTPS site can share an
existing inbound's endpoint without changing how existing clients connect.

**Final decision for production: `NOT SAFE TO IMPLEMENT — EXISTING INBOUND LEFT
UNCHANGED`.** Not because sharing is impossible in general, but because the
mandatory inspection (spec §1) could not be performed: the Arvoo production host
is not reachable from this workspace, and no server-side state was available to
inspect. Nothing on any server was changed. What this change delivers instead is
the machinery that makes the operation correct *on* the real host.

## 1. What was actually inspected

The workspace machine (the only system reachable here) was inspected for real:

| Port | Protocol | Process | Owner | Notes |
| ---: | --- | --- | --- | --- |
| 80 | tcp | `httpd.exe` (PID 4288) | Windows service | Apache already owns the web port |
| 443 | tcp | `httpd.exe` (PID 4288) | Windows service | TLS terminated by Apache |
| 21 | tcp | `FileZillaServer.exe` (PID 4344) | Windows service | FTP control |
| 3306 | tcp | `mysqld.exe` (PID 4648) | Windows service | MySQL |
| 10808 | tcp | `xray.exe` (PID 2300) | user session | Xray **client** inbound, loopback only |
| 53 | udp | PID 3892 | local resolver | not an inbound |

Absent on this host: nginx, OpenVPN, Docker, systemd, nftables, iptables, `ss`,
`iproute2`. There is no Arvoo inbound to share here, and the repository contains
no SSH/deploy configuration pointing at the production server, so the production
port matrix could not be produced. Reporting a matrix from anything other than
real state would be exactly the fake result the brief forbids.

Consequences for the spec's phases: **INSPECT could not be completed for
production**, therefore MAP PORTS → BUILD COMPATIBILITY MATRIX → SELECT
ARCHITECTURE → BACKUP → IMPLEMENT were not run against it. No port was changed,
no nginx configuration was touched, no service was reloaded, and no client
configuration was altered.

## 2. Compatibility rules (the matrix, as executable code)

Because the matrix must come from real observations, the rules that build it live
in `packages/shared/src/endpoint-sharing.ts` and are unit-tested (13 tests in
`packages/shared/src/endpoint-sharing.test.ts`). Given an observed inbound they
return: possible / risk / method / required changes / rollback / what must never
be done. Summary of the decision table:

| Observed inbound | Shown as | Web sharing | Method | Risk |
| --- | --- | --- | --- | --- |
| UDP-only (WireGuard, OpenVPN UDP, QUIC/Hysteria) | `udp` | **no** | — | blocked |
| Owns both TCP and UDP on one port | `both` | **no** | — | blocked |
| Raw IP protocol (GRE, ESP/AH, IPIP) | any | **no** | — | blocked |
| Reality-style TLS passthrough to a third party | `passthrough-sni` | **no** | — | blocked |
| No TLS and no HTTP semantics (Shadowsocks) | `none` | **no** | — | blocked |
| Port already owned by another process | any | **no** | — | blocked |
| A web server already fronts it | `terminated-by-proxy` | yes | `http-vhost` | low |
| The protocol has its own fallback (Trojan, Xray fallback) | `inbound-fallback` | yes | `inbound-native-fallback` | low |
| Plain HTTP service | `http` | yes | `http-vhost` | low |
| ALPN-splittable in front of TLS | `alpn` | yes | `alpn-stream-split` | medium |
| Ends TLS itself and routes by SNI | `sni` | yes | `sni-stream-split` | high |

Rules that are enforced, not merely documented: UDP is never proxied; TLS is
never re-terminated to add a website; a share that would require a client
configuration change is refused; anything unknown is `blocked`, not "probably
fine".

## 3. Delivered tooling (safe order, each step refuses when it should)

```bash
# 1. INSPECT — read-only; emits the human map and machine-readable state
./scripts/endpoint-inspect.sh --json /root/endpoint-inspection.json

# 2. RULES — compatibility matrix + per-inbound decision + plan (changes nothing)
npx tsx scripts/endpoint-verdict.ts /root/endpoint-inspection.json \
    --web-port 8080 --web-hostname web.example \
    --emit-plan /root/endpoint-plan.json

# 3. BASELINE — before/after metrics for the comparison table (spec §5/§18)
ARVOO_BENCH_HOST=10.66.0.2 ./scripts/endpoint-share.sh snapshot before /root/before.txt

# 4. PLAN — show every file that would be written; still changes nothing
./scripts/endpoint-share.sh plan /root/endpoint-plan.json

# 5. APPLY — backup -> stage -> nginx -t -> graceful reload -> verify, and
#    automatic rollback if validation or verification fails
ARVOO_WEB_HOSTNAME=web.example WEB_SERVICE_PORT=8080 \
    ./scripts/endpoint-share.sh apply /root/endpoint-plan.json

# 6. MEASURE — same metrics after, then compare
ARVOO_BENCH_HOST=10.66.0.2 ./scripts/endpoint-share.sh snapshot after /root/after.txt
./scripts/endpoint-share.sh compare /root/before.txt /root/after.txt

# 7. VERIFY / ROLLBACK
./scripts/endpoint-share.sh verify /root/endpoint-plan.json
./scripts/endpoint-share.sh rollback
```

Guarantees built into `scripts/endpoint-share.sh`: `nginx.conf` is **never**
edited (if the standard `sites-enabled` include is missing, it refuses and prints
the line for a human to add); a failed `nginx -t` is rolled back before it can
reach the running server; `reload` is always used, never `restart`; no inbound
service is ever signalled; a listener that existed before and is gone afterwards
triggers an automatic rollback; an SNI listener move requires an explicit
`--accept-listener-move`.

## 4. The web service

`deploy/endpoint-web/` is a static, dependency-free site (no third-party
requests, no analytics, no login, no forms, no credential collection):

- Persian RTL by default with an English LTR switch; identifiers (ports, IPs,
  timestamps) are bidi-isolated so they cannot be reordered by the browser.
- Dark graphite with the Arvoo red used only where a real state exists.
- A status board that reads the server's own `status.json`. Missing data shows
  as "not reported", a report older than five minutes is labelled stale, and when
  the file cannot be read, every derived value is cleared — stale numbers are
  never left on screen looking current.
- `scripts/endpoint-status.sh` generates `status.json` from real listener state
  and real certificate expiry (`openssl x509`); a service that is not listening
  is written as `down`.

`deploy/endpoint-inspection.example.json` is a **sample** used to exercise the
rules; it is not measured production state.

## 5. Verification performed here

- `npx vitest run packages/shared/src/endpoint-sharing.test.ts` — 13 passing.
- `npx tsx scripts/endpoint-verdict.ts deploy/endpoint-inspection.example.json`
  — matrix renders; 2 of 6 inbounds shareable, 4 refused with reasons (Reality
  passthrough, UDP-only, UDP+TCP, raw GRE).
- `scripts/endpoint-share.sh`: `bash -n` clean; `plan` renders the proposed
  configuration without touching anything; `apply` with an empty plan exits 3 and
  refuses; `apply` on a non-Linux host exits 1; `snapshot` refuses without nginx.
- Site: served locally and checked in the browser — Persian RTL and English LTR,
  live rows for real observed listeners, red for the `down` entry, "not reported"
  for absent certificates, stale-window note after 40 minutes, and full clearing
  of derived values when `status.json` disappears. One real bug was found this
  way and fixed (stale facts/table left behind on failure).

## 6. Not done, and why

- No production change of any kind, no before/after performance numbers from a
  real inbound, and no measurement of connection success or packet loss: these
  require the actual server, which is not reachable from this workspace.
- No claim of "zero impact" — the numbers do not exist yet. Collect them with the
  snapshot/compare pair above, on the real host.
- The site is verified as a static artifact only; certificate and listener values
  it displays will come from `endpoint-status.sh` on the server.

## 7. What the operator should do next, on the real host

1. Run `endpoint-inspect.sh --json` and keep the file: it is the port matrix.
2. Run `endpoint-verdict.ts` on it; only inbounds it approves may be shared.
3. Take the `before` snapshot, then `plan`, then read it.
4. Apply during a window, then `snapshot after` and `compare`.
5. If any metric meaningfully degrades, `rollback` and leave the inbound alone;
   deploy the website on an independent endpoint instead.
