import { q, q1, run, uuid, nowIso } from "../db/index.js";
import type { GreOpInput, IPsecOpInput, TunnelRecord } from "@arvoo/shared";
import { computeGreMtu, carve30, ipToInt } from "@arvoo/shared";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors.js";
import { enqueueOperation, logOperation } from "./operations.js";
import { raiseAlert, resolveAlerts } from "./alerts.js";
import { audit } from "../lib/audit.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { randomBytes } from "node:crypto";

type Row = Record<string, unknown>;

/**
 * Return the IPsec PSK for a tunnel, generating and storing it on first use.
 * The PSK is encrypted at rest and is only ever sent to the two nodes.
 */
async function tunnelPsk(tunnelId: string): Promise<string> {
  const row = await q1<{ data_encrypted: string }>(
    `SELECT data_encrypted FROM tunnel_secrets WHERE tunnel_id = ? AND kind = 'ipsec_psk'`,
    tunnelId,
  );
  if (row) return decryptSecret(row.data_encrypted);
  const psk = randomBytes(32).toString("base64url");
  await run(
    `INSERT INTO tunnel_secrets (id, tunnel_id, kind, data_encrypted, created_at) VALUES (?,?,'ipsec_psk',?,?)`,
    uuid(),
    tunnelId,
    encryptSecret(psk),
    nowIso(),
  );
  return psk;
}

function rowToTunnel(r: Row): TunnelRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    type: r.type as TunnelRecord["type"],
    sourceNodeId: r.source_node_id as string,
    destNodeId: r.dest_node_id as string,
    sourceEndpoint: r.source_endpoint as string,
    destEndpoint: r.dest_endpoint as string,
    tunnelNetwork: r.tunnel_network as string,
    localTunnelIp: r.local_tunnel_ip as string,
    remoteTunnelIp: r.remote_tunnel_ip as string,
    mtu: r.mtu as number,
    ttl: r.ttl as number,
    key: r.key as string | null,
    keepaliveIntervalSec: r.keepalive_interval_sec as number,
    keepaliveRetries: r.keepalive_retries as number,
    fouPort: (r.fou_port as number | null) ?? null,
    ipsecEnabled: Boolean(r.ipsec_enabled),
    status: r.status as TunnelRecord["status"],
    latencyMs: r.latency_ms as number | null,
    lossPct: r.loss_pct as number | null,
    lastVerifiedAt: r.last_verified_at as string | null,
    mtuOverride: r.mtu_override as number | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function listTunnels(): Promise<TunnelRecord[]> {
  return (await q<Row>(`SELECT * FROM tunnels ORDER BY name ASC`)).map(rowToTunnel);
}

export async function getTunnel(id: string): Promise<TunnelRecord> {
  const row = await q1<Row>(`SELECT * FROM tunnels WHERE id = ?`, id);
  if (!row) throw notFound("Tunnel not found");
  return rowToTunnel(row);
}

export function tunnelRoutes(tunnelId: string) {
  return q(`SELECT * FROM routes WHERE scope = 'tunnel' AND ref_id = ?`, tunnelId);
}

/** Allocate the next free /30 inside 10.200.0.0/16. */
async function nextTunnelNetwork(): Promise<string> {
  const rows = await q<{ tunnel_network: string }>(`SELECT tunnel_network FROM tunnels`);
  const used = new Set(rows.map((r) => r.tunnel_network));
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 64; b++) {
      const candidate = `10.200.${a}.${b * 4}/30`;
      if (!used.has(candidate)) return candidate;
    }
  }
  throw conflict("GRE transport address pool exhausted (10.200.0.0/16)");
}

export interface CreateTunnelInput {
  name: string;
  sourceNodeId: string;
  destNodeId: string;
  key?: boolean | null;
  ttl?: number;
  mtuOverride?: number | null;
  pathMtu?: number;
  /** GRE over FOU: UDP port used to encapsulate GRE. */
  fouPort?: number | null;
  /** GRE over IPsec: encrypt the GRE traffic between the two public endpoints. */
  ipsec?: boolean;
}

