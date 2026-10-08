import { q, q1, run, tx, uuid, nowIso } from "../db/index.js";
import type {
  ClientRecord,
  ClientLimits,
  OpenVPNStructuredConfig,
  PolicyRuleRecord,
} from "@arvoo/shared";
import { evaluatePolicies, isExpired, isStarted, timeQuotaState, trafficQuotaState } from "@arvoo/shared";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { issueClientCertificate, clientMaterial, revokeCertificatesFor } from "./pki.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { generateClientOvpn } from "@arvoo/shared";
import { enqueueOperation } from "./operations.js";

type Row = Record<string, unknown>;

export function rowToClient(r: Row): ClientRecord {
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: r.display_name as string | null,
    description: r.description as string | null,
    status: r.status as ClientRecord["status"],
    groupId: r.group_id as string | null,
    tags: JSON.parse((r.tags as string) ?? "[]"),
    notes: r.notes as string | null,
    limits: JSON.parse(r.limits as string) as ClientLimits,
    baseMultiplier: (r.base_multiplier as number) ?? 1,
    usedBilledBytes: (r.used_billed_bytes as number) ?? 0,
    rxBytes: (r.rx_bytes as number) ?? 0,
    txBytes: (r.tx_bytes as number) ?? 0,
    usedTimeSec: (r.used_time_sec as number) ?? 0,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function getClient(id: string): Promise<ClientRecord> {
  const row = await q1<Row>(`SELECT * FROM clients WHERE id = ?`, id);
  if (!row) throw notFound("Client not found");
  return rowToClient(row);
}

export async function getClientByCommonName(cn: string): Promise<ClientRecord | null> {
  const row = await q1<Row>(`SELECT * FROM clients WHERE cert_common_name = ?`, cn);
  return row ? rowToClient(row) : null;
}

export interface CreateClientInput {
  username: string;
  displayName?: string | null;
  description?: string | null;
  groupId?: string | null;
  tags?: string[];
  notes?: string | null;
  baseMultiplier?: number;
  limits: Partial<ClientLimits>;
  inboundIds?: string[];
}

export function defaultLimits(): ClientLimits {
  return {
    trafficQuotaBytes: null,
    timeQuotaSec: null,
    expiresAt: null,
    startsAt: null,
    concurrentSessions: null,
    deviceLimit: null,
    ipLimit: null,
    ipAllowlist: [],
    ipDenylist: [],
    downloadSpeedKbps: null,
    uploadSpeedKbps: null,
  };
}

export async function createClient(input: CreateClientInput): Promise<ClientRecord> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,62}$/.test(input.username)) {
    throw badRequest("Username must be 3-63 chars: letters, digits, dots, dashes, underscores or @.");
  }
  if (await q1(`SELECT id FROM clients WHERE username = ?`, input.username)) {
    throw conflict(`Client "${input.username}" already exists`);
  }
  if (input.baseMultiplier != null && (input.baseMultiplier < 0.1 || input.baseMultiplier > 100)) {
    throw badRequest("Multiplier must be between 0.1 and 100.");
  }

  const id = uuid();
  const now = nowIso();
  const limits: ClientLimits = { ...defaultLimits(), ...input.limits };
  await run(
    `INSERT INTO clients (id, username, cert_common_name, display_name, description, status, group_id, tags, notes, limits, base_multiplier, created_at, updated_at)
     VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?)`,
    id,
    input.username,
    input.username, // CN = username
    input.displayName ?? null,
    input.description ?? null,
    input.groupId ?? null,
    JSON.stringify(input.tags ?? []),
    input.notes ?? null,
    JSON.stringify(limits),
    input.baseMultiplier ?? 1,
    now,
    now,
  );
  // Real client certificate (PKI)
  const issued = await issueClientCertificate(id, input.username);
  await run(
    `INSERT INTO client_secrets (id, client_id, kind, data_encrypted, created_at) VALUES (?,?,?,?,?)`,
    uuid(),
    id,
    "client_key",
    encryptSecret(issued.privateKeyPem),
    now,
  );
  for (const inboundId of input.inboundIds ?? []) {
    await assignClientToInbound(id, inboundId);
  }
  return getClient(id);
}

