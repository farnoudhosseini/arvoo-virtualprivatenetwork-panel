import { q, q1, run, uuid, nowIso } from "../db/index.js";
import type { OpenVPNStructuredConfig, InboundRecord } from "@arvoo/shared";
import {
  generateOpenVPNServerConfig,
  validateOpenVPNConfig,
  profileAdjustments,
} from "@arvoo/shared";
import { badRequest, conflict, notFound, unprocessable } from "../lib/errors.js";
import { sha256, randomToken, encryptSecret } from "../lib/crypto.js";
import { ensureRootCA, issueServerCertificate, revokeCertificatesFor, serverMaterial } from "./pki.js";
import { enqueueOperation, completeOperation, logOperation } from "./operations.js";
import { raiseAlert } from "./alerts.js";
import { audit } from "../lib/audit.js";

type Row = Record<string, unknown>;

export async function rowToInbound(r: Row): Promise<InboundRecord> {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    protocol: r.protocol as InboundRecord["protocol"],
    nodeId: r.node_id as string,
    status: r.status as InboundRecord["status"],
    structuredConfig: JSON.parse(r.structured_config as string),
    currentVersion: r.current_version as number,
    clientCount:
      (await q1<{ c: number }>(`SELECT COUNT(*) AS c FROM client_inbounds WHERE inbound_id = ?`, r.id as string))?.c ?? 0,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function listInbounds(): Promise<InboundRecord[]> {
  const rows = await q<Row>(`SELECT * FROM inbounds ORDER BY name ASC`);
  return Promise.all(rows.map(rowToInbound));
}

export async function getInbound(id: string): Promise<InboundRecord> {
  const row = await q1<Row>(`SELECT * FROM inbounds WHERE id = ?`, id);
  if (!row) throw notFound("Inbound not found");
  return rowToInbound(row);
}

export function inboundVersions(inboundId: string) {
  return q(
    `SELECT id, inbound_id, version, checksum, openvpn_version, created_by, created_at, structured_config FROM inbound_versions WHERE inbound_id = ? ORDER BY version DESC`,
    inboundId,
  );
}

export async function inboundVersionConfig(inboundId: string, version: number): Promise<{ generatedConfig: string; structured: OpenVPNStructuredConfig } | null> {
  const row = await q1<{ generated_config: string; structured_config: string }>(
    `SELECT generated_config, structured_config FROM inbound_versions WHERE inbound_id = ? AND version = ?`,
    inboundId,
    version,
  );
  if (!row) return null;
  return { generatedConfig: row.generated_config, structured: JSON.parse(row.structured_config) };
}

export function inboundDeployments(inboundId: string) {
  return q(
    `SELECT d.*, o.status AS operation_status FROM inbound_deployments d LEFT JOIN operations o ON o.id = d.operation_id WHERE d.inbound_id = ? ORDER BY d.created_at DESC LIMIT 50`,
    inboundId,
  );
}

/** First free /24 inside the Arvoo VPN pool 10.40.0.0/16. */
export async function nextVpnSubnet(): Promise<string> {
  const rows = await q(`SELECT structured_config FROM inbounds`);
  const used = new Set(
    rows.map((r) => {
      try {
        return (JSON.parse(r.structured_config as string) as OpenVPNStructuredConfig).serverNetwork;
      } catch {
        return "";
      }
    }),
  );
  for (let i = 0; i < 256; i++) {
    const candidate = `10.40.${i}.0/24`;
    if (!used.has(candidate)) return candidate;
  }
  throw conflict("VPN address pool exhausted (10.40.0.0/16)");
}

/** Suggest the next free UDP port on a node. */
export async function suggestPort(nodeId: string): Promise<number> {
  const rows = await q<{ port: string | number }>(
    `SELECT (structured_config::jsonb ->> 'port') AS port FROM inbounds WHERE node_id = ?`,
    nodeId,
  );
  const used = new Set(rows.map((r) => Number(r.port)));
  let port = 1194;
  while (used.has(port) && port < 65535) port += 7;
  return port;
}

/** Expand a partial structured config with the same defaults the builder uses. */
export async function expandForValidation(partial: Partial<OpenVPNStructuredConfig>, nodeId?: string): Promise<OpenVPNStructuredConfig> {
  const effectiveNodeId = nodeId ?? partial.tunnelId ?? "00000000-0000-0000-0000-000000000000";
  return fullConfig(partial, effectiveNodeId);
}

export interface CreateInboundInput {
  name: string;
  description?: string | null;
  nodeId: string;
  config: Partial<OpenVPNStructuredConfig>;
}

async function fullConfig(input: Partial<OpenVPNStructuredConfig>, nodeId: string): Promise<OpenVPNStructuredConfig> {
  const profile = input.performanceProfile ?? "balanced";
  const adj = profileAdjustments(profile);
  const base: OpenVPNStructuredConfig = {
    port: await suggestPort(nodeId),
    listenAddress: "0.0.0.0",
    transport: "udp",
    device: "tun",
    topology: "subnet",
    serverNetwork: await nextVpnSubnet(),
    dnsServers: ["1.1.1.1", "1.0.0.1"],
    redirectGateway: true,
    clientToClient: false,
    tunMtu: 1420,
    mssFix: 1380,
    fragment: null,
    dataCiphers: ["AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305"],
    fallbackCipher: profile === "compatibility" ? "AES-256-CBC" : null,
    authDigest: "SHA256",
    tlsMode: adj.tlsMode,
    tlsVersionMin: "1.2",
    keepaliveInterval: adj.keepaliveInterval,
    keepaliveTimeout: adj.keepaliveTimeout,
    maxClients: 100,
    performanceProfile: profile,
    compression: "off",
    duplicateCn: false,
    pushRoutes: [],
    logVerbosity: 3,
    deploymentMode: "direct",
    tunnelId: null,
    egressNodeId: null,
  };
  return { ...base, ...input, performanceProfile: profile };
}

export async function createInbound(input: CreateInboundInput, actor: { id: string; name: string }): Promise<InboundRecord> {
  await ensureRootCA(); // PKI must exist before server cert issuance
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(input.name)) {
    throw badRequest("Inbound name must be 3-63 chars: letters, digits, dashes, underscores.");
  }
  if (await q1(`SELECT id FROM inbounds WHERE name = ?`, input.name)) {
    throw conflict(`An inbound named "${input.name}" already exists`);
  }
  const node = await q1(`SELECT id, name FROM nodes WHERE id = ?`, input.nodeId);
  if (!node) throw notFound("Node not found");

  const cfg = await fullConfig(input.config, input.nodeId);
  const validation = validateOpenVPNConfig(cfg);
  if (!validation.valid) {
    throw unprocessable(
      "Configuration validation failed: " + validation.errors.map((e) => `${e.field}: ${e.message}`).join(" | "),
      validation,
    );
  }

  // Through-tunnel: resolve egress node from tunnel
  if (cfg.deploymentMode === "through-tunnel") {
    const tunnel = await q1<{ id: string; source_node_id: string; dest_node_id: string; status: string }>(
      `SELECT id, source_node_id, dest_node_id, status FROM tunnels WHERE id = ?`,
      cfg.tunnelId!,
    );
    if (!tunnel) throw notFound("Selected tunnel not found");
    if (tunnel.source_node_id !== input.nodeId) {
      throw badRequest(
        "For through-tunnel deployment, the inbound's node must be the tunnel's source (ingress) node.",
      );
    }
    cfg.egressNodeId = tunnel.dest_node_id;
  }

  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO inbounds (id, name, description, protocol, node_id, status, structured_config, current_version, created_at, updated_at)
     VALUES (?,?,?,'openvpn',?, 'draft', ?, 1, ?, ?)`,
    id,
    input.name,
    input.description ?? null,
    input.nodeId,
    JSON.stringify(cfg),
    now,
    now,
  );

  // Server certificate + static TLS key
  const issued = await issueServerCertificate(id, input.name);
  const tlsKey = cfg.tlsMode === "none" ? null : randomToken(48);
  if (tlsKey) {
    await run(
      `INSERT INTO inbound_secrets (id, inbound_id, kind, data_encrypted, created_at) VALUES (?,?,?,?,?)`,
      uuid(),
      id,
      "tls_key",
      encryptSecret(tlsKey),
      now,
    );
  }

  await generateVersion(id, cfg, actor);
  void issued;
  return getInbound(id);
}

async function generateVersion(inboundId: string, cfg: OpenVPNStructuredConfig, actor: { id: string; name: string }) {
  const inbound = await getInbound(inboundId);
  const nodeTelemetryVersion = (await q1<{ agent_version: string }>(`SELECT agent_version FROM nodes WHERE id = ?`, inbound.nodeId))?.agent_version ?? null;
  const generated = generateOpenVPNServerConfig(cfg, {
    inboundName: inbound.name,
    configDir: `/etc/arvoo/openvpn/${inbound.name}`,
    openvpnVersion: nodeTelemetryVersion,
  });
  const checksum = sha256(generated);
  const versionNo = inbound.currentVersion;
  await run(
    `INSERT INTO inbound_versions (id, inbound_id, version, structured_config, generated_config, checksum, openvpn_version, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(inbound_id, version) DO UPDATE SET structured_config = excluded.structured_config, generated_config = excluded.generated_config, checksum = excluded.checksum, created_at = excluded.created_at`,
    uuid(),
    inboundId,
    versionNo,
    JSON.stringify(cfg),
    generated,
    checksum,
    nodeTelemetryVersion,
    actor.name,
    nowIso(),
  );
  return { versionNo, generated, checksum };
}

export async function updateInbound(id: string, patch: {
  description?: string | null;
  config?: Partial<OpenVPNStructuredConfig>;
}, actor: { id: string; name: string }): Promise<InboundRecord> {
  const inbound = await getInbound(id);
  const merged: OpenVPNStructuredConfig = { ...inbound.structuredConfig, ...(patch.config ?? {}) };
  if (patch.description !== undefined) {
    await run(`UPDATE inbounds SET description = ?, updated_at = ? WHERE id = ?`, patch.description, nowIso(), id);
  }
  const validation = validateOpenVPNConfig(merged);
  if (!validation.valid) {
    throw unprocessable(
      "Configuration validation failed: " + validation.errors.map((e) => `${e.field}: ${e.message}`).join(" | "),
      validation,
    );
  }
  const changed = JSON.stringify(merged) !== JSON.stringify(inbound.structuredConfig);
  if (changed) {
    await run(
      `UPDATE inbounds SET structured_config = ?, current_version = current_version + 1, updated_at = ? WHERE id = ?`,
      JSON.stringify(merged),
      nowIso(),
      id,
    );
    await generateVersion(id, merged, actor);
  }
  return getInbound(id);
}

/**
 * Deploy an inbound to its node. Requires the node agent to be approved AND
 * currently reporting heartbeats; otherwise the deployment is rejected with a
 * clear reason - we never pretend a deployment succeeded.
 */
export async function deployInbound(id: string, actor: { id: string; name: string }): Promise<{ operationId: string; egressOperationId: string | null }> {
  const inbound = await getInbound(id);
  const node = await q1<Row & { enrollment_state: string; status: string; name: string }>(
    `SELECT * FROM nodes WHERE id = ?`,
    inbound.nodeId,
  );
  if (!node) throw notFound("Node not found");
  const version = await inboundVersionConfig(id, inbound.currentVersion);
  if (!version) throw notFound("Inbound version missing");

  if (node.enrollment_state !== "approved") {
    throw badRequest(
      `Node "${node.name}" has no approved agent. Complete node enrollment before deploying.`,
    );
  }
  if (node.status !== "online") {
    throw badRequest(
      `Node "${node.name}" is currently ${node.status}. The agent must be online to receive the deployment.`,
    );
  }
  const validation = validateOpenVPNConfig(inbound.structuredConfig);
  if (!validation.valid) {
    throw unprocessable("Cannot deploy an invalid configuration.", validation);
  }

  const cfg = inbound.structuredConfig;
  const material = await serverMaterial(id);
  const tlsKeyRow = await q1<{ data_encrypted: string }>(
    `SELECT data_encrypted FROM inbound_secrets WHERE inbound_id = ? AND kind = 'tls_key'`,
    id,
  );

  const egress =
    cfg.deploymentMode === "through-tunnel" && cfg.tunnelId
      ? await buildEgressContext(cfg.tunnelId, cfg.serverNetwork)
      : null;

  const opInput = {
    inboundName: inbound.name,
    port: cfg.port,
    protocol: cfg.transport,
    configText: version.generatedConfig,
    pki: {
      ca: material.ca,
      cert: material.cert,
      key: material.key,
      tlsKey: tlsKeyRow ? Buffer.from(tlsKeyRow.data_encrypted, "base64").toString("base64") : null,
      tlsMode: cfg.tlsMode,
      dhParam: null,
    },
    clientNetwork: cfg.serverNetwork,
    egress: egress?.ingressSide ?? null,
  };

  const op = await enqueueOperation({
    type: "CreateOpenVPNInbound",
    nodeId: inbound.nodeId,
    refType: "inbound",
    refId: id,
    requestedBy: actor.name,
    input: opInput,
  });

  let egressOpId: string | null = null;
  if (egress) {
    const egressOp = await enqueueOperation({
      type: "ApplyFirewallPolicy",
      nodeId: cfg.egressNodeId!,
      refType: "inbound",
      refId: id,
      requestedBy: actor.name,
      input: egress.egressSide,
    });
    egressOpId = egressOp.id;
  }

  await run(
    `INSERT INTO inbound_deployments (id, inbound_id, node_id, version, operation_id, status, created_at)
     VALUES (?,?,?,?,?,'queued',?)`,
    uuid(),
    id,
    inbound.nodeId,
    inbound.currentVersion,
    op.id,
    nowIso(),
  );
  await run(`UPDATE inbounds SET status = 'deploying', updated_at = ? WHERE id = ?`, nowIso(), id);
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "inbound.deploy",
    entityType: "inbound",
    entityId: id,
    entityName: inbound.name,
    summary: `Deployment of ${inbound.name} v${inbound.currentVersion} queued`,
    detail: { operationId: op.id, egressOperationId: egressOpId },
  });
  return { operationId: op.id, egressOperationId: egressOpId };
}

async function buildEgressContext(tunnelId: string, vpnSubnet: string) {
  const tunnel = await q1<Row & {
    source_node_id: string;
    dest_node_id: string;
    local_tunnel_ip: string;
    remote_tunnel_ip: string;
    name: string;
  }>(`SELECT * FROM tunnels WHERE id = ?`, tunnelId);
  if (!tunnel) throw notFound("Tunnel not found");
  return {
    ingressSide: {
      tunnelInterfaceName: tunnel.name,
      remoteTunnelIp: tunnel.remote_tunnel_ip,
      vpnSubnet,
    },
    egressSide: {
      inboundName: tunnel.name,
      masqueradeSourceNetworks: [vpnSubnet],
      forwardFromSubnet: vpnSubnet,
      routeViaTunnelIp: tunnel.local_tunnel_ip,
    },
  };
}

/** Called by the operations service when a deployment op settles. */
export async function onDeploymentOperationSettled(operationId: string, success: boolean, error: string | null): Promise<void> {
  const deployment = await q1<Row & { inbound_id: string; node_id: string; version: number }>(
    `SELECT * FROM inbound_deployments WHERE operation_id = ?`,
    operationId,
  );
  if (!deployment) return;
  const inboundId = deployment.inbound_id as string;
  const version = deployment.version as number;

  await run(
    `UPDATE inbound_deployments SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
    success ? "success" : "failed",
    error,
    nowIso(),
    deployment.id as string,
  );

  if (success) {
    await run(`UPDATE inbounds SET status = 'active', updated_at = ? WHERE id = ?`, nowIso(), inboundId);
  } else {
    await run(`UPDATE inbounds SET status = 'error', updated_at = ? WHERE id = ?`, nowIso(), inboundId);
    await raiseAlert({
      severity: "critical",
      type: "deployment.failed",
      title: "Configuration deployment failed",
      message: error ?? "Deployment failed without a specific error",
      entityType: "inbound",
      entityId: inboundId,
    });
  }

  // If there is a paired egress op still pending, wait for it before finalizing.
  const cfgRow = await q1<{ structured_config: string }>(`SELECT structured_config FROM inbounds WHERE id = ?`, inboundId);
  if (!cfgRow) return;
  const cfg = JSON.parse(cfgRow.structured_config) as OpenVPNStructuredConfig;
  if (success && cfg.deploymentMode === "through-tunnel" && cfg.tunnelId) {
    const egressOp = await q1<{ id: string; status: string }>(
      `SELECT id, status FROM operations WHERE ref_type = 'inbound' AND ref_id = ? AND type = 'ApplyFirewallPolicy' ORDER BY created_at DESC LIMIT 1`,
      inboundId,
    );
    if (egressOp && egressOp.status !== "success") {
      // Deployment stays queued/running until egress settles (handled on its own completion).
      await logOperation(egressOp.id, "info", "egress", "Waiting for egress node policy application");
    }
  }
  void version;
}

