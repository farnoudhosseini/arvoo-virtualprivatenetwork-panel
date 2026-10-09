import { q, q1, run, uuid, nowIso } from "../db/index.js";
import { config } from "../config.js";
import type {
  CleanupNodeOpInput,
  NodeDependencies,
  NodeDecommissionState,
  NodeRecord,
  NodeTelemetry,
  NodeTokenSecret,
  NodeTokenStatus,
  NodeStatus,
} from "@arvoo/shared";
import { randomToken, sha256, encryptSecret, decryptSecret } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { raiseAlert, resolveAlerts } from "./alerts.js";
import { ingestOpenvpnStatus } from "./clients.js";
import { enqueueOperation, logOperation } from "./operations.js";
import { audit } from "../lib/audit.js";

type NodeRow = Record<string, unknown>;

export function rowToNode(r: NodeRow): NodeRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    hostname: r.hostname as string | null,
    address: r.address as string | null,
    region: r.region as string | null,
    country: r.country as string | null,
    provider: r.provider as string | null,
    role: r.role as NodeRecord["role"],
    regionClass: r.region_class as NodeRecord["regionClass"],
    tags: JSON.parse((r.tags as string) ?? "[]"),
    description: r.description as string | null,
    status: r.status as NodeStatus,
    enrollmentState: r.enrollment_state as NodeRecord["enrollmentState"],
    agentVersion: r.agent_version as string | null,
    agentPlatform: r.agent_platform as string | null,
    lastHeartbeatAt: r.last_heartbeat_at as string | null,
    isSelf: Boolean(r.is_self),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    decommissionState: (r.decommission_state as NodeDecommissionState | undefined) ?? "none",
    decommissionedAt: (r.decommissioned_at as string | null | undefined) ?? null,
    decommissionDetail: (r.decommission_detail as string | null | undefined) ?? null,
    tokenIssuedAt: (r.token_issued_at as string | null | undefined) ?? null,
    tokenRotatedAt: (r.token_rotated_at as string | null | undefined) ?? null,
    tokenRevokedAt: (r.token_revoked_at as string | null | undefined) ?? null,
    // The secret itself is never part of a node record; only whether the panel
    // holds a copy it is allowed to reveal.
    tokenRevealable: Boolean(r.node_secret_encrypted),
  };
}

export async function listNodes(): Promise<NodeRecord[]> {
  return (await q<NodeRow>(`SELECT * FROM nodes ORDER BY name ASC`)).map(rowToNode);
}

export async function getNode(id: string): Promise<NodeRecord> {
  const row = await q1<NodeRow>(`SELECT * FROM nodes WHERE id = ?`, id);
  if (!row) throw notFound("Node not found");
  return rowToNode(row);
}

export interface CreateNodeInput {
  name: string;
  hostname?: string | null;
  address?: string | null;
  region?: string | null;
  country?: string | null;
  provider?: string | null;
  role?: NodeRecord["role"];
  regionClass?: NodeRecord["regionClass"];
  tags?: string[];
  description?: string | null;
}

export async function createNode(input: CreateNodeInput, actor: { id: string; name: string }): Promise<{
  node: NodeRecord;
  /** Enrollment token plaintext - shown once. */
  enrollmentToken: string;
  expiresAt: string;
}> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(input.name)) {
    throw badRequest("Node name must be 2-63 chars: letters, digits, dots, dashes, underscores.");
  }
  const exists = await q1(`SELECT id FROM nodes WHERE name = ?`, input.name);
  if (exists) throw conflict(`A node named "${input.name}" already exists`);

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO nodes (id, name, hostname, address, region, country, provider, role, region_class, tags, description, status, enrollment_state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending','not_enrolled',?,?)`,
    id,
    input.name,
    input.hostname ?? null,
    input.address ?? null,
    input.region ?? null,
    input.country ?? null,
    input.provider ?? null,
    input.role ?? "vpn",
    input.regionClass ?? "international",
    JSON.stringify(input.tags ?? []),
    input.description ?? null,
    now,
    now,
  );
  const { token, expiresAt } = await issueEnrollmentToken(id, actor.id);
  return { node: await getNode(id), enrollmentToken: token, expiresAt };
}