/**
 * Refuse encapsulation the node cannot actually provide. The UI must never be
 * able to create a tunnel whose FOU or IPsec layer the agent cannot apply.
 */
export async function assertNodeSupportsEncap(nodeId: string, encap: { fou: boolean; ipsec: boolean }): Promise<void> {
  const row = await q1<{ name: string; capabilities: string; capabilities_at: string | null }>(
    `SELECT name, capabilities, capabilities_at FROM nodes WHERE id = ?`,
    nodeId,
  );
  if (!row) throw notFound("Node not found");
  const caps = JSON.parse(row.capabilities || "{}") as {
    fou?: boolean | null;
    ipsec?: { available?: boolean };
  };
  if (!row.capabilities_at) {
    throw conflict(`Node ${row.name} has not reported its capabilities yet. Wait for the agent heartbeat.`);
  }
  if (encap.fou && caps.fou !== true) {
    throw unprocessable(`Node ${row.name} does not support GRE over FOU (fou kernel module or udp tunnel support missing).`);
  }
  if (encap.ipsec && caps.ipsec?.available !== true) {
    throw unprocessable(`Node ${row.name} does not have a working strongSwan/IPsec stack, so GRE over IPsec is unavailable.`);
  }
}

export async function createTunnel(input: CreateTunnelInput, actor: { id: string; name: string }): Promise<TunnelRecord> {
  // 15 chars max: the name is used verbatim as the GRE interface name on both
  // nodes (Linux IFNAMSIZ is 16 including the terminator).
  if (!/^[a-z0-9][a-z0-9-]{2,14}$/.test(input.name)) {
    throw badRequest("Tunnel name must be 3-15 chars: lowercase letters, digits, dashes.");
  }
  if (await q1(`SELECT id FROM tunnels WHERE name = ?`, input.name)) {
    throw conflict(`A tunnel named "${input.name}" already exists`);
  }
  if (input.sourceNodeId === input.destNodeId) {
    throw badRequest("A tunnel needs two different nodes.");
  }
  const source = await q1<Row & { name: string; address: string | null; status: string; enrollment_state: string }>(
    `SELECT * FROM nodes WHERE id = ?`,
    input.sourceNodeId,
  );
  const dest = await q1<Row & { name: string; address: string | null; status: string; enrollment_state: string }>(
    `SELECT * FROM nodes WHERE id = ?`,
    input.destNodeId,
  );
  if (!source || !dest) throw notFound("Node not found");
  if (source.enrollment_state !== "approved" || dest.enrollment_state !== "approved") {
    throw badRequest(
      `Both nodes need approved agents before a tunnel can be planned. Currently: ${source.name}=${source.enrollment_state}, ${dest.name}=${dest.enrollment_state}.`,
    );
  }
  if (!source.address || !dest.address) {
    throw badRequest(
      "Both nodes must have a known endpoint address (reported by the agent heartbeat or set manually).",
    );
  }

  const fouPort = input.fouPort ?? null;
  const ipsec = input.ipsec === true;
  if (fouPort != null && (!Number.isInteger(fouPort) || fouPort < 1024 || fouPort > 65535)) {
    throw badRequest("FOU port must be an integer between 1024 and 65535.");
  }
  if (fouPort != null || ipsec) {
    await assertNodeSupportsEncap(input.sourceNodeId, { fou: fouPort != null, ipsec });
    await assertNodeSupportsEncap(input.destNodeId, { fou: fouPort != null, ipsec });
  }

  const network = await nextTunnelNetwork();
  const { local, remote } = carve30(network);

  // MTU engine: keyed GRE over the physical path, with the real overhead of
  // every encapsulation layer this tunnel uses (FOU adds UDP, IPsec adds ESP).
  const keyed = input.key !== false;
  const pathMtu = input.pathMtu ?? 1500;
  const engine = computeGreMtu(pathMtu, { keyed, fou: fouPort != null, ipsec });
  const mtu = input.mtuOverride ?? engine.mtu;
  const ttl = input.ttl ?? 255;

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO tunnels (id, name, type, source_node_id, dest_node_id, source_endpoint, dest_endpoint, tunnel_network, local_tunnel_ip, remote_tunnel_ip, mtu, ttl, key, fou_port, ipsec_enabled, status, created_at, updated_at)
     VALUES (?,?, 'gre', ?,?,?,?,?,?,?,?,?,?,?,?,'planned',?,?)`,
    id,
    input.name,
    input.sourceNodeId,
    input.destNodeId,
    source.address,
    dest.address,
    network,
    local,
    remote,
    mtu,
    ttl,
    keyed ? String(Math.abs(ipToInt(local)) % 2147483647) : null,
    fouPort,
    ipsec ? 1 : 0,
    now,
    now,
  );
  if (input.mtuOverride != null && input.mtuOverride !== engine.mtu) {
    await run(`UPDATE tunnels SET mtu_override = ? WHERE id = ?`, input.mtuOverride, id);
  }

  await deployTunnel(id, actor);
  return getTunnel(id);
}

/**
 * Deploy both sides. Each agent applies its side and verifies in-place
 * (interface present + ping across the tunnel). Status becomes up/degraded
 * ONLY from reported results.
 */
export async function deployTunnel(id: string, actor: { id: string; name: string }): Promise<void> {
  const tunnel = await getTunnel(id);
  const side = (localEndpoint: string, remoteEndpoint: string, localIp: string, remoteIp: string): GreOpInput => ({
    interfaceName: tunnel.name,
    localEndpoint,
    remoteEndpoint,
    localTunnelIp: localIp,
    remoteTunnelIp: remoteIp,
    tunnelNetwork: tunnel.tunnelNetwork,
    mtu: tunnel.mtu,
    ttl: tunnel.ttl,
    key: tunnel.key,
    fouPort: tunnel.fouPort,
    routes: [],
  });

  await run(`UPDATE tunnels SET status = 'deploying', updated_at = ? WHERE id = ?`, nowIso(), id);

  // IPsec must be in place before GRE carries traffic, otherwise the GRE side
  // would send unprotected packets on the public path.
  if (tunnel.ipsecEnabled) {
    const psk = await tunnelPsk(id);
    for (const [nodeId, localPublicIp, remotePublicIp] of [
      [tunnel.sourceNodeId, tunnel.sourceEndpoint, tunnel.destEndpoint],
      [tunnel.destNodeId, tunnel.destEndpoint, tunnel.sourceEndpoint],
    ] as const) {
      await enqueueOperation({
        type: "ApplyIPsec",
        nodeId,
        refType: "tunnel",
        refId: id,
        requestedBy: actor.name,
        input: { interfaceName: tunnel.name, localPublicIp, remotePublicIp, psk } satisfies IPsecOpInput,
      });
    }
  }

  await enqueueOperation({
    type: "CreateGRE",
    nodeId: tunnel.sourceNodeId,
    refType: "tunnel",
    refId: id,
    requestedBy: actor.name,
    input: side(tunnel.sourceEndpoint, tunnel.destEndpoint, tunnel.localTunnelIp, tunnel.remoteTunnelIp),
  });
  await enqueueOperation({
    type: "CreateGRE",
    nodeId: tunnel.destNodeId,
    refType: "tunnel",
    refId: id,
    requestedBy: actor.name,
    input: side(tunnel.destEndpoint, tunnel.sourceEndpoint, tunnel.remoteTunnelIp, tunnel.localTunnelIp),
  });
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "tunnel.deploy",
    entityType: "tunnel",
    entityId: id,
    entityName: tunnel.name,
    summary: `GRE tunnel ${tunnel.name} deployment queued on both nodes`,
  });
}

/** Settle a CreateGRE op: status comes strictly from the agent-reported result. */
export async function onGreOperationSettled(operationId: string, success: boolean, output: unknown, error: string | null): Promise<void> {
  const op = await q1<Row & { ref_id: string; node_id: string }>(`SELECT ref_id, node_id FROM operations WHERE id = ?`, operationId);
  if (!op?.ref_id) return;
  const tunnelId = op.ref_id as string;
  const tunnel = await q1<Row & { name: string; source_node_id: string; dest_node_id: string }>(
    `SELECT * FROM tunnels WHERE id = ?`,
    tunnelId,
  );
  if (!tunnel) return;

  const result = (output ?? {}) as {
    ok?: boolean;
    latencyMs?: number | null;
    lossPct?: number | null;
    mtuDetected?: number | null;
  };

  if (!success || !result.ok) {
    await run(`UPDATE tunnels SET status = 'error', updated_at = ? WHERE id = ?`, nowIso(), tunnelId);
    await raiseAlert({
      severity: "critical",
      type: "tunnel.down",
      title: `Tunnel failed: ${tunnel.name}`,
      message: `GRE side on node reported failure: ${error ?? (result.ok === false ? "verification failed" : "unknown error")}`,
      entityType: "tunnel",
      entityId: tunnelId,
    });
    return;
  }

  await run(
    `UPDATE tunnels SET status = 'up', latency_ms = ?, loss_pct = ?, last_verified_at = ?, updated_at = ? WHERE id = ?`,
    result.latencyMs ?? null,
    result.lossPct ?? null,
    nowIso(),
    nowIso(),
    tunnelId,
  );
  await resolveAlerts("tunnel.down", tunnelId);
}

export async function recordTunnelTest(tunnelId: string, result: {
  ok: boolean;
  latencyMs: number | null;
  lossPct: number | null;
}): Promise<void> {
  const tunnel = await q1<Row & { name: string }>(`SELECT name FROM tunnels WHERE id = ?`, tunnelId);
  if (!tunnel) throw notFound("Tunnel not found");
  await run(
    `UPDATE tunnels SET status = ?, latency_ms = ?, loss_pct = ?, last_verified_at = ?, updated_at = ? WHERE id = ?`,
    result.ok ? (result.lossPct != null && result.lossPct > 2 ? "degraded" : "up") : "down",
    result.latencyMs,
    result.lossPct,
    nowIso(),
    nowIso(),
    tunnelId,
  );
}

export async function testTunnel(id: string, actor: { id: string; name: string }): Promise<{ operationId: string }> {
  const tunnel = await getTunnel(id);
  const op = await enqueueOperation({
    type: "TestTunnel",
    nodeId: tunnel.sourceNodeId,
    refType: "tunnel",
    refId: id,
    requestedBy: actor.name,
    input: {
      interfaceName: tunnel.name,
      remoteTunnelIp: tunnel.remoteTunnelIp,
      localTunnelIp: tunnel.localTunnelIp,
      mtu: tunnel.mtu,
    },
  });
  return { operationId: op.id };
}

export interface CreateMeshInput {
  name: string;
  sourceNodeIds: string[];
  destNodeIds: string[];
  fouPort?: number | null;
  ipsec?: boolean;
  key?: boolean | null;
  pathMtu?: number;
}

/**
 * Full mesh: one independent GRE tunnel per (source, destination) pair. Each
 * pair is created through createTunnel, so each one passes the same validation
 * and capability checks. A pair that fails is reported, not silently skipped.
 */
export async function createMesh(input: CreateMeshInput, actor: { id: string; name: string }) {
  if (!/^[a-z0-9][a-z0-9-]{2,14}$/.test(input.name)) {
    throw badRequest("Mesh name must be 3-15 chars: lowercase letters, digits, dashes.");
  }
  const sources = [...new Set(input.sourceNodeIds)];
  const dests = [...new Set(input.destNodeIds)];
  if (sources.length === 0 || dests.length === 0) throw badRequest("A mesh needs at least one source and one destination node.");
  const pairs: Array<{ source: string; dest: string }> = [];
  for (const s of sources) for (const d of dests) if (s !== d) pairs.push({ source: s, dest: d });
  if (pairs.length === 0) throw badRequest("A mesh needs at least two different nodes.");
  if (pairs.length > 200) throw badRequest("A mesh may contain at most 200 tunnels.");

  const created: TunnelRecord[] = [];
  const failed: Array<{ source: string; dest: string; error: string }> = [];
  for (let i = 0; i < pairs.length; i++) {
    const { source, dest } = pairs[i]!;
    try {
      const tunnel = await createTunnel(
        {
          name: `${input.name.slice(0, 10)}-${String(i + 1).padStart(2, "0")}`,
          sourceNodeId: source,
          destNodeId: dest,
          key: input.key,
          fouPort: input.fouPort ?? null,
          ipsec: input.ipsec,
          pathMtu: input.pathMtu,
        },
        actor,
      );
      created.push(tunnel);
    } catch (err) {
      failed.push({ source, dest, error: (err as Error).message });
    }
  }
  await run(
    `INSERT INTO tunnel_meshes (id, name, source_node_ids, dest_node_ids, tunnel_type, fou_port, ipsec_enabled, created_at, updated_at)
     VALUES (?,?,?,?, 'gre', ?,?,?,?)`,
    uuid(),
    input.name,
    JSON.stringify(sources),
    JSON.stringify(dests),
    input.fouPort ?? null,
    input.ipsec ? 1 : 0,
    nowIso(),
    nowIso(),
  );
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "tunnel.mesh",
    entityType: "tunnel",
    entityId: null,
    entityName: input.name,
    summary: `Mesh ${input.name}: ${created.length} tunnel(s) queued, ${failed.length} failed`,
  });
  return { created, failed };
}

export async function deleteTunnel(id: string, actor: { id: string; name: string }): Promise<void> {
  const tunnel = await getTunnel(id);
  const usedByInbound = await q1(
    `SELECT id FROM inbounds WHERE structured_config LIKE '%' || ? || '%' LIMIT 1`,
    `"tunnelId":"${id}"`,
  );
  if (usedByInbound) {
    throw conflict("This tunnel is used by an inbound. Detach it first.");
  }
  for (const nodeId of [tunnel.sourceNodeId, tunnel.destNodeId]) {
    const nodeOnline = ((await q1<{ status: string }>(`SELECT status FROM nodes WHERE id = ?`, nodeId))?.status) === "online";
    if (nodeOnline) {
      const op = await enqueueOperation({
        type: "DeleteGRE",
        nodeId,
        refType: "tunnel",
        refId: id,
        requestedBy: actor.name,
        input: { interfaceName: tunnel.name, localTunnelIp: tunnel.localTunnelIp, remoteTunnelIp: tunnel.remoteTunnelIp },
      });
      await logOperation(op.id, "info", "queue", `DeleteGRE queued for ${tunnel.name}`);
    }
  }
  await run(`DELETE FROM routes WHERE scope = 'tunnel' AND ref_id = ?`, id);
  await run(`DELETE FROM tunnels WHERE id = ?`, id);
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "tunnel.delete",
    entityType: "tunnel",
    entityId: id,
    entityName: tunnel.name,
    summary: `Tunnel ${tunnel.name} deleted`,
  });
}

export function mtuAdvice(pathMtu: number, keyed: boolean) {
  const engine = computeGreMtu(pathMtu, { keyed });
  return {
    recommendedMtu: engine.mtu,
    recommendedMss: engine.mss,
    explanation: engine.explanation,
    warnings: engine.warnings,
  };
}

export async function assertValidPool(): Promise<void> {
  // sanity used by tests
  const n = await nextTunnelNetwork();
  const { local, remote } = carve30(n);
  if (ipToInt(local) >= ipToInt(remote)) throw unprocessable("Tunnel IP allocation bug");
}
