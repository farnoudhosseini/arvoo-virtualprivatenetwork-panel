#!/usr/bin/env bash
# Arvoo shared endpoint — applies the web service next to an existing inbound
# ONLY when the plan approves it, and only with a way back (spec §7/§10/§11).
#
# Subcommands:
#   snapshot before|after <file>  metrics for the before/after table (§5/§18)
#   compare <before> <after>      print the comparison table
#   plan    <plan.json>           show exactly what would be written; changes nothing
#   apply   <plan.json>           backup -> stage -> validate -> reload -> verify -> rollback on failure
#   verify  <plan.json>           check the intended listeners exist and the inbound is untouched
#   rollback                      restore the newest backup and reload the web server
#
# Hard rules enforced here, not just documented:
#   * Only nginx is touched, and only by adding isolated files. nginx.conf is
#     never edited; if the standard include directories are not present, the
#     script refuses and prints the one line a human should add.
#   * A failed `nginx -t` never reaches the running server, and a failed
#     post-reload verification rolls back automatically.
#   * `reload` is used, never `restart`. No inbound service is ever signalled.
#   * Nothing is applied when the plan has no approvals, or when an approval
#     needs a listener move (sni-stream-split) and the operator did not accept
#     that explicitly.

set -uo pipefail

BACKUP_ROOT="${ARVOO_BACKUP_ROOT:-/var/backups/arvoo/endpoint}"
WEB_ROOT="${ARVOO_WEB_ROOT:-/opt/arvoo/web}"
WEB_SERVICE_PORT="${ARVOO_WEB_PORT:-8080}"
WEB_HOSTNAME="${ARVOO_WEB_HOSTNAME:-}"
STREAM_DIR="${ARVOO_STREAM_DIR:-/etc/nginx/streams-enabled}"

log()  { printf '[endpoint-share] %s\n' "$*"; }
warn() { printf '[endpoint-share] WARNING: %s\n' "$*" >&2; }
die()  { printf '[endpoint-share] ERROR: %s\n' "$*" >&2; exit 1; }

need_linux_nginx() {
  [[ "$(uname -s)" == "Linux" ]] || die "this script manages a Linux nginx host; run it on the server (this platform: $(uname -s))"
  command -v nginx >/dev/null 2>&1 || die "nginx is not installed; the web service cannot be shared through a web server that does not exist"
}

nginx_dump() { nginx -T 2>/dev/null; }

listeners_now() {
  if command -v ss >/dev/null 2>&1; then ss -H -lntu 2>/dev/null | awk '{print $1, $5}' | sort -u;
  else netstat -lntu 2>/dev/null | awk 'NR>2 {print $1, $4}' | sort -u; fi
}

reload_nginx() {
  log "reloading nginx gracefully (never restart)"
  if command -v systemctl >/dev/null 2>&1; then systemctl reload nginx || die "nginx reload failed"
  else nginx -s reload || die "nginx reload failed"; fi
}

# ---------------------------------------------------------------------------
# snapshot / compare
# ---------------------------------------------------------------------------

