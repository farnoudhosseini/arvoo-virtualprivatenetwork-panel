#!/usr/bin/env bash
# Arvoo shared-endpoint inspection — READ ONLY (spec §1/§2/§16).
#
# Maps what is actually running on a server: TCP and UDP listeners, the process
# and systemd unit or container behind each one, the web server's configuration
# and certificates, and the firewall state. It changes nothing, restarts
# nothing and needs no root for most of its output (root, or sudo without a
# password prompt, only improves process ownership detail).
#
# Usage:
#   ./scripts/endpoint-inspect.sh                 # human report on stdout
#   ./scripts/endpoint-inspect.sh --json out.json # also write machine-readable state
#   ./scripts/endpoint-inspect.sh --help
#
# The JSON is what `scripts/endpoint-verdict.ts` consumes: it classifies the
# observed inbounds so the compatibility rules can run on real state instead of
# on assumptions. Classification is deliberately conservative — anything the
# script cannot prove is reported as "unknown" with low confidence.

set -uo pipefail

JSON_OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUT="${2:-}"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  cat >&2 <<'EOF'
This inspection targets a Linux server and uses Linux-only tooling
(ss, systemd, nft, iproute2, /proc). It was invoked on a different platform.

Run it on the host that actually serves the inbounds:
    scp scripts/endpoint-inspect.sh root@HOST:/root/ && ssh root@HOST /root/endpoint-inspect.sh --json /root/endpoint-inspection.json

Nothing was inspected and nothing was changed.
EOF
  exit 2
fi

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Collectors (all read-only)
# ---------------------------------------------------------------------------

collect_listeners() {
  if have ss; then
    # -H hides the header, -l listening, -n numeric, -t TCP, -u UDP, -p processes.
    ss -H -lntup 2>/dev/null
  else
    netstat -lntup 2>/dev/null | tail -n +3
  fi
}

pid_of() { sed -n 's/.*pid=\([0-9]\+\).*/\1/p' <<<"$1" | head -n1; }
proc_of() { sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' <<<"$1" | head -n1; }

unit_of_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  if have systemctl; then
    systemctl show -p Id --value "$(cat /proc/"$pid"/cgroup 2>/dev/null | sed -n 's/.*\/\([^/]*\.service\).*/\1/p' | head -n1)" 2>/dev/null
  fi
}

container_of_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  sed -n 's/.*\/docker\/\([0-9a-f]\{12\}\).*/\1/p' /proc/"$pid"/cgroup 2>/dev/null | head -n1
}

collect_nginx() {
  have nginx || return 0
  nginx -v 2>&1 | head -n1
  echo "-- server_names --"
  nginx -T 2>/dev/null | grep -E "^\s*server_name" | sed 's/^\s*//' | sort -u
  echo "-- tls certificates --"
  nginx -T 2>/dev/null | grep -E "^\s*ssl_certificate\s" | sed 's/^\s*//' | sort -u
  echo "-- stream blocks --"
  nginx -T 2>/dev/null | grep -cE "^\s*stream\s*\{" || echo 0
  echo "-- listens --"
  nginx -T 2>/dev/null | grep -E "^\s*listen\s" | sed 's/^\s*//' | sort -u
}

cert_expiry() {
  local file="$1"
  [[ -r "$file" ]] || { echo "unreadable"; return 0; }
  have openssl || { echo "openssl-absent"; return 0; }
  openssl x509 -noout -enddate -subject -in "$file" 2>/dev/null | tr '\n' ' ' || echo "unreadable"
}

collect_firewall() {
  if have nft; then
    echo "nft_table_count=$(nft list ruleset 2>/dev/null | grep -c '^table' || echo 0)"
    nft list ruleset 2>/dev/null | grep -E "^\s*(tcp|udp) dport (443|80|1194|51820|8443)" | sed 's/^\s*//' | head -n 20
  fi
  if have iptables; then
    echo "iptables_rule_count=$(iptables -S 2>/dev/null | wc -l)"
  fi
}

collect_forwarding() {
  echo "ipv4_forwarding=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo unknown)"
  if have ip; then
    ip -brief addr 2>/dev/null | head -n 20
    echo "-- routes --"
    ip route 2>/dev/null | head -n 20
  fi
}

# ---------------------------------------------------------------------------
# Classification (evidence-based, conservative)
# ---------------------------------------------------------------------------

