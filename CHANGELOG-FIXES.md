# Arvoo panel fixes (session summary)

## OpenVPN connectivity
- Client profile: correct `tls-crypt` inline blocks, `verify-x509-name "CN" name`
- Server config: `dh none` (fixes "You must define DH file")
- Do not drop to `nobody` (auth hooks need node-secret + control plane)
- `block-outside-dns` for Windows DNS / streaming sites
- Agent: create `/var/log` + `/run` dirs; inject `dh none` if missing; wait for port listen
- Auth hook JS: fixed broken regex escaping; use HTTP control plane URL when needed
- Egress payload: `masqueradeSourceNetworks` always an array; through-tunnel uses null on OpenVPN op + ApplyFirewallPolicy on egress node

## Through-tunnel routing
- Documented/required: policy route table from VPN subnet via GRE; NAT on egress node only
- Local eth0 MASQUERADE on ingress breaks "tunnel exit IP" — remove it for through-tunnel

## Installer / panel
- ACME email: never `root@hostname`; use `admin@domain` / ARVOO_EMAIL
- No duplicate nginx `default_server` (public site vs panel)
- Panel URL `/panel/` on ports 80/443; API loopback `:4001`
- Final report prints Panel URL, public ports, path
- Node install: auto-build agent when `dist/` missing
- Control-plane health check clearer errors; HTTP `/health` + `/api` without forced HTTPS redirect

## UI
- Inbound detail: **Delete** button (calls DELETE /api/v1/inbounds/:id)
- API already had PATCH update + DELETE; deploy/restart/stop present

## Operator notes
1. Agent control plane URL for this network may need `http://` if HTTPS path drops responses after TLS
2. After deploy, verify: `ss -ltnp | grep PORT`, auth hook `hook_exit=0`, `ip rule` for through-tunnel
3. Re-deploy inbound after pulling these sources so server.conf regenerates with dh none / no nobody / block-outside-dns
