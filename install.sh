#!/usr/bin/env bash
#
# Arvoo Control Plane - Ubuntu 24.04 installer and maintenance script.
#
# Commands:
#   ./install.sh               install (or repair) everything - idempotent
#   ./install.sh --check       verify prerequisites without changing anything
#   ./install.sh --update      git pull, rebuild, migrate, restart, health check
#   ./install.sh --restart     restart backend + nginx
#   ./install.sh --status      show service + health status
#   ./install.sh --backup      run a PostgreSQL backup now
#   ./install.sh --uninstall   stop services (database + data preserved)
#   ./install.sh --purge       also delete database, secrets and backups
#   ./install.sh --help        list every command
#
# Environment overrides (all optional):
#   ARVOO_DOMAIN=panel.example.com   enables HTTPS via Let's Encrypt
#   ARVOO_EMAIL=ops@example.com      ACME account email
#   ARVOO_ADMIN_PASSWORD=...         initial admin password (else random)
#   ARVOO_CONTROL_PLANE_URL=...      node install: control plane to enroll with
#   ARVOO_ENROLLMENT_TOKEN=...       node install: one-time token (unattended)
#
# Layout:
#   /opt/arvoo          application checkout (owned by arvoo)
#   /etc/arvoo.env      secrets + DATABASE_URL (mode 0640 root:arvoo)
#   /etc/systemd/system/arvoo.service
#   /etc/nginx/sites-available/arvoo (+ snippets)
#   /var/backups/arvoo  pg_dump backups + /etc/cron.d/arvoo-backup
#
# The database is never created or dropped by hand: install.sh provisions the
# role + database once, then the application owns the schema through
# versioned SQL migrations (apps/api/src/migrations, run at startup).
set -eEuo pipefail

INSTALL_ROOT="${ARVOO_INSTALL_ROOT:-/opt/arvoo}"
ENV_FILE="${ARVOO_ENV_FILE:-/etc/arvoo.env}"
BACKUP_DIR="${ARVOO_BACKUP_DIR:-/var/backups/arvoo}"
APP_USER="arvoo"
APP_GROUP="arvoo"
DB_NAME="arvoo"
DB_USER="arvoo_user"
API_PORT="${ARVOO_API_PORT:-4001}"
# Non-obvious URL path for the admin UI (camouflage). Fake marketing site stays at /.
PANEL_PATH="${ARVOO_PANEL_PATH:-/panel}"
# Normalise: leading slash, no trailing slash.
PANEL_PATH="/${PANEL_PATH#/}"
PANEL_PATH="${PANEL_PATH%/}"
[[ -n "$PANEL_PATH" ]] || PANEL_PATH="/panel"
PG_HOST="127.0.0.1"
PG_PORT="5432"
REQUIRED_NODE_MAJOR="22"
# Set to 1 only when THIS run generates a fresh admin password, so the report
# can print it once instead of re-printing an existing secret.
GENERATED_ADMIN_PASSWORD=0

BOLD="$(printf '\033[1m')"
GREEN="$(printf '\033[32m')"
RED="$(printf '\033[31m')"
YELLOW="$(printf '\033[33m')"
DIM="$(printf '\033[2m')"
RESET="$(printf '\033[0m')"

log()   { echo "[arvoo] $*"; }
ok()    { echo "${GREEN}[ OK ]${RESET} $*"; }
warn()  { echo "${YELLOW}[WARN ]${RESET} $*"; }
fail()  { echo "${RED}[FAIL]${RESET} $*" >&2; }
step()  { CURRENT_STAGE="$*"; echo; echo "${BOLD}==> $*${RESET}"; }

# Tracks the stage currently running so an unexpected failure can name it.
CURRENT_STAGE="startup"

on_error() {
  local rc=$?
  [[ $rc -eq 0 ]] && return 0
  echo >&2
  fail "Command failed (exit ${rc}) during stage: ${CURRENT_STAGE}"
  fail "System state: nothing further in that stage was executed. Re-run ./install.sh after fixing the cause."
  echo >&2
}
trap on_error ERR

abort() {
  fail "$*"
  fail "Failed during stage: ${CURRENT_STAGE}"
  fail "Fix the cause above, then re-run ./install.sh (it is idempotent and resumes safely)."
  exit 1
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

running_as_root() { [[ "${EUID}" -eq 0 ]]; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if ! running_as_root; then
    abort "Must run as root (try: sudo ./install.sh)"
  fi
}

check_ubuntu() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    log "OS: ${PRETTY_NAME:-unknown} (id=${ID:-?} version=${VERSION_ID:-?})"
    case "${ID:-}" in
      ubuntu|debian) ;;
      *) warn "Only Ubuntu 24.04 LTS is tested; continuing on ${ID:-unknown}." ;;
    esac
    if [[ "${ID:-}" == "ubuntu" && -n "${VERSION_ID:-}" ]]; then
      # Numeric (sort -V) comparison so 22.04 < 24.04 works for any version.
      if [[ "$(printf '%s\n24.04\n' "${VERSION_ID}" | sort -V | head -n1)" != "24.04" ]]; then
        warn "Ubuntu ${VERSION_ID} is older than 24.04; PostgreSQL 16+ recommended."
      fi
    fi
    if [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]]; then
      ok "Ubuntu 24.04 LTS detected"
    fi
  else
    warn "Cannot determine OS (/etc/os-release missing)."
  fi
}

check_arch() {
  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64|x86_64) ;;
    arm64|aarch64) ;;
    *) warn "Untested architecture: $arch" ;;
  esac
}
# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------

install_system_packages() {
  step "Installing system dependencies"
  export DEBIAN_FRONTEND=noninteractive

  if ! command_exists apt-get; then
    abort "apt-get not found; this installer targets Ubuntu/Debian."
  fi

  apt-get update -qq
  apt-get install -y -qq \
    ca-certificates curl gnupg lsb-release \
    nginx postgresql postgresql-contrib libpq-dev \
    certbot python3-certbot-nginx git \
    iproute2 iptables ufw openvpn > /dev/null

  # Node.js LTS from NodeSource (Ubuntu 24.04 ships Node 18 in universe, too
  # old for this project which requires >= 22.5).
  if ! command_exists node || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$REQUIRED_NODE_MAJOR" ]]; then
    log "Installing Node.js ${REQUIRED_NODE_MAJOR}.x"
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" -o /tmp/nodesource.sh
    bash /tmp/nodesource.sh > /dev/null
    apt-get install -y -qq nodejs > /dev/null
  fi

  command_exists node || abort "Node.js did not install"
  command_exists npm  || abort "npm did not install"
  command_exists psql  || abort "psql did not install (postgresql-client missing)"
  command_exists nginx || abort "nginx did not install"

  local nodever pgver
  nodever="$(node -v)"
  pgver="$(psql --version 2>/dev/null | awk '{print $3}')"
  ok "Node.js ${nodever}, npm $(npm -v), PostgreSQL client ${pgver}, nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"
}

# ---------------------------------------------------------------------------
# Application user + checkout
# ---------------------------------------------------------------------------

ensure_user() {
  step "Ensuring application user '${APP_USER}'"
  if ! getent group "$APP_GROUP" >/dev/null; then
    groupadd --system "$APP_GROUP"
    ok "created system group ${APP_GROUP}"
  fi
  if id "$APP_USER" &>/dev/null; then
    ok "user ${APP_USER} exists"
  else
    useradd --system --gid "$APP_GROUP" --home-dir "$INSTALL_ROOT" \
            --shell /usr/sbin/nologin --no-create-home "$APP_USER"
    ok "created system user ${APP_USER} (no login shell, no privileges)"
  fi
  # nginx needs to read the static build; nothing else is granted to www-data.
  if getent passwd www-data >/dev/null; then
    usermod -a -G "$APP_GROUP" www-data 2>/dev/null || true
  fi
}

# Run a command as the application user (npm/git must not run as root).
run_as_app() {
  if command_exists runuser; then
    runuser -u "$APP_USER" -- env HOME="$INSTALL_ROOT" "$@"
  else
    sudo -u "$APP_USER" env HOME="$INSTALL_ROOT" "$@"
  fi
}

# ---------------------------------------------------------------------------
# Checkout detection
#
# The installer runs in two different ways and must handle both:
#   A) from inside a full clone/export of the repository - that tree is used;
#   B) piped from curl (`curl .../install.sh | bash -s --`) - then there are no
#      repository files next to the script at all, and the current working
#      directory is NOT a checkout ($0 is just "bash"). Treating it as one
#      staged /opt/arvoo with a single file in it, so deploy/*.service,
#      cli/arvoo and site/ were missing; treating the operator's cwd as one also
#      copied unrelated (possibly secret) files into /opt/arvoo.
# The layout is therefore detected explicitly, and the repository is cloned
# when a checkout cannot be seen.
# ---------------------------------------------------------------------------

DEFAULT_SOURCE_URL="https://github.com/farnoudhosseini/arvoo-virtualprivatenetwork-panel.git"

# A directory is a usable checkout only when everything the installer
# installs from the repository is actually there.
looks_like_checkout() {
  local dir="${1:-}"
  [[ -n "$dir" && -d "$dir" ]] || return 1
  [[ -f "$dir/install.sh" && -f "$dir/package.json" && -d "$dir/apps" && -d "$dir/deploy" && -d "$dir/cli" ]]
}

# Directory this script lives in. Prints nothing when the script was piped from
# stdin, because then $0 is "bash" and its directory means nothing.
script_dir() {
  local src="$0"
  [[ -f "$src" ]] || return 1
  ( cd "$(dirname "$(readlink -f "$src")")" 2>/dev/null && pwd )
}

