-- Adaptive routing intelligence: administrative lifecycle, endpoint pools,
-- real path/transport health, sticky client assignments, explainable routing
-- events and the policy that drives candidate selection.
--
-- Health *samples* are recorded here; health *states* are derived from them by
-- the engine (hysteresis lives in code, not in duplicated columns), so the
-- panel can always recompute why a path is marked down or degraded.
-- Timestamps are ISO-8601 UTC strings, ids are UUID v4 strings, and flags are
-- INTEGER 0/1 - the existing conventions.

-- ---------------------------------------------------------------------------
-- Administrative lifecycle (spec §22/§23): Disable and Drain never kill users.
-- ---------------------------------------------------------------------------
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS admin_state TEXT NOT NULL DEFAULT 'enabled'
  CHECK (admin_state IN ('enabled','disabled','drained'));
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capacity_sessions INTEGER
  CHECK (capacity_sessions IS NULL OR capacity_sessions > 0);
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS bandwidth_mbps DOUBLE PRECISION
  CHECK (bandwidth_mbps IS NULL OR bandwidth_mbps > 0);

ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS admin_state TEXT NOT NULL DEFAULT 'enabled'
  CHECK (admin_state IN ('enabled','disabled','drained'));
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 100
  CHECK (weight >= 0 AND weight <= 1000);

-- ---------------------------------------------------------------------------
-- Endpoint pools (spec §21): one node can reach the network through several
-- endpoints, each with its own administrative weight and health state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS node_endpoints (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  port INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
  transport TEXT NOT NULL DEFAULT 'openvpn-udp',
  enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (state IN ('healthy','degraded','failing','down','recovering','unknown')),
  state_since TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (node_id, label)
);
CREATE INDEX IF NOT EXISTS idx_node_endpoints_node ON node_endpoints(node_id);

-- ---------------------------------------------------------------------------
-- Path health: one row per real probe or benchmark (spec §4/§32).
-- A failed probe is recorded as ok=0 with NULL metrics: failures are evidence,
-- invented numbers are not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS path_health (
  id TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  latency_ms DOUBLE PRECISION,
  loss_pct DOUBLE PRECISION,
  jitter_ms DOUBLE PRECISION,
  throughput_mbps DOUBLE PRECISION,
  samples INTEGER,
  source TEXT NOT NULL DEFAULT 'benchmark'
    CHECK (source IN ('benchmark','deploy','test','heartbeat')),
  detail TEXT,
  -- Hysteresis needs the previous state, so each sample carries the state it
  -- produced. The newest row is therefore the path's current state.
  state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (state IN ('healthy','degraded','failing','down','recovering','unknown')),
  state_since TEXT
);
CREATE INDEX IF NOT EXISTS idx_path_health_tunnel_at ON path_health(tunnel_id, at DESC);

-- ---------------------------------------------------------------------------
-- Transport health: the hysteretic state of each transport on a tunnel
-- (spec §5/§12). One row per (tunnel, transport), advanced by the engine.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transport_health (
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  transport TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (state IN ('healthy','degraded','failing','down','recovering','unknown')),
  state_since TEXT,
  score DOUBLE PRECISION,
  handshake_success_pct DOUBLE PRECISION,
  failures INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  latency_ms DOUBLE PRECISION,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tunnel_id, transport)
);

-- ---------------------------------------------------------------------------
-- Sticky client assignments (spec §9/§14): one active ingress->egress pair per
-- client, never spread across egress nodes packet by packet.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_assignments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  ingress_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  egress_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tunnel_id TEXT REFERENCES tunnels(id) ON DELETE SET NULL,
  transport TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','draining','migrated','released')),
  reason TEXT,
  score DOUBLE PRECISION,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assignments_ingress ON client_assignments(ingress_node_id);
CREATE INDEX IF NOT EXISTS idx_assignments_egress ON client_assignments(egress_node_id);

-- ---------------------------------------------------------------------------
-- Explainable routing events (spec §39): every placement, hold and failover
-- decision with the reason an operator can audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create','keep','move','reject','failover','drain','admin','policy','health')),
  client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  from_path TEXT,
  to_path TEXT,
  ingress_node_id TEXT,
  egress_node_id TEXT,
  tunnel_id TEXT,
  transport TEXT,
  score DOUBLE PRECISION,
  reason TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_routing_events_at ON routing_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_events_client ON routing_events(client_id, at DESC);

-- ---------------------------------------------------------------------------
-- Routing policy (spec §24): AUTO / PREFERRED_* / STRICT, per scope.
-- `ref_id` is NOT NULL DEFAULT '' so the global ('' / 'global') row is unique.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS routing_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','client','group')),
  ref_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (mode IN ('auto','preferred-node','preferred-region','preferred-transport','strict')),
  preferred_node_ids TEXT NOT NULL DEFAULT '[]',
  preferred_countries TEXT NOT NULL DEFAULT '[]',
  preferred_region_classes TEXT NOT NULL DEFAULT '[]',
  preferred_transports TEXT NOT NULL DEFAULT '[]',
  weights TEXT NOT NULL DEFAULT '{}',
  min_switch_delta DOUBLE PRECISION NOT NULL DEFAULT 5,
  hold_down_sec INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, ref_id)
);