cmd_snapshot() {
  local phase="${1:-}"; local out="${2:-}"
  [[ "$phase" == "before" || "$phase" == "after" ]] || die "usage: endpoint-share.sh snapshot before|after <file>"
  [[ -n "$out" ]] || die "usage: endpoint-share.sh snapshot before|after <file>"
  command -v nginx >/dev/null 2>&1 || die "nginx is not installed on this host"

  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local listeners; listeners="$(listeners_now)"
  local established; established="$(ss -H -tn 2>/dev/null | grep -c ESTAB || echo 0)"
  local latency="unavailable" loss="unavailable" throughput="unavailable"

  if command -v ping >/dev/null 2>&1; then
    local ping_out; ping_out="$(ping -c 10 -i 0.2 -W 2 1.1.1.1 2>/dev/null || true)"
    latency="$(sed -n 's/.*= [0-9.]*\/\([0-9.]*\)\/.*/\1/p' <<<"$ping_out")"
    loss="$(sed -n 's/.* \([0-9]*\)% packet loss.*/\1/p' <<<"$ping_out")"
    [[ -n "$latency" ]] || latency="unavailable"
    [[ -n "$loss" ]] || loss="unavailable"
  fi
  if command -v iperf3 >/dev/null 2>&1 && [[ -n "${ARVOO_BENCH_HOST:-}" ]]; then
    throughput="$(iperf3 -c "$ARVOO_BENCH_HOST" -t 5 -f m 2>/dev/null | sed -n 's/.*receiver.* \([0-9.]*\) Mbits.*/\1/p' | tail -n1)"
    [[ -n "$throughput" ]] || throughput="unavailable"
  fi

  local top_procs; top_procs="$(ps -eo comm=,%cpu=,%mem= --sort=-%cpu 2>/dev/null | head -n 8 | awk '{printf "%s:%s%%cpu/%s%%mem ", $1, $2, $3}')"

  {
    echo "phase=$phase"
    echo "at=$ts"
    echo "latency_avg_ms=$latency"
    echo "packet_loss_pct=$loss"
    echo "throughput_mbps=$throughput"
    echo "established_connections=$established"
    echo "processes=$top_procs"
    echo "listeners_begin"
    echo "$listeners"
    echo "listeners_end"
  } > "$out"
  log "snapshot ($phase) written to $out"
}

cmd_compare() {
  local before="${1:-}" after="${2:-}"
  [[ -n "$before" && -n "$after" ]] || die "usage: endpoint-share.sh compare <before> <after>"
  local metric key
  printf '%-24s %-24s %-24s\n' "Metric" "Before" "After"
  printf '%-24s %-24s %-24s\n' "------------------------" "------------------------" "------------------------"
  for start in $'latency_avg_ms\npacket_loss_pct\nthroughput_mbps\nestablished_connections'; do
    key="$(tr -d '\n' <<<"$start")"
    printf '%-24s %-24s %-24s\n' "$key" \
      "$(sed -n "s/^$key=//p" "$before")" \
      "$(sed -n "s/^$key=//p" "$after")"
  done
  printf '%-24s %-24s %-24s\n' "cpu/mem (top procs)" "$(sed -n 's/^processes=//p' "$before")" "$(sed -n 's/^processes=//p' "$after")"
  local added removed
  added="$(comm -13 <(sed -n '/listeners_begin/,/listeners_end/p' "$before" | sed '1d;$d' | sort) \
                     <(sed -n '/listeners_begin/,/listeners_end/p' "$after"  | sed '1d;$d' | sort) | tr '\n' ';')"
  removed="$(comm -23 <(sed -n '/listeners_begin/,/listeners_end/p' "$before" | sed '1d;$d' | sort) \
                     <(sed -n '/listeners_begin/,/listeners_end/p' "$after"  | sed '1d;$d' | sort) | tr '\n' ';')"
  echo
  echo "listeners added:   ${added:-none}"
  echo "listeners removed: ${removed:-none}"
  if [[ -n "$removed" ]]; then
    warn "a listener disappeared: if it belongs to an existing inbound, roll back immediately"
  fi
}

# ---------------------------------------------------------------------------
# plan rendering
# ---------------------------------------------------------------------------

plan_field() { node -e 'const p=require(process.argv[1]);const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],p);process.stdout.write(v==null?"":String(typeof v==="object"?JSON.stringify(v):v))' "$1" "$2" 2>/dev/null; }

render_web_block() {
  cat <<CONF
# Arvoo web service (loopback only). Generated by scripts/endpoint-share.sh.
# The shared endpoint routes here; this block never listens publicly.
server {
    listen 127.0.0.1:${WEB_SERVICE_PORT};
    server_name ${WEB_HOSTNAME:-_};
    root ${WEB_ROOT};
    index index.html;

    charset utf-8;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    location / {
        try_files \$uri \$uri/ =404;
    }
    location /status.json {
        add_header Cache-Control "no-store" always;
        try_files \$uri =404;
    }
    access_log off;
}
CONF
}