export async function assignClientToInbound(clientId: string, inboundId: string): Promise<void> {
  if (!(await q1(`SELECT id FROM inbounds WHERE id = ?`, inboundId))) throw notFound("Inbound not found");
  await run(
    `INSERT INTO client_inbounds (client_id, inbound_id, assigned_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`,
    clientId,
    inboundId,
    nowIso(),
  );
}

export async function unassignClientFromInbound(clientId: string, inboundId: string): Promise<void> {
  await run(`DELETE FROM client_inbounds WHERE client_id = ? AND inbound_id = ?`, clientId, inboundId);
}

export async function updateClient(id: string, patch: {
  displayName?: string | null;
  description?: string | null;
  notes?: string | null;
  groupId?: string | null;
  tags?: string[];
  baseMultiplier?: number;
  limits?: Partial<ClientLimits>;
}): Promise<ClientRecord> {
  const client = await getClient(id);
  const limits = { ...client.limits, ...(patch.limits ?? {}) };
  await run(
    `UPDATE clients SET display_name = ?, description = ?, notes = ?, group_id = ?, tags = ?, base_multiplier = ?, limits = ?, updated_at = ? WHERE id = ?`,
    patch.displayName ?? client.displayName,
    patch.description ?? client.description,
    patch.notes ?? client.notes,
    patch.groupId ?? client.groupId,
    JSON.stringify(patch.tags ?? client.tags),
    patch.baseMultiplier ?? client.baseMultiplier,
    JSON.stringify(limits),
    nowIso(),
    id,
  );
  return getClient(id);
}

export async function setStatus(id: string, status: ClientRecord["status"]): Promise<ClientRecord> {
  await getClient(id);
  await run(`UPDATE clients SET status = ?, updated_at = ? WHERE id = ?`, status, nowIso(), id);
  return getClient(id);
}

/**
 * Queue a KillClient operation unless an identical one is already waiting or
 * running. The status ingest runs on every heartbeat, so without this check a
 * still-connected client would receive a new kill operation every few seconds.
 */
export async function queueClientKill(nodeId: string, inboundName: string, commonName: string): Promise<void> {
  const input = { inboundName, commonName };
  const pending = await q1(
    `SELECT id FROM operations WHERE type = 'KillClient' AND node_id = ? AND status IN ('queued','running') AND input = ?`,
    nodeId,
    JSON.stringify(input),
  );
  if (pending) return;
  await enqueueOperation({
    type: "KillClient",
    nodeId,
    refType: "inbound",
    refId: null,
    requestedBy: "system",
    input,
  });
}

/**
 * Queue a live disconnect for every active session of a client. The session
 * row is closed later, when the agent reports the client gone in the status
 * ingest. Closing it here would hide a VPN connection that is still up.
 */
export async function disconnectClientSessions(clientId: string): Promise<number> {
  const client = await getClient(clientId);
  const sessions = await q<{ node_id: string; inbound_name: string }>(
    `SELECT DISTINCT s.node_id, i.name AS inbound_name
       FROM client_sessions s
       JOIN inbounds i ON i.id = s.inbound_id
      WHERE s.client_id = ? AND s.active = 1 AND s.node_id IS NOT NULL`,
    clientId,
  );
  for (const s of sessions) {
    await queueClientKill(s.node_id, s.inbound_name, client.username);
  }
  return sessions.length;
}

/**
 * Mid-session enforcement: billing can push a connected client over its
 * traffic or time quota, or past its expiry. Those clients are marked expired
 * and disconnected from the node immediately.
 */
