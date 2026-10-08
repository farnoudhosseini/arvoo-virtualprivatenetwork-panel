import { q, q1, run, uuid, nowIso } from "../db/index.js";
import type {
  LbGroupRecord,
  LbGroupView,
  LbMemberView,
  LbMode,
  LbHealthRequirements,
  LbFailoverPolicy,
  LbMemberRecord,
} from "@arvoo/shared";
import { chooseMember, evaluateLbHealth, weightShares, type LbCandidate } from "@arvoo/shared";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { config } from "../config.js";

type Row = Record<string, unknown>;

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function defaultHealthRequirements(): LbHealthRequirements {
  return { minSuccessRatePct: 80, maxLatencyMs: 250, maxLossPct: 10, requireNodeOnline: true };
}

export function defaultFailoverPolicy(): LbFailoverPolicy {
  return { redirectNewSessions: true, keepExistingSessions: true, autoDrain: false, autoRestore: false };
}

function rowToGroup(r: Row): LbGroupRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    enabled: Number(r.enabled) === 1,
    mode: r.mode as LbMode,
    healthRequirements: { ...defaultHealthRequirements(), ...safeJson<Partial<LbHealthRequirements>>(r.health_requirements, {}) },
    failover: { ...defaultFailoverPolicy(), ...safeJson<Partial<LbFailoverPolicy>>(r.failover, {}) },
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToMember(r: Row): LbMemberRecord {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    kind: r.kind as "inbound" | "node",
    refId: r.ref_id as string,
    weight: Number(r.weight),
    priority: Number(r.priority),
    enabled: Number(r.enabled) === 1,
    drained: Number(r.drained) === 1,
    drainReason: (r.drain_reason as string | null) ?? null,
  };
}

export async function listGroups(): Promise<LbGroupRecord[]> {
  const rows = await q<Row>(`SELECT * FROM lb_groups ORDER BY name ASC`);
  return rows.map(rowToGroup);
}

async function groupRow(id: string): Promise<Row> {
  const row = await q1<Row>(`SELECT * FROM lb_groups WHERE id = ?`, id);
  if (!row) throw notFound("Load-balancing group not found");
  return row;
}

export async function getGroup(id: string): Promise<LbGroupRecord> {
  return rowToGroup(await groupRow(id));
}

export async function createGroup(
  input: {
    name: string;
    description?: string | null;
    mode?: LbMode;
    enabled?: boolean;
    healthRequirements?: Partial<LbHealthRequirements>;
    failover?: Partial<LbFailoverPolicy>;
  },
  actorName: string,
): Promise<LbGroupRecord> {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,62}$/.test(input.name)) {
    throw badRequest("Group name must be 2-63 characters: letters, digits, spaces, dashes or underscores.");
  }
  if (await q1(`SELECT id FROM lb_groups WHERE name = ?`, input.name)) {
    throw conflict(`A load-balancing group named "${input.name}" already exists`);
  }
  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO lb_groups (id, name, description, enabled, mode, health_requirements, failover, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.name,
    input.description ?? null,
    input.enabled === false ? 0 : 1,
    input.mode ?? "weighted",
    JSON.stringify({ ...defaultHealthRequirements(), ...(input.healthRequirements ?? {}) }),
    JSON.stringify({ ...defaultFailoverPolicy(), ...(input.failover ?? {}) }),
    now,
    now,
  );
  await logEvent(id, "group.created", null, `${actorName} created the group`, null);
  return getGroup(id);
}

export async function updateGroup(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    mode?: LbMode;
    healthRequirements?: Partial<LbHealthRequirements>;
    failover?: Partial<LbFailoverPolicy>;
  },
  actorName: string,
): Promise<LbGroupRecord> {
  const group = await getGroup(id);
  if (patch.name && patch.name !== group.name) {
    if (await q1(`SELECT id FROM lb_groups WHERE name = ? AND id <> ?`, patch.name, id)) {
      throw conflict(`A load-balancing group named "${patch.name}" already exists`);
    }
  }
  await run(
    `UPDATE lb_groups SET name = ?, description = ?, enabled = ?, mode = ?, health_requirements = ?, failover = ?, updated_at = ? WHERE id = ?`,
    patch.name ?? group.name,
    patch.description !== undefined ? patch.description : group.description,
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : group.enabled ? 1 : 0,
    patch.mode ?? group.mode,
    JSON.stringify({ ...group.healthRequirements, ...(patch.healthRequirements ?? {}) }),
    JSON.stringify({ ...group.failover, ...(patch.failover ?? {}) }),
    nowIso(),
    id,
  );
  await logEvent(id, "group.updated", null, `${actorName} updated the group`, null);
  return getGroup(id);
}