# Fail immediately, with a list of what is missing, instead of halfway through
# an install that assumes deploy/ and cli/ exist.
require_checkout_layout() {
  local missing=() f
  for f in install.sh package.json apps deploy cli; do
    [[ -e "${INSTALL_ROOT}/${f}" ]] || missing+=("${f}")
  done
  for f in deploy/arvoo.service deploy/arvoo-agent.service deploy/nginx-common.conf deploy/nginx-arvoo.conf; do
    [[ -f "${INSTALL_ROOT}/${f}" ]] || missing+=("${f}")
  done
  if (( ${#missing[@]} > 0 )); then
    abort "the checkout at ${INSTALL_ROOT} is incomplete (missing: ${missing[*]}). Run the installer from a full clone, or set ARVOO_SOURCE_URL to a git URL it can fetch."
  fi
}

ensure_checkout() {
  step "Ensuring application checkout at ${INSTALL_ROOT}"
  local src=""
  src="$(script_dir || true)"

  if [[ -d "$INSTALL_ROOT/.git" ]]; then
    log "git checkout already present at ${INSTALL_ROOT}"
  elif looks_like_checkout "$src"; then
    if [[ "$src" == "$INSTALL_ROOT" ]]; then
      log "installer is running from ${INSTALL_ROOT}; using it in place"
    else
      log "staging the checkout this installer runs from (${src})"
      mkdir -p "$INSTALL_ROOT"
      # node_modules, build output and any local .env are deliberately not
      # copied: dependencies are installed fresh and secrets stay in ${ENV_FILE}.
      tar -C "$src" --exclude=node_modules --exclude='*/node_modules' \
          --exclude=dist --exclude='*/dist' --exclude=.env --exclude='.freebuff' \
          -cf - . | tar -C "$INSTALL_ROOT" -xf -
    fi
    ok "application staged from ${src}"
  else
    if [[ -n "$src" ]]; then
      warn "installer is not running from a full checkout (${src} has no apps/ deploy/ cli/); fetching the repository instead"
    else
      log "installer was piped from stdin; fetching the repository into ${INSTALL_ROOT}"
    fi
    command_exists git || abort "git is required to fetch the repository (apt-get install -y git), or run install.sh from a full clone"
    local url="${ARVOO_SOURCE_URL:-$DEFAULT_SOURCE_URL}"
    local tmp
    if [[ -d "$INSTALL_ROOT" && -n "$(ls -A "$INSTALL_ROOT" 2>/dev/null || true)" ]]; then
      # A non-empty directory that is not a checkout is never deleted: the
      # repository is fetched into a temporary directory and staged from there.
      tmp="$(mktemp -d)"
      git clone --quiet --depth 1 "$url" "$tmp/repo" \
        || { rm -rf "$tmp"; abort "git clone ${url} failed; set ARVOO_SOURCE_URL to a reachable repository URL"; }
      tar -C "$tmp/repo" --exclude=node_modules --exclude='*/node_modules' \
          --exclude=dist --exclude='*/dist' --exclude=.env --exclude='.freebuff' \
          -cf - . | tar -C "$INSTALL_ROOT" -xf -
      rm -rf "$tmp"
      warn "staged the repository into the existing ${INSTALL_ROOT}; it is not a git checkout, so ./install.sh --update needs one"
    else
      mkdir -p "$INSTALL_ROOT"
      git clone --quiet --depth 1 "$url" "$INSTALL_ROOT" \
        || abort "git clone ${url} failed; set ARVOO_SOURCE_URL to a reachable repository URL"
    fi
    ok "repository fetched from ${url}"
  fi

  require_checkout_layout
  chown -R "${APP_USER}:${APP_GROUP}" "$INSTALL_ROOT"
}

# ---------------------------------------------------------------------------
# Secrets and environment file
# ---------------------------------------------------------------------------

rand_hex() { openssl rand -hex 32; }
rand_pw() { openssl rand -base64 30 | tr -d '/=+' | head -c 32; }

# Read an existing value out of the env file without printing it anywhere.
env_get() {
  local key="$1"
  [[ -r "$ENV_FILE" ]] || return 0
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -n1 | sed -E "s/^${key}=//; s/[[:space:]]*$//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" || true
}

# Write a key/value pair into the env file; keep file mode 0640.
env_set() {
  local key="$1" value="$2" escaped
  # Escape sed replacement metacharacters so operator-supplied values survive.
  escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

env_has() { grep -qE "^$1=" "$ENV_FILE" 2>/dev/null; }

# Only write a variable when it is absent: never clobber operator tuning.
env_set_default() {
  if env_has "$1"; then return 0; fi
  env_set "$1" "$2"
}

ensure_env_file() {
  step "Configuring ${ENV_FILE}"

  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"

  # A port configured by an earlier run (or by the operator) wins unless an
  # explicit override was passed, so re-running never breaks the Nginx vhost.
  if [[ -z "${ARVOO_API_PORT:-}" ]]; then
    local configured_port
    configured_port="$(env_get PORT)"
    if [[ -n "$configured_port" ]]; then API_PORT="$configured_port"; fi
  fi

  local need_secret=1 need_admin_pw=1 changed=0
  if [[ -n "$(env_get ARVOO_APP_SECRET)" ]]; then need_secret=0; fi
  if [[ -n "$(env_get ARVOO_ADMIN_PASSWORD)" && "$(env_get ARVOO_ADMIN_PASSWORD)" != "arvoo-admin" ]]; then
    need_admin_pw=0
  fi

  if [[ "$need_secret" -eq 1 ]]; then
    # One key for both secret-at-rest encryption and session tokens, so the
    # panel has a single master secret to protect and rotate.
    env_set ARVOO_APP_SECRET "$(rand_hex)"
    log "generated ARVOO_APP_SECRET (AES-256-GCM key for stored secrets + session tokens)"
    changed=1
  fi
  if [[ "$need_admin_pw" -eq 1 ]]; then
    local pw
    pw="${ARVOO_ADMIN_PASSWORD:-$(rand_pw)}"
    env_set ARVOO_ADMIN_PASSWORD "$pw"
    GENERATED_ADMIN_PASSWORD=1
    changed=1
  fi
  env_set_default ARVOO_ADMIN_USER "${ARVOO_ADMIN_USER:-admin}"

  # Non-secret, machine-local configuration.
  env_set APP_ENV "production"
  if env_has HOST && [[ "$(env_get HOST)" != "127.0.0.1" ]]; then
    warn "HOST=$(env_get HOST) would expose the backend directly; forcing 127.0.0.1 (Nginx is the only entry point)"
  fi
  env_set HOST "127.0.0.1"
  env_set PORT "$API_PORT"
  env_set_default LOG_LEVEL "${ARVOO_LOG_LEVEL:-info}"
  env_set_default ARVOO_POOL_MAX "${ARVOO_POOL_MAX:-10}"
  env_set_default ARVOO_MIGRATIONS_DIR "${INSTALL_ROOT}/apps/api/src/migrations"
  env_set_default ARVOO_BACKUP_KEEP "${ARVOO_BACKUP_KEEP:-14}"
  if [[ -n "${ARVOO_DOMAIN:-}" ]]; then
    env_set ARVOO_CORS_ORIGINS "https://${ARVOO_DOMAIN}"
    env_set ARVOO_CONTROL_PLANE_URL "https://${ARVOO_DOMAIN}"
  fi

  chmod 0640 "$ENV_FILE"
  chown "root:${APP_GROUP}" "$ENV_FILE"

  if [[ "$changed" -eq 1 ]]; then
    ok "secrets written to ${ENV_FILE} (mode 0640 root:${APP_GROUP})"
  else
    ok "existing ${ENV_FILE} kept (secrets untouched)"
  fi
}

# ---------------------------------------------------------------------------
# PostgreSQL: dedicated database + role, localhost only
# ---------------------------------------------------------------------------

pg_is_ready() { su - postgres -c "psql -tAc 'SELECT 1'" >/dev/null 2>&1; }

# Run SQL as the postgres superuser with the statement on stdin, so neither the
# password nor any query text ever appears in a process argument list.
# Usage: psql_super                    (default database)
#        psql_super "-d ${DB_NAME}"    (a specific database)
psql_super() { su - postgres -c "psql -v ON_ERROR_STOP=1 -q -tA ${1:-}"; }

# Verify the application role can authenticate over TCP using the stored
# password; the password travels via PGPASSWORD (env), never via argv.
pg_app_can_connect() {
  PGPASSWORD="$1" psql -h "$PG_HOST" -p "$PG_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1
}

# Extract the password / host from a URL without printing the secret anywhere.
url_password() { printf '%s' "$1" | sed -E 's#^postgres(ql)?://[^:]*:([^@]*)@.*$#\2#'; }
url_host()     { printf '%s' "$1" | sed -E 's#^postgres(ql)?://[^@]*@([^:/]+).*$#\2#'; }

# Create the application login role, or update it when it already exists. Both
# the first and every later run of the installer must succeed:
#   * `ALTER ROLE` alone failed on a freshly installed PostgreSQL with
#     "role \"${DB_USER}\" does not exist", and that failure was easy to miss
#     because psql's exit status was not checked - the run continued with a
#     DATABASE_URL whose password did not exist in the cluster.
#   * one statement does it, so there is no check-then-act race, and the DO
#     block is executed by PostgreSQL itself instead of parsing psql output.
#   * the password is escaped for a SQL literal (single quotes doubled; the
#     generated value is alphanumeric anyway).
#   * the password travels on stdin - never in argv (/proc/*/cmdline is public),
#     and never in the output: `psql -q` prints no statement text.
#   * ON_ERROR_STOP=1 (psql_super) makes a failure return non-zero, which the
#     caller checks instead of assuming success.
set_role_password() {
  local password="$1" escaped
  escaped="$(printf '%s' "$password" | sed "s/'/''/g")"
  psql_super <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${escaped}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${escaped}';
  END IF;
END
\$\$;
SQL
}

configure_postgres() {
  step "Configuring PostgreSQL"

  if ! systemctl is-enabled --quiet postgresql 2>/dev/null; then
    systemctl enable --quiet postgresql
  fi
  systemctl start postgresql
  # Wait for the local cluster to accept connections.
  local tries=0
  while ! pg_is_ready; do
    tries=$((tries + 1)); [[ $tries -ge 20 ]] && abort "PostgreSQL did not come up"
    sleep 1
  done

  local version confdir
  version="$(ls -1 /etc/postgresql 2>/dev/null | sort -V | tail -n1)"
  if [[ -z "$version" ]]; then
    # Some installs (e.g. docker/containers) manage postgres outside pg_wrapper.
    version="$(psql_super <<'SQL' | cut -c1-2 | sed 's/^1[0-9]/16/'
SHOW server_version_num;
SQL
)"
  fi
  confdir="/etc/postgresql/${version:-16}/main"
  log "PostgreSQL ${version:-16} cluster (${confdir})"

  # ---- Dedicated application role ----------------------------------------
  # Never the 'postgres' superuser: the panel runs with its own login role that
  # owns only its own database.
  local role_exists db_url pw
  role_exists="$(psql_super <<SQL
SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}';
SQL
)"
  db_url="$(env_get DATABASE_URL)"

  if [[ "$role_exists" != "1" ]]; then
    pw="$(rand_pw)"
    set_role_password "$pw" || abort "could not create the database role '${DB_USER}' (see the PostgreSQL output above)"
    env_set DATABASE_URL "postgresql://${DB_USER}:${pw}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
    db_url="$(env_get DATABASE_URL)"
    ok "created dedicated role '${DB_USER}' (generated password stored in ${ENV_FILE})"
  else
    ok "database role '${DB_USER}' already exists"
    if [[ -z "$db_url" ]]; then
      # Repair path: role exists but the env file lost its connection string.
      pw="$(rand_pw)"
      set_role_password "$pw" || abort "could not reset the password of role '${DB_USER}'"
      env_set DATABASE_URL "postgresql://${DB_USER}:${pw}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
      db_url="$(env_get DATABASE_URL)"
      warn "${ENV_FILE} had no DATABASE_URL; role password rotated and connection string restored"
    fi
  fi

  # ---- Dedicated database ------------------------------------------------
  local db_exists
  db_exists="$(psql_super <<SQL
SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}';
SQL
)"
  if [[ "$db_exists" != "1" ]]; then
    psql_super <<SQL
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
SQL
    ok "created database '${DB_NAME}' owned by '${DB_USER}'"
  else
    ok "database '${DB_NAME}' already exists"
  fi

  # Owner + schema rights are asserted on every run so the application can run
  # its own migrations without superuser involvement (idempotent by nature).
  psql_super <<SQL
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL
  psql_super "-d ${DB_NAME}" <<SQL