export async function issueEnrollmentToken(nodeId: string, createdBy: string): Promise<{ token: string; expiresAt: string }> {
  const node = await getNode(nodeId);
  if (node.enrollmentState === "approved") {
    throw conflict("This node is already approved. Revoke first if you need to re-enroll.");
  }
  const token = `arv_${randomToken(24)}`;
  const expiresAt = new Date(Date.now() + config.agent.enrollmentTokenTtlMin * 60_000).toISOString();
  await run(
    `INSERT INTO enrollment_tokens (id, node_id, token_hash, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?)`,
    uuid(),
    nodeId,
    sha256(token),
    expiresAt,
    createdBy,
    nowIso(),
  );
  return { token, expiresAt };
}

export async function approveNode(id: string): Promise<NodeRecord> {
  const node = await getNode(id);
  if (node.enrollmentState !== "enrolled") {
    throw badRequest(
      `Node "${node.name}" is "${node.enrollmentState}". Only nodes that have completed agent enrollment can be approved.`,
    );
  }
  await run(`UPDATE nodes SET enrollment_state = 'approved', status = 'offline', updated_at = ? WHERE id = ?`, nowIso(), id);
  return getNode(id);
}

export async function revokeNodeEnrollment(id: string): Promise<NodeRecord> {
  await getNode(id);
  await run(
    `UPDATE nodes SET enrollment_state = 'revoked', status = 'pending', node_secret_hash = NULL, node_secret_encrypted = NULL, token_revoked_at = ?, updated_at = ? WHERE id = ?`,
    nowIso(),
    nowIso(),
    id,
  );
  return getNode(id);
}

// ---------------------------------------------------------------------------
// Agent credential (node token) lifecycle
// ---------------------------------------------------------------------------
/**
 * Standard location of the node identity the agent reads (see the agent's
 * config.ts and the systemd unit). The rotate response hands the operator the
 * exact command so a rotation can actually be completed on the host.
 */
export const NODE_STATE_FILE = "/var/lib/arvoo/agent-state.json";

/**
 * Mint a node credential: `arvnode_<48 hex>`. Cryptographically random (the old
 * enrollment path derived it from a timestamp and Math.random), 64+ bits of the
 * value are stored as a hash for authentication and an encrypted copy is kept so
 * the active credential can be revealed to an authorized administrator.
 */
function mintNodeSecret(): string {
  return `arvnode_${randomToken(24)}`;
}

async function storeNodeSecret(nodeId: string, secret: string, kind: "issued" | "rotated", actor?: { id: string; name: string }): Promise<void> {
  const at = nowIso();
  await run(
    `UPDATE nodes SET node_secret_hash = ?, node_secret_encrypted = ?,
       token_issued_at = COALESCE(token_issued_at, ?),
       token_rotated_at = ${kind === "rotated" ? "?" : "token_rotated_at"},
       token_revoked_at = NULL, updated_at = ?
     WHERE id = ?`,
    sha256(secret),
    encryptSecret(secret),
    at,
    ...(kind === "rotated" ? [at] : []),
    at,
    nodeId,
  );
  if (kind === "rotated") {
    const node = await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, nodeId);
    if (node) {
      auditNodeEvent(
        { id: nodeId, name: node.name },
        "node.token.rotate",
        `Rotated the agent credential for node ${node.name}; the previous credential is invalid immediately`,
        actor,
      );
    }
  }
}

/**
 * The credential handed to an agent at enrollment. Exported so `/agent/hello`
 * uses exactly the same minting/storage path as a rotation (the enrollment
 * secret used to be derived from a timestamp, and was never revealable).
 */
export async function issueNodeCredential(nodeId: string): Promise<string> {
  const secret = mintNodeSecret();
  await storeNodeSecret(nodeId, secret, "issued");
  return secret;
}

