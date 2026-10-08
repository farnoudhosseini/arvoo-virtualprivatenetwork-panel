import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { q, q1, run, uuid, nowIso } from "../db/index.js";
import type {
  FirewallPolicy,
  FirewallPlan,
  FirewallApplyRecord,
  FirewallNodeState,
  FirewallOpInput,
  OpenVPNStructuredConfig,
} from "@arvoo/shared";
import {
  buildFirewallPlan,
  diffFirewallPlans,
  normalizeAuthMode,
  ruleToUfwArgs,
  type FirewallRule,
  type FirewallPlanInput,
} from "@arvoo/shared";
import { badRequest, notFound } from "../lib/errors.js";
import { config } from "../config.js";
import { getSetting, setSetting } from "./settings.js";
import { enqueueOperation } from "./operations.js";

type Row = Record<string, unknown>;

const POLICY_KEY = "firewall.policy";

/**
 * Where the privileged helper for *this* host picks up work.
 *
 * The control plane runs unprivileged and cannot execute `ufw`; a systemd path
 * unit on the master watches this directory and runs the root helper
 * (`arvoo-ufw-apply`). Requests and results are files, so the panel shows the
 * helper's real output instead of an assumed success.
 */
const SPOOL_DIR = process.env.ARVOO_FIREWALL_SPOOL ?? "/var/lib/arvoo/firewall-spool";

/** The host key the panel uses for the machine running the control plane. */
export const SELF_HOST = "self";

export function defaultFirewallPolicy(): FirewallPolicy {
  return {
    sshPorts: [22],
    adminSources: [],
    panelPorts: [80, 443],
    restrictPanel: false,
    exposeApiPort: false,
    allowIcmp: true,
    includeInactiveInbounds: false,
    extraRules: [],
  };
}

export async function getFirewallPolicy(): Promise<FirewallPolicy> {
  const raw = await getSetting(POLICY_KEY);
  const defaults = defaultFirewallPolicy();
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<FirewallPolicy>;
    return {
      ...defaults,
      ...parsed,
      sshPorts: (parsed.sshPorts ?? defaults.sshPorts).filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
      panelPorts: (parsed.panelPorts ?? defaults.panelPorts).filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
      adminSources: parsed.adminSources ?? [],
      extraRules: parsed.extraRules ?? [],
    };
  } catch {
    return defaults;
  }
}

export async function saveFirewallPolicy(patch: Partial<FirewallPolicy>): Promise<FirewallPolicy> {
  const current = await getFirewallPolicy();
  const merged: FirewallPolicy = {
    ...current,
    ...patch,
    sshPorts: patch.sshPorts ?? current.sshPorts,
    panelPorts: patch.panelPorts ?? current.panelPorts,
    adminSources: patch.adminSources ?? current.adminSources,
    extraRules: patch.extraRules ?? current.extraRules,
  };
  if (merged.sshPorts.length === 0) {
    throw badRequest("At least one SSH port must stay open: closing SSH from the panel would lock you out.");
  }
  for (const port of [...merged.sshPorts, ...merged.panelPorts]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest(`Invalid port ${String(port)}.`);
  }
  if (merged.exposeApiPort && !merged.panelPorts.includes(config.port)) {
    // Exposing the API without opening its port would silently do nothing.
    merged.panelPorts = [...merged.panelPorts, config.port];
  }
  await setSetting(POLICY_KEY, JSON.stringify(merged));
  return merged;
}

// ---------------------------------------------------------------------------
// Plan construction from real state
// ---------------------------------------------------------------------------

interface HostTarget {
  key: string;
  kind: "self" | "node";
  nodeId: string | null;
  name: string;
  role: "master" | "node";
  address: string | null;
  sshPort: number;
}

export async function firewallHosts(): Promise<HostTarget[]> {
  const policy = await getFirewallPolicy();
  const hosts: HostTarget[] = [
    {
      key: SELF_HOST,
      kind: "self",
      nodeId: null,
      name: "master (this host)",
      role: "master",
      address: null,
      sshPort: policy.sshPorts[0] ?? 22,
    },
  ];
  const nodes = await q<{ id: string; name: string; address: string | null; role: string; ssh_port: number; is_self: number }>(
    `SELECT id, name, address, role, ssh_port, is_self FROM nodes ORDER BY name ASC`,
  );
  for (const node of nodes) {
    hosts.push({
      key: node.id,
      kind: "node",
      nodeId: node.id,
      name: node.name,
      role: node.is_self === 1 || node.role === "master" ? "master" : "node",
      address: node.address,
      sshPort: Number(node.ssh_port ?? 22),
    });
  }
  return hosts;
}