GRANT ALL ON SCHEMA public TO ${DB_USER};
SQL
  ok "database owner + schema privileges asserted; PUBLIC has no access"

  # ---- Verify the stored credentials really work -------------------------
  local db_host
  db_host="$(url_host "$db_url")"
  if [[ "$db_host" == "127.0.0.1" || "$db_host" == "localhost" || "$db_host" == "::1" ]]; then
    if ! pg_app_can_connect "$(url_password "$db_url")"; then
      pw="$(rand_pw)"
      set_role_password "$pw"
      env_set DATABASE_URL "postgresql://${DB_USER}:${pw}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
      db_url="$(env_get DATABASE_URL)"
      pg_app_can_connect "$(url_password "$db_url")" \
        || abort "role ${DB_USER} cannot connect to ${DB_NAME} at ${PG_HOST}:${PG_PORT}"
      warn "stored DATABASE_URL could not authenticate; role password rotated to match the cluster"
    fi
    ok "application credentials verified over TCP (${DB_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME})"
  else
    warn "DATABASE_URL targets ${db_host:-an external host}; local role/database credentials were left untouched"
  fi

  # Listen on loopback only: the panel never needs remote database access and
  # the port must not be reachable from the Internet.
  if [[ -d "$confdir" ]]; then
    if ! grep -qE "^#?listen_addresses *= *'127.0.0.1'" "$confdir/postgresql.conf" 2>/dev/null; then
      printf "\n# Arvoo: database reachable on localhost only.\nlisten_addresses = '127.0.0.1'\n" >> "$confdir/postgresql.conf"
    else
      sed -i -E "s/^#?listen_addresses *= *.*/listen_addresses = '127.0.0.1'/" "$confdir/postgresql.conf"
    fi
    systemctl reload postgresql
  else
    warn "cluster config directory ${confdir} not found; verify listen_addresses manually"
  fi

  ok "PostgreSQL listens on ${PG_HOST} only; port ${PG_PORT} is not exposed publicly"
}

# ---------------------------------------------------------------------------
# Build, migrate and start the backend
# ---------------------------------------------------------------------------

build_app() {
  step "Installing dependencies and building the application"
  cd "$INSTALL_ROOT"

  # Optional dependencies are NOT skipped: esbuild/rollup ship their platform
  # binaries as optional deps, so --omit=optional breaks the build.
  if [[ -f package-lock.json ]]; then
    run_as_app npm ci --no-audit --no-fund > /tmp/arvoo-install.log 2>&1 || {
      tail -n 30 /tmp/arvoo-install.log >&2 || true
      abort "npm ci failed - see /tmp/arvoo-install.log"
    }
  else
    run_as_app npm install --no-audit --no-fund > /tmp/arvoo-install.log 2>&1 || {
      tail -n 30 /tmp/arvoo-install.log >&2 || true
      abort "npm install failed - see /tmp/arvoo-install.log"
    }
  fi
  ok "dependencies installed (as ${APP_USER})"

  # When the admin UI is served under a path (ARVOO_PANEL_PATH), Vite must emit
  # asset URLs with that base. Default PANEL_PATH is /panel.
  local vite_base="${PANEL_PATH}/"
  [[ "$PANEL_PATH" == "/" ]] && vite_base="/"
  run_as_app env VITE_BASE="$vite_base" npm run build > /tmp/arvoo-build.log 2>&1 || {
    tail -n 30 /tmp/arvoo-build.log >&2 || true
    abort "npm run build failed - see /tmp/arvoo-build.log"
  }

  # Fail here rather than at service start if a build artifact is missing.
  local artifact
  for artifact in apps/api/dist/index.js apps/api/dist/migrate.js apps/web/dist/index.html; do
    [[ -f "$INSTALL_ROOT/$artifact" ]] || abort "expected build artifact is missing: ${artifact}"
  done
  ok "build complete (api + agent + web)"
}

run_migrations() {
  step "Running database migrations"
  # Schema ownership lives with the application: migrations are executed by the
  # app itself against the dedicated role (never as the postgres superuser and
  # never by hand in SQL here). The bundled migrate.js is a dedicated entrypoint.
  if [[ ! -f "$INSTALL_ROOT/apps/api/dist/migrate.js" ]]; then
    abort "apps/api/dist/migrate.js missing - did the build run?"
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  local out rc
  out="$(cd "$INSTALL_ROOT" && sudo -E -u "$APP_USER" \
     env DATABASE_URL="$DATABASE_URL" \
     node "$INSTALL_ROOT/apps/api/dist/migrate.js" 2>&1)" || rc=$?
  rc="${rc:-0}"
  if [[ "$rc" -ne 0 ]]; then
    echo "$out" | tail -n 20 >&2 || true
    abort "Migration failed. The database schema was NOT changed partially (migrations run in a transaction)."
  fi
  echo "$out" | grep -E "migration|up to date" || true
  ok "schema is up to date"
}

install_services() {
  step "Installing systemd services"
  install -m 0644 "$INSTALL_ROOT/deploy/arvoo.service" /etc/systemd/system/arvoo.service
  install -m 0644 "$INSTALL_ROOT/deploy/arvoo-agent.service" /etc/systemd/system/arvoo-agent.service
  # Privileged firewall helper: the panel host applies its own UFW plan through
  # this oneshot unit, triggered by the path unit watching the request spool.
  install -m 0644 "$INSTALL_ROOT/deploy/arvoo-ufw-apply.service" /etc/systemd/system/arvoo-ufw-apply.service
  install -m 0644 "$INSTALL_ROOT/deploy/arvoo-ufw-apply.path" /etc/systemd/system/arvoo-ufw-apply.path
  systemctl daemon-reload
  systemctl enable --quiet arvoo
  systemctl enable --quiet arvoo-ufw-apply.path 2>/dev/null || true
  systemctl start arvoo-ufw-apply.path 2>/dev/null || true
  # The node agent is enabled after enrollment (see DEPLOYMENT.md); enabling it
  # before enrollment would crash-loop.
  ok "arvoo.service installed; firewall helper path unit active; arvoo-agent.service installed, not enabled"
}

start_backend() {
  step "Starting backend"
  systemctl restart arvoo
  local tries=0
  while [[ $tries -lt 15 ]]; do
    if systemctl is-active --quiet arvoo; then
      ok "arvoo.service active (127.0.0.1:${API_PORT})"
      return 0
    fi
    tries=$((tries + 1)); sleep 1
  done
  journalctl -u arvoo -n 25 --no-pager >&2 || true
  abort "arvoo.service failed to start"
}

# ---------------------------------------------------------------------------
# Nginx + optional HTTPS
# ---------------------------------------------------------------------------

install_nginx() {
  step "Configuring Nginx"
  [[ -f "$INSTALL_ROOT/apps/web/dist/index.html" ]] \
    || abort "frontend build missing (apps/web/dist/index.html) - run the build first"

  mkdir -p /etc/nginx/snippets
  install -m 0644 "$INSTALL_ROOT/deploy/nginx-common.conf" /etc/nginx/snippets/arvoo-common.conf
  # Camouflage: panel UI under a non-obvious path; public site at /.
  sed -i -E \
    -e "s|__PANEL_PATH__|${PANEL_PATH}|g" \
    -e "s|__PANEL_ROOT__|${INSTALL_ROOT}/apps/web/dist|g" \
    /etc/nginx/snippets/arvoo-common.conf

  install -m 0644 "$INSTALL_ROOT/deploy/nginx-arvoo.conf" /etc/nginx/sites-available/arvoo

  # Bind the vhost to the configured port/root instead of the defaults baked
  # into the template, so ARVOO_API_PORT / ARVOO_INSTALL_ROOT stay authoritative.
  sed -i -E \
    -e "s|server 127\.0\.0\.1:[0-9]+;|server 127.0.0.1:${API_PORT};|" \
    -e "s|root /opt/arvoo/apps/web/dist;|root ${INSTALL_ROOT}/apps/web/dist;|" \
    /etc/nginx/sites-available/arvoo

  # Public static assets must be readable by the nginx worker (which is in the
  # ${APP_GROUP} group); nothing else in the checkout is exposed.
  chmod o+rX "$INSTALL_ROOT" "$INSTALL_ROOT/apps" "$INSTALL_ROOT/apps/web"
  chmod -R o+rX "$INSTALL_ROOT/apps/web/dist"

  ln -sf /etc/nginx/sites-available/arvoo /etc/nginx/sites-enabled/arvoo
  rm -f /etc/nginx/sites-enabled/default

  nginx -t > /dev/null 2>&1 || { nginx -t; abort "nginx configuration test failed"; }
  systemctl restart nginx || systemctl start nginx
  systemctl enable --quiet nginx 2>/dev/null || true
  ok "nginx active; /api/ -> 127.0.0.1:${API_PORT}, / -> static build"
}

