-- Reverse of 0002_tunnel_encap_capabilities.sql.
DROP TABLE IF EXISTS tunnel_meshes;
ALTER TABLE nodes DROP COLUMN IF EXISTS capabilities_at;
ALTER TABLE nodes DROP COLUMN IF EXISTS capabilities;
ALTER TABLE tunnels DROP COLUMN IF EXISTS ipsec_enabled;
ALTER TABLE tunnels DROP COLUMN IF EXISTS fou_port;
DROP TABLE IF EXISTS tunnel_secrets;
