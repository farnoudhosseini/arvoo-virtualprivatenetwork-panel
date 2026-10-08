import { q, q1, run, uuid, nowIso } from "../db/index.js";
import { config } from "../config.js";
import type { NodeRecord, NodeTelemetry, NodeStatus } from "@arvoo/shared";
import { randomToken, sha256 } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { raiseAlert, resolveAlerts } from "./alerts.js";
import { ingestOpenvpnStatus } from "./clients.js";

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
    `UPDATE nodes SET enrollment_state = 'revoked', status = 'pending', node_secret_hash = NULL, updated_at = ? WHERE id = ?`,
    nowIso(),
    id,
  );
  return getNode(id);
}

export async function deleteNode(id: string): Promise<void> {
  const node = await getNode(id);
  const usedByInbound = await q1(`SELECT id FROM inbounds WHERE node_id = ? LIMIT 1`, id);
  const usedByTunnel = await q1(
    `SELECT id FROM tunnels WHERE source_node_id = ? OR dest_node_id = ? LIMIT 1`,
    id,
    id,
  );
  if (usedByInbound || usedByTunnel) {
    throw conflict(
      `Node "${node.name}" still has ${usedByInbound ? "inbounds" : "tunnels"} attached. Remove them first.`,
    );
  }
  await run(`DELETE FROM nodes WHERE id = ?`, id);
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