function tokenStatusRow(node: NodeRecord, row: { node_secret_hash: string | null; node_secret_encrypted: string | null }): NodeTokenStatus {
  const status: NodeTokenStatus["status"] = row.node_secret_hash
    ? "active"
    : node.tokenRevokedAt
      ? "revoked"
      : "none";
  const revealable = status === "active" && Boolean(row.node_secret_encrypted);
  return {
    nodeId: node.id,
    nodeName: node.name,
    status,
    issuedAt: node.tokenIssuedAt,
    rotatedAt: node.tokenRotatedAt,
    revokedAt: node.tokenRevokedAt,
    revealable,
    lastHeartbeatAt: node.lastHeartbeatAt,
    reason: revealable
      ? null
      : status !== "active"
        ? status === "revoked"
          ? "This node's credential was revoked. Issue a new one (rotate) to reconnect the agent."
          : "This node has no credential yet. It receives one when its agent enrolls."
        : "This node enrolled before credentials were stored recoverably, so only its hash exists. Rotate the credential to make the active one revealable.",
  };
}

/** Credential metadata - never the secret, safe for the node detail page. */
export async function nodeTokenStatus(id: string): Promise<NodeTokenStatus> {
  const node = await getNode(id);
  const row = await q1<{ node_secret_hash: string | null; node_secret_encrypted: string | null }>(
    `SELECT node_secret_hash, node_secret_encrypted FROM nodes WHERE id = ?`,
    id,
  );
  if (!row) throw notFound("Node not found");
  return tokenStatusRow(node, row);
}

/**
 * Reveal the active credential. Requires the encrypted copy; a legacy hash-only
 * node is refused with an explanation instead of an empty or invented value.
 */
export async function revealNodeToken(id: string): Promise<NodeTokenSecret> {
  const node = await getNode(id);
  const row = await q1<{ node_secret_hash: string | null; node_secret_encrypted: string | null }>(
    `SELECT node_secret_hash, node_secret_encrypted FROM nodes WHERE id = ?`,
    id,
  );
  if (!row) throw notFound("Node not found");
  const info = tokenStatusRow(node, row);
  if (!info.revealable || !row.node_secret_encrypted) {
    throw conflict(info.reason ?? "This node's credential cannot be revealed.");
  }
  let secret: string;
  try {
    secret = decryptSecret(row.node_secret_encrypted);
  } catch {
    // The envelope is unreadable (rotated APP_SECRET or corrupted row). Say so;
    // never return a value that would not authenticate.
    throw conflict(
      "The stored credential cannot be decrypted with the current APP_SECRET. Rotate the credential to issue a new one.",
    );
  }
  return { ...info, secret, applyCommand: applyCredentialCommand(secret) };
}

function applyCredentialCommand(secret: string): string {
  return `install -m 600 /dev/null ${NODE_STATE_FILE} && printf '%s' '${secret}' > ${NODE_STATE_FILE}.secret && python3 - <<'PY'\nimport json,os\np="${NODE_STATE_FILE}"\nd=json.load(open(p)) if os.path.exists(p) else {}\nd["nodeSecret"]="${secret}"\nopen(p,"w").write(json.dumps(d, indent=2))\nos.chmod(p,0o600)\nPY\nsystemctl restart arvoo-agent`;
}

/**
 * Rotate the credential: a new secret is active immediately, the old one stops
 * authenticating at once (the agent route compares against the stored hash on
 * every request), and the new value is returned so the operator can install it
 * on the node in the same step.
 */
export async function rotateNodeToken(id: string, actor?: { id: string; name: string }): Promise<NodeTokenSecret> {
  const node = await getNode(id);
  if (node.enrollmentState === "revoked") {
    throw conflict(
      `Node "${node.name}" is revoked. Re-enroll it with an enrollment token and approve it, then rotate if needed.`,
    );
  }
  if (node.enrollmentState === "not_enrolled") {
    throw conflict(
      `Node "${node.name}" has no agent yet. Enroll it first - the credential is issued during enrollment.`,
    );
  }
  const secret = mintNodeSecret();
  await storeNodeSecret(id, secret, "rotated", actor);
  const info = await nodeTokenStatus(id);
  return { ...info, secret, applyCommand: applyCredentialCommand(secret) };
}

/**
 * Revoke the credential only (the node record and its history stay). Every
 * agent request re-reads the hash, so revocation takes effect on the next
 * request without waiting for a cache to expire; the node also stops being
 * eligible for new work.
 */