# Domain vs IP installation (spec §5). One answer here drives nginx, the ACME
# certificate, CORS and the control plane URL the agent uses.
ask_domain() {
  if [[ -n "${ARVOO_DOMAIN:-}" ]]; then
    ok "domain configured: ${ARVOO_DOMAIN} - HTTPS will be provisioned"
    validate_domain_dns "${ARVOO_DOMAIN}"
    return 0
  fi
  # Explicit non-interactive IP install (CI / unattended).
  if [[ "${ARVOO_NO_DOMAIN:-0}" == "1" ]]; then
    warn "IP-based installation (ARVOO_NO_DOMAIN=1): the panel is served over HTTP without TLS."
    warn "  Keep it on a private network/VPN, or re-run with ARVOO_DOMAIN=<name> to enable HTTPS."
    return 0
  fi

  # When the installer is piped (`curl ... | bash`), stdin is not a TTY.
  # Always prompt on the controlling terminal so the operator can still choose
  # a domain. Fall back to IP-only only when no TTY exists at all.
  local tty="/dev/tty"
  if [[ ! -r "$tty" || ! -w "$tty" ]]; then
    if [[ ! -t 0 ]]; then
      warn "No interactive terminal available and ARVOO_DOMAIN is unset."
      warn "  Continuing with IP-based HTTP install. Set ARVOO_DOMAIN=... or ARVOO_NO_DOMAIN=1 to silence this."
      return 0
    fi
    tty=""
  fi

  echo
  echo "Do you have a domain for this panel?"
  echo "  1) Yes - configure HTTPS with a Let's Encrypt certificate (recommended)"
  echo "  2) No  - continue with this server's IP address over HTTP"
  local answer=""
  if [[ -n "$tty" ]]; then
    read -r -p "Select [1/2]: " answer <"$tty" || true
  else
    read -r -p "Select [1/2]: " answer || true
  fi
  case "${answer:-}" in
    1|y|Y|yes|YES)
      local domain=""
      if [[ -n "$tty" ]]; then
        read -r -p "Domain (e.g. panel.example.com): " domain <"$tty" || true
      else
        read -r -p "Domain (e.g. panel.example.com): " domain || true
      fi
      [[ -n "$domain" ]] || abort "a domain is required when HTTPS is selected (or choose 2 for an IP installation)"
      ARVOO_DOMAIN="${domain#http://}"; ARVOO_DOMAIN="${ARVOO_DOMAIN#https://}"; ARVOO_DOMAIN="${ARVOO_DOMAIN%%/*}"
      validate_domain_dns "${ARVOO_DOMAIN}"
      ok "domain configured: ${ARVOO_DOMAIN} - HTTPS will be provisioned"
      ;;
    2|n|N|no|NO)
      warn "IP-based installation: no TLS certificate will be requested."
      warn "  Credentials cross the network in the clear - restrict access with firewall rules, or re-run with ARVOO_DOMAIN=<name>."
      ;;
    *)
      # Empty answer when piped without TTY already handled above; empty on TTY defaults to asking again is noisy — prefer explicit IP with a clear message.
      warn "No choice entered; defaulting to IP-based HTTP install."
      warn "  Re-run with ARVOO_DOMAIN=panel.example.com for HTTPS, or answer 1 when prompted."
      ;;
  esac
}

# Resolve the name and compare it with this host's public address. A mismatch is
# a warning, not a refusal: proxy/CDN and NAT setups are legitimate. A name that
# does not resolve at all is reported before certbot is attempted, so the
# operator sees the real cause instead of an ACME error.
validate_domain_dns() {
  local domain="$1" resolved="" public_ip=""
  if command_exists dig; then
    resolved="$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.' | tail -n1 || true)"
  elif command_exists getent; then
    resolved="$(getent hosts "$domain" 2>/dev/null | awk '{print $1; exit}' || true)"
  fi
  if [[ -z "$resolved" ]]; then
    warn "DNS: ${domain} does not resolve from this server yet; the certificate request will fail until it does."
    return 0
  fi
  ok "DNS: ${domain} resolves to ${resolved}"
  public_ip="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
  if [[ -n "$public_ip" && "$public_ip" != "$resolved" ]]; then
    warn "DNS points to ${resolved} while this server's public address looks like ${public_ip}."
    warn "  Behind a proxy/CDN or NAT this can still be correct; otherwise fix DNS before certificates are issued."
  fi
}

# Extra names to include in the first certificate request (public site, etc.).
cert_extra_domains() {
  [[ -n "${ARVOO_SITE_DOMAIN:-}" && "${ARVOO_SITE_DOMAIN}" != "${ARVOO_DOMAIN:-}" ]] && printf ' -d %s' "${ARVOO_SITE_DOMAIN}"
}

configure_https() {
  [[ -n "${ARVOO_DOMAIN:-}" ]] || return 0

  step "Provisioning TLS certificate for ${ARVOO_DOMAIN}"
  if [[ -f "/etc/letsencrypt/live/${ARVOO_DOMAIN}/fullchain.pem" ]]; then
    ok "certificate already present"
  else
    if ! certbot certonly --nginx --non-interactive --agree-tos \
          -m "${ARVOO_EMAIL:-root@$(hostname)}" -d "${ARVOO_DOMAIN}" $(cert_extra_domains); then
      warn "certbot failed; panel stays HTTP-only. Fix DNS/ports and re-run ./install.sh"
      return 0
    fi
    ok "certificate issued"
  fi

  render_tls_site
  nginx -t > /dev/null 2>&1 || { nginx -t; abort "nginx TLS configuration test failed"; }
  systemctl reload nginx
  # Renewal runs from certbot's own systemd timer.
  systemctl enable --quiet certbot.timer 2>/dev/null || true
  ok "HTTPS enabled for ${ARVOO_DOMAIN}; HTTP redirects to HTTPS"

  # Verify what the server actually presents, rather than trusting that certbot
  # exited 0: the served certificate is read back over TLS.
  local served=""
  served="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "${ARVOO_DOMAIN}" 2>/dev/null \
    | openssl x509 -noout -subject -enddate 2>/dev/null || true)"
  if [[ -z "$served" ]]; then
    warn "could not read the certificate back over 127.0.0.1:443; check: openssl s_client -connect ${ARVOO_DOMAIN}:443"
  else
    local end="" days=""
    end="$(printf '%s' "$served" | sed -n 's/^notAfter=//p')"
    if [[ -n "$end" ]]; then days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 )); fi
    ok "served certificate verified (${days:-?} days remaining)"
  fi

  # Renewal is only "configured" if the timer is actually armed.
  if systemctl is-enabled certbot.timer >/dev/null 2>&1; then
    ok "automatic renewal: certbot.timer is enabled"
  else
    warn "automatic renewal: certbot.timer is NOT enabled - renew manually with: certbot renew"
  fi
}

