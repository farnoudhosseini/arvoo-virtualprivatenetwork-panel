-- Node lifecycle: token visibility, decommission tracking, and deployment
-- history that survives the node it was deployed to.
--
-- Why each piece exists:
--
-- 1. The agent credential (node secret) was only ever stored as a SHA-256 hash
--    and shown once at enrollment, so the *active* credential could never be
--    inspected again. Newly issued or rotated credentials also keep an
--    AES-256-GCM encrypted copy (the same envelope used for tunnel PSKs and
--    client keys) so an authorized administrator can reveal the credential that
--    is actually in use. Nothing is stored in plaintext, and a legacy row that
--    only has a hash is reported as not revealable instead of pretending.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS node_secret_encrypted TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS token_issued_at TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS token_rotated_at TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS token_revoked_at TEXT;

-- 2. Decommissioning is tracked separately from enrollment. A node can be
--    revoked (its credential is dead, no new work can be claimed) while the
--    cleanup of Arvoo-owned resources on the host is still pending. That
--    difference must be a real stored state, not something the UI guesses:
--      none      - nothing was asked for
--      requested - cleanup was queued/attempted and has not reported yet
--      partial   - the host did not report back (offline, failed, or refused)
--      complete  - every Arvoo-owned resource on the host was removed
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS decommission_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE nodes ADD CONSTRAINT nodes_decommission_state_check
  CHECK (decommission_state IN ('none', 'requested', 'partial', 'complete'));
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS decommissioned_at TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS decommission_detail TEXT;

-- 3. Deployment history must outlive the node it was deployed to. `node_id` was
--    NOT NULL with a plain FK, so the row could neither be kept (NOT NULL) nor
--    survive the node (no ON DELETE action): deleting a node with any deployment
--    history failed with a foreign-key error instead of a policy decision. The
--    history now survives with a NULL node reference - the same pattern
--    `operations.node_id` already uses.
ALTER TABLE inbound_deployments ALTER COLUMN node_id DROP NOT NULL;
ALTER TABLE inbound_deployments DROP CONSTRAINT IF EXISTS inbound_deployments_node_id_fkey;
ALTER TABLE inbound_deployments ADD CONSTRAINT inbound_deployments_node_id_fkey
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL;