export async function revokeNodeToken(id: string, actor?: { id: string; name: string }): Promise<NodeTokenStatus> {
  const node = await getNode(id);
  await run(
    `UPDATE nodes SET node_secret_hash = NULL, node_secret_encrypted = NULL, token_revoked_at = ?, updated_at = ? WHERE id = ?`,
    nowIso(),
    nowIso(),
    id,
  );
  // A credential that was never handed out must not stay usable either.
  await run(`DELETE FROM enrollment_tokens WHERE node_id = ? AND used_at IS NULL`, id);
  auditNodeEvent(
    node,
    "node.token.revoke",
    `Revoked the agent credential for node ${node.name}; the agent can no longer authenticate`,
    actor,
  );
  return nodeTokenStatus(id);
}

// ---------------------------------------------------------------------------
// Dependencies, decommissioning and deletion
// ---------------------------------------------------------------------------

/** Arvoo-owned resources on a node's host, and everything that blocks deletion. */
export async function nodeDependencies(id: string): Promise<NodeDependencies> {
  const node = await getNode(id);
  const tunnels = await q<{ id: string; name: string; source_node_id: string; dest_node_id: string; other_name: string }>(
    `SELECT t.id, t.name, t.source_node_id, t.dest_node_id,
            CASE WHEN t.source_node_id = ? THEN n2.name ELSE n1.name END AS other_name
       FROM tunnels t
       JOIN nodes n1 ON n1.id = t.source_node_id
       JOIN nodes n2 ON n2.id = t.dest_node_id
      WHERE t.source_node_id = ? OR t.dest_node_id = ?
      ORDER BY t.name`,
    id,
    id,
    id,
  );
  const inbounds = await q<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM inbounds WHERE node_id = ? ORDER BY name`,
    id,
  );
  const inFlight = await q<{ id: string; type: string; status: string }>(
    `SELECT id, type, status FROM operations WHERE node_id = ? AND status IN ('queued','running') ORDER BY created_at`,
    id,
  );
  const routes = await q1<{ n: string }>(`SELECT COUNT(*)::text AS n FROM routes WHERE node_id = ?`, id);
  // lb_members references its target through (kind, ref_id), not a node column.
  const lbMembers = await q1<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM lb_members WHERE kind = 'node' AND ref_id = ?`,
    id,
  );
  const sessions = await q1<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM client_sessions WHERE node_id = ? AND active = 1`,
    id,
  );
  const certificates = await q1<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pki_certificates WHERE inbound_id IN (SELECT id FROM inbounds WHERE node_id = ?)`,
    id,
  );
  const num = (r: { n: string } | undefined) => Number(r?.n ?? 0);

  const deletable = tunnels.length === 0 && inbounds.length === 0;
  const blocking: string[] = [];
  if (tunnels.length > 0) blocking.push(`${tunnels.length} tunnel(s): ${tunnels.map((t) => t.name).join(", ")}`);
  if (inbounds.length > 0) blocking.push(`${inbounds.length} inbound(s): ${inbounds.map((i) => i.name).join(", ")}`);

  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeStatus: node.status,
    enrollmentState: node.enrollmentState,
    decommissionState: node.decommissionState,
    decommissionDetail: node.decommissionDetail,
    blocking: {
      tunnels: tunnels.map((t) => ({ id: t.id, name: t.name, otherNodeName: t.other_name })),
      inbounds: inbounds.map((i) => ({ id: i.id, name: i.name, status: i.status })),
    },
    managed: {
      interfaces: tunnels.map((t) => t.name),
      inbounds: inbounds.map((i) => i.name),
      routes: num(routes),
      lbMembers: num(lbMembers),
      certificates: num(certificates),
      activeSessions: num(sessions),
    },
    inFlightOperations: inFlight.map((o) => ({ id: o.id, type: o.type, status: o.status })),
    deletable,
    summary: deletable
      ? `Node ${node.name} has no tunnels or inbounds. Deleting it removes its credential, telemetry, routes and memberships; operation history is kept.`
      : `Node ${node.name} cannot be deleted yet: it still has ${blocking.join(" and ")}. Remove those first.`,
  };
}

