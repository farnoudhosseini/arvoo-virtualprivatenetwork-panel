#!/usr/bin/env bash
#
# Arvoo Control Plane - PostgreSQL backup (pg_dump).
#
# Backups are written OUTSIDE the PostgreSQL data directory. Retention keeps
# the newest ARVOO_BACKUP_KEEP (default 14) dumps and deletes older ones.
#
# Usage:
#   scripts/backup.sh                  # dump to /var/backups/arvoo (default)
#   BACKUP_DIR=/mnt/backups scripts/backup.sh
#
# Wired as a system cron job by install.sh (/etc/cron.d/arvoo-backup) at
# 02:30 daily. Credentials are read from /etc/arvoo.env, so the cron job must
# run as root (the file is mode 0640 root:arvoo).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/arvoo}"
KEEP="${ARVOO_BACKUP_KEEP:-14}"
ENV_FILE="${ARVOO_ENV_FILE:-/etc/arvoo.env}"
PG_DUMP="${PG_DUMP:-pg_dump}"

log() { echo "[arvoo-backup] $*" >&2; }

if ! command -v "$PG_DUMP" >/dev/null 2>&1; then
  log "ERROR: pg_dump not found. Install postgresql-client: apt-get install -y postgresql-client"
  exit 1
fi

# Read DATABASE_URL from the environment file. The value is never printed.
if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ ! -r "$ENV_FILE" ]]; then
    log "ERROR: DATABASE_URL not set and $ENV_FILE not readable."
    exit 1
  fi
  # Extract only the DATABASE_URL assignment; ignore comments and blanks.
  DATABASE_URL="$(grep -E '^[[:space:]]*DATABASE_URL=' "$ENV_FILE" | head -n1 | sed -E 's/^[[:space:]]*DATABASE_URL=//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')" || true
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  log "ERROR: DATABASE_URL is empty."
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 0750 "$BACKUP_DIR"

TS="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/arvoo-$TS.sql.gz"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Custom-format dump piped through gzip; single-transaction keeps a running
# server consistent. pg_dump reads the connection string from the environment
# (never from the command line, so it stays out of the process table).
if ! DATABASE_URL="$DATABASE_URL" "$PG_DUMP" --no-owner --no-privileges -Z 6 -f "$TMP" 2>/dev/null; then
  log "ERROR: pg_dump failed."
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
chmod 0640 "$OUT"

# Retention: keep the newest $KEEP dumps.
if [[ -n "${KEEP//[!0-9]/}" ]] && [[ "$KEEP" -gt 0 ]]; then
  ls -1dt "$BACKUP_DIR"/arvoo-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
    rm -f "$old"
  done
fi

log "wrote $OUT"
