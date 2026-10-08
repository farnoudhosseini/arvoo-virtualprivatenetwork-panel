-- Full client management (§38/§39), inbound domains (§40), load balancing (§41)
-- and managed UFW firewall state (§UFW).
--
-- Conventions match 0001-0003: TEXT ids (UUID v4) and ISO-8601 UTC timestamps,
-- INTEGER 0/1 flags, JSON payloads stored as TEXT.

-- ---------------------------------------------------------------------------
-- §39 OpenVPN username + password: a *separate* credential from the Arvoo panel
-- account and from the node secret. Only an OpenVPN tunnel ever authenticates
-- with these values; the panel never accepts them and the API never returns the
-- password (only its salt+hash and the timestamp of the last change).
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ovpn_username TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ovpn_password_hash TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ovpn_password_set_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ovpn_username_changed_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ovpn_auth_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (ovpn_auth_enabled IN (0,1));

-- Existing rows keep working: the OpenVPN username starts as the client name
-- and no password exists yet (password authentication is switched on per
-- inbound and per client, never silently).
UPDATE clients SET ovpn_username = username WHERE ovpn_username IS NULL OR ovpn_username = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_ovpn_username ON clients (lower(ovpn_username));

-- ---------------------------------------------------------------------------
-- §38 Client placement / routing preferences. These are consumed by the
-- routing engine when a session is placed; they are never decorative.
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_region TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_transport TEXT
  CHECK (preferred_transport IS NULL OR preferred_transport IN ('udp','tcp'));
ALTER TABLE clients ADD COLUMN IF NOT EXISTS fallback_inbound_id TEXT REFERENCES inbounds(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS routing_preferences TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_clients_preferred_node ON clients(preferred_node_id);

-- ---------------------------------------------------------------------------
-- §40 Inbound domain: the domain itself lives in the inbound's structured
-- configuration (so it is versioned and flows into generated .ovpn profiles);
-- these columns record the *result* of the DNS check that gates it.
-- ---------------------------------------------------------------------------
ALTER TABLE inbounds ADD COLUMN IF NOT EXISTS domain_status TEXT NOT NULL DEFAULT 'unset'
  CHECK (domain_status IN ('unset','verified','mismatch','unresolved'));
ALTER TABLE inbounds ADD COLUMN IF NOT EXISTS domain_resolved_ips TEXT NOT NULL DEFAULT '[]';
ALTER TABLE inbounds ADD COLUMN IF NOT EXISTS domain_checked_at TEXT;

-- ---------------------------------------------------------------------------
-- Firewall management (§UFW). The master composes a plan from real state
-- (SSH + panel + inbound + tunnel ports) and the node applies it with ufw.
-- ---------------------------------------------------------------------------
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ssh_port INTEGER NOT NULL DEFAULT 22
  CHECK (ssh_port BETWEEN 1 AND 65535);

CREATE TABLE IF NOT EXISTS firewall_state (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  plan_hash TEXT,
  rules TEXT NOT NULL DEFAULT '[]',
  applied_at TEXT,
  verified_at TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS firewall_applies (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  requested_by TEXT,
  action TEXT NOT NULL CHECK (action IN ('enable','update','disable')),
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','success','failed')),
  rules_count INTEGER NOT NULL DEFAULT 0,
  added TEXT NOT NULL DEFAULT '[]',
  removed TEXT NOT NULL DEFAULT '[]',
  operation_id TEXT,
  output TEXT,
  error TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_firewall_applies_node ON firewall_applies(node_id, at DESC);

-- ---------------------------------------------------------------------------
-- §41 Load balancing: a deliberately small model over the real routing engine.
-- A group is a named pool of inbounds or nodes with weights, health thresholds
-- and a failover policy; every value displayed in the panel is derived from
-- live telemetry (health samples, sessions, deployments), never simulated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lb_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  mode TEXT NOT NULL DEFAULT 'weighted' CHECK (mode IN ('weighted','failover','least-load')),
  health_requirements TEXT NOT NULL DEFAULT '{}',
  failover TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lb_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES lb_groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('inbound','node')),
  ref_id TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  drained INTEGER NOT NULL DEFAULT 0 CHECK (drained IN (0,1)),
  drain_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (group_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_lb_members_group ON lb_members(group_id);

-- Administrative and failover history for a group (drain, restore, member
-- health transitions) - the panel shows this instead of pretending to know
-- the future.
CREATE TABLE IF NOT EXISTS lb_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES lb_groups(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  member_id TEXT,
  message TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_lb_events_group ON lb_events(group_id, at DESC);