/** Lifecycle events land in the audit trail (never in the secret). */
function auditNodeEvent(
  node: { id: string; name: string },
  action: "node.token.rotate" | "node.token.revoke" | "node.decommission" | "node.cleanup",
  summary: string,
  actor: { id: string; name: string } = { id: "system", name: "system" },
): void {
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action,
    entityType: "node",
    entityId: node.id,
    entityName: node.name,
    summary,
  });
}

/**
 * Decommission: revoke the credential (no new work, no heartbeats), then ask the
 * agent to remove exactly the Arvoo-owned resources this control plane created
 * on the host. When the node is offline or refuses, the state is recorded as
 * `partial` with the reason - never as done.
 */
export async function decommissionNode(
  id: string,
  actor: { id: string; name: string },
): Promise<{ decommissionState: NodeDecommissionState; detail: string; operationId: string | null }> {
  const node = await getNode(id);
  const deps = await nodeDependencies(id);
  const cleanupInput: CleanupNodeOpInput = {
    interfaceNames: deps.managed.interfaces,
    inboundNames: deps.managed.inbounds,
  };
  const hasWork = cleanupInput.interfaceNames.length > 0 || cleanupInput.inboundNames.length > 0;
  const names = [...cleanupInput.interfaceNames, ...cleanupInput.inboundNames];

  // Every branch below revokes the credential (no new work, no heartbeats) and
  // then stores the state that is actually true for the host.
  await revokeNodeToken(id, actor);

  // A host that never confirmed cleanup stays unconfirmed. The resources may
  // have been released in the panel since it last reported (deleting a tunnel
  // does not ask an offline node to remove anything), but that says nothing
  // about the host - so this must never be silently upgraded to "clean".
  if (node.decommissionState === "partial") {
    const detail =
      node.decommissionDetail ??
      "The host never confirmed that the resources this panel created were removed.";
    await run(
      `UPDATE nodes SET decommission_state = 'partial', decommission_detail = ?, updated_at = ? WHERE id = ?`,
      detail,
      nowIso(),
      id,
    );
    auditNodeEvent(node, "node.decommission", `Decommission repeated for ${node.name}: ${detail}`, actor);
    return { decommissionState: "partial", detail, operationId: null };
  }

  // Nothing the panel ever created on this host: there is no cleanup to wait
  // for, and pretending otherwise would block deletion for no reason.
  if (!hasWork) {
    const detail =
      "No Arvoo-managed interfaces or inbounds are recorded for this node; the credential was revoked.";
    await run(
      `UPDATE nodes SET decommission_state = 'complete', decommissioned_at = ?, decommission_detail = ?, updated_at = ? WHERE id = ?`,
      nowIso(),
      detail,
      nowIso(),
      id,
    );
    auditNodeEvent(node, "node.decommission", `Credential revoked; nothing to remove on the host for ${node.name}`, actor);
    return { decommissionState: "complete", detail, operationId: null };
  }

  if (node.status !== "online") {
    const detail = `Node is ${node.status}: nothing could be removed on the host. Pending on the node: ${names.join(", ")}.`;
    await run(
      `UPDATE nodes SET decommission_state = 'partial', decommissioned_at = ?, decommission_detail = ?, updated_at = ? WHERE id = ?`,
      nowIso(),
      detail,
      nowIso(),
      id,
    );
    auditNodeEvent(
      node,
      "node.decommission",
      `Decommission started but the node is ${node.status}: ${detail}`,
      actor,
    );
    return { decommissionState: "partial", detail, operationId: null };
  }

  // Online with real work: record the request, then let the host's own report
  // settle it (onCleanupOperationSettled).
  await run(
    `UPDATE nodes SET decommission_state = 'requested', decommissioned_at = ?, decommission_detail = ?, updated_at = ? WHERE id = ?`,
    nowIso(),
    deps.summary,
    nowIso(),
    id,
  );
  const op = await enqueueOperation({
    type: "CleanupNode",
    nodeId: id,
    refType: "node",
    refId: id,
    requestedBy: actor.name,
    input: cleanupInput,
  });
  await logOperation(op.id, "info", "decommission", `CleanupNode queued for ${node.name}`);
  auditNodeEvent(
    node,
    "node.decommission",
    `Credential revoked and host cleanup queued for ${node.name} (${names.join(", ")})`,
    actor,
  );
  return { decommissionState: "requested", detail: deps.summary, operationId: op.id };
}