async function enforceLimitsAfterBilling(client: ClientRecord, nodeId: string, inboundName: string, now: Date): Promise<void> {
  if (client.status !== "active") return;
  const expired = isExpired(client.limits.expiresAt, now);
  const trafficExceeded = trafficQuotaState(client.usedBilledBytes, client.limits.trafficQuotaBytes).exceeded;
  const timeExceeded = timeQuotaState(client.usedTimeSec, client.limits.timeQuotaSec).exceeded;
  if (!expired && !trafficExceeded && !timeExceeded) return;
  await setStatus(client.id, "expired");
  await queueClientKill(nodeId, inboundName, client.username);
}

export async function suspendClient(id: string): Promise<ClientRecord> {
  const client = await setStatus(id, "suspended");
  await disconnectClientSessions(id);
  return client;
}

export function resumeClient(id: string): Promise<ClientRecord> {
  return setStatus(id, "active");
}

export async function revokeClient(id: string): Promise<ClientRecord> {
  const c = await setStatus(id, "revoked");
  await revokeCertificatesFor("client", id);
  await disconnectClientSessions(id);
  return c;
}

export async function rotateClientCertificate(id: string): Promise<{ profileReady: boolean }> {
  const client = await getClient(id);
  await issueClientCertificate(id, client.username);
  return { profileReady: true };
}

export async function revokeDevice(clientId: string, deviceId: string): Promise<void> {
  const dev = await q1(`SELECT id FROM client_devices WHERE id = ? AND client_id = ?`, deviceId, clientId);
  if (!dev) throw notFound("Device not found for this client");
  await run(`UPDATE client_devices SET revoked = 1 WHERE id = ?`, deviceId);
}

export async function clientInbounds(clientId: string) {
  return q(
    `SELECT i.* FROM client_inbounds ci JOIN inbounds i ON i.id = ci.inbound_id WHERE ci.client_id = ? ORDER BY i.name`,
    clientId,
  );
}

export async function clientDevices(clientId: string) {
  return q(`SELECT * FROM client_devices WHERE client_id = ? ORDER BY last_seen_at DESC`, clientId);
}

export async function clientSessions(clientId: string, onlyActive = false) {
  return q(
    `SELECT * FROM client_sessions WHERE client_id = ? ${onlyActive ? "AND active = 1" : ""} ORDER BY connected_at DESC LIMIT 200`,
    clientId,
  );
}

export async function clientUsageSeries(clientId: string, sinceIso: string) {
  return q(
    `SELECT at, rx_bytes, tx_bytes, billed_bytes FROM client_usage_samples WHERE client_id = ? AND at >= ? ORDER BY at ASC`,
    clientId,
    sinceIso,
  );
}

// ---------------------------------------------------------------------------
// Effective multiplier + policy engine integration
// ---------------------------------------------------------------------------