render_tls_site() {
  # `http2 on;` is a directive that only exists in nginx >= 1.25.1. Ubuntu 24.04
  # ships nginx 1.24, where it aborts the whole configuration with
  # "unknown directive \"http2\"". HTTP/2 is therefore enabled through the listen
  # directive, which every nginx that can serve HTTP/2 understands.
  # ARVOO_NGINX_SITE_FILE keeps the generated vhost verifiable in a test.
  local target="${ARVOO_NGINX_SITE_FILE:-/etc/nginx/sites-available/arvoo}"
  cat > "$target" <<NGINX
upstream arvoo_api {
    server 127.0.0.1:${API_PORT};
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${ARVOO_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${ARVOO_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${ARVOO_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${ARVOO_DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:arvoo:10m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    root ${INSTALL_ROOT}/apps/web/dist;
    include /etc/nginx/snippets/arvoo-common.conf;
}
NGINX
}

install_backup_cron() {
  step "Installing backup job"
  install -m 0755 "$INSTALL_ROOT/scripts/backup.sh" /usr/local/sbin/arvoo-backup.sh
  cat > /etc/cron.d/arvoo-backup <<CRON
# Daily PostgreSQL backup for the Arvoo Control Plane (installed by install.sh).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 2 * * * root /usr/local/sbin/arvoo-backup.sh >> /var/log/arvoo-backup.log 2>&1
CRON
  chmod 0644 /etc/cron.d/arvoo-backup
  mkdir -p "$BACKUP_DIR"
  chmod 0750 "$BACKUP_DIR"
  ok "daily 02:30 pg_dump -> ${BACKUP_DIR} (retention 14)"
}

# ---------------------------------------------------------------------------
# Health check and final report
# ---------------------------------------------------------------------------

health_json() {
  curl -fsS --max-time 5 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || true
}

health_report() {
  step "Health check"
  local body status db
  body="$(health_json)" || body=""
  if [[ -z "$body" ]]; then
    fail "backend did not answer /health"
    return 1
  fi
  status="$(printf '%s' "$body" | grep -oE '"status":"[^"]*"' | head -n1 | cut -d'"' -f4)"
  db="$(printf '%s' "$body" | grep -oE '"database":"[^"]*"' | head -n1 | cut -d'"' -f4)"
  if [[ "$status" == "ok" && "$db" == "ok" ]]; then
    ok "/health -> status:ok database:ok"
  else
    fail "/health -> status:${status:-?} database:${db:-?}"
    return 1
  fi
}

service_state() { systemctl is-active "$1" 2>/dev/null || echo "n/a"; }

final_report() {
  local host_url="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "${ARVOO_DOMAIN:-}" ]] && host_url="https://${ARVOO_DOMAIN}"
  local admin_pw
  admin_pw="$(env_get ARVOO_ADMIN_PASSWORD)"

  echo
  echo "========================================"
  echo "        ARVOO INSTALLATION COMPLETE"
  echo "========================================"
  echo
  printf "%-11s : %s\n" "Application" "OK"
  printf "%-11s : %s\n" "PostgreSQL" "$(service_state postgresql | sed 's/active/OK/')"
  printf "%-11s : %s\n" "Migrations" "OK"
  printf "%-11s : %s\n" "Backend" "$(service_state arvoo | sed 's/active/OK/')"
  printf "%-11s : %s\n" "Frontend" "OK ($(du -sh "$INSTALL_ROOT/apps/web/dist" 2>/dev/null | cut -f1))"
  printf "%-11s : %s\n" "Nginx" "$(service_state nginx | sed 's/active/OK/')"
  printf "%-11s : %s\n" "Backup" "cron 02:30 -> ${BACKUP_DIR}"
  echo
  printf "%-11s : %s\n" "Backend" "127.0.0.1:${API_PORT} (loopback only)"
  printf "%-11s : %s\n" "Web" "${host_url}"
  echo
  echo "Services:"
  printf "  %-22s %s\n" "arvoo.service" "$(service_state arvoo)"
  printf "  %-22s %s\n" "nginx.service" "$(service_state nginx)"
  printf "  %-22s %s\n" "postgresql.service" "$(service_state postgresql)"
  echo
  local admin_user
  admin_user="$(env_get ARVOO_ADMIN_USER)"
  admin_user="${admin_user:-admin}"
  if [[ "$GENERATED_ADMIN_PASSWORD" -eq 1 ]]; then
    # Printed exactly once - on the run that generated it. Nothing here writes
    # it to a log file; other runs point at ${ENV_FILE} instead.
    echo "First login:  ${admin_user} / ${admin_pw}"
    echo "              (shown once; stored in ${ENV_FILE}, mode 0640 root:${APP_GROUP})"
  else
    echo "First login:  ${admin_user} / <password in ${ENV_FILE}, mode 0640 root:${APP_GROUP}>"
  fi
  echo "Change it immediately after signing in."
  echo
  echo "Next steps:"
  echo "  arvoo                     interactive management menu (status, logs, diagnostics, backup)"
  echo "  arvoo diagnostics         real system checks with actionable results"
  echo "  ./install.sh --status     services, health, listeners, database, backups"
  echo "  ./install.sh --check      re-verify prerequisites without changing anything"
  echo "  ./install.sh --update     git pull, rebuild, migrate, restart, health check"
  echo "  scripts/backup.sh         manual PostgreSQL backup (cron runs it daily)"
  echo
  echo "Logs:"
  echo "  journalctl -u arvoo -f          backend"
  echo "  journalctl -u nginx -f          web server / reverse proxy"
  echo "  tail -f /var/log/nginx/error.log"
  echo
  echo "========================================"
}

# ---------------------------------------------------------------------------
# Host integration (node-side prerequisites)
# ---------------------------------------------------------------------------

install_host_tuning() {
  step "Preparing host integration paths"

  # The node agent (apps/agent) writes its OpenVPN/GRE state here. Only root and
  # the agent service ever touch these directories.
  mkdir -p /etc/arvoo /var/lib/arvoo
  chmod 0700 /etc/arvoo /var/lib/arvoo

  # ufw paths: the units list them in ReadWritePaths (see ensure_ufw_dirs).
  ensure_ufw_dirs

  # Firewall request spool: the unprivileged API drops a plan here, the root
  # helper (arvoo-ufw-apply.service) applies it and writes the result back. The
  # API can only create/modify files in this directory - never run ufw itself.
  mkdir -p /var/lib/arvoo/firewall-spool
  chown "$APP_USER:$APP_GROUP" /var/lib/arvoo/firewall-spool
  chmod 0750 /var/lib/arvoo/firewall-spool
  ok "firewall spool ready (/var/lib/arvoo/firewall-spool, ${APP_USER}:${APP_GROUP} 0750)"

  # IPv4 forwarding must survive a reboot: without it a VPN node silently stops
  # forwarding after the first restart. The agent verifies this value at deploy
  # time instead of relying on a privileged sysctl write per request.
  install -m 0644 "$INSTALL_ROOT/deploy/arvoo-sysctl.conf" /etc/sysctl.d/99-arvoo.conf
  if sysctl --system > /dev/null 2>&1; then
    ok "net.ipv4.ip_forward enabled persistently (/etc/sysctl.d/99-arvoo.conf)"
  else
    warn "could not reload sysctl now; values apply on the next boot"
  fi

  ok "host integration paths ready (/etc/arvoo, /var/lib/arvoo - mode 0700)"
}

# ufw keeps its rule files in /var/lib/ufw and its configuration in /etc/ufw.
# Both are listed in the agent unit's ReadWritePaths, and systemd refuses to
# start a unit whose ReadWritePaths entry does not exist:
#   Failed to set up mount namespacing: /var/lib/ufw: No such file or directory
#   status=226/NAMESPACE
# which is how a host without the ufw package could not run the agent at all.
# The package is installed by the installer and this function creates the
# directories idempotently before either unit is enabled; the units also use the
# "-" prefix so a missing path can never break them again.
ensure_ufw_dirs() {
  install -d -m 0755 /var/lib/ufw
  [[ -d /etc/ufw ]] || install -d -m 0755 /etc/ufw
  ok "ufw paths ready (/etc/ufw, /var/lib/ufw - safe to re-run)"
}

firewall_rules() {
  # ufw is installed by the installer; on a host where it was removed by hand
  # the rules are simply left alone instead of failing the install.
  command_exists ufw || { warn "ufw is not installed; firewall rules were not touched (apt-get install -y ufw)"; return 0; }
  if ! ufw status 2>/dev/null | grep -qi '^Status: active'; then
    log "ufw is installed but inactive; no firewall rules changed (HTTP/HTTPS/SSH are the only ports this stack needs)"
    return 0
  fi

  step "Aligning the firewall with the deployment"
  ufw allow 'Nginx Full' > /dev/null 2>&1 || {
    ufw allow 80/tcp > /dev/null 2>&1 || true
    ufw allow 443/tcp > /dev/null 2>&1 || true
  }
  ufw allow OpenSSH > /dev/null 2>&1 || ufw allow 22/tcp > /dev/null 2>&1 || true
  ok "ufw active: 80/443 + SSH allowed; PostgreSQL (${PG_PORT}) and the backend (${API_PORT}) stay closed"
  log "VPN, tunnel and extra ports are opened from the panel (Firewall section: 'Config & Enable UFW' / 'Update UFW'),"
  log "which computes them from the inbounds and tunnels that actually exist, or from the CLI: arvoo firewall enable"
}

# ---------------------------------------------------------------------------
# Helpers shared by the maintenance modes
# ---------------------------------------------------------------------------

git_app() { run_as_app git -C "$INSTALL_ROOT" "$@"; }

# Require an exact interactive confirmation; ARVOO_FORCE=1 skips it for
# automated teardown. Never proceeds when there is no terminal to ask on.
confirm_or_exit() { # $1 = prompt, $2 = required answer
  local answer=""
  if [[ "${ARVOO_FORCE:-0}" == "1" ]]; then
    log "$1: auto-confirmed (ARVOO_FORCE=1)"
    return 0
  fi
  if [[ -r /dev/tty ]]; then
    read -r -p "$1: " answer < /dev/tty || answer=""
  else
    warn "no interactive terminal available; refusing to continue (set ARVOO_FORCE=1 to override)"
    return 1
  fi
  [[ "$answer" == "$2" ]]
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

mode_check() {
  step "Pre-flight check (read-only - nothing is changed)"
  local problems=0
  local can_inspect=1
  if ! running_as_root; then
    can_inspect=0
    warn "not running as root: database and service checks are skipped (use sudo for a full report)"
  fi

  check_ubuntu
  check_arch

  if command_exists systemctl && [[ -d /run/systemd/system ]]; then
    ok "systemd is available"
  else
    warn "systemd not detected (this installer requires a systemd-based host)"
    problems=$((problems + 1))
  fi

  local missing=()
  local tool
  for tool in apt-get nginx psql; do
    command_exists "$tool" || missing+=("$tool")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "missing system packages: ${missing[*]} (./install.sh installs them)"
    problems=$((problems + 1))
  else
    ok "system tools present (apt-get, nginx, psql)"
  fi

  if command_exists node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$major" -ge "$REQUIRED_NODE_MAJOR" ]]; then
      ok "Node.js $(node -v) (>= ${REQUIRED_NODE_MAJOR}.5 required)"
    else
      warn "Node.js $(node -v) is older than ${REQUIRED_NODE_MAJOR}.x"
      problems=$((problems + 1))
    fi
  else
    warn "Node.js is not installed (>= ${REQUIRED_NODE_MAJOR}.x required)"
    problems=$((problems + 1))
  fi

  local free_mb mem_mb
  free_mb="$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [[ -n "$free_mb" && "$free_mb" -lt 2048 ]]; then
    warn "only ${free_mb} MB free on / (at least 2 GB recommended for build + database)"
    problems=$((problems + 1))
  else
    ok "disk space: ${free_mb:-?} MB free on /"
  fi
  mem_mb="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)"
  if [[ -n "$mem_mb" && "$mem_mb" -lt 900 ]]; then
    warn "only ${mem_mb} MB RAM detected (builds are memory hungry)"
    problems=$((problems + 1))
  else
    ok "memory: ${mem_mb:-?} MB"
  fi

  if [[ -f "$INSTALL_ROOT/package.json" ]]; then
    ok "application checkout present at ${INSTALL_ROOT}"
  else
    warn "no checkout at ${INSTALL_ROOT} yet (a fresh install stages one)"
  fi
  if [[ -f "$INSTALL_ROOT/apps/web/dist/index.html" ]]; then
    ok "frontend build present"
  else
    warn "frontend is not built yet"
  fi

  if [[ -r "$ENV_FILE" ]]; then
    ok "${ENV_FILE} exists (mode $(stat -c '%a %U:%G' "$ENV_FILE" 2>/dev/null || echo '?'))"
    if [[ -n "$(env_get DATABASE_URL)" ]]; then
      ok "DATABASE_URL is configured"
    else
      warn "DATABASE_URL is missing from ${ENV_FILE}"
      problems=$((problems + 1))
    fi
    if [[ -n "$(env_get ARVOO_APP_SECRET)" ]]; then
      ok "ARVOO_APP_SECRET is configured"
    else
      warn "ARVOO_APP_SECRET is missing (required in production)"
      problems=$((problems + 1))
    fi
  else
    warn "${ENV_FILE} does not exist yet (created during install)"
  fi

  if [[ "$can_inspect" -eq 1 ]]; then
    local unit state
    for unit in postgresql nginx arvoo; do
      state="$(systemctl is-active "$unit" 2>/dev/null || true)"
      if [[ "$state" == "active" ]]; then ok "${unit}.service active"; else log "${unit}.service: ${state:-not installed}"; fi
    done

    if systemctl is-active --quiet postgresql 2>/dev/null; then
      local has_db has_role
      has_db="$(psql_super <<SQL
SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}';
SQL
)" || has_db=""
      has_role="$(psql_super <<SQL
SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}';
SQL
)" || has_role=""
      if [[ "$has_role" == "1" ]]; then ok "database role '${DB_USER}' exists"; else warn "database role '${DB_USER}' not created yet"; fi
      if [[ "$has_db" == "1" ]]; then ok "database '${DB_NAME}' exists"; else warn "database '${DB_NAME}' not created yet"; fi
    else
      warn "PostgreSQL is not running; database checks skipped"
    fi

    if [[ "$(systemctl is-active arvoo 2>/dev/null || true)" == "active" ]]; then
      health_report || warn "backend health check did not pass"
    fi
  fi

  echo
  if [[ "$problems" -eq 0 ]]; then
    ok "pre-flight check passed - ./install.sh can proceed"
    return 0
  fi
  warn "${problems} blocking item(s) found - ./install.sh installs and repairs them"
  return 1
}

mode_status() {
  # A node-only host has no panel to inspect. Reporting arvoo/postgresql/nginx
  # as missing there is misleading, so the agent is reported instead.
  if [[ ! -f /etc/systemd/system/arvoo.service && ! -f "$ENV_FILE" ]]; then
    step "Arvoo node status (no panel on this host)"
    local node_failed=0 node_state
    if command_exists systemctl && systemctl is-active --quiet arvoo-agent 2>/dev/null; then
      ok "arvoo-agent.service active"
    else
      node_state="$(systemctl is-active arvoo-agent 2>/dev/null || echo 'not installed')"
      fail "arvoo-agent.service ${node_state}"
      node_failed=1
    fi
    if [[ "$(systemctl is-enabled arvoo-agent 2>/dev/null || true)" == "enabled" ]]; then
      ok "arvoo-agent.service enabled (starts on boot)"
    else
      warn "arvoo-agent.service is not enabled (systemctl enable arvoo-agent)"
    fi
    if [[ -r "${AGENT_STATE_DIR}/agent-state.json" ]]; then
      ok "node identity present (${AGENT_STATE_DIR}/agent-state.json, mode $(stat -c '%a' "${AGENT_STATE_DIR}/agent-state.json" 2>/dev/null))"
    else
      fail "node identity missing - enroll this host: ./install.sh --node"
      node_failed=1
    fi
    if [[ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null || true)" == "1" ]]; then
      ok "net.ipv4.ip_forward enabled (a node must forward)"
    else
      warn "net.ipv4.ip_forward is not 1; check /etc/sysctl.d/99-arvoo.conf"
    fi
    echo
    if [[ "$node_failed" -eq 0 ]]; then ok "status: healthy (node)"; return 0; fi
    fail "status: degraded (see the FAIL lines above)"
    return 1
  fi

  step "Arvoo service status"
  local failed=0 state
  local unit
  for unit in arvoo postgresql nginx; do
    state="$(systemctl is-active "$unit" 2>/dev/null || echo 'not installed')"
    if [[ "$state" == "active" ]]; then ok "${unit}.service active"; else fail "${unit}.service ${state}"; failed=1; fi
  done
  if [[ "$(systemctl is-enabled arvoo-agent 2>/dev/null || true)" == "enabled" ]]; then
    state="$(systemctl is-active arvoo-agent 2>/dev/null || echo unknown)"
    if [[ "$state" == "active" ]]; then ok "arvoo-agent.service active (this host is a managed node)"; else warn "arvoo-agent.service ${state}"; fi
  fi

  step "Backend health"
  local body
  if body="$(health_json)" && [[ -n "$body" ]]; then
    log "${body}"
    if printf '%s' "$body" | grep -q '"status":"ok"'; then
      ok "GET http://127.0.0.1:${API_PORT}/health -> status ok"
    else
      fail "health endpoint reported a problem"
      failed=1
    fi
  else
    fail "no response from http://127.0.0.1:${API_PORT}/health"
    failed=1
  fi

  step "Listening sockets"
  if command_exists ss; then
    if ss -ltn 2>/dev/null | grep -qE ':(80|443) '; then
      ok "public entry point present (port 80/443 via Nginx)"
    else
      warn "nothing listening on 80/443 - the panel is not reachable from the browser"
      failed=1
    fi
    local backend_listeners
    backend_listeners="$(ss -ltn 2>/dev/null | awk -v p=":${API_PORT}" '$4 ~ p {print $4}' || true)"
    if [[ -z "$backend_listeners" ]]; then
      warn "nothing listening on ${API_PORT}"
      failed=1
    elif printf '%s\n' "$backend_listeners" | grep -qE "^(127\.0\.0\.1|\[::1\]):${API_PORT}$"; then
      ok "backend bound to loopback only (${backend_listeners//$'\n'/ }) - not exposed publicly"
    else
      fail "backend is listening on a non-loopback address: ${backend_listeners//$'\n'/ }"
      failed=1
    fi
    # The database port must never be reachable off-host.
    if ss -ltn 2>/dev/null | grep -qE "^(0\.0\.0\.0|\[::\]):${PG_PORT}" ; then
      fail "PostgreSQL appears to listen on all interfaces; check listen_addresses"
      failed=1
    else
      ok "PostgreSQL is not listening publicly"
    fi
  else
    log "ss not available; skipped socket checks"
  fi

  step "Database"
  if running_as_root && systemctl is-active --quiet postgresql 2>/dev/null; then
    local size applied
    size="$(psql_super "-d ${DB_NAME}" <<SQL
SELECT pg_size_pretty(pg_database_size('${DB_NAME}'));
SQL
)" || size=""
    applied="$(psql_super "-d ${DB_NAME}" <<SQL
SELECT count(*) FROM _migrations;
SQL
)" || applied="n/a"
    ok "database ${DB_NAME}: ${size:-unknown} on disk, ${applied} migration(s) applied"
  else
    log "database details need root and a running PostgreSQL (run with sudo)"
  fi

  step "Backups"
  if [[ -d "$BACKUP_DIR" ]]; then
    local latest count
    latest="$(ls -1t "$BACKUP_DIR"/arvoo-*.sql.gz 2>/dev/null | head -n1 || true)"
    count="$(ls -1 "$BACKUP_DIR"/arvoo-*.sql.gz 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
    ok "${count} backup(s) in ${BACKUP_DIR}; newest: ${latest:-none}"
    if [[ -f /etc/cron.d/arvoo-backup ]]; then ok "daily backup cron installed (02:30)"; else warn "no /etc/cron.d/arvoo-backup"; fi
  else
    warn "no backup directory yet (${BACKUP_DIR})"
  fi

  echo
  if [[ "$failed" -eq 0 ]]; then
    ok "status: healthy"
    return 0
  fi
  fail "status: degraded (see the FAIL lines above)"
  return 1
}

# The node id recorded in the agent identity file (empty when there is none).
agent_node_id() {
  local state_file="${AGENT_STATE_DIR}/agent-state.json"
  [[ -r "$state_file" ]] || return 0
  sed -n 's/.*"nodeId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state_file" | head -n1
}

mode_restart() {
  require_root
  # A node has no panel to restart; restarting arvoo/nginx there would only
  # produce failures for services that are deliberately not installed.
  if [[ ! -f /etc/systemd/system/arvoo.service && ! -f "$ENV_FILE" ]]; then
    step "Restarting the node agent"
    local before after
    before="$(agent_node_id)"
    systemctl restart arvoo-agent || abort "arvoo-agent failed to restart (inspect: journalctl -u arvoo-agent -n 50)"
    sleep 2
    systemctl is-active --quiet arvoo-agent || abort "arvoo-agent is not active after the restart"
    after="$(agent_node_id)"
    if [[ -n "$before" && "$before" != "$after" ]]; then
      abort "the restart changed the node identity (${before} -> ${after})"
    fi
    ok "arvoo-agent restarted${after:+ (node ${after}, identity preserved)}"
    return 0
  fi
  step "Restarting application services"
  systemctl restart arvoo
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  if health_report; then
    ok "backend and web server restarted"
    return 0
  fi
  journalctl -u arvoo -n 30 --no-pager >&2 || true
  abort "backend did not pass its health check after restart"
}

mode_update() {
  require_root
  if [[ ! -d "$INSTALL_ROOT/.git" ]]; then
    abort "${INSTALL_ROOT} is not a git checkout - update it manually (git pull) and re-run sudo ./install.sh"
  fi

  step "Recording the current revision"
  local old_rev branch
  old_rev="$(git -C "$INSTALL_ROOT" rev-parse --short HEAD)"
  branch="$(git -C "$INSTALL_ROOT" rev-parse --abbrev-ref HEAD)"
  log "current revision: ${old_rev} (branch ${branch})"

  step "Fetching updates"
  git_app fetch --prune origin
  local target
  target="$(git -C "$INSTALL_ROOT" rev-parse --short "origin/${branch}" 2>/dev/null || echo "$old_rev")"
  if [[ "$target" == "$old_rev" ]]; then
    ok "already at the newest revision (${old_rev}); continuing with a rebuild"
  else
    git_app merge --ff-only "origin/${branch}"
    ok "updated ${old_rev} -> $(git -C "$INSTALL_ROOT" rev-parse --short HEAD)"
  fi

  build_app
  run_migrations
  install_host_tuning
  install_services
  install_nginx
  start_backend

  if health_report; then
    ok "update complete (revision $(git -C "$INSTALL_ROOT" rev-parse --short HEAD))"
    return 0
  fi

  warn "the new revision failed its health check"
  if [[ "${ARVOO_AUTO_ROLLBACK:-1}" != "1" ]]; then
    abort "update failed. Deployment left at the new revision; roll back with: git -C ${INSTALL_ROOT} reset --hard ${old_rev} && ./install.sh --restart"
  fi

  warn "rolling the code back to ${old_rev} (database migrations are forward-only and are NOT reverted)"
  git_app reset --hard "$old_rev"
  build_app
  start_backend
  health_report || abort "the panel is still unhealthy after rollback - inspect: journalctl -u arvoo -n 100 --no-pager"
  warn "rolled back to ${old_rev}; the previous revision is serving traffic again"
  warn "the database schema was already migrated and stays as-is (upgrade/downgrade it explicitly below)"
  exit 1
}

mode_backup() {
  require_root
  step "PostgreSQL backup"
  [[ -x "$INSTALL_ROOT/scripts/backup.sh" ]] \
    || abort "${INSTALL_ROOT}/scripts/backup.sh not found or not executable"
  "$INSTALL_ROOT/scripts/backup.sh"
  ok "backup finished (retention: ${ARVOO_BACKUP_KEEP:-14} newest dumps in ${BACKUP_DIR})"
}

mode_uninstall() {
  require_root
  local purge="${ARVOO_PURGE:-0}"

  step "Uninstall"
  echo "This removes Arvoo from this host:"
  echo "  - stops and disables arvoo.service (and arvoo-agent.service when enabled)"
  echo "  - deletes the systemd units, the Nginx site + snippet and the backup cron job"
  echo
  if [[ "$purge" == "1" ]]; then
    warn "PURGE: the database '${DB_NAME}', role '${DB_USER}', ${ENV_FILE},"
    warn "       ${INSTALL_ROOT} and every backup in ${BACKUP_DIR} will be DELETED."
  else
    echo "Preserved (safe default):"
    echo "  - database '${DB_NAME}' and role '${DB_USER}'"
    echo "  - ${ENV_FILE} (secrets)"
    echo "  - ${INSTALL_ROOT} (application files)"
    echo "  - backups in ${BACKUP_DIR}"
    echo "  Re-run with --purge to delete those too."
  fi
  echo
  confirm_or_exit "Type 'yes' to continue" "yes" || { warn "uninstall cancelled - nothing was changed"; exit 0; }

  systemctl disable --now arvoo 2>/dev/null || systemctl stop arvoo 2>/dev/null || true
  systemctl disable --now arvoo-agent 2>/dev/null || systemctl stop arvoo-agent 2>/dev/null || true
  rm -f /etc/systemd/system/arvoo.service /etc/systemd/system/arvoo-agent.service
  systemctl daemon-reload

  rm -f /etc/nginx/sites-enabled/arvoo /etc/nginx/sites-available/arvoo \
        /etc/nginx/sites-enabled/arvoo-site /etc/nginx/sites-available/arvoo-site \
        /etc/nginx/snippets/arvoo-common.conf
  # The public site is content, not state: it is only removed on purge.
  [[ "$purge" == "1" ]] && rm -rf "$(public_site_root)"
  if nginx -t > /dev/null 2>&1; then
    systemctl reload nginx > /dev/null 2>&1 || true
  else
    warn "nginx configuration no longer validates; inspect /etc/nginx before reloading"
  fi
  rm -f /etc/cron.d/arvoo-backup
  ok "services, web server site and backup cron removed"

  if [[ "$purge" != "1" ]]; then
    echo
    ok "uninstall complete (database, secrets, application files and backups preserved)"
    return 0
  fi

  echo
  confirm_or_exit "Type 'DELETE ARVOO' to erase the database and all data" "DELETE ARVOO" \
    || { warn "purge cancelled - database and data were left untouched"; exit 0; }

  # FORCE terminates remaining client connections so the drop cannot hang.
  psql_super <<SQL
DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);
DROP ROLE IF EXISTS ${DB_USER};
SQL
  rm -f "$ENV_FILE"
  rm -rf "$INSTALL_ROOT" "$BACKUP_DIR" /etc/arvoo /var/lib/arvoo
  ok "database, role, secrets, application files and backups deleted"
}

# The CLI is the terminal counterpart of the panel: same services, same API for
# secret rotation, same backup script. Installed for both roles.
install_cli() {
  step "Installing the Arvoo CLI"
  local source=""
  for candidate in "${INSTALL_ROOT}/cli/arvoo" "${NODE_AGENT_ROOT}/cli/arvoo" "./cli/arvoo"; do
    if [[ -f "$candidate" ]]; then source="$candidate"; break; fi
  done
  if [[ -z "$source" ]]; then
    warn "cli/arvoo not found in the checkout; skipping (panel and API are unaffected)"
    return 0
  fi
  install -m 0755 "$source" /usr/local/bin/arvoo
  ok "installed: arvoo (run 'arvoo --help', or 'arvoo' for the menu)"
}

mode_install() {
  require_root

  check_ubuntu
  check_arch
  install_system_packages
  # Asked before the env file is written: the answer feeds CORS, the control
  # plane URL and the certificate.
  ask_domain
  ensure_user
  ensure_checkout
  ensure_env_file
  configure_postgres
  install_host_tuning
  build_app
  run_migrations
  install_services
  start_backend
  install_nginx
  configure_https
  install_backup_cron
  install_cli
  install_public_site
  firewall_rules
  health_report || abort "the backend did not report status:ok / database:ok"
  final_report
}

# ---------------------------------------------------------------------------
# Public site (spec §12): a static, indexable marketing page served by nginx.
# It never links to, proxies or reveals the management panel, and it collects
# no credentials. Served on its own domain when one is configured, otherwise as
# the default virtual host so an IP-only install still has a public page.
# ---------------------------------------------------------------------------

public_site_root() { printf '/var/www/arvoo-site'; }

install_public_site() {
  local source="${INSTALL_ROOT}/site"
  if [[ ! -d "$source" ]]; then
    warn "site/ not found in the checkout; skipping the public site (the panel is unaffected)"
    return 0
  fi
  step "Installing the public site"

  local root; root="$(public_site_root)"
  install -d -m 0755 "$root" "$root/assets"
  install -m 0644 "$source/index.html" "$root/index.html"
  install -m 0644 "$source/robots.txt" "$root/robots.txt"
  install -m 0644 "$source/sitemap.xml" "$root/sitemap.xml"
  install -m 0644 "$source/assets/site.css" "$root/assets/site.css"
  install -m 0644 "$source/assets/site.js" "$root/assets/site.js"

  # Placeholders are replaced once, here. No secrets ever reach this directory.
  local site_domain="${ARVOO_SITE_DOMAIN:-${ARVOO_DOMAIN:-$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname)}}"
  local contact="${ARVOO_CONTACT_EMAIL:-support@${site_domain}}"
  local file
  for file in "$root/index.html" "$root/robots.txt" "$root/sitemap.xml"; do
    sed -i "s|__SITE_DOMAIN__|${site_domain}|g; s|__CONTACT_EMAIL__|${contact}|g" "$file"
  done
  ok "public site installed at ${root} (domain: ${site_domain}, contact: ${contact})"

  local conf="/etc/nginx/sites-available/arvoo-site"
  if [[ -n "${ARVOO_SITE_DOMAIN:-}" && "${ARVOO_SITE_DOMAIN}" != "${ARVOO_DOMAIN:-}" ]]; then
    cat > "$conf" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${ARVOO_SITE_DOMAIN};

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { root ${root}; index index.html; try_files \$uri \$uri/ /index.html; }
    location = /robots.txt { root ${root}; }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'" always;
}
NGINX
  else
    # No separate site domain: answer for any host that is not the panel, so the
    # public page exists on an IP-only installation too. The panel keeps its own
    # server_name (and TLS) block.
    cat > "$conf" <<NGINX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { root ${root}; index index.html; try_files \$uri \$uri/ /index.html; }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'" always;
}
NGINX
  fi

  ln -sf "$conf" /etc/nginx/sites-enabled/arvoo-site
  if nginx -t > /dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    ok "nginx now serves the public site"
  else
    warn "nginx configuration test failed for the public site; the panel is unaffected"
    nginx -t || true
    rm -f /etc/nginx/sites-enabled/arvoo-site
  fi
}