/** Settlement of a CleanupNode operation: the stored state follows the report. */
export async function onCleanupOperationSettled(
  operationId: string,
  success: boolean,
  output: unknown,
  error: string | null,
): Promise<void> {
  const op = await q1<{ ref_id: string | null }>(`SELECT ref_id FROM operations WHERE id = ?`, operationId);
  if (!op?.ref_id) return;
  const nodeId = op.ref_id;
  const node = await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, nodeId);
  if (!node) return;

  const result = (output ?? {}) as { removed?: string[]; absent?: string[]; failed?: Array<{ name: string; error: string }> };
  if (success) {
    const detail = `Cleanup complete: ${(result.removed ?? []).length} resource(s) removed, ${(result.absent ?? []).length} already absent.`;
    await run(
      `UPDATE nodes SET decommission_state = 'complete', decommission_detail = ?, updated_at = ? WHERE id = ?`,
      detail,
      nowIso(),
      nodeId,
    );
    auditNodeEvent({ id: nodeId, name: node.name }, "node.cleanup", detail);
    return;
  }
  // The per-resource report is the actionable evidence (which interface, which
  // error); the operation error is only its summary, so it is the fallback.
  const failed = (result.failed ?? []).map((f) => `${f.name}: ${f.error}`).join("; ");
  const detail = `Cleanup incomplete: ${failed || error || "the node did not report a reason"}`;
  await run(
    `UPDATE nodes SET decommission_state = 'partial', decommission_detail = ?, updated_at = ? WHERE id = ?`,
    detail,
    nowIso(),
    nodeId,
  );
  auditNodeEvent({ id: nodeId, name: node.name }, "node.cleanup", detail);
}

/**
 * Delete a node.
 *
 * Policy (documented, not implicit):
 *  - A node with tunnels or inbounds is **never** deleted, forced or not: those
 *    records name it, so removing it would either destroy live configuration or
 *    leave interfaces running on hosts nothing points at any more. The error
 *    lists exactly what is attached.
 *  - The safe path additionally requires the host cleanup to be `complete`, or
 *    to have nothing to clean up. A node that was never decommissioned has its
 *    credential revoked first, and cleanup is queued - so a node cannot silently
 *    disappear while its interfaces keep running.
 *  - `force` is the explicit override: the record is removed, in-flight
 *    operations are cancelled with a reason, and the audit entry states what was
 *    left behind on the host. Operation history is preserved (node_id -> NULL).
 */
export async function deleteNode(
  id: string,
  actor: { id: string; name: string },
  opts: { force?: boolean } = {},
): Promise<{ deleted: true; forced: boolean; pendingCleanup: string | null; cancelledOperations: number }> {
  const node = await getNode(id);
  const deps = await nodeDependencies(id);

  if (!deps.deletable) {
    const parts: string[] = [];
    if (deps.blocking.tunnels.length > 0) {
      parts.push(
        `${deps.blocking.tunnels.length} tunnel(s) still terminate here (${deps.blocking.tunnels
          .map((t) => `${t.name} -> ${t.otherNodeName}`)
          .join(", ")}). Delete those tunnels first.`,
      );
    }
    if (deps.blocking.inbounds.length > 0) {
      parts.push(`${deps.blocking.inbounds.length} inbound(s) still live here (${deps.blocking.inbounds.map((i) => i.name).join(", ")}). Delete or move them first.`);
    }
    throw conflict(`Node "${node.name}" cannot be deleted: ${parts.join(" ")}`);
  }

  let pendingCleanup: string | null = null;
  let queuedCleanup = false;

  if (node.decommissionState !== "complete") {
    // Revoke and ask for cleanup even when the operator deleted directly: a node
    // whose interface still exists on the host must not be forgotten silently.
    const decom = await decommissionNode(id, actor);
    queuedCleanup = decom.operationId !== null;
    if (!queuedCleanup && decom.decommissionState !== "complete") pendingCleanup = decom.detail;
  }

  if (queuedCleanup && !opts.force) {
    throw conflict(
      `Node "${node.name}" is decommissioning: its credential is revoked and host cleanup is in flight. ` +
        "Wait for the cleanup operation to finish, then delete. Use force=true to delete the record now and keep the pending cleanup in the audit log.",
    );
  }
  if (queuedCleanup && !pendingCleanup) {
    pendingCleanup =
      "Host cleanup was still queued when the node was force-deleted; resources may remain on the host.";
  }

  if (!opts.force && pendingCleanup) {
    throw conflict(
      `Node "${node.name}" still has pending host cleanup: ${pendingCleanup} ` +
        "Re-run decommission when the node is reachable, or force=true to delete the record and record the pending cleanup in the audit log.",
    );
  }

  const inFlight = await q<{ id: string }>(
    `SELECT id FROM operations WHERE node_id = ? AND status IN ('queued','running')`,
    id,
  );
  for (const op of inFlight) {
    await run(
      `UPDATE operations SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?`,
      `Cancelled: node ${node.name} was deleted before the operation finished`,
      nowIso(),
      op.id,
    );
    await logOperation(op.id, "warn", "cancel", "Cancelled because the node was deleted");
  }

  await run(`DELETE FROM nodes WHERE id = ?`, id);
  return {
    deleted: true,
    forced: Boolean(opts.force),
    pendingCleanup,
    cancelledOperations: inFlight.length,
  };
}