export async function listPolicyRules(): Promise<PolicyRuleRecord[]> {
  return (await q<Row>(`SELECT * FROM policy_rules ORDER BY priority ASC`)).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    enabled: Boolean(r.enabled),
    priority: r.priority as number,
    effectiveFrom: r.effective_from as string | null,
    effectiveUntil: r.effective_until as string | null,
    conditions: JSON.parse((r.conditions as string) ?? "[]"),
    actions: JSON.parse((r.actions as string) ?? "[]"),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export async function effectiveMultiplier(
  client: ClientRecord,
  ctx: { inboundId: string | null; nodeId: string | null; sourceIp: string | null; now: Date },
): Promise<number> {
  const rules = await listPolicyRules();
  const decision = evaluatePolicies(rules, {
    clientId: client.id,
    groupId: client.groupId,
    inboundId: ctx.inboundId,
    nodeId: ctx.nodeId,
    sourceIp: ctx.sourceIp,
    timeOfDayMinutes: ctx.now.getUTCHours() * 60 + ctx.now.getUTCMinutes(),
    dayOfWeek: ctx.now.getUTCDay(),
    trafficUsedBilledBytes: client.usedBilledBytes,
    activeSessions: 0,
    deviceCount: 0,
    now: ctx.now,
  });
  return client.baseMultiplier * decision.multiplier;
}

// ---------------------------------------------------------------------------
// Session accounting (driven by real agent status reports)
// ---------------------------------------------------------------------------

export interface ReportedClientStatus {
  commonName: string;
  realIp: string;
  vpnIp: string | null;
  rxBytes: number;
  txBytes: number;
  connectedSinceSec: number;
}

/**
 * Reconcile agent-reported OpenVPN status with our session table.
 * Applies quota billing with the effective multiplier on deltas.
 */
export async function ingestOpenvpnStatus(nodeId: string, statuses: Array<{ inboundName: string; connected: ReportedClientStatus[] }>): Promise<void> {
  const now = new Date();
  const seenSessionKeys = new Set<string>();

  for (const status of statuses) {
    const inbound = await q1<{ id: string }>(`SELECT id FROM inbounds WHERE node_id = ? AND name = ?`, nodeId, status.inboundName);
    if (!inbound) continue;

    for (const conn of status.connected) {
      const client = await getClientByCommonName(conn.commonName);
      if (!client) continue; // Unknown CN: not provisioned through Arvoo
      const key = `${client.id}:${inbound.id}:${conn.vpnIp ?? conn.realIp}`;
      if (client.status !== "active") {
        // Still connected but no longer allowed: enforce it instead of recording it.
        await queueClientKill(nodeId, status.inboundName, conn.commonName);
        continue;
      }
      seenSessionKeys.add(key);

      const existing = await q1<Row>(
        `SELECT * FROM client_sessions WHERE client_id = ? AND inbound_id = ? AND COALESCE(vpn_ip, source_ip) = ? AND active = 1`,
        client.id,
        inbound.id,
        conn.vpnIp ?? conn.realIp,
      );

      if (existing) {
        const prevRx = (existing.rx_bytes as number) ?? 0;
        const prevTx = (existing.tx_bytes as number) ?? 0;
        const dRx = Math.max(0, conn.rxBytes - prevRx);
        const dTx = Math.max(0, conn.txBytes - prevTx);
        if (dRx > 0 || dTx > 0) {
          await billClient(client.id, dRx, dTx, { inboundId: inbound.id, nodeId, sourceIp: conn.realIp, now });
          await enforceLimitsAfterBilling(await getClient(client.id), nodeId, status.inboundName, now);
        }
        await run(
          `UPDATE client_sessions SET last_seen_at = ?, rx_bytes = ?, tx_bytes = ?, duration_sec = ? WHERE id = ?`,
          now.toISOString(),
          conn.rxBytes,
          conn.txBytes,
          Math.max(0, Math.round((now.getTime() - new Date(existing.connected_at as string).getTime()) / 1000)),
          existing.id,
        );
      } else {
        await run(
          `INSERT INTO client_sessions (id, client_id, inbound_id, node_id, common_name, source_ip, vpn_ip, connected_at, last_seen_at, duration_sec, rx_bytes, tx_bytes, active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          uuid(),
          client.id,
          inbound.id,
          nodeId,
          conn.commonName,
          conn.realIp,
          conn.vpnIp,
          now.toISOString(),
          now.toISOString(),
          0,
          conn.rxBytes,
          conn.txBytes,
        );
        await billClient(client.id, conn.rxBytes, conn.txBytes, { inboundId: inbound.id, nodeId, sourceIp: conn.realIp, now });
        await enforceLimitsAfterBilling(await getClient(client.id), nodeId, status.inboundName, now);
      }

      // Device tracking
      const hwid = deriveHwid(conn);
      await upsertDevice(client.id, hwid, conn.realIp, now);
    }
  }

  // Close sessions that disappeared from the live status
  const activeSessions = await q<Row>(
    `SELECT * FROM client_sessions WHERE node_id = ? AND active = 1`,
    nodeId,
  );
  for (const s of activeSessions) {
    const key = `${s.client_id}:${s.inbound_id}:${s.vpn_ip ?? s.source_ip}`;
    if (seenSessionKeys.has(key)) continue;
    // Keep a small grace period: only close if not seen for > 90s
    const lastSeen = new Date(s.last_seen_at as string).getTime();
    if (now.getTime() - lastSeen > 90_000) {
      await run(`UPDATE client_sessions SET active = 0 WHERE id = ?`, s.id);
    }
  }
}

function deriveHwid(conn: ReportedClientStatus): string {
  // OpenVPN exposes IV_HWADDR when the client sends push-peer-info; the agent
  // falls back to the real IP as a weaker identity. Format: mac:XX or ip:X.
  return conn.realIp; // agent may override with hwid later via authorize payload
}

export async function upsertDevice(clientId: string, hwid: string, ip: string, now: Date): Promise<void> {
  const existing = await q1(`SELECT id FROM client_devices WHERE client_id = ? AND hwid = ?`, clientId, hwid);
  if (existing) {
    await run(`UPDATE client_devices SET last_seen_at = ?, last_ip = ? WHERE id = ?`, now.toISOString(), ip, existing.id);
  } else {
    await run(
      `INSERT INTO client_devices (id, client_id, hwid, first_seen_at, last_seen_at, last_ip) VALUES (?,?,?,?,?,?)`,
      uuid(),
      clientId,
      hwid,
      now.toISOString(),
      now.toISOString(),
      ip,
    );
  }
}

export async function billClient(
  clientId: string,
  dRx: number,
  dTx: number,
  ctx: { inboundId: string | null; nodeId: string | null; sourceIp: string | null; now: Date },
): Promise<void> {
  const client = await getClient(clientId);
  const multiplier = await effectiveMultiplier(client, ctx);
  const billed = Math.round((dRx + dTx) * multiplier);
  await tx(async () => {
    await run(
      `UPDATE clients SET rx_bytes = rx_bytes + ?, tx_bytes = tx_bytes + ?, used_billed_bytes = used_billed_bytes + ? WHERE id = ?`,
      dRx,
      dTx,
      billed,
      clientId,
    );
    await run(
      `INSERT INTO client_usage_samples (id, client_id, at, rx_bytes, tx_bytes, billed_bytes) VALUES (?,?,?,?,?,?)`,
      uuid(),
      clientId,
      ctx.now.toISOString(),
      dRx,
      dTx,
      billed,
    );
  });
}

// ---------------------------------------------------------------------------
// Admission control (client-connect hook)
// ---------------------------------------------------------------------------

export interface AuthorizeInput {
  commonName: string;
  sourceIp: string;
  vpnIp: string | null;
  hwid: string | null;
  inboundName: string;
}

export async function authorizeConnection(input: AuthorizeInput): Promise<{
  allow: boolean;
  reason: string | null;
  client: ClientRecord | null;
}> {
  const client = await getClientByCommonName(input.commonName);
  if (!client) {
    return { allow: false, reason: `Unknown client certificate CN "${input.commonName}"`, client: null };
  }
  const now = new Date();

  if (client.status === "suspended") return { allow: false, reason: "Client is suspended", client };
  if (client.status === "revoked") return { allow: false, reason: "Client credentials are revoked", client };
  if (client.status === "expired") return { allow: false, reason: "Client is expired", client };
  if (!isStarted(client.limits.startsAt, now)) return { allow: false, reason: "Client service has not started yet", client };
  if (isExpired(client.limits.expiresAt, now)) {
    await setStatus(client.id, "expired");
    return { allow: false, reason: "Client subscription has expired", client };
  }

  const quota = trafficQuotaState(client.usedBilledBytes, client.limits.trafficQuotaBytes);
  if (quota.exceeded) return { allow: false, reason: "Traffic quota exhausted", client };

  const tquota = timeQuotaState(client.usedTimeSec, client.limits.timeQuotaSec);
  if (tquota.exceeded) return { allow: false, reason: "Time quota exhausted", client };

  // IP checks
  if (client.limits.ipDenylist.some((cidr) => ipInCidr(input.sourceIp, cidr))) {
    return { allow: false, reason: "Source IP is blacklisted for this client", client };
  }
  if (client.limits.ipAllowlist.length > 0 && !client.limits.ipAllowlist.some((cidr) => ipInCidr(input.sourceIp, cidr))) {
    return { allow: false, reason: "Source IP is not in the client allowlist", client };
  }
  if (client.limits.ipLimit != null) {
    const ipRows = await q<{ c: number }>(
      `SELECT COUNT(DISTINCT last_ip) AS c FROM client_devices WHERE client_id = ? AND revoked = 0 AND last_ip IS NOT NULL`,
      client.id,
    );
    const distinctIps = ipRows[0]?.c ?? 0;
    const known = await q1(`SELECT id FROM client_devices WHERE client_id = ? AND last_ip = ? AND revoked = 0`, client.id, input.sourceIp);
    if (!known && distinctIps >= client.limits.ipLimit) {
      return { allow: false, reason: `IP limit reached (${client.limits.ipLimit} distinct IPs allowed)`, client };
    }
  }

  // Device (HWID) checks
  const hwid = input.hwid ?? input.sourceIp;
  if (client.limits.deviceLimit != null) {
    const device = await q1<{ id: string; revoked: number }>(
      `SELECT id, revoked FROM client_devices WHERE client_id = ? AND hwid = ?`,
      client.id,
      hwid,
    );
    if (!device) {
      const deviceRows = await q<{ c: number }>(
        `SELECT COUNT(*) AS c FROM client_devices WHERE client_id = ? AND revoked = 0`,
        client.id,
      );
      const count = deviceRows[0]?.c ?? 0;
      if (count >= client.limits.deviceLimit) {
        return { allow: false, reason: `Device limit reached (${client.limits.deviceLimit} devices allowed)`, client };
      }
    } else if (device.revoked) {
      return { allow: false, reason: "This device has been revoked by an administrator", client };
    }
  }

  // Policy engine (deny / suspend / limits)
  const rules = await listPolicyRules();
  const sessionRows = await q<{ c: number }>(
    `SELECT COUNT(*) AS c FROM client_sessions WHERE client_id = ? AND active = 1`,
    client.id,
  );
  const activeSessions = sessionRows[0]?.c ?? 0;
  const deviceRows2 = await q<{ c: number }>(
    `SELECT COUNT(*) AS c FROM client_devices WHERE client_id = ? AND revoked = 0`,
    client.id,
  );
  const deviceCount = deviceRows2[0]?.c ?? 0;
  const inboundRow = await q1<{ id: string; node_id: string }>(`SELECT id, node_id FROM inbounds WHERE name = ?`, input.inboundName);

  const decision = evaluatePolicies(rules, {
    clientId: client.id,
    groupId: client.groupId,
    inboundId: inboundRow?.id ?? null,
    nodeId: inboundRow?.node_id ?? null,
    sourceIp: input.sourceIp,
    timeOfDayMinutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
    dayOfWeek: now.getUTCDay(),
    trafficUsedBilledBytes: client.usedBilledBytes,
    activeSessions,
    deviceCount,
    now,
  });

  if (decision.deny) return { allow: false, reason: decision.deny.reason, client };
  if (decision.suspend) {
    await setStatus(client.id, "suspended");
    return { allow: false, reason: "Client suspended by policy", client };
  }
  if (decision.sessionLimit != null && activeSessions >= decision.sessionLimit) {
    return { allow: false, reason: `Concurrent session limit reached (${decision.sessionLimit})`, client };
  }
  if (decision.deviceLimit != null && deviceCount >= decision.deviceLimit) {
    return { allow: false, reason: `Device limit reached by policy (${decision.deviceLimit})`, client };
  }

  // Register device + session on success
  await upsertDevice(client.id, hwid, input.sourceIp, now);
  await run(
    `INSERT INTO client_sessions (id, client_id, inbound_id, node_id, common_name, source_ip, vpn_ip, hwid, connected_at, last_seen_at, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    uuid(),
    client.id,
    inboundRow?.id ?? null,
    inboundRow?.node_id ?? null,
    input.commonName,
    input.sourceIp,
    input.vpnIp,
    hwid,
    now.toISOString(),
    now.toISOString(),
  );

  return { allow: true, reason: null, client };
}

export async function closeSessionByVpnIp(inboundName: string, vpnIp: string | null, sourceIp: string): Promise<void> {
  const inbound = await q1<{ id: string }>(`SELECT id FROM inbounds WHERE name = ?`, inboundName);
  if (!inbound) return;
  const s = await q1<{ id: string; connected_at: string }>(
    `SELECT id, connected_at FROM client_sessions WHERE inbound_id = ? AND active = 1 AND COALESCE(vpn_ip, source_ip) = ? ORDER BY connected_at DESC LIMIT 1`,
    inbound.id,
    vpnIp ?? sourceIp,
  );
  if (!s) return;
  const duration = Math.max(0, Math.round((Date.now() - new Date(s.connected_at).getTime()) / 1000));
  await run(`UPDATE client_sessions SET active = 0, duration_sec = ? WHERE id = ?`, duration, s.id);
}

function ipToLong(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, prefixStr] = cidr.split("/");
  if (!range || !prefixStr) return false;
  const ipLong = ipToLong(ip);
  const rangeLong = ipToLong(range);
  if (ipLong == null || rangeLong == null) return false;
  const prefix = Number(prefixStr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipLong & mask) === (rangeLong & mask);
}

// ---------------------------------------------------------------------------
// Client configuration generation
// ---------------------------------------------------------------------------

export async function buildClientProfile(clientId: string, inboundId: string): Promise<{ ovpn: string; filename: string }> {
  const client = await getClient(clientId);
  const inbound = await q1<Row & { structured_config: string; current_version: number; name: string }>(
    `SELECT * FROM inbounds WHERE id = ?`,
    inboundId,
  );
  if (!inbound) throw notFound("Inbound not found");
  const node = await q1<Row>(`SELECT * FROM nodes WHERE id = ?`, inbound.node_id);
  if (!node?.address) {
    throw badRequest(
      `Node "${node?.name ?? "?"}" has no known address yet. The agent must enroll and heartbeat at least once.`,
    );
  }
  const cfg = JSON.parse(inbound.structured_config as string) as OpenVPNStructuredConfig;
  const material = await clientMaterial(clientId);
  const caRow = await q1<{ certificate: string }>(`SELECT certificate FROM pki_certificates WHERE kind = 'ca' LIMIT 1`);
  if (!caRow) throw notFound("Root CA is missing; create an inbound first to initialize the PKI");

  // The static TLS key is stored encrypted per inbound (never in metadata).
  const tlsKeyRow = await q1<{ data_encrypted: string }>(
    `SELECT s.data_encrypted FROM inbound_secrets s WHERE s.inbound_id = ? AND s.kind = 'tls_key' LIMIT 1`,
    inboundId,
  );

  const ovpn = generateClientOvpn({
    serverAddress: node.address as string,
    port: cfg.port,
    transport: cfg.transport,
    ca: caRow.certificate,
    cert: material.cert,
    key: material.key,
    tlsMode: cfg.tlsMode,
    tlsKey: tlsKeyRow ? decryptSecret(tlsKeyRow.data_encrypted) : null,
    tlsVersionMin: cfg.tlsVersionMin,
    dataCiphers: cfg.dataCiphers,
    fallbackCipher: cfg.fallbackCipher,
    authDigest: cfg.authDigest,
    tunMtu: cfg.tunMtu,
    mssFix: cfg.mssFix,
    redirectGateway: cfg.redirectGateway,
    dnsServers: cfg.dnsServers,
    pushRoutes: cfg.pushRoutes,
    profileName: client.username,
  });
  return { ovpn, filename: `${client.username}-${inbound.name}.ovpn` };
}