export async function rollbackInbound(id: string, toVersion: number, actor: { id: string; name: string }): Promise<InboundRecord> {
  const inbound = await getInbound(id);
  const target = await inboundVersionConfig(id, toVersion);
  if (!target) throw notFound(`Version v${toVersion} not found for this inbound`);
  const validation = validateOpenVPNConfig(target.structured);
  if (!validation.valid) {
    throw unprocessable("The target version does not validate against current rules.", validation);
  }
  await run(
    `UPDATE inbounds SET structured_config = ?, current_version = current_version + 1, updated_at = ? WHERE id = ?`,
    JSON.stringify(target.structured),
    nowIso(),
    id,
  );
  await generateVersion(id, target.structured, actor);
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "inbound.rollback",
    entityType: "inbound",
    entityId: id,
    entityName: inbound.name,
    summary: `Rolled back configuration to v${toVersion} (new version created)`,
  });
  return getInbound(id);
}

export async function deleteInbound(id: string, actor: { id: string; name: string }): Promise<void> {
  const inbound = await getInbound(id);
  const nodeOnline = ((await q1<{ status: string }>(`SELECT status FROM nodes WHERE id = ?`, inbound.nodeId))?.status) === "online";
  if (nodeOnline) {
    await enqueueOperation({
      type: "DeleteOpenVPNInbound",
      nodeId: inbound.nodeId,
      refType: "inbound",
      refId: id,
      requestedBy: actor.name,
      input: { inboundName: inbound.name, clientNetwork: inbound.structuredConfig.serverNetwork },
    });
  }
  await revokeCertificatesFor("inbound", id);
  await run(`DELETE FROM inbounds WHERE id = ?`, id);
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "inbound.delete",
    entityType: "inbound",
    entityId: id,
    entityName: inbound.name,
    summary: `Inbound ${inbound.name} deleted${nodeOnline ? " (removal queued on node)" : " (node offline; node-side files may remain)"}`,
  });
}