// ---------------------------------------------------------------------------
// Heartbeat ingestion
// ---------------------------------------------------------------------------

export async function ingestHeartbeat(
  nodeId: string,
  telemetry: NodeTelemetry,
  openvpnStatus: Parameters<typeof ingestOpenvpnStatus>[1] | undefined,
  sourceIp: string,
): Promise<void> {
  const node = await q1<NodeRow & { enrollment_state: string }>(`SELECT * FROM nodes WHERE id = ?`, nodeId);
  if (!node) throw notFound("Node not found");
  if (node.enrollment_state !== "approved") {
    throw badRequest("Node agent is not approved yet; heartbeats are rejected.");
  }

  const wasOffline = node.status !== "online";
  // agent_version is NOT taken from telemetry: the agent reports its own build
  // at enrollment (/agent/hello). Writing the OpenVPN version here made the
  // panel display "agent v2.6.12" - the OpenVPN version is reported separately
  // through telemetry.openvpnVersion and shown on its own line.
  await run(
    `UPDATE nodes SET status = 'online', last_heartbeat_at = ?, agent_platform = ?, address = COALESCE(address, ?), updated_at = ? WHERE id = ?`,
    nowIso(),
    `${telemetry.os}${telemetry.kernel ? ` (${telemetry.kernel})` : ""}`,
    sourceIp,
    nowIso(),
    nodeId,
  );
  if (telemetry.capabilities) {
    await run(
      `UPDATE nodes SET capabilities = ?, capabilities_at = ? WHERE id = ?`,
      JSON.stringify(telemetry.capabilities),
      nowIso(),
      nodeId,
    );
  }

  // Health sample (throttled to one per minute per node)
  const last = await q1<{ at: string }>(
    `SELECT at FROM node_health_samples WHERE node_id = ? ORDER BY at DESC LIMIT 1`,
    nodeId,
  );
  const openvpnClients = (openvpnStatus ?? []).reduce((acc, s) => acc + s.connected.length, 0);
  const rx = Object.values(telemetry.trafficCounters ?? {}).reduce((a, c) => a + (c?.rx ?? 0), 0);
  const tx = Object.values(telemetry.trafficCounters ?? {}).reduce((a, c) => a + (c?.tx ?? 0), 0);
  if (!last || Date.now() - new Date(last.at).getTime() > 60_000) {
    await run(
      `INSERT INTO node_health_samples (id, node_id, at, cpu_usage_pct, memory_usage_pct, disk_usage_pct, rx_bytes, tx_bytes, openvpn_clients)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      uuid(),
      nodeId,
      nowIso(),
      telemetry.cpuUsagePct,
      telemetry.memoryUsagePct,
      telemetry.diskUsagePct,
      rx,
      tx,
      openvpnClients,
    );
  }

  await run(
    `INSERT INTO node_telemetry (node_id, telemetry, at) VALUES (?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET telemetry = excluded.telemetry, at = excluded.at`,
    nodeId,
    JSON.stringify(telemetry),
    nowIso(),
  );

  if (wasOffline) await resolveAlerts("node.offline", nodeId);

  // OpenVPN processes observed -> inbound status
  for (const proc of telemetry.openvpnProcesses ?? []) {
    const inbound = await q1<{ id: string; status: string }>(
      `SELECT id, status FROM inbounds WHERE node_id = ? AND name = ?`,
      nodeId,
      proc.name,
    );
    if (!inbound) continue;
    if (proc.status === "running" && inbound.status !== "active" && inbound.status !== "deploying") {
      await run(`UPDATE inbounds SET status = 'active', updated_at = ? WHERE id = ?`, nowIso(), inbound.id);
      await resolveAlerts("inbound.down", inbound.id);
    } else if (proc.status === "stopped" && inbound.status === "active") {
      await run(`UPDATE inbounds SET status = 'error', updated_at = ? WHERE id = ?`, nowIso(), inbound.id);
      await raiseAlert({
        severity: "critical",
        type: "inbound.down",
        title: `OpenVPN service stopped`,
        message: `Inbound "${proc.name}" is not running on node. Traffic through this inbound is interrupted.`,
        entityType: "inbound",
        entityId: inbound.id,
      });
    }
  }

  // GRE interfaces observed -> tunnel status
  for (const gre of telemetry.greInterfaces ?? []) {
    const tunnel = await q1<{ id: string }>(
      `SELECT id FROM tunnels WHERE (source_node_id = ? OR dest_node_id = ?) AND name = ?`,
      nodeId,
      nodeId,
      gre.name,
    );
    if (tunnel) {
      await run(`UPDATE tunnels SET status = 'up', last_verified_at = ? WHERE id = ? AND status IN ('deploying','down','planned','error')`, nowIso(), tunnel.id);
      await resolveAlerts("tunnel.down", tunnel.id);
    }
  }

  if (openvpnStatus && openvpnStatus.length > 0) {
    await ingestOpenvpnStatus(nodeId, openvpnStatus);
  }
}

/** Periodic sweep: mark approved nodes with stale heartbeats offline. */
export async function evaluateNodeLiveness(): Promise<number> {
  const cutoff = new Date(Date.now() - config.heartbeatOfflineSec * 1000).toISOString();
  const stale = await q<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM nodes WHERE enrollment_state = 'approved' AND status = 'online' AND last_heartbeat_at < ?`,
    cutoff,
  );
  for (const n of stale) {
    await run(`UPDATE nodes SET status = 'offline', updated_at = ? WHERE id = ?`, nowIso(), n.id);
    await raiseAlert({
      severity: "critical",
      type: "node.offline",
      title: `Node offline: ${n.name}`,
      message: `Node "${n.name}" has not sent a heartbeat for more than ${config.heartbeatOfflineSec} seconds.`,
      entityType: "node",
      entityId: n.id,
    });
  }
  return stale.length;
}

export async function latestTelemetry(nodeId: string): Promise<{ telemetry: NodeTelemetry; at: string } | null> {
  const row = await q1<{ telemetry: string; at: string }>(
    `SELECT telemetry, at FROM node_telemetry WHERE node_id = ?`,
    nodeId,
  );
  if (!row) return null;
  return { telemetry: JSON.parse(row.telemetry) as NodeTelemetry, at: row.at };
}

export async function healthSamples(nodeId: string, sinceIso: string) {
  return q(
    `SELECT * FROM node_health_samples WHERE node_id = ? AND at >= ? ORDER BY at ASC`,
    nodeId,
    sinceIso,
  );
}

/** Discovered capabilities as last reported by the node agent (never assumed). */
export async function nodeCapabilities(id: string): Promise<{
  capabilities: Record<string, unknown>;
  reportedAt: string | null;
}> {
  const row = await q1<{ capabilities: string; capabilities_at: string | null }>(
    `SELECT capabilities, capabilities_at FROM nodes WHERE id = ?`,
    id,
  );
  if (!row) throw notFound("Node not found");
  return { capabilities: JSON.parse(row.capabilities || "{}"), reportedAt: row.capabilities_at };
}