/** Tunnel peers as they exist for a given node, with their encapsulation. */
async function tunnelPeersFor(nodeId: string): Promise<FirewallPlanInput["tunnelPeers"]> {
  const tunnels = await q<{
    id: string;
    name: string;
    source_node_id: string;
    dest_node_id: string;
    ipsec_enabled: number;
    fou_port: number | null;
  }>(
    `SELECT t.id, t.name, t.source_node_id, t.dest_node_id, t.ipsec_enabled, t.fou_port
       FROM tunnels t
      WHERE t.source_node_id = ? OR t.dest_node_id = ?`,
    nodeId,
    nodeId,
  );
  const peers: FirewallPlanInput["tunnelPeers"] = [];
  for (const tunnel of tunnels) {
    const peerNodeId = tunnel.source_node_id === nodeId ? tunnel.dest_node_id : tunnel.source_node_id;
    const peer = await q1<{ address: string | null; name: string }>(`SELECT address, name FROM nodes WHERE id = ?`, peerNodeId);
    peers.push({
      name: tunnel.name,
      peerAddress: peer?.address ?? "",
      ipsec: Number(tunnel.ipsec_enabled) === 1,
      fouPort: tunnel.fou_port ?? null,
    });
  }
  return peers;
}

function plannedInbounds(rows: Array<{ name: string; structured_config: string; status: string }>): FirewallPlanInput["inbounds"] {
  const out: FirewallPlanInput["inbounds"] = [];
  for (const row of rows) {
    try {
      const cfg = JSON.parse(row.structured_config) as OpenVPNStructuredConfig;
      void normalizeAuthMode(cfg.authMode);
      out.push({
        name: row.name,
        port: Number(cfg.port),
        proto: cfg.transport === "tcp" ? "tcp" : "udp",
        active: row.status === "active" || row.status === "deploying",
      });
    } catch {
      // An unreadable configuration is reported by the inbound page, not here.
    }
  }
  return out;
}

/** Plan for one managed node, built from its inbounds/tunnels and the policy. */
export async function buildPlanForNode(nodeId: string): Promise<FirewallPlan> {
  const node = await q1<{ id: string; name: string; address: string | null; ssh_port: number; role: string }>(
    `SELECT id, name, address, ssh_port, role FROM nodes WHERE id = ?`,
    nodeId,
  );
  if (!node) throw notFound("Node not found");
  const policy = await getFirewallPolicy();
  const inbounds = await q<{ name: string; structured_config: string; status: string }>(
    `SELECT name, structured_config, status FROM inbounds WHERE node_id = ? ORDER BY name`,
    nodeId,
  );
  return buildFirewallPlan({
    nodeName: node.name,
    role: node.role === "master" ? "master" : "node",
    sshPorts: [Number(node.ssh_port ?? 22)],
    panelPorts: policy.panelPorts,
    // The API never listens publicly on a node; its port stays closed.
    apiPort: null,
    adminSources: policy.adminSources,
    restrictPanel: policy.restrictPanel,
    inbounds: plannedInbounds(inbounds),
    includeInactiveInbounds: policy.includeInactiveInbounds,
    tunnelPeers: await tunnelPeersFor(nodeId),
    extraRules: policy.extraRules,
    allowIcmp: policy.allowIcmp,
  });
}

/** Plan for the machine running the control plane. */
export async function buildPlanForSelf(): Promise<FirewallPlan> {
  const policy = await getFirewallPolicy();
  const selfNode = await q1<{ id: string; name: string; ssh_port: number }>(
    `SELECT id, name, ssh_port FROM nodes WHERE is_self = 1 LIMIT 1`,
  );
  const inbounds = selfNode
    ? await q<{ name: string; structured_config: string; status: string }>(
        `SELECT name, structured_config, status FROM inbounds WHERE node_id = ? ORDER BY name`,
        selfNode.id,
      )
    : [];
  return buildFirewallPlan({
    nodeName: "master (this host)",
    role: "master",
    sshPorts: policy.sshPorts,
    panelPorts: policy.panelPorts,
    apiPort: policy.exposeApiPort ? config.port : null,
    adminSources: policy.adminSources,
    restrictPanel: policy.restrictPanel,
    inbounds: plannedInbounds(inbounds),
    includeInactiveInbounds: policy.includeInactiveInbounds,
    tunnelPeers: selfNode ? await tunnelPeersFor(selfNode.id) : [],
    extraRules: policy.extraRules,
    allowIcmp: policy.allowIcmp,
  });
}

