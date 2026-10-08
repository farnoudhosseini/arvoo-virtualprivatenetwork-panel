-- Reverse of 0004_full_management.sql. Drops only the objects it created and
-- drops the columns it added, so a downgrade returns the schema to 0003.

DROP TABLE IF EXISTS lb_events;
DROP TABLE IF EXISTS lb_members;
DROP TABLE IF EXISTS lb_groups;
DROP TABLE IF EXISTS firewall_applies;
DROP TABLE IF EXISTS firewall_state;

ALTER TABLE nodes DROP COLUMN IF EXISTS ssh_port;

ALTER TABLE inbounds DROP COLUMN IF EXISTS domain_checked_at;
ALTER TABLE inbounds DROP COLUMN IF EXISTS domain_resolved_ips;
ALTER TABLE inbounds DROP COLUMN IF EXISTS domain_status;

DROP INDEX IF EXISTS idx_clients_preferred_node;
ALTER TABLE clients DROP COLUMN IF EXISTS routing_preferences;
ALTER TABLE clients DROP COLUMN IF EXISTS fallback_inbound_id;
ALTER TABLE clients DROP COLUMN IF EXISTS preferred_transport;
ALTER TABLE clients DROP COLUMN IF EXISTS preferred_region;
ALTER TABLE clients DROP COLUMN IF EXISTS preferred_node_id;

DROP INDEX IF EXISTS idx_clients_ovpn_username;
ALTER TABLE clients DROP COLUMN IF EXISTS ovpn_auth_enabled;
ALTER TABLE clients DROP COLUMN IF EXISTS ovpn_username_changed_at;
ALTER TABLE clients DROP COLUMN IF EXISTS ovpn_password_set_at;
ALTER TABLE clients DROP COLUMN IF EXISTS ovpn_password_hash;
ALTER TABLE clients DROP COLUMN IF EXISTS ovpn_username;