render_vhost_block() {
  local listen_port="$1"
  cat <<CONF
# Arvoo shared endpoint — one isolated virtual host on port ${listen_port}.
# Generated by scripts/endpoint-share.sh; the existing configuration is untouched.
server {
    listen ${listen_port};
    server_name ${WEB_HOSTNAME};

    location / {
        proxy_pass http://127.0.0.1:${WEB_SERVICE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
CONF
}

render_stream_block() {
  local listen_port="$1" inbound_port="$2"
  cat <<CONF
# Arvoo shared endpoint — SNI split with TLS passthrough on port ${listen_port}.
# The inbound keeps TLS; the web hostname is routed to the local web service.
# Generated by scripts/endpoint-share.sh.
stream {
    map \$ssl_preread_server_name \$arvoo_upstream {
        hostnames;
        default            inbound_${inbound_port};
        ${WEB_HOSTNAME}    web_${WEB_SERVICE_PORT};
    }
    upstream inbound_${inbound_port} { server 127.0.0.1:${inbound_port}; }
    upstream web_${WEB_SERVICE_PORT} { server 127.0.0.1:${WEB_SERVICE_PORT}; }

    server {
        listen ${listen_port};
        proxy_pass \$arvoo_upstream;
        ssl_preread on;
    }
}
CONF
}

cmd_plan() {
  local plan="${1:-}"
  [[ -n "$plan" && -f "$plan" ]] || die "usage: endpoint-share.sh plan <plan.json> (produced by scripts/endpoint-verdict.ts --emit-plan)"
  local count; count="$(node -e 'const p=require(process.argv[1]);process.stdout.write(String((p.approved||[]).length))' "$plan")"
  log "plan: $plan — $count approved share(s)"

  if [[ "$count" == "0" ]]; then
    warn "the plan approves nothing: every inspected inbound must be left exactly as it is"
    log "nothing to do; deploy the web service on an independent endpoint instead"
    return 0
  fi

  echo "--- would create /etc/nginx/sites-available/arvoo-web-loopback ---"
  render_web_block
  echo
  node -e '
    const p = require(process.argv[1]);
    for (const entry of p.approved) {
      console.log("--- approved: " + entry.inbound + " (" + entry.method + ", risk " + entry.risk + ") ---");
      for (const change of entry.requiredChanges) console.log("    required: " + change);
    }
    for (const entry of p.refused) console.log("--- left unchanged: " + entry.inbound + " — " + entry.reason);
  ' "$plan"
  echo
  log "plan only: nothing was written, nothing was reloaded"
}

# ---------------------------------------------------------------------------
# apply / verify / rollback
# ---------------------------------------------------------------------------

STAMP=""
STAGED=()

backup_config() {
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  local dir="${BACKUP_ROOT}/${STAMP}"
  mkdir -p "$dir" || die "cannot create backup directory $dir"
  chmod 0700 "$BACKUP_ROOT" 2>/dev/null || true

  local paths
  paths="$(nginx_dump | sed -n 's/^# configuration file \(.*\):$/\1/p' | sort -u)"
  [[ -n "$paths" ]] || die "could not read the list of configuration files from nginx -T; refusing to continue without a backup"
  while read -r file; do
    [[ -r "$file" ]] || continue
    local rel; rel="$(sed 's#^/##; s#/#__#g' <<<"$file")"
    cp -p "$file" "$dir/$rel" || die "failed to back up $file"
  done <<<"$paths"
  nginx_dump > "$dir/nginx-T.txt"
  listeners_now > "$dir/listeners-before.txt"
  echo "$dir"
  log "backed up $(wc -l <<<"$paths") configuration file(s) to $dir"
}

rollback_to() {
  local dir="$1"
  log "rolling back from $dir"
  local file rel
  while read -r file; do
    rel="$(sed 's#^/##; s#/#__#g' <<<"$file")"
    [[ -f "$dir/$rel" ]] || continue
    install -m 0644 "$dir/$rel" "$file" || warn "could not restore $file"
  done < <(nginx_dump | sed -n 's/^# configuration file \(.*\):$/\1/p' | sort -u)

  for staged in "${STAGED[@]}"; do rm -f "$staged" 2>/dev/null || true; done
  if nginx -t >/dev/null 2>&1; then reload_nginx; else die "rolled the files back but nginx -t still fails: restore $dir manually before doing anything else"; fi
  log "rollback complete"
}

install_file() {
  local source="$1" target="$2"
  install -m 0644 "$source" "$target" || die "failed to install $target"
  STAGED+=("$target")
  log "installed $target"
}

cmd_apply() {
  local plan="${1:-}"; shift || true
  local accept_move=0
  for arg in "$@"; do [[ "$arg" == "--accept-listener-move" ]] && accept_move=1; done
  [[ -n "$plan" && -f "$plan" ]] || die "usage: endpoint-share.sh apply <plan.json> [--accept-listener-move]"

  # Refuse on the plan itself before looking at the host: an unapproved plan is
  # never a reason to touch a server, on any platform.
  node -e '
    const p = require(process.argv[1]);
    const approved = p.approved || [];
    if (approved.length === 0) { console.error("[endpoint-share] plan approves nothing: refusing to touch the server"); process.exit(3); }
    const risky = approved.filter((a) => a.method === "sni-stream-split");
    if (risky.length > 0 && process.argv[2] !== "1") {
      console.error("[endpoint-share] plan contains an SNI listener move (" + risky.map((r) => r.inbound).join(", ") + "); re-run with --accept-listener-move after a maintenance window is agreed");
      process.exit(4);
    }
  ' "$plan" "$accept_move" || exit $?

  need_linux_nginx

  # Include directories must exist; nginx.conf is never edited by this script.
  local dump; dump="$(nginx_dump)"
  grep -qE "include .*sites-enabled" <<<"$dump" || die "nginx does not include sites-enabled/*; add that include to nginx.conf yourself, then re-run (this script never edits nginx.conf)"

  local has_stream=0
  grep -qE "^\s*stream\s*\{" <<<"$dump" && has_stream=1

  local backup; backup="$(backup_config)"
  trap 'warn "apply interrupted; rolling back"; rollback_to "'"$backup"'"' ERR INT TERM

  local stage; stage="$(mktemp -d)" || die "cannot create staging directory"
  local target="${WEB_HOSTNAME:?set ARVOO_WEB_HOSTNAME to the public hostname of the web service}"

  # 1. The loopback web service block (required by every approved method).
  render_web_block > "$stage/arvoo-web-loopback"

  # 2. Route the public hostname to it, using the method the plan approved.
  local method; method="$(node -e 'const p=require(process.argv[1]);const m=[...new Set((p.approved||[]).map(a=>a.method))];process.stdout.write(m.join(","))' "$plan")"
  case "$method" in
    *http-vhost*)
      local listen_port; listen_port="$(node -e 'const p=require(process.argv[1]);const a=(p.approved||[]).find(x=>x.method==="http-vhost");process.stdout.write(String((a&&a.listenPort)||80))' "$plan")"
      render_vhost_block "$listen_port" > "$stage/arvoo-shared-endpoint"
      ;;
    *sni-stream-split*)
      [[ "$has_stream" == "1" ]] || die "the plan needs a stream{} split but nginx has no stream include; add /etc/nginx/streams-enabled/* to nginx.conf yourself and re-run"
      local listen_port inbound_port
      listen_port="$(node -e 'const p=require(process.argv[1]);const a=(p.approved||[]).find(x=>x.method==="sni-stream-split");process.stdout.write(String((a&&a.listenPort)||443))' "$plan")"
      inbound_port="${ARVOO_INBOUND_LOOPBACK_PORT:-}"
      [[ -n "$inbound_port" ]] || die "an SNI split moves the inbound to a loopback port; set ARVOO_INBOUND_LOOPBACK_PORT to the port the inbound will move to (it is not guessed here)"
      render_stream_block "$listen_port" "$inbound_port" > "$stage/arvoo-shared-endpoint"
      ;;
    *inbound-native-fallback*)
      # Nothing for nginx to route: the inbound itself forwards to our loopback
      # service. That change is made in the inbound's own configuration, which
      # this script deliberately does not touch.
      log "approved method is the inbound's own fallback: no nginx routing block is needed"
      log "next step (documented, not automated): point the inbound fallback at 127.0.0.1:${WEB_SERVICE_PORT}"
      ;;
    *)
      die "no supported method in the plan"
      ;;
  esac

  install_file "$stage/arvoo-web-loopback" /etc/nginx/sites-available/arvoo-web-loopback
  ln -sfn /etc/nginx/sites-available/arvoo-web-loopback /etc/nginx/sites-enabled/arvoo-web-loopback
  STAGED+=("/etc/nginx/sites-enabled/arvoo-web-loopback")

  if [[ -f "$stage/arvoo-shared-endpoint" ]]; then
    if [[ "$method" == *sni-stream-split* ]]; then
      install_file "$stage/arvoo-shared-endpoint" "${STREAM_DIR}/arvoo-shared-endpoint.conf"
    else
      install_file "$stage/arvoo-shared-endpoint" /etc/nginx/sites-available/arvoo-shared-endpoint
      ln -sfn /etc/nginx/sites-available/arvoo-shared-endpoint /etc/nginx/sites-enabled/arvoo-shared-endpoint
      STAGED+=("/etc/nginx/sites-enabled/arvoo-shared-endpoint")
    fi
  fi

  # 3. Validate BEFORE anything reaches the running server.
  if ! nginx -t; then
    warn "nginx -t rejected the new configuration"
    rollback_to "$backup"
    die "configuration rejected; the previous state has been restored"
  fi
  log "nginx -t passed"

  # 4. Reload (never restart) and verify.
  reload_nginx
  sleep 1

  local before_listeners="${backup}/listeners-before.txt"
  if ! comm -23 <(sort "$before_listeners") <(listeners_now | sort) | grep -q .; then
    log "verification: every listener that existed before is still present"
  else
    warn "a listener that existed before the change is gone"
    rollback_to "$backup"
    die "verification failed; rolled back"
  fi

  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: ${target}" "http://127.0.0.1:${WEB_SERVICE_PORT}/" 2>/dev/null)"
    [[ "$code" == "200" ]] && log "web service answers 200 on the loopback port" || warn "web service returned ${code:-no response} on 127.0.0.1:${WEB_SERVICE_PORT}"
  fi

  trap - ERR INT TERM
  log "applied. Backup: $backup"
  log "compare performance with: $0 compare <before> <after>"
}

