# Node lifecycle: credentials, decommissioning, deletion

What was wrong before this change:

* **The agent credential could not be inspected.** `/agent/hello` derived the
  secret from `${nodeId}:${Date.now()}:${Math.random()}` and stored only its
  SHA-256 hash. The value was shown once at enrollment and was unrecoverable
  afterwards, so "show me the node token" had no honest implementation: the only
  options were to fake it or to rotate.
* **Deletion was a thin guard with a latent foreign-key bug.** `deleteNode()`
  refused when an inbound or a tunnel existed and then deleted the row. Nothing
  revoked the credential, nothing removed what the panel had created on the host,
  and `inbound_deployments.node_id` was `NOT NULL REFERENCES nodes(id)` with no
  `ON DELETE` action - so a node with any deployment history failed on a
  constraint instead of a policy decision.
* **There was no decommission state.** A node could be revoked while its GRE
  interface and OpenVPN instance kept running on the host, and nothing recorded
  that.

## The credential model

| Step | Behaviour |
| --- | --- |
| Enrollment (`POST /api/v1/agent/hello`) | `arvnode_<48 hex>` from `crypto.randomBytes`, stored as `node_secret_hash` **and** `node_secret_encrypted` (AES-256-GCM, `APP_SECRET`), with `token_issued_at` |
| Authentication | Every agent request re-reads the hash and compares (`/api/v1/agent/*`), so revocation and rotation take effect on the next request - there is no cache to expire |
| Reveal (`POST /nodes/:id/token/reveal`) | Returns the **active** credential (admin + management gate when enabled). Audited as `node.token.reveal` without the value. Refused with an explanation for a legacy hash-only row instead of inventing a value |
| Rotate (`POST /nodes/:id/token/rotate`) | New credential returned in the same response; the previous one stops authenticating immediately; `token_rotated_at` recorded; the response carries the exact command that installs it on the node (`/var/lib/arvoo/agent-state.json` + `systemctl restart arvoo-agent`) |
| Revoke (`POST /nodes/:id/token/revoke`) | Clears hash and encrypted copy, deletes unused enrollment tokens, `token_revoked_at`; the node record and its history stay |
| Status (`GET /nodes/:id/token`) | `status` (active/revoked/none), timestamps, `revealable` and the reason it is not |

Nothing in a list, record, log, export or audit entry contains the credential:
`NodeRecord.tokenRevealable` is a boolean, and the secret is only ever returned by
the two endpoints above. The reveal/rotate responses are `no-store` like every
other API response.

**Legacy rows**: a node enrolled before migration 0006 has a hash only. The panel
reports it as *not revealable* and offers rotation, which issues a recoverable
credential. A downgrade (`0006_node_lifecycle.down.sql`) removes the encrypted
copy but keeps the hash, so authentication continues to work.

## Decommissioning

`POST /nodes/:id/decommission` does, in this order:

1. Revoke the credential (no new work, no heartbeats).
2. Compute what the panel owns on that host: one GRE interface per tunnel that
   terminates there, one systemd instance + config directory per inbound.
3. Store the outcome truthfully:

| Situation | Stored state | Detail |
| --- | --- | --- |
| Nothing was ever created there | `complete` | "No Arvoo-managed interfaces or inbounds are recorded for this node" |
| Node online, work queued | `requested` | cleanup operation queued; the node's own report settles it |
| Node offline, work pending | `partial` | "Node is offline: nothing could be removed on the host. Pending on the node: …" |
| Cleanup reported failure | `partial` | per-resource report, e.g. `interface:gate-01: RTNETLINK answers: Operation not permitted` |
| Cleanup reported success | `complete` | removed/absent counts from the node |
| Decommission repeated while unconfirmed | `partial` (unchanged) | never silently upgraded to clean |

The state lives in `nodes.decommission_state` / `decommission_detail` /
`decommissioned_at` and is shown on the node page and in the dependency preview.
The cleanup operation itself appears in the node's operation history.

## CleanupNode (agent side)

The payload names **exactly** what to remove - the interfaces and inbounds the
control plane created for that node:

```json
{ "interfaceNames": ["gate-01"], "inboundNames": ["ovpn-ir-01"], "fouPorts": [5555] }
```

Guarantees, each covered by `apps/agent/test/cleanup-node.test.ts`:

