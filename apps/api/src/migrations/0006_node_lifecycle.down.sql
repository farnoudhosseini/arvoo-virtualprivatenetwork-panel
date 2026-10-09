-- Reverse of 0006_node_lifecycle.sql.
--
-- The FK is restored to its original shape first: rows whose node was deleted
-- (node_id IS NULL) cannot satisfy the NOT NULL column, so the operator is told
-- rather than silently losing deployment history in a downgrade.

ALTER TABLE inbound_deployments DROP CONSTRAINT IF EXISTS inbound_deployments_node_id_fkey;
ALTER TABLE inbound_deployments ADD CONSTRAINT inbound_deployments_node_id_fkey
  FOREIGN KEY (node_id) REFERENCES nodes(id);
ALTER TABLE inbound_deployments ALTER COLUMN node_id SET NOT NULL;

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_decommission_state_check;
ALTER TABLE nodes DROP COLUMN IF EXISTS decommission_detail;
ALTER TABLE nodes DROP COLUMN IF EXISTS decommissioned_at;
ALTER TABLE nodes DROP COLUMN IF EXISTS decommission_state;
ALTER TABLE nodes DROP COLUMN IF EXISTS token_revoked_at;
ALTER TABLE nodes DROP COLUMN IF EXISTS token_rotated_at;
ALTER TABLE nodes DROP COLUMN IF EXISTS token_issued_at;
ALTER TABLE nodes DROP COLUMN IF EXISTS node_secret_encrypted;
