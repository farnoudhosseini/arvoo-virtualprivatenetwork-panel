-- GRE encapsulation options (FOU / IPsec) and discovered node capabilities.

ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS fou_port INTEGER CHECK (fou_port IS NULL OR (fou_port BETWEEN 1 AND 65535));
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS ipsec_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ipsec_enabled IN (0,1));

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capabilities TEXT NOT NULL DEFAULT '{}';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS capabilities_at TEXT;

-- Mesh grouping: tunnels created together by one "Create Mesh" action.
CREATE TABLE IF NOT EXISTS tunnel_meshes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source_node_ids TEXT NOT NULL,
  dest_node_ids TEXT NOT NULL,
  tunnel_type TEXT NOT NULL DEFAULT 'gre' CHECK (tunnel_type IN ('gre')),
  fou_port INTEGER,
  ipsec_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-tunnel secrets (IPsec PSK), encrypted with ARVOO_APP_SECRET.
CREATE TABLE IF NOT EXISTS tunnel_secrets (
  id TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ipsec_psk')),
  data_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tunnel_id, kind)
);