* an empty payload removes nothing (no "clean the host" mode);
* only named resources are touched - an unrelated interface or OpenVPN instance
  survives, and no glob/wildcard deletion exists;
* per interface it also removes the tunnel's IPsec connection (`swanctl`) and its
  saved definition; per inbound it stops+disables `arvoo-openvpn@<name>` and
  removes `/etc/arvoo/openvpn/<name>`;
* an already-absent resource counts as success, so the call is safe to repeat;
* a real failure is reported **by name and reason**, the remaining resources are
  still processed, and the operation is reported failed - which is what keeps the
  node at `partial`;
* names are re-validated at the privileged boundary (`CleanupNode` case in
  `apps/agent/src/validate-op.ts`), max 128 resources.

## Deleting a node

`DELETE /api/v1/nodes/:id` (`?force=true` for the override), operator role +
management gate:

* **Blocking dependencies are absolute.** A node with tunnels or inbounds is
  never deleted, forced or not, because those records name it. The error lists
  them with the peer/name so the operator knows what to remove:
  `Node "IR-01" cannot be deleted: 1 tunnel(s) still terminate here (gate-01 -> DE-01). Delete those tunnels first.`
* **The safe path** requires `decommission_state = 'complete'`. Deleting directly
  without decommissioning runs it first; if cleanup is queued or pending, the
  delete is refused and says so. There is no path where a node disappears while
  its interface is still running on the host and nobody recorded it.
* **Force** is the explicit override: the record is deleted, in-flight operations
  for that node are cancelled with a reason in their own history, and the audit
  entry carries `PENDING HOST CLEANUP: …` so what was left behind is recorded.
* **History is preserved**: `operations.node_id` and (since 0006)
  `inbound_deployments.node_id` become `NULL` instead of taking the rows with
  them.

Dependency preview: `GET /nodes/:id/dependencies` returns blocking tunnels and
inbounds, managed interfaces/inbounds/routes/memberships/sessions, in-flight
operations, `deletable` and a one-line summary. The UI uses it in the delete
dialog and before enabling the delete button.

## Migration 0006 and rollback

`apps/api/src/migrations/0006_node_lifecycle.sql`

* adds `nodes.node_secret_encrypted`, `token_issued_at`, `token_rotated_at`,
  `token_revoked_at`;
* adds `nodes.decommission_state` (CHECK `none|requested|partial|complete`),
  `decommissioned_at`, `decommission_detail`;
* makes `inbound_deployments.node_id` nullable with
  `FOREIGN KEY … ON DELETE SET NULL`.

`0006_node_lifecycle.down.sql` restores the previous FK and `NOT NULL` and drops
the new columns. It fails loudly (rather than losing history) if rows exist whose
node was deleted while the migration was applied.

Rollback of the feature: revert the code and run
`npx tsx apps/api/src/db/migrate-cli.ts down` (one step) on the panel host. No
data is written outside the panel's own tables, and no host was modified by this
change.

## Verification status

* `npx vitest run` → 23 files, 387 tests; `npm run typecheck`, `npm run build` →
  exit 0.
* **API (10 tests, real PostgreSQL + migrations + HTTP):** credential kept out of
  list/record/JSON responses; reveal returns the value that actually
  authenticates; legacy hash-only row is refused with a rotate hint; rotation
  shows the new value at once and the old one gets 401; dependency preview lists
  the real tunnel and interface; delete refused through a tunnel with and without
  force; decommission queues `CleanupNode` with exactly `interfaceNames:[<tunnel>]`
  and `inboundNames:[]`; failed cleanup → `partial` + refused delete; successful
  re-run → `complete`; offline node → `partial` with the pending names, refused
  delete, forced delete records `PENDING HOST CLEANUP` in the audit trail; the
  peer node keeps authenticating afterwards; a node with nothing to clean is
  decommissioned and deleted in one step.
* **Agent (9 tests, mocked `exec` seam):** scope, idempotency, named failures,
  non-Linux honesty, and validation of hostile names/lists.
* **Migrations (5 tests, downgrade + rebuild):** 0006 applies, reverts, re-applies;
  the FK delete action is asserted on `pg_constraint`; deployment and operation
  history survive a node deletion.

Not verified here (no access to the deployment): the real host-side removal on
TCI-01/TR-01, the `systemctl`/`swanctl` behaviour of a real node, and the
production migration itself.