classify() {
  local proc="$1" port="$2" proto="$3"
  local protocol="other" tls="unknown" mux="unknown" confidence="low" note=""

  case "$proc" in
    xray|v2ray|sing-box)
      protocol="vless"
      note="proxy core: protocol/transport and TLS ownership must be confirmed in its own config"
      ;;
    openvpn)
      protocol="openvpn"
      tls="terminated-by-inbound"
      mux="none"
      note="OpenVPN ends TLS itself; clients connect by IP, so there is no SNI or ALPN to split on"
      ;;
    wg|wireguard-go)
      protocol="wireguard"
      tls="none"
      mux="none"
      note="WireGuard is UDP with no TLS and no HTTP semantics"
      ;;
    trojan|trojan-go)
      protocol="trojan"
      tls="terminated-by-inbound"
      mux="inbound-fallback"
      note="Trojan forwards non-matching traffic to its configured fallback address"
      ;;
    hysteria|hysteria2|tuic)
      protocol="other"
      note="QUIC-based transport (UDP): cannot share a TCP web endpoint"
      ;;
    nginx)
      protocol="http"
      tls="terminated-by-proxy"
      mux="http-vhost"
      note="web server already listening here"
      ;;
    apache2|httpd|httpd.exe)
      protocol="http"
      tls="terminated-by-proxy"
      mux="http-vhost"
      note="web server already listening here"
      ;;
    sshd)
      protocol="other"
      note="management service; not an inbound and never to be shared"
      ;;
  esac

  if [[ "$proto" == "udp" && "$protocol" == "other" ]]; then
    protocol="other"
    note="${note:-UDP service, not shareable with a TCP website}"
  fi

  printf '%s|%s|%s|%s|%s|%s' "$protocol" "$tls" "$mux" "$confidence" "$note" "$port"
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

echo "Arvoo shared-endpoint inspection"
echo "host=$(hostname 2>/dev/null || echo unknown)  kernel=$(uname -r)  date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

LISTENERS="$(collect_listeners)"
if [[ -z "$LISTENERS" ]]; then
  echo "No listener information available: install iproute2 (ss) or net-tools (netstat)." >&2
  exit 3
fi

printf '%-7s %-24s %-7s %-18s %-18s %s\n' "PROTO" "LOCAL" "PID" "PROCESS" "UNIT/CONTAINER" "CLASSIFICATION"
echo "-----------------------------------------------------------------------------------------------------"

INBOUNDS_JSON="[]"
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  proto_port="${line%% *}"
  proto="${proto_port%%[0-9]*}"
  proto="${proto:0:3}"
  local_addr="$(awk '{print $4}' <<<"$line")"
  port="${local_addr##*:}"
  pid="$(pid_of "$line")"
  proc="$(proc_of "$line")"
  [[ -n "$proc" ]] || proc="$(ps -o comm= -p "$pid" 2>/dev/null || echo unknown)"
  owner="$(unit_of_pid "$pid")"
  [[ -n "$owner" ]] || owner="$(container_of_pid "$pid")"
  [[ -n "$owner" ]] || owner="-"

  proto="${proto//[^a-z]/}"
  case "$proto" in
    tcp*) proto="tcp" ;;
    udp*) proto="udp" ;;
    *) proto="tcp" ;;
  esac

  classified="$(classify "$proc" "$port" "$proto")"
  IFS='|' read -r protocol tls mux confidence note _ <<<"$classified"

  printf '%-7s %-24s %-7s %-18s %-18s %s\n' "$proto" "$local_addr" "${pid:-?}" "$proc" "$owner" "$protocol (tls=$tls mux=$mux)"

  INBOUNDS_JSON="$(node -e '
    const list = JSON.parse(process.argv[1]);
    list.push({
      name: process.argv[2] + "/" + (process.argv[3] || "unknown") + ":" + process.argv[4],
      protocol: process.argv[5],
      transport: process.argv[6],
      tls: process.argv[7],
      multiplexing: process.argv[8],
      ports: [Number(process.argv[4])],
      evidence: [process.argv[9]],
      confidence: process.argv[10],
    });
    process.stdout.write(JSON.stringify(list));
  ' "$INBOUNDS_JSON" "$(hostname 2>/dev/null || echo host)" "$proc" "$port" "$protocol" "$proto" "$tls" "$mux" "$note" "$confidence" 2>/dev/null || echo "$INBOUNDS_JSON")"
done <<<"$LISTENERS"

echo
echo "== Web server =="
collect_nginx || echo "nginx not installed"
echo
echo "== Certificates =="
if have nginx; then
  while read -r cert; do
    cert_path="$(awk '{print $2}' <<<"$cert" | tr -d ';')"
    [[ -n "$cert_path" ]] || continue
    printf '%s -> %s\n' "$cert_path" "$(cert_expiry "$cert_path")"
  done < <(nginx -T 2>/dev/null | grep -E "^\s*ssl_certificate\s")
else
  echo "no web server certificate inventory"
fi
echo
echo "== Firewall =="
collect_firewall || true
echo
echo "== Networking =="
collect_forwarding || true

if [[ -n "$JSON_OUT" ]]; then
  umask 022
  node -e '
    const fs = require("node:fs");
    const out = process.argv[1];
    const inbounds = JSON.parse(process.argv[2]);
    const payload = {
      generatedAt: new Date().toISOString(),
      host: process.argv[3],
      kernel: process.argv[4],
      inbounds,
      note: "Classification is heuristic and low-confidence by default: confirm protocol, TLS ownership and multiplexing in each service own configuration before acting on it.",
    };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    console.log("wrote " + out + " (" + inbounds.length + " listener(s))");
  ' "$JSON_OUT" "$INBOUNDS_JSON" "$(hostname 2>/dev/null || echo host)" "$(uname -r)"
fi

echo
echo "Read-only inspection complete. Nothing was modified."