cmd_rollback() {
  need_linux_nginx
  local newest; newest="$(ls -1d "${BACKUP_ROOT}"/*/ 2>/dev/null | sort | tail -n1)"
  [[ -n "$newest" ]] || die "no backup found under ${BACKUP_ROOT}; nothing to roll back to"
  STAGED=()
  rollback_to "${newest%/}"
}

cmd_verify() {
  local plan="${1:-}"
  need_linux_nginx
  log "verify: comparing current listeners with the state recorded before the change"
  local newest; newest="$(ls -1d "${BACKUP_ROOT}"/*/ 2>/dev/null | sort | tail -n1)"
  [[ -n "$newest" ]] || die "no recorded before-state found under ${BACKUP_ROOT}"
  local lost
  lost="$(comm -23 <(sort "${newest%/}/listeners-before.txt") <(listeners_now | sort))"
  if [[ -n "$lost" ]]; then
    warn "listeners present before the change are missing now:"
    echo "$lost" >&2
    exit 1
  fi
  log "all previously listening sockets are still listening"
  if [[ -n "$plan" && -f "$plan" ]]; then
    log "web service on 127.0.0.1:${WEB_SERVICE_PORT}: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${WEB_SERVICE_PORT}/" 2>/dev/null)"
  fi
}

case "${1:-}" in
  snapshot) shift; cmd_snapshot "$@" ;;
  compare)  shift; cmd_compare "$@" ;;
  plan)     shift; cmd_plan "$@" ;;
  apply)    shift; cmd_apply "$@" ;;
  verify)   shift; cmd_verify "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  -h|--help|"") sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown subcommand: $1 (try --help)" ;;
esac
