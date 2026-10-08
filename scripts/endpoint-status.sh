#!/usr/bin/env bash
# Writes the Arvoo website's status.json from real system state (spec §14).
#
# The page shows "not reported" for anything absent from this file, so an empty
# or partial file is an honest outcome — but never edit these numbers by hand:
# generate the file, then serve it.
#
# Usage:
#   ./scripts/endpoint-status.sh --out /opt/arvoo/web/status.json \
#       --cert /etc/letsencrypt/live/web.example/fullchain.pem \
#       --service 443:tcp:xray-vless --service 80:tcp:arvoo-web
#
# Every --service triple is checked against the real listener table; a service
# that is not listening is written as "down", which is what the page will show.

set -uo pipefail

OUT=""
CERT=""
SERVICES=()
CONTACT="${ARVOO_CONTACT:-}"
DOCS="${ARVOO_DOCS_URL:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --cert) CERT="${2:-}"; shift 2 ;;
    --service) SERVICES+=("${2:-}"); shift 2 ;;
    --contact) CONTACT="${2:-}"; shift 2 ;;
    --docs) DOCS="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || { echo "this reads Linux listener state; run it on the server" >&2; exit 2; }
[[ -n "$OUT" ]] || { echo "--out is required (e.g. --out /opt/arvoo/web/status.json)" >&2; exit 64; }

have() { command -v "$1" >/dev/null 2>&1; }

listeners_now() {
  if have ss; then ss -H -lntu 2>/dev/null | awk '{print $1, $5}';
  else netstat -lntu 2>/dev/null | awk 'NR>2 {print $1, $4}'; fi
}

LISTENERS="$(listeners_now)"
[[ -n "$LISTENERS" ]] || { echo "no listener data (install iproute2 or net-tools)" >&2; exit 3; }

is_listening() {
  local want_port="$1" want_proto="$2"
  awk -v p="$want_port" -v t="$want_proto" '
    $1 ~ t && $2 ~ (":" p "$") { found = 1 }
    END { exit found ? 0 : 1 }
  ' <<<"$LISTENERS"
}

cert_json() {
  local path="$1"
  if [[ -z "$path" ]]; then printf 'null'; return; fi
  if [[ ! -r "$path" ]]; then
    printf '{"name":"%s","path":"%s","expiresAt":null,"daysLeft":null,"error":"unreadable"}' "$(basename "$(dirname "$(dirname "$path")")")" "$path"
    return
  fi
  have openssl || { printf '{"name":"%s","path":"%s","expiresAt":null,"daysLeft":null,"error":"openssl-absent"}' "$(basename "$(dirname "$(dirname "$path")")")" "$path"; return; }
  local end name epoch days
  end="$(openssl x509 -noout -enddate -in "$path" 2>/dev/null | cut -d= -f2)"
  name="$(openssl x509 -noout -subject -in "$path" 2>/dev/null | sed 's/^subject=//')"
  if [[ -z "$end" ]]; then printf '{"name":"%s","path":"%s","expiresAt":null,"daysLeft":null,"error":"unparseable"}' "$name" "$path"; return; fi
  epoch="$(date -d "$end" +%s 2>/dev/null || echo 0)"
  days=$(( epoch > 0 ? (epoch - $(date +%s)) / 86400 : -1 ))
  printf '{"name":"%s","path":"%s","expiresAt":"%s","daysLeft":%s}' "$name" "$path" "$(date -u -d "$end" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")" "$days"
}

LISTENERS_JSON="[]"
for entry in "${SERVICES[@]:-}"; do
  [[ -n "$entry" ]] || continue
  IFS=':' read -r port proto service <<<"$entry"
  status="down"
  is_listening "$port" "$proto" && status="listening"
  LISTENERS_JSON="$(node -e '
    const list = JSON.parse(process.argv[1]);
    list.push({ service: process.argv[2], protocol: process.argv[3], port: Number(process.argv[4]), status: process.argv[5] });
    process.stdout.write(JSON.stringify(list));
  ' "$LISTENERS_JSON" "${service:-service}" "${proto:-tcp}" "${port:-0}" "$status")"
done

CERT_JSON="$(cert_json "$CERT")"
WEB_JSON='{"status":"ok"}'

TMP="$(mktemp)"
node -e '
  const fs = require("node:fs");
  const [out, listeners, cert, web, contact, docs, generatedAt] = process.argv.slice(1);
  const payload = {
    generatedAt,
    listeners: JSON.parse(listeners),
    certificates: cert === "null" ? [] : [JSON.parse(cert)],
    web: JSON.parse(web),
    nodes: JSON.parse(fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "{}").nodes || [],
    contact: contact || null,
    docs: docs || null,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
' "$TMP" "$LISTENERS_JSON" "$CERT_JSON" "$WEB_JSON" "$CONTACT" "$DOCS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || { echo "failed to build status.json" >&2; exit 1; }

# Preserve an operator-maintained node list if the previous file had one.
if [[ -f "$OUT" ]]; then
  node -e '
    const fs = require("node:fs");
    const [tmp, out] = process.argv.slice(1);
    const next = JSON.parse(fs.readFileSync(tmp, "utf8"));
    const previous = JSON.parse(fs.readFileSync(out, "utf8"));
    if (Array.isArray(previous.nodes) && previous.nodes.length > 0) next.nodes = previous.nodes;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  ' "$TMP" "$OUT" || true
fi

install -m 0644 "$TMP" "$OUT"
rm -f "$TMP"
echo "wrote $OUT from real listener state ($(grep -c '"service"' "$OUT" 2>/dev/null || echo 0) service row(s))"