# ---------------------------------------------------------------------------
# Node-only installation: a VPN node needs the agent and the network
# dependencies, never the panel, PostgreSQL, nginx or the master API.
# ---------------------------------------------------------------------------

NODE_AGENT_ROOT="${ARVOO_NODE_ROOT:-/opt/arvoo}"
AGENT_ENV_FILE="/etc/arvoo/agent.env"
AGENT_STATE_DIR="/var/lib/arvoo"
AGENT_ENTRY="${NODE_AGENT_ROOT}/apps/agent/dist/index.js"

# Control plane URL for the agent. Persisted (no secrets) so repairs and
# restarts do not need to ask again.
write_agent_env() {
  local url="$1"
  install -d -m 0750 /etc/arvoo
  ( umask 077; cat > "$AGENT_ENV_FILE" <<EOF
# Arvoo Node Agent environment (installed by install.sh).
# No secrets are stored here: the node identity lives in
# ${AGENT_STATE_DIR}/agent-state.json (mode 0600, root only).
ARVOO_AGENT_STATE_DIR=${AGENT_STATE_DIR}
ARVOO_CONTROL_PLANE_URL=${url}
EOF
  )
  chmod 0640 "$AGENT_ENV_FILE"
}

ask_control_plane_url() {
  local url="${ARVOO_CONTROL_PLANE_URL:-}"
  if [[ -z "$url" && -r "$AGENT_ENV_FILE" ]]; then
    url="$(sed -n 's/^ARVOO_CONTROL_PLANE_URL=//p' "$AGENT_ENV_FILE" | head -n1)"
  fi
  if [[ -z "$url" && -t 0 ]]; then
    echo >&2
    echo "Arvoo Control Plane URL:" >&2
    read -r -p "  (e.g. https://panel.example.com) " url
  fi
  [[ -n "$url" ]] || abort "no control plane URL given. For unattended installs set ARVOO_CONTROL_PLANE_URL=https://panel.example.com"
  url="${url%/}"
  case "$url" in
    http://*|https://*) ;;
    *) abort "the control plane URL must start with http:// or https:// (got: ${url})" ;;
  esac
  printf '%s' "$url"
}

