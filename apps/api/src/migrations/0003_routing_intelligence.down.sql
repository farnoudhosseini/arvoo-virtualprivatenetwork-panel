-- Reverse of 0003_routing_intelligence.sql (newest objects first).

DROP TABLE IF EXISTS routing_policies;
DROP TABLE IF EXISTS routing_events;
DROP TABLE IF EXISTS client_assignments;
DROP TABLE IF EXISTS transport_health;
DROP TABLE IF EXISTS path_health;
DROP TABLE IF EXISTS node_endpoints;

ALTER TABLE tunnels DROP COLUMN IF EXISTS weight;
ALTER TABLE tunnels DROP COLUMN IF EXISTS admin_state;

ALTER TABLE nodes DROP COLUMN IF EXISTS bandwidth_mbps;
ALTER TABLE nodes DROP COLUMN IF EXISTS capacity_sessions;
ALTER TABLE nodes DROP COLUMN IF EXISTS admin_state;
