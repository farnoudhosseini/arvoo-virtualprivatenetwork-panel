-- Arvoo Control Plane - initial schema (PostgreSQL)
-- All timestamps are ISO-8601 UTC strings stored as TEXT. IDs are UUID v4 strings.
-- Boolean-like flags are INTEGER (0/1), matching the application code.
-- Traffic/byte counters are BIGINT (64-bit) and parsed as JS numbers by the driver.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT,
  address TEXT,
  region TEXT,
  country TEXT,
  provider TEXT,
  role TEXT NOT NULL DEFAULT 'vpn' CHECK (role IN ('master','vpn','edge','gateway','transit','custom')),
  region_class TEXT NOT NULL DEFAULT 'international' CHECK (region_class IN ('iran','international')),
  tags TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline','degraded','maintenance','error','unknown')),
  enrollment_state TEXT NOT NULL DEFAULT 'not_enrolled' CHECK (enrollment_state IN ('not_enrolled','enrolled','approved','revoked')),
  agent_version TEXT,
  agent_platform TEXT,
  last_heartbeat_at TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  node_secret_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enroll_tokens_node ON enrollment_tokens(node_id);

CREATE TABLE IF NOT EXISTS node_health_samples (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  cpu_usage_pct DOUBLE PRECISION,
  memory_usage_pct DOUBLE PRECISION,
  disk_usage_pct DOUBLE PRECISION,
  rx_bytes BIGINT,
  tx_bytes BIGINT,
  openvpn_clients INTEGER
);
CREATE INDEX IF NOT EXISTS idx_health_node_at ON node_health_samples(node_id, at);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  ref_type TEXT CHECK (ref_type IN ('inbound','tunnel','route','node')),
  ref_id TEXT,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','failed','cancelled','rolled_back')),
  progress INTEGER NOT NULL DEFAULT 0,
  input TEXT,
  output TEXT,
  error TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_node_status ON operations(node_id, status);
CREATE INDEX IF NOT EXISTS idx_ops_status ON operations(status);

CREATE TABLE IF NOT EXISTS inbounds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  protocol TEXT NOT NULL DEFAULT 'openvpn' CHECK (protocol IN ('openvpn')),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','deploying','error','stopped')),
  structured_config TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbounds_node ON inbounds(node_id);

CREATE TABLE IF NOT EXISTS inbound_versions (
  id TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  structured_config TEXT NOT NULL,
  generated_config TEXT NOT NULL,
  checksum TEXT NOT NULL,
  openvpn_version TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (inbound_id, version)
);

CREATE TABLE IF NOT EXISTS inbound_deployments (
  id TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  version INTEGER NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','failed','rolled_back')),
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_inbound ON inbound_deployments(inbound_id, created_at);

CREATE TABLE IF NOT EXISTS client_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  cert_common_name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','expired','revoked')),
  group_id TEXT REFERENCES client_groups(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  limits TEXT NOT NULL,
  base_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  used_billed_bytes BIGINT NOT NULL DEFAULT 0,
  rx_bytes BIGINT NOT NULL DEFAULT 0,
  tx_bytes BIGINT NOT NULL DEFAULT 0,
  used_time_sec INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

CREATE TABLE IF NOT EXISTS client_secrets (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client_cert','client_key','tls_key')),
  data_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_id, kind)
);

CREATE TABLE IF NOT EXISTS client_devices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  hwid TEXT NOT NULL,
  label TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_ip TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  UNIQUE (client_id, hwid)
);
CREATE INDEX IF NOT EXISTS idx_devices_client ON client_devices(client_id);

CREATE TABLE IF NOT EXISTS client_sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  inbound_id TEXT REFERENCES inbounds(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  common_name TEXT NOT NULL,
  source_ip TEXT,
  vpn_ip TEXT,
  hwid TEXT,
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  rx_bytes BIGINT NOT NULL DEFAULT 0,
  tx_bytes BIGINT NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sessions_client ON client_sessions(client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON client_sessions(active);

CREATE TABLE IF NOT EXISTS client_usage_samples (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  rx_bytes BIGINT NOT NULL,
  tx_bytes BIGINT NOT NULL,
  billed_bytes BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_client_at ON client_usage_samples(client_id, at);

CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  effective_from TEXT,
  effective_until TEXT,
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'gre' CHECK (type IN ('gre')),
  source_node_id TEXT NOT NULL REFERENCES nodes(id),
  dest_node_id TEXT NOT NULL REFERENCES nodes(id),
  source_endpoint TEXT NOT NULL,
  dest_endpoint TEXT NOT NULL,
  tunnel_network TEXT NOT NULL,
  local_tunnel_ip TEXT NOT NULL,
  remote_tunnel_ip TEXT NOT NULL,
  mtu INTEGER NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 255,
  key TEXT,
  keepalive_interval_sec INTEGER NOT NULL DEFAULT 10,
  keepalive_retries INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','deploying','up','degraded','down','error')),
  latency_ms DOUBLE PRECISION,
  loss_pct DOUBLE PRECISION,
  last_verified_at TEXT,
  mtu_override INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  gateway TEXT,
  device TEXT,
  metric INTEGER,
  scope TEXT NOT NULL DEFAULT 'manual' CHECK (scope IN ('tunnel','inbound','manual')),
  ref_id TEXT,
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routes_node ON routes(node_id);

CREATE TABLE IF NOT EXISTS operation_logs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  step TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oplogs_op ON operation_logs(operation_id, at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  entity_name TEXT,
  summary TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pki_certificates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ca','server','client')),
  name TEXT NOT NULL,
  inbound_id TEXT REFERENCES inbounds(id) ON DELETE CASCADE,
  client_id TEXT REFERENCES clients(id) ON DELETE CASCADE,
  serial TEXT NOT NULL,
  certificate TEXT NOT NULL,
  encrypted_private_key TEXT,
  not_before TEXT,
  not_after TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pki_inbound ON pki_certificates(inbound_id);
CREATE INDEX IF NOT EXISTS idx_pki_client ON pki_certificates(client_id);

CREATE TABLE IF NOT EXISTS node_telemetry (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  telemetry TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_inbounds (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  inbound_id TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (client_id, inbound_id)
);
CREATE INDEX IF NOT EXISTS idx_client_inbounds_inbound ON client_inbounds(inbound_id);

CREATE TABLE IF NOT EXISTS inbound_secrets (
  id TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tls_key')),
  data_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (inbound_id, kind)
);