export async function deleteGroup(id: string): Promise<void> {
  const group = await groupRow(id);
  await run(`DELETE FROM lb_groups WHERE id = ?`, id);
  void group;
}

/** Members never outlive their reference: deleting the node/inbound removes them. */
async function assertRefExists(kind: "inbound" | "node", refId: string): Promise<string> {
  if (kind === "node") {
    const node = await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, refId);
    if (!node) throw notFound("Node not found");
    return node.name;
  }
  const inbound = await q1<{ name: string }>(`SELECT name FROM inbounds WHERE id = ?`, refId);
  if (!inbound) throw notFound("Inbound not found");
  return inbound.name;
}

export async function addMember(
  groupId: string,
  input: { kind: "inbound" | "node"; refId: string; weight?: number; priority?: number; enabled?: boolean },
  actorName: string,
): Promise<LbMemberRecord> {
  await groupRow(groupId);
  const name = await assertRefExists(input.kind, input.refId);
  if (await q1(`SELECT id FROM lb_members WHERE group_id = ? AND kind = ? AND ref_id = ?`, groupId, input.kind, input.refId)) {
    throw conflict(`"${name}" is already a member of this group`);
  }
  const weight = input.weight ?? 100;
  if (weight < 0 || weight > 1000) throw badRequest("Weight must be between 0 and 1000.");
  const id = uuid();
  const now = nowIso();
  await run(
    `INSERT INTO lb_members (id, group_id, kind, ref_id, weight, priority, enabled, drained, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,?)`,
    id,
    groupId,
    input.kind,
    input.refId,
    weight,
    input.priority ?? 100,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  await logEvent(groupId, "member.added", id, `${actorName} added ${input.kind} "${name}" (weight ${weight})`, null);
  return rowToMember((await q1<Row>(`SELECT * FROM lb_members WHERE id = ?`, id))!);
}

async function memberRow(id: string): Promise<Row> {
  const row = await q1<Row>(`SELECT * FROM lb_members WHERE id = ?`, id);
  if (!row) throw notFound("Load-balancing member not found");
  return row;
}

export async function getMember(id: string): Promise<LbMemberRecord> {
  return rowToMember(await memberRow(id));
}

export async function updateMember(
  memberId: string,
  patch: { weight?: number; priority?: number; enabled?: boolean },
  actorName: string,
): Promise<LbMemberRecord> {
  const row = await memberRow(memberId);
  if (patch.weight !== undefined && (patch.weight < 0 || patch.weight > 1000)) {
    throw badRequest("Weight must be between 0 and 1000.");
  }
  await run(
    `UPDATE lb_members SET weight = ?, priority = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    patch.weight ?? Number(row.weight),
    patch.priority ?? Number(row.priority),
    patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : Number(row.enabled),
    nowIso(),
    memberId,
  );
  await logEvent(
    row.group_id as string,
    "member.updated",
    memberId,
    `${actorName} updated member settings`,
    JSON.stringify(patch),
  );
  return rowToMember((await q1<Row>(`SELECT * FROM lb_members WHERE id = ?`, memberId))!);
}

export async function removeMember(memberId: string, actorName: string): Promise<void> {
  const row = await memberRow(memberId);
  await run(`DELETE FROM lb_members WHERE id = ?`, memberId);
  await logEvent(row.group_id as string, "member.removed", memberId, `${actorName} removed the member`, null);
}

/**
 * Drain a member: no *new* sessions are placed on it, existing tunnels keep
 * running (spec §41). For a node member this also sets the node's
 * administrative state, which is what the routing engine actually reads, so the
 * effect is real rather than a flag in a table the router ignores.
 */
export async function drainMember(memberId: string, reason: string | null, actorName: string): Promise<void> {
  const row = await memberRow(memberId);
  await run(`UPDATE lb_members SET drained = 1, drain_reason = ?, updated_at = ? WHERE id = ?`, reason ?? "Manual drain", nowIso(), memberId);
  if (row.kind === "node") {
    await run(`UPDATE nodes SET admin_state = 'drained', updated_at = ? WHERE id = ?`, nowIso(), row.ref_id as string);
  }
  await logEvent(row.group_id as string, "member.drained", memberId, `${actorName} drained the member: ${reason ?? "no reason given"}`, null);
}

export async function restoreMember(memberId: string, actorName: string): Promise<void> {
  const row = await memberRow(memberId);
  await run(`UPDATE lb_members SET drained = 0, drain_reason = NULL, updated_at = ? WHERE id = ?`, nowIso(), memberId);
  if (row.kind === "node") {
    // Only lift the drained state we set ourselves; a node drained elsewhere
    // (routing admin) must not be un-drained by a load-balancing action.
    const node = await q1<{ admin_state: string }>(`SELECT admin_state FROM nodes WHERE id = ?`, row.ref_id as string);
    if (node?.admin_state === "drained") {
      await run(`UPDATE nodes SET admin_state = 'enabled', updated_at = ? WHERE id = ?`, nowIso(), row.ref_id as string);
    }
  }
  await logEvent(row.group_id as string, "member.restored", memberId, `${actorName} restored the member`, null);
}

async function logEvent(groupId: string, kind: string, memberId: string | null, message: string, detail: string | null): Promise<void> {
  await run(
    `INSERT INTO lb_events (id, group_id, at, kind, member_id, message, detail) VALUES (?,?,?,?,?,?,?)`,
    uuid(),
    groupId,
    nowIso(),
    kind,
    memberId,
    message,
    detail,
  );
}

export function groupEvents(groupId: string, limit = 50) {
  return q(
    `SELECT * FROM lb_events WHERE group_id = ? ORDER BY at DESC LIMIT ?`,
    groupId,
    limit,
  );
}

/** Real node freshness: online status plus a heartbeat inside the offline window. */
function nodeIsOnline(status: string, lastHeartbeatAt: string | null): boolean {
  if (status !== "online") return false;
  if (!lastHeartbeatAt) return false;
  return Date.now() - new Date(lastHeartbeatAt).getTime() < config.heartbeatOfflineSec * 1000;
}

interface MemberTelemetry {
  nodeOnline: boolean;
  inboundStatus: string | null;
  successRatePct: number | null;
  latencyMs: number | null;
  lossPct: number | null;
  checkedAt: string | null;
  activeSessions: number;
  rxBytes: number;
  txBytes: number;
}

/**
 * Measure a member from real data: node heartbeat/status, inbound deployment
 * status, the newest path-health probes that touch the member's node and the
 * sessions currently recorded on it. Missing data stays missing (null) instead
 * of being replaced with an invented "healthy" default.
 */
async function memberTelemetry(member: LbMemberRecord, windowHours = 24): Promise<MemberTelemetry> {
  const nodeId =
    member.kind === "node"
      ? member.refId
      : ((await q1<{ node_id: string }>(`SELECT node_id FROM inbounds WHERE id = ?`, member.refId))?.node_id ?? null);

  let nodeOnline = false;
  let inboundStatus: string | null = null;
  if (nodeId) {
    const node = await q1<{ status: string; last_heartbeat_at: string | null }>(
      `SELECT status, last_heartbeat_at FROM nodes WHERE id = ?`,
      nodeId,
    );
    nodeOnline = node ? nodeIsOnline(node.status, node.last_heartbeat_at) : false;
  }
  if (member.kind === "inbound") {
    inboundStatus = (await q1<{ status: string }>(`SELECT status FROM inbounds WHERE id = ?`, member.refId))?.status ?? null;
  }

  // Probes: the newest samples for tunnels that terminate on this member's node.
  let successRatePct: number | null = null;
  let latencyMs: number | null = null;
  let lossPct: number | null = null;
  let checkedAt: string | null = null;
  if (nodeId) {
    const probes = await q<{ ok: number; latency_ms: number | null; loss_pct: number | null; at: string }>(
      `SELECT ph.ok, ph.latency_ms, ph.loss_pct, ph.at
         FROM path_health ph
         JOIN tunnels t ON t.id = ph.tunnel_id
        WHERE (t.source_node_id = ? OR t.dest_node_id = ?)
        ORDER BY ph.at DESC
        LIMIT 50`,
      nodeId,
      nodeId,
    );
    if (probes.length > 0) {
      const okCount = probes.filter((p) => Number(p.ok) === 1).length;
      successRatePct = Math.round((okCount / probes.length) * 1000) / 10;
      const latencies = probes.map((p) => p.latency_ms).filter((v): v is number => typeof v === "number");
      const losses = probes.map((p) => p.loss_pct).filter((v): v is number => typeof v === "number");
      latencyMs = latencies.length > 0 ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10 : null;
      lossPct = losses.length > 0 ? Math.round((losses.reduce((a, b) => a + b, 0) / losses.length) * 10) / 10 : null;
      checkedAt = probes[0]!.at;
    }
  }

  const sessionFilter =
    member.kind === "inbound"
      ? { sql: `inbound_id = ?`, param: member.refId }
      : { sql: `node_id = ?`, param: member.refId };
  const active = await q1<{ c: number }>(
    `SELECT COUNT(*) AS c FROM client_sessions WHERE active = 1 AND ${sessionFilter.sql}`,
    sessionFilter.param,
  );
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const traffic = await q1<{ rx: number; tx: number }>(
    `SELECT COALESCE(SUM(rx_bytes),0) AS rx, COALESCE(SUM(tx_bytes),0) AS tx
       FROM client_sessions WHERE connected_at >= ? AND ${sessionFilter.sql}`,
    since,
    sessionFilter.param,
  );

  return {
    nodeOnline,
    inboundStatus,
    successRatePct,
    latencyMs,
    lossPct,
    checkedAt,
    activeSessions: Number(active?.c ?? 0),
    rxBytes: Number(traffic?.rx ?? 0),
    txBytes: Number(traffic?.tx ?? 0),
  };
}

async function memberViews(group: LbGroupRecord, members: LbMemberRecord[]): Promise<{ views: LbMemberView[]; candidates: LbCandidate[] }> {
  const raw: Array<{ member: LbMemberRecord; telemetry: MemberTelemetry; name: string; nodeId: string | null; nodeName: string | null }> = [];
  for (const member of members) {
    const telemetry = await memberTelemetry(member);
    let name = member.refId;
    let nodeId: string | null = null;
    let nodeName: string | null = null;
    if (member.kind === "inbound") {
      const inbound = await q1<{ name: string; node_id: string }>(`SELECT name, node_id FROM inbounds WHERE id = ?`, member.refId);
      name = inbound?.name ?? "(deleted inbound)";
      nodeId = inbound?.node_id ?? null;
      if (nodeId) nodeName = (await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, nodeId))?.name ?? null;
    } else {
      const node = await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, member.refId);
      name = node?.name ?? "(deleted node)";
      nodeId = member.refId;
      nodeName = node?.name ?? null;
    }
    raw.push({ member, telemetry, name, nodeId, nodeName });
  }

  const shares = weightShares(
    raw.map(({ member, telemetry }) => ({
      id: member.id,
      weight: member.weight,
      enabled: member.enabled,
      drained: member.drained,
      healthy: evaluateLbHealth(
        {
          nodeOnline: telemetry.nodeOnline,
          successRatePct: telemetry.successRatePct,
          latencyMs: telemetry.latencyMs,
          lossPct: telemetry.lossPct,
          inboundStatus: telemetry.inboundStatus,
        },
        group.healthRequirements,
      ).healthy,
      priority: member.priority,
      load: telemetry.activeSessions,
    })),
    group.mode,
  );

  const candidates: LbCandidate[] = [];
  const views: LbMemberView[] = raw.map(({ member, telemetry, name, nodeId, nodeName }) => {
    const health = evaluateLbHealth(
      {
        nodeOnline: telemetry.nodeOnline,
        successRatePct: telemetry.successRatePct,
        latencyMs: telemetry.latencyMs,
        lossPct: telemetry.lossPct,
        inboundStatus: telemetry.inboundStatus,
      },
      group.healthRequirements,
    );
    const state: LbMemberView["state"] = !member.enabled
      ? "disabled"
      : member.drained
        ? "drained"
        : health.healthy
          ? "healthy"
          : telemetry.successRatePct == null && telemetry.latencyMs == null
            ? "unknown"
            : telemetry.lossPct == null && health.reasons.length > 0
              ? "unhealthy"
              : "degraded";
    candidates.push({
      id: member.id,
      weight: member.weight,
      enabled: member.enabled,
      drained: member.drained,
      healthy: health.healthy,
      priority: member.priority,
      load: telemetry.activeSessions,
    });
    return {
      ...member,
      name,
      nodeId,
      nodeName,
      healthy: health.healthy,
      state,
      reasons: health.reasons,
      latencyMs: telemetry.latencyMs,
      lossPct: telemetry.lossPct,
      successRatePct: telemetry.successRatePct,
      checkedAt: telemetry.checkedAt,
      activeSessions: telemetry.activeSessions,
      inboundStatus: telemetry.inboundStatus,
      weightSharePct: shares[member.id] ?? 0,
    };
  });
  return { views, candidates };
}

export async function getGroupView(id: string): Promise<LbGroupView> {
  const group = await getGroup(id);
  const members = (await q<Row>(`SELECT * FROM lb_members WHERE group_id = ? ORDER BY priority ASC, weight DESC`, id)).map(rowToMember);
  const { views } = await memberViews(group, members);
  return {
    ...group,
    members: views,
    healthyMembers: views.filter((m) => m.state === "healthy").length,
    totalMembers: views.length,
    activeSessions: views.reduce((sum, m) => sum + m.activeSessions, 0),
    rxBytes: 0,
    txBytes: 0,
  };
}

export async function listGroupViews(): Promise<LbGroupView[]> {
  const groups = await listGroups();
  const out: LbGroupView[] = [];
  for (const group of groups) out.push(await getGroupView(group.id));
  return out;
}

/**
 * Choose which member should take the next session, using measured health and
 * the configured weights. Exposed so the panel and CLI can show the *real*
 * decision (including when it had to fall back to an unhealthy member).
 */
export async function chooseForGroup(
  id: string,
  random: () => number = Math.random,
): Promise<{ member: LbMemberView | null; degraded: boolean; reason: string; group: LbGroupView }> {
  const group = await getGroup(id);
  const members = (await q<Row>(`SELECT * FROM lb_members WHERE group_id = ?`, id)).map(rowToMember);
  const { views, candidates } = await memberViews(group, members);
  const selection = chooseMember(candidates, group.mode, random);
  const view = selection.member ? (views.find((v) => v.id === selection.member!.id) ?? null) : null;
  return { member: view, degraded: selection.degraded, reason: selection.reason, group: { ...group, members: views, healthyMembers: views.filter((m) => m.state === "healthy").length, totalMembers: views.length, activeSessions: views.reduce((s, m) => s + m.activeSessions, 0), rxBytes: 0, txBytes: 0 } };
}

/**
 * Maintenance pass (called by the maintenance sweep): apply the group's
 * failover policy to observed health. Only acts when the policy asks for it -
 * an auto-drain that nobody enabled would surprise an operator.
 */
export async function reconcileGroups(): Promise<{ drained: number; restored: number }> {
  let drained = 0;
  let restored = 0;
  for (const group of await listGroups()) {
    if (!group.enabled) continue;
    const members = (await q<Row>(`SELECT * FROM lb_members WHERE group_id = ?`, group.id)).map(rowToMember);
    for (const member of members) {
      if (!member.enabled) continue;
      const health = await memberTelemetry(member);
      const evaluation = evaluateLbHealth(
        {
          nodeOnline: health.nodeOnline,
          successRatePct: health.successRatePct,
          latencyMs: health.latencyMs,
          lossPct: health.lossPct,
          inboundStatus: health.inboundStatus,
        },
        group.healthRequirements,
      );
      if (group.failover.autoDrain && !member.drained && !evaluation.healthy && health.successRatePct != null) {
        await run(
          `UPDATE lb_members SET drained = 1, drain_reason = ?, updated_at = ? WHERE id = ?`,
          `Automatic drain: ${evaluation.reasons.join("; ")}`,
          nowIso(),
          member.id,
        );
        if (member.kind === "node") {
          await run(`UPDATE nodes SET admin_state = 'drained', updated_at = ? WHERE id = ?`, nowIso(), member.refId);
        }
        await logEvent(group.id, "member.auto_drained", member.id, `Automatic drain: ${evaluation.reasons.join("; ")}`, null);
        drained++;
      }
      if (group.failover.autoRestore && member.drained && evaluation.healthy && (member.drainReason ?? "").startsWith("Automatic drain")) {
        await run(`UPDATE lb_members SET drained = 0, drain_reason = NULL, updated_at = ? WHERE id = ?`, nowIso(), member.id);
        if (member.kind === "node") {
          const node = await q1<{ admin_state: string }>(`SELECT admin_state FROM nodes WHERE id = ?`, member.refId);
          if (node?.admin_state === "drained") {
            await run(`UPDATE nodes SET admin_state = 'enabled', updated_at = ? WHERE id = ?`, nowIso(), member.refId);
          }
        }
        await logEvent(group.id, "member.auto_restored", member.id, "Automatic restore: member is healthy again", null);
        restored++;
      }
    }
  }
  return { drained, restored };
}