validate_control_plane() {
  local url="$1" health
  health="$(curl -fsS --max-time 20 "${url}/health" 2>/dev/null)" \
    || abort "the control plane at ${url} did not answer ${url}/health. Check the URL, DNS and that the panel is running."
  if printf '%s' "$health" | grep -q '"status":"ok"'; then
    ok "control plane reachable and healthy (${url})"
  else
    warn "control plane answered but did not report status:ok: ${health}"
  fi
}

# Production enrollment: the installer asks, validates, enrolls, verifies. The
# operator never runs a development command, and the one-time token is passed
# through the environment only - never argv (world-readable in /proc) and never
# echoed back.
enroll_agent() {
  step "Node enrollment"
  [[ -f "$AGENT_ENTRY" ]] || abort "agent build not found at ${AGENT_ENTRY}"
  command_exists node || abort "Node.js is required to run the agent"

  local state_file="${AGENT_STATE_DIR}/agent-state.json"

  # Already enrolled: a re-run of the installer (repair, update, or a second
  # `--node` run) must never need a new one-time token and must never create a
  # second node. The identity on disk is reused, exactly as it is across service
  # restarts. No control plane round trip is required here, so a repair works
  # while the panel is down.
  if [[ -r "$state_file" ]]; then
    local existing_url=""
    existing_url="$(ask_control_plane_url 2>/dev/null || true)"
    if [[ -z "$existing_url" ]]; then
      existing_url="$(sed -n 's/.*"controlPlaneUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state_file" | head -n1)"
    fi
    [[ -n "$existing_url" ]] \
      || abort "this host is already enrolled but its control plane URL could not be determined; re-run with ARVOO_CONTROL_PLANE_URL=https://panel.example.com"
    write_agent_env "$existing_url"
    ok "already enrolled (node $(agent_node_id)); enrollment skipped, no new token needed"
    return 0
  fi

  local url; url="$(ask_control_plane_url)"
  validate_control_plane "$url"
  write_agent_env "$url"

  local token="${ARVOO_ENROLLMENT_TOKEN:-}"
  if [[ -z "$token" ]]; then
    if [[ -t 0 ]]; then
      echo >&2
      echo "One-time Node enrollment token:" >&2
      echo "  Generate it in the panel: Nodes -> Add node -> enrollment token." >&2
      echo "  It is single use and expires in a few minutes." >&2
      read -r -s -p "  " token
      echo >&2
    fi
  fi
  [[ -n "$token" ]] \
    || abort "no enrollment token given. Generate one in the panel (Nodes -> Add node) and re-run: ./install.sh --node"

  local rc=0 output=""
  output="$(ARVOO_AGENT_STATE_DIR="$AGENT_STATE_DIR" \
            ARVOO_CONTROL_PLANE_URL="$url" \
            ARVOO_ENROLLMENT_TOKEN="$token" \
            node "$AGENT_ENTRY" enroll 2>&1)" || rc=$?
  unset token

  if [[ $rc -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    abort "enrollment failed. Tokens are single use and short lived: generate a new one in the panel and re-run ./install.sh --node"
  fi
  printf '%s\n' "$output"
  [[ -f "$state_file" ]] \
    || abort "enrollment reported success but no identity was written to ${AGENT_STATE_DIR}; refusing to continue"
  chmod 0600 "$state_file"
  ok "node identity created (${state_file}, mode 0600)"
}

mode_install_node() {
  require_root
  check_ubuntu
  check_arch

  step "Installing node dependencies (no panel, database or web server)"
  export DEBIAN_FRONTEND=noninteractive
  command_exists apt-get || abort "apt-get not found; this installer targets Ubuntu."
  apt-get update -qq
  # Every package backs a feature the agent probes and reports. The panel only
  # offers a feature when the node confirms it, so a missing package never
  # results in a configuration that silently does nothing.
  apt-get install -y -qq \
    ca-certificates curl iproute2 iptables nftables ufw ethtool iperf3 \
    openvpn strongswan-swanctl charon-systemd kmod > /dev/null \
    || abort "package installation failed"

  if ! command_exists node || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$REQUIRED_NODE_MAJOR" ]]; then
    log "Installing Node.js ${REQUIRED_NODE_MAJOR}.x"
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" -o /tmp/nodesource.sh
    bash /tmp/nodesource.sh > /dev/null
    apt-get install -y -qq nodejs > /dev/null
  fi
  command_exists node || abort "Node.js did not install"

  step "Installing the agent"
  [[ -f "${NODE_AGENT_ROOT}/apps/agent/dist/index.js" ]] \
    || abort "agent build not found at ${NODE_AGENT_ROOT}/apps/agent/dist/index.js; copy the checkout there and run: npm ci && npm run build -w apps/agent"
  install -d -m 0750 /var/lib/arvoo /etc/arvoo
  # Must exist before the agent unit is enabled: its ReadWritePaths contain
  # /etc/ufw and /var/lib/ufw, and a missing path makes systemd fail the unit
  # with status=226/NAMESPACE before the agent ever runs.
  ensure_ufw_dirs
  install -m 0644 "${NODE_AGENT_ROOT}/deploy/arvoo-agent.service" /etc/systemd/system/arvoo-agent.service
  install_cli
  systemctl daemon-reload
  systemctl enable arvoo-agent >/dev/null 2>&1 || true

  step "Kernel modules and forwarding"
  for mod in ip_gre fou ipip; do
    modprobe "$mod" 2>/dev/null || warn "kernel module ${mod} is not available on this kernel"
  done
  if [[ -f "${NODE_AGENT_ROOT}/deploy/arvoo-sysctl.conf" ]]; then
    install -m 0644 "${NODE_AGENT_ROOT}/deploy/arvoo-sysctl.conf" /etc/sysctl.d/99-arvoo.conf
    sysctl --system >/dev/null 2>&1 || true
  fi

  enroll_agent

  step "Starting the agent"
  systemctl enable arvoo-agent >/dev/null 2>&1 || true
  systemctl restart arvoo-agent || abort "arvoo-agent failed to start (inspect: journalctl -u arvoo-agent -n 50)"
  sleep 2
  if systemctl is-active --quiet arvoo-agent; then
    ok "arvoo-agent: active - heartbeats and capability reporting started"
  else
    abort "arvoo-agent is not active after enrollment (inspect: journalctl -u arvoo-agent -n 50)"
  fi

  local reported=""
  reported="$(ARVOO_AGENT_STATE_DIR="$AGENT_STATE_DIR" node "$AGENT_ENTRY" status 2>/dev/null || true)"
  [[ -n "$reported" ]] && printf '%s\n' "$reported" | sed 's/^/  /'

  # Restart safety is verified here, not assumed: the identity in
  # ${AGENT_STATE_DIR}/agent-state.json must survive a service restart, and no
  # new enrollment may happen (a fresh token must never be needed for that).
  step "Verifying restart safety"
  local id_before="" id_after=""
  id_before="$(agent_node_id)"
  systemctl restart arvoo-agent || abort "arvoo-agent failed to restart (inspect: journalctl -u arvoo-agent -n 50)"
  sleep 3
  if ! systemctl is-active --quiet arvoo-agent; then
    journalctl -u arvoo-agent -n 30 --no-pager >&2 || true
    abort "arvoo-agent did not come back after a restart"
  fi
  id_after="$(agent_node_id)"
  if [[ -n "$id_before" && "$id_before" == "$id_after" ]]; then
    ok "arvoo-agent restarts cleanly with the same identity (${id_after}); no re-enrollment needed"
  else
    abort "a restart changed the node identity (${id_before:-none} -> ${id_after:-none}); the agent must reload ${AGENT_STATE_DIR}/agent-state.json instead of enrolling again"
  fi

  ok "node-only install complete."
  ok "the panel will offer only the features this node confirms (see Node > Capabilities)"
  ok "for emergency terminal operations use: arvoo node status / arvoo diagnostics / arvoo logs --component node"
  echo
  echo "Final status: the node appears in the panel as awaiting approval."
  echo "  Approve it:  Nodes -> this node -> Approve   (capabilities arrive with the first heartbeats)"
  echo "  Verify:      arvoo node status ; arvoo diagnostics"
  echo
}

# Repair picks the role from what is actually installed, then runs the same
# idempotent path. Neither path deletes data; both are safe to re-run.
mode_repair() {
  if [[ -f /etc/systemd/system/arvoo.service || -f "${ENV_FILE}" ]]; then
    step "Repair: Master / Panel (detected from the installed services)"
    mode_install
  else
    step "Repair: Node Agent (no panel detected on this host)"
    mode_install_node
  fi
}

mode_diagnostics() {
  step "Diagnostics"
  local rc=0
  for bin in ip nft openvpn swanctl iperf3 modprobe; do
    if command_exists "$bin"; then ok "$bin: $(command -v "$bin")"; else warn "$bin: not installed"; rc=1; fi
  done
  for mod in ip_gre fou ovpn_dco_v2 ovpn; do
    if modprobe -n "$mod" >/dev/null 2>&1; then ok "kernel module ${mod}: loadable"; else warn "kernel module ${mod}: not loadable"; fi
  done
  if systemctl is-active arvoo-agent >/dev/null 2>&1; then ok "arvoo-agent: active"; else warn "arvoo-agent: not active"; rc=1; fi
  if [[ -r "${AGENT_STATE_DIR}/agent-state.json" ]]; then
    ok "node identity: enrolled ($(stat -c '%a' "${AGENT_STATE_DIR}/agent-state.json" 2>/dev/null))"
    if command_exists node && [[ -f "$AGENT_ENTRY" ]]; then
      local reported; reported="$(ARVOO_AGENT_STATE_DIR="$AGENT_STATE_DIR" node "$AGENT_ENTRY" status 2>/dev/null || true)"
      [[ -n "$reported" ]] && printf '%s\n' "$reported" | sed 's/^/        /'
    fi
  else
    warn "node identity: not enrolled (re-run ./install.sh --node with a fresh enrollment token)"
    rc=1
  fi
  return "$rc"
}

mode_menu() {
  cat <<'MENU'
====================================
          ARVOO INSTALLER
====================================

1) Install Arvoo Master / Panel
2) Install Arvoo Node Agent
3) Repair installation
4) Update
5) Diagnostics
6) Uninstall