export async function buildPlanForHost(hostKey: string): Promise<FirewallPlan> {
  return hostKey === SELF_HOST ? buildPlanForSelf() : buildPlanForNode(hostKey);
}

// ---------------------------------------------------------------------------
// Applying a plan
// ---------------------------------------------------------------------------

/** Public mapper so the route layer can return real apply history. */
export function rowToApplyRecord(r: Row): FirewallApplyRecord {
  return rowToApply(r);
}

function rowToApply(r: Row): FirewallApplyRecord {
  return {
    id: r.id as string,
    nodeId: r.node_id as string,
    at: r.at as string,
    requestedBy: (r.requested_by as string | null) ?? null,
    action: r.action as FirewallApplyRecord["action"],
    planHash: r.plan_hash as string,
    status: r.status as FirewallApplyRecord["status"],
    rulesCount: Number(r.rules_count ?? 0),
    added: safeArray(r.added),
    removed: safeArray(r.removed),
    operationId: (r.operation_id as string | null) ?? null,
    output: (r.output as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function safeArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** The rule set currently applied on a host (empty when never applied). */
export async function appliedRules(hostKey: string): Promise<FirewallRule[]> {
  return previousRulesFor(hostKey);
}

async function previousRulesFor(hostKey: string): Promise<FirewallRule[]> {
  const state = await q1<{ rules: string }>(`SELECT rules FROM firewall_state WHERE node_id = ?`, hostKey);
  if (!state?.rules) return [];
  try {
    const parsed = JSON.parse(state.rules) as FirewallRule[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface FirewallApplyResult {
  hostKey: string;
  action: "enable" | "update" | "disable";
  planHash: string;
  added: FirewallRule[];
  removed: FirewallRule[];
  status: "queued" | "running" | "success" | "failed" | "unavailable";
  detail: string;
  operationId: string | null;
}

/**
 * Request a firewall change on one host.
 *
 * * a managed node gets a real `ConfigureFirewall` operation through its agent;
 * * the master host gets a spool request that the root helper picks up, because
 *   the control plane itself is deliberately unprivileged.
 */
export async function requestApply(
  hostKey: string,
  action: "enable" | "update" | "disable",
  actorName: string,
): Promise<FirewallApplyResult> {
  const hosts = await firewallHosts();
  const host = hosts.find((h) => h.key === hostKey);
  if (!host) throw notFound("Unknown host");

  const plan = action === "disable" ? null : await buildPlanForHost(hostKey);
  const previous = await previousRulesFor(hostKey);
  const diff = diffFirewallPlans(previous, plan?.rules ?? []);
  const applyId = uuid();
  const planHash = plan?.hash ?? "disabled";

  if (host.kind === "node" && action !== "disable") {
    const node = await q1<{ status: string; enrollment_state: string }>(
      `SELECT status, enrollment_state FROM nodes WHERE id = ?`,
      hostKey,
    );
    if (!node || node.enrollment_state !== "approved" || node.status !== "online") {
      return {
        hostKey,
        action,
        planHash,
        added: diff.added,
        removed: diff.removed,
        status: "unavailable",
        detail:
          "The node agent is not online (or not approved), so the plan cannot be applied right now. Nothing was changed.",
        operationId: null,
      };
    }
    const input: FirewallOpInput = {
      nodeName: host.name,
      action,
      plan: {
        nodeName: plan!.nodeName,
        role: plan!.role,
        generatedAt: plan!.generatedAt,
        defaultDenyIncoming: true,
        rules: plan!.rules,
        hash: plan!.hash,
      },
      previousRuleIds: previous.map((r) => r.id),
    };
    const op = await enqueueOperation({
      type: "ConfigureFirewall",
      nodeId: hostKey,
      refType: "node",
      refId: hostKey,
      requestedBy: actorName,
      input,
    });
    await run(
      `INSERT INTO firewall_applies (id, node_id, at, requested_by, action, plan_hash, status, rules_count, added, removed, operation_id)
       VALUES (?,?,?,?,?,?,'queued',?,?,?,?)`,
      applyId,
      hostKey,
      nowIso(),
      actorName,
      action,
      planHash,
      plan!.rules.length,
      JSON.stringify(diff.added.map((r) => r.id)),
      JSON.stringify(diff.removed.map((r) => r.id)),
      op.id,
    );
    return {
      hostKey,
      action,
      planHash,
      added: diff.added,
      removed: diff.removed,
      status: "queued",
      detail: `Operation queued for node agent (${op.id.slice(0, 8)}).`,
      operationId: op.id,
    };
  }

  // Master host (or an explicit disable): hand the plan to the root helper.
  const spooled = await spoolRequest(applyId, host, action, plan, actorName);
  await run(
    `INSERT INTO firewall_applies (id, node_id, at, requested_by, action, plan_hash, status, rules_count, added, removed, operation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
    applyId,
    hostKey,
    nowIso(),
    actorName,
    action,
    planHash,
    plan?.rules.length ?? 0,
    JSON.stringify(diff.added.map((r) => r.id)),
    JSON.stringify(diff.removed.map((r) => r.id)),
    spooled ? "queued" : "failed",
  );
  return {
    hostKey,
    action,
    planHash,
    added: diff.added,
    removed: diff.removed,
    status: spooled ? "queued" : "failed",
    detail: spooled
      ? `Request written to ${SPOOL_DIR}; the root helper (arvoo-ufw-apply.service) applies it within seconds.`
      : `Could not write to ${SPOOL_DIR}. Run the same plan from a root shell: arvoo firewall apply --host ${hostKey}`,
    operationId: null,
  };
}

async function spoolRequest(
  id: string,
  host: HostTarget,
  action: "enable" | "update" | "disable",
  plan: FirewallPlan | null,
  actorName: string,
): Promise<boolean> {
  try {
    mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o750 });
    // Rendered command lines travel with the request so the helper never has to
    // re-derive them (and so preview and reality are the same bytes).
    const commands = (plan?.rules ?? []).map((rule) => ruleToUfwArgs(rule));
    const payload = {
      id,
      host: host.key,
      hostName: host.name,
      action,
      requestedBy: actorName,
      requestedAt: nowIso(),
      plan: plan
        ? {
            nodeName: plan.nodeName,
            role: plan.role,
            generatedAt: plan.generatedAt,
            hash: plan.hash,
            defaultDenyIncoming: true,
            rules: plan.rules,
          }
        : null,
      commands,
      previousRuleIds: (await previousRulesFor(host.key)).map((r) => r.id),
    };
    writeFileSync(path.join(SPOOL_DIR, `${id}.request.json`), JSON.stringify(payload, null, 2), { mode: 0o640 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick up results produced by the root helper. Called by the firewall overview
 * (and the maintenance sweep), so the panel reflects what actually happened on
 * the host - including a failed `ufw` run.
 */
export async function ingestSelfResults(): Promise<number> {
  if (!existsSync(SPOOL_DIR)) return 0;
  let ingested = 0;
  for (const file of readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".result.json"))) {
    const full = path.join(SPOOL_DIR, file);
    let payload: {
      id?: string;
      host?: string;
      action?: "enable" | "update" | "disable";
      ok?: boolean;
      error?: string | null;
      output?: string | null;
      appliedRules?: unknown;
      verified?: boolean;
      enabled?: boolean;
    };
    try {
      payload = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const id = payload.id ?? file.replace(".result.json", "");
    const apply = await q1<Row>(`SELECT * FROM firewall_applies WHERE id = ?`, id);
    const hostKey = payload.host ?? (apply?.node_id as string | undefined);
    if (!hostKey) {
      rmSync(full, { force: true });
      continue;
    }
    const ok = payload.ok === true;
    if (apply) {
      await run(
        `UPDATE firewall_applies SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?`,
        ok ? "success" : "failed",
        payload.output ?? null,
        payload.error ?? null,
        nowIso(),
        id,
      );
    }
    const rules = Array.isArray(payload.appliedRules) ? payload.appliedRules : [];
    await run(
      `INSERT INTO firewall_state (node_id, enabled, plan_hash, rules, applied_at, verified_at, detail)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET enabled = excluded.enabled, plan_hash = excluded.plan_hash, rules = excluded.rules,
         applied_at = excluded.applied_at, verified_at = excluded.verified_at, detail = excluded.detail`,
      hostKey,
      ok ? (payload.enabled === false ? 0 : 1) : 0,
      apply?.plan_hash ?? null,
      JSON.stringify(rules),
      nowIso(),
      payload.verified ? nowIso() : null,
      ok ? (payload.output ?? null) : (payload.error ?? "helper reported failure"),
    );
    rmSync(full, { force: true });
    ingested++;
  }
  return ingested;
}

/** Called when a node's ConfigureFirewall operation settles. */
export async function onFirewallOperationSettled(
  operationId: string,
  success: boolean,
  output: { rules?: unknown; enabled?: boolean; verified?: boolean } | null,
  error: string | null,
): Promise<void> {
  const apply = await q1<Row>(`SELECT * FROM firewall_applies WHERE operation_id = ?`, operationId);
  if (!apply) return;
  const hostKey = apply.node_id as string;
  await run(
    `UPDATE firewall_applies SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?`,
    success ? "success" : "failed",
    output ? JSON.stringify(output) : null,
    error,
    nowIso(),
    apply.id as string,
  );
  const rules = success && Array.isArray(output?.rules) ? output!.rules : [];
  await run(
    `INSERT INTO firewall_state (node_id, enabled, plan_hash, rules, applied_at, verified_at, detail)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(node_id) DO UPDATE SET enabled = excluded.enabled, plan_hash = excluded.plan_hash, rules = excluded.rules,
       applied_at = excluded.applied_at, verified_at = excluded.verified_at, detail = excluded.detail`,
    hostKey,
    success ? (output?.enabled === false ? 0 : 1) : 0,
    apply.plan_hash as string,
    JSON.stringify(rules),
    success ? nowIso() : null,
    success && output?.verified ? nowIso() : null,
    success ? "Applied by node agent" : (error ?? "operation failed"),
  );
}

export interface FirewallHostOverview {
  key: string;
  kind: "self" | "node";
  nodeId: string | null;
  name: string;
  role: "master" | "node";
  address: string | null;
  sshPort: number;
  /** Live plan hash (what the current state requires) and the applied one. */
  planHash: string;
  appliedHash: string | null;
  enabled: boolean;
  inSync: boolean;
  rulesCount: number;
  publicPorts: number[];
  warnings: string[];
  lastApply: FirewallApplyRecord | null;
  verifiedAt: string | null;
  detail: string | null;
}

export async function firewallOverview(): Promise<{
  policy: FirewallPolicy;
  hosts: FirewallHostOverview[];
  spoolDir: string;
}> {
  await ingestSelfResults().catch(() => 0);
  const policy = await getFirewallPolicy();
  const hosts = await firewallHosts();
  const out: FirewallHostOverview[] = [];
  for (const host of hosts) {
    const plan = await buildPlanForHost(host.key).catch(() => null);
    const state = await q1<Row>(`SELECT * FROM firewall_state WHERE node_id = ?`, host.key);
    const lastApply = await q1<Row>(`SELECT * FROM firewall_applies WHERE node_id = ? ORDER BY at DESC LIMIT 1`, host.key);
    const stateRules = state?.rules ? (JSON.parse(state.rules as string) as FirewallRule[]) : [];
    const diff = diffFirewallPlans(stateRules, plan?.rules ?? []);
    out.push({
      key: host.key,
      kind: host.kind,
      nodeId: host.nodeId,
      name: host.name,
      role: host.role,
      address: host.address,
      sshPort: host.sshPort,
      planHash: plan?.hash ?? "unavailable",
      appliedHash: (state?.plan_hash as string | null) ?? null,
      enabled: Number(state?.enabled ?? 0) === 1,
      inSync: plan != null && state?.plan_hash === plan.hash && diff.added.length === 0 && diff.removed.length === 0,
      rulesCount: plan?.rules.length ?? 0,
      publicPorts: plan?.publicPorts ?? [],
      warnings: [...(plan?.warnings ?? []), ...(diff.added.length + diff.removed.length > 0 && state?.plan_hash ? [`${diff.added.length} rule(s) to add, ${diff.removed.length} to remove since the last apply.`] : [])],
      lastApply: lastApply ? rowToApply(lastApply) : null,
      verifiedAt: (state?.verified_at as string | null) ?? null,
      detail: (state?.detail as string | null) ?? null,
    });
  }
  return { policy, hosts: out, spoolDir: SPOOL_DIR };
}

export function hasSelfNode(): Promise<boolean> {
  return q1<{ id: string }>(`SELECT id FROM nodes WHERE is_self = 1 LIMIT 1`).then((row) => Boolean(row));
}