export async function markInboundStopped(id: string, actor: { id: string; name: string }): Promise<void> {
  const inbound = await getInbound(id);
  const nodeOnline = ((await q1<{ status: string }>(`SELECT status FROM nodes WHERE id = ?`, inbound.nodeId))?.status) === "online";
  if (!nodeOnline) throw badRequest("Node agent must be online to stop the service.");
  await enqueueOperation({
    type: "StopOpenVPN",
    nodeId: inbound.nodeId,
    refType: "inbound",
    refId: id,
    requestedBy: actor.name,
    input: { inboundName: inbound.name },
  });
  void actor;
}

export async function restartInbound(id: string, actor: { id: string; name: string }): Promise<void> {
  const inbound = await getInbound(id);
  const nodeOnline = ((await q1<{ status: string }>(`SELECT status FROM nodes WHERE id = ?`, inbound.nodeId))?.status) === "online";
  if (!nodeOnline) throw badRequest("Node agent must be online to restart the service.");
  await enqueueOperation({
    type: "RestartOpenVPN",
    nodeId: inbound.nodeId,
    refType: "inbound",
    refId: id,
    requestedBy: actor.name,
    input: { inboundName: inbound.name },
  });
  void actor;
}

/** Deployment op completion for ApplyFirewallPolicy also finalizes deployments. */
export async function onEgressOperationSettled(operationId: string, success: boolean, error: string | null): Promise<void> {
  const op = await q1<Row & { ref_id: string }>(`SELECT ref_id FROM operations WHERE id = ?`, operationId);
  if (!op?.ref_id) return;
  const inboundId = op.ref_id as string;
  if (!success) {
    const deployment = await q1<Row & { id: string }>(
      `SELECT id FROM inbound_deployments WHERE inbound_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`,
      inboundId,
    );
    if (deployment) {
      await run(
        `UPDATE inbound_deployments SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        `Egress node policy application failed: ${error}`,
        nowIso(),
        deployment.id,
      );
      await run(`UPDATE inbounds SET status = 'error', updated_at = ? WHERE id = ?`, nowIso(), inboundId);
      await raiseAlert({
        severity: "critical",
        type: "deployment.failed",
        title: "Egress configuration failed",
        message: `NAT/forwarding on the egress node failed: ${error}`,
        entityType: "inbound",
        entityId: inboundId,
      });
    }
  }
}

export { completeOperation };
