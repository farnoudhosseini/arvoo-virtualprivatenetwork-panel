# Arvoo update — quality, TCP boost, traffic, UFW, edit

## Critical fixes
1. **Client traffic was always zero**
   - Status path was `/var/log/arvoo/...` but agent read `/etc/arvoo/...`
   - Missing `status-version 3` so CSV CLIENT_LIST was never produced
   - Parser now supports v1 + v3 and both paths

2. **UFW too tight**
   - Inbound ports now open for any non-stopped inbound (not only status=active)
   - `includeInactiveInbounds` defaults to true
   - GRE + FOU + IPsec peer rules still built from tunnels

3. **OpenVPN reliability** (previous session, kept)
   - `dh none`, no `user nobody`, auth hook fixed, HTTP control plane when needed

## New performance
- Profile **`tcp-boost`**: 1MB sndbuf/rcvbuf, TCP_NODELAY, MTU 1360 / MSS 1320, high txqueuelen — for TCP-only paths (UDP blocked in IR)
- **low-latency / throughput / balanced** retuned with larger buffers and tcp-nodelay on TCP
- Server pushes sndbuf/rcvbuf to clients

## Panel control
- Inbound **Delete** + **Edit configuration** (profile, MTU, MSS) then Deploy
- Tunnel create: optional **FOU UDP port** for GRE-over-UDP
- Profile list includes TCP Boost in the builder

## Safe panel updates
- `./install.sh --update` rebuilds panel only; does **not** restart OpenVPN/GRE on nodes
- Update agents with `./install.sh --node` when agent code changes; OpenVPN processes keep running until an inbound Deploy

## Operator tips (Iran / TCP)
1. Create inbound with transport **TCP**, profile **tcp-boost**
2. Through-tunnel: policy route VPN subnet via GRE; NAT only on egress
3. After this update: Deploy inbound once so status-version 3 + buffers apply
4. Re-apply UFW from panel after update so ports open correctly
5. YouTube: `block-outside-dns` in config; client may still need browser QUIC off on some paths