MENU
  local choice=""
  read -r -p "Select: " choice
  case "$choice" in
    1) mode_install ;;
    2) mode_install_node ;;
    3) mode_repair ;;
    4) mode_update ;;
    5) run_diagnostic mode_diagnostics ;;
    6) mode_uninstall ;;
    *) fail "invalid selection: ${choice:-<empty>}"; exit 2 ;;
  esac
}

usage() {
  cat <<'USAGE'
Arvoo Control Plane - installer and maintenance (Ubuntu 24.04 LTS)

Usage: sudo ./install.sh [command]

Commands:
  (none)          interactive menu in a terminal; full panel install otherwise (idempotent)
  --menu          show the interactive installer menu
  --node          install and enroll the Node Agent (no panel/PostgreSQL/nginx)
  --diagnostics   check node tools, kernel modules and the agent service
  --check         verify prerequisites and current state; changes nothing
  --status        services, health, listeners, database and backups
  --update        git pull + rebuild + migrate + restart, with health check
  --restart       restart the backend and reload Nginx
  --backup        run a PostgreSQL backup now (scripts/backup.sh)
  --uninstall     remove services and the Nginx site; keeps database + data
  --purge         --uninstall, then delete database, secrets, files and backups
  -h, --help      this help

Environment overrides:
  ARVOO_DOMAIN=panel.example.com   enable HTTPS via Let's Encrypt
  ARVOO_EMAIL=ops@example.com      ACME account email
  ARVOO_ADMIN_PASSWORD=secret      initial admin password (else generated)
  ARVOO_ADMIN_USER=admin           initial admin username
  ARVOO_API_PORT=4001              backend port (loopback only)
  ARVOO_INSTALL_ROOT=/opt/arvoo    application directory
  ARVOO_ENV_FILE=/etc/arvoo.env    environment/secret file
  ARVOO_BACKUP_DIR=/var/backups/arvoo   backup destination
  ARVOO_LOG_LEVEL / ARVOO_POOL_MAX / ARVOO_BACKUP_KEEP
  ARVOO_AUTO_ROLLBACK=0            do not auto-rollback code after a failed --update
  ARVOO_FORCE=1                    skip interactive confirmation (--uninstall/--purge)

Exit codes: 0 success - 1 a check or command failed - 2 usage error
Full documentation: DEPLOYMENT.md
USAGE
}

# Run a diagnostic mode whose non-zero exit is a RESULT (degraded/unmet
# prerequisites) instead of a crash, so the ERR reporter stays quiet.
run_diagnostic() {
  if "$1"; then
    exit 0
  else
    exit 1
  fi
}

main() {
  local command="install"
  if [[ $# -eq 0 && -t 0 ]]; then
    command="menu"
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --menu)        command="menu"; shift ;;
      --node)        command="node"; shift ;;
      --diagnostics) command="diagnostics"; shift ;;
      --master)      command="install"; shift ;;
      --check)     command="check"; shift ;;
      --status)    command="status"; shift ;;
      --update)    command="update"; shift ;;
      --restart)   command="restart"; shift ;;
      --backup)    command="backup"; shift ;;
      --uninstall) command="uninstall"; shift ;;
      --purge)     command="purge"; shift ;;
      -h|--help)   usage; exit 0 ;;
      "")          shift ;;
      *)           fail "unknown option: $1"; echo; usage; exit 2 ;;
    esac
  done

  case "$command" in
    menu)        mode_menu ;;
    node)        mode_install_node ;;
    diagnostics) run_diagnostic mode_diagnostics ;;
    install)   mode_install ;;
    check)     run_diagnostic mode_check ;;
    status)    run_diagnostic mode_status ;;
    update)    mode_update ;;
    restart)   mode_restart ;;
    backup)    mode_backup ;;
    uninstall) mode_uninstall ;;
    purge)     ARVOO_PURGE=1 mode_uninstall ;;
    *)         fail "internal error: unknown command '${command}'"; exit 2 ;;
  esac
}

# Only run when executed: the file is also sourced by the test suite, which
# calls individual functions (looks_like_checkout, render_tls_site, ...).
#
# When the script is piped in (`curl .../install.sh | bash -s --`) bash reports
# an EMPTY BASH_SOURCE[0] with $0 set to "bash", which is the documented install
# method - so an empty value must count as "executed" too. Without that the
# guard silently skipped main() and the command did nothing at all.
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
