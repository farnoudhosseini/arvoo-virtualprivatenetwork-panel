/**
 * Routing intelligence service.
 *
 * Bridges the pure engine in `@arvoo/shared` (decision logic, hysteresis,
 * scoring) to real state: nodes, tunnels, capabilities, path measurements,
 * sticky assignments and the audit trail. Nothing here fabricates a
 * measurement — a probe that failed is recorded as a failure, and a path that
 * was never measured is reported `down`, never "probably fine".
 *
 * The service owns persistence and orchestration, not policy: which candidate
 * wins is always decided by the shared engine so the panel, the API and the
 * tests all explain a decision the same way.
 */
import { q, q1, run, uuid, nowIso } from "../db/index.js";
import {
  DEFAULT_HEALTH_STATE_THRESHOLDS,
  DEFAULT_ROUTING_POLICY,
  healthAdmission,
  nextHealthState,
  observationFromHistory,
  orderByPolicy,
  pathStateFromHealth,
  placeSession,
  profileForTunnel,
  rankPaths,
  scoreNode,
  supportedProfiles,
  transportProfile,
  type AdminState,
  type FailoverMode,
  type HealthSample,
  type HealthState,
  type HealthStateRecord,
  type IngressCandidate,
  type NodeTelemetry,
  type PathCandidate,
  type PathMetrics,
  type PolicyCandidateMeta,
  type RoutingPolicy,
} from "@arvoo/shared";
import { badRequest, notFound, unprocessable } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { raiseAlert, resolveAlerts } from "./alerts.js";
import { enqueueOperation } from "./operations.js";

type Row = Record<string, unknown>;

const HEALTH_STATES: HealthState[] = ["healthy", "degraded", "failing", "down", "recovering"];
const HEALTH_SEVERITY: Record<HealthState, number> = { healthy: 4, degraded: 3, recovering: 2, failing: 1, down: 0 };
const FAILOVER_MODES: FailoverMode[] = ["auto", "preferred-node", "preferred-region", "preferred-transport", "strict"];

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rowMetrics(row: Row): PathMetrics | null {
  const latencyMs = asNumber(row.latency_ms);
  const lossPct = asNumber(row.loss_pct);
  const jitterMs = asNumber(row.jitter_ms);
  const throughputMbps = asNumber(row.throughput_mbps);
  if (latencyMs == null && lossPct == null && jitterMs == null && throughputMbps == null) return null;
  return { latencyMs, lossPct, jitterMs, throughputMbps, samples: asNumber(row.samples) ?? 0 };
}

function worstHealth(states: HealthState[]): HealthState | null {
  if (states.length === 0) return null;
  return states.reduce((worst, state) => (HEALTH_SEVERITY[state] < HEALTH_SEVERITY[worst] ? state : worst));
}

// ---------------------------------------------------------------------------
// Path health: measurement in, hysteretic state out
// ---------------------------------------------------------------------------

export interface PathHealthInput {
  ok: boolean;
  metrics: {
    latencyMs?: number | null;
    lossPct?: number | null;
    jitterMs?: number | null;
    throughputMbps?: number | null;
    samples?: number | null;
  } | null;
  source: "benchmark" | "deploy" | "test" | "heartbeat";
  detail?: string | null;
}

export interface PathHealthResult {
  tunnelId: string;
  state: HealthState;
  previousState: HealthState | null;
  changed: boolean;
  reasons: string[];
}

/**
 * Record one real measurement (or one real failure) and advance the path's
 * hysteretic state. The new sample carries the resulting state, so the newest
 * row is always the current state and a restart cannot lose the hysteresis.
 */
export async function recordPathHealth(tunnelId: string, input: PathHealthInput): Promise<PathHealthResult> {
  const tunnel = await q1<Row>(
    `SELECT id, name, status, fou_port, ipsec_enabled FROM tunnels WHERE id = ?`,
    tunnelId,
  );
  if (!tunnel) throw notFound("Tunnel not found");

  const metrics: PathMetrics | null = input.metrics
    ? {
        latencyMs: asNumber(input.metrics.latencyMs),
        lossPct: asNumber(input.metrics.lossPct),
        jitterMs: asNumber(input.metrics.jitterMs),
        throughputMbps: asNumber(input.metrics.throughputMbps),
        samples: asNumber(input.metrics.samples) ?? 0,
      }
    : null;
  const measured =
    metrics != null &&
    (metrics.latencyMs != null || metrics.lossPct != null || metrics.jitterMs != null || metrics.throughputMbps != null);
  const ok = input.ok && measured;
  const at = nowIso();

  const history = await q<Row>(
    `SELECT at, ok, latency_ms, loss_pct, jitter_ms, throughput_mbps, samples, state, state_since
     FROM path_health WHERE tunnel_id = ? ORDER BY at DESC LIMIT 50`,
    tunnelId,
  );
  const samples: HealthSample[] = history.map((row) => ({
    at: String(row.at),
    ok: Boolean(row.ok),
    metrics: rowMetrics(row),
  }));
  const observation = observationFromHistory([{ at, ok, metrics: ok ? metrics : null }, ...samples]);
  const previousRow = history[0];
  const previousState: HealthState | null =
    previousRow && HEALTH_STATES.includes(String(previousRow.state) as HealthState)
      ? (String(previousRow.state) as HealthState)
      : null;
  const previous: HealthStateRecord | null =
    previousState && previousRow
      ? { state: previousState, since: String(previousRow.state_since ?? previousRow.at) }
      : null;

  const transition = nextHealthState(previous, observation, new Date(at));

  await run(
    `INSERT INTO path_health (id, tunnel_id, at, ok, latency_ms, loss_pct, jitter_ms, throughput_mbps, samples, source, detail, state, state_since)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uuid(),
    tunnelId,
    at,
    ok ? 1 : 0,
    ok ? metrics?.latencyMs ?? null : null,
    ok ? metrics?.lossPct ?? null : null,
    ok ? metrics?.jitterMs ?? null : null,
    ok ? metrics?.throughputMbps ?? null : null,
    metrics?.samples ?? null,
    input.source,
    input.detail ?? null,
    transition.state,
    transition.since,
  );

  // The tunnel row keeps the coarse status the panel shows; the detailed state
  // stays in path_health where it was derived.
  const mappedStatus = transition.state === "healthy" ? "up" : transition.state === "down" ? "down" : "degraded";
  await run(
    `UPDATE tunnels SET status = ?, latency_ms = COALESCE(?, latency_ms), loss_pct = COALESCE(?, loss_pct),
       last_verified_at = CASE WHEN ? = 1 THEN ? ELSE last_verified_at END, updated_at = ?
     WHERE id = ? AND status IN ('planned','deploying','up','degraded','down','error')`,
    mappedStatus,
    ok ? metrics?.latencyMs ?? null : null,
    ok ? metrics?.lossPct ?? null : null,
    ok ? 1 : 0,
    at,
    at,
    tunnelId,
  );

  const transport = profileForTunnel({ fouPort: asNumber(tunnel.fou_port), ipsecEnabled: Boolean(tunnel.ipsec_enabled) }).kind;

  if (transition.changed) {
    await run(
      `INSERT INTO routing_events (id, at, kind, from_path, to_path, tunnel_id, transport, score, reason, detail)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      uuid(),
      at,
      "health",
      null,
      null,
      tunnelId,
      transport,
      null,
      transition.reasons.join(" "),
      JSON.stringify({
        previous: previousState,
        state: transition.state,
        hardFailure: transition.hardFailure,
        softDegradation: transition.softDegradation,
        ok,
      }),
    );
  }

  if (transition.state === "down") {
    await raiseAlert({
      severity: "critical",
      type: "tunnel.down",
      title: `Tunnel down: ${String(tunnel.name)}`,
      message: transition.reasons.join(" "),
      entityType: "tunnel",
      entityId: tunnelId,
    });
  } else if (transition.state === "healthy") {
    await resolveAlerts("tunnel.down", tunnelId);
  }

  return {
    tunnelId,
    state: transition.state,
    previousState,
    changed: transition.changed,
    reasons: transition.reasons,
  };
}

// ---------------------------------------------------------------------------
// Topology snapshot: what the engine is allowed to consider
// ---------------------------------------------------------------------------

interface CandidateContext extends PolicyCandidateMeta {
  candidate: PathCandidate;
  label: string;
  healthState: HealthState;
}

interface Topology {
  ingress: IngressCandidate[];
  contexts: CandidateContext[];
  domainLoad: Record<string, number>;
}

async function buildTopology(): Promise<Topology> {
  const [nodes, tunnels, latestRows, assignmentRows] = await Promise.all([
    q<Row>(`SELECT * FROM nodes WHERE enrollment_state = 'approved' ORDER BY name`),
    q<Row>(
      `SELECT t.*,
              n1.name AS source_name, n1.country AS source_country, n1.provider AS source_provider,
              n1.region_class AS source_region_class, n1.status AS source_status, n1.admin_state AS source_admin_state,
              n1.capacity_sessions AS source_capacity,
              n2.name AS dest_name, n2.country AS dest_country, n2.provider AS dest_provider,
              n2.region_class AS dest_region_class, n2.status AS dest_status, n2.admin_state AS dest_admin_state,
              n2.capacity_sessions AS dest_capacity
       FROM tunnels t
       JOIN nodes n1 ON n1.id = t.source_node_id
       JOIN nodes n2 ON n2.id = t.dest_node_id
       ORDER BY t.name`,
    ),
    q<Row>(`SELECT DISTINCT ON (tunnel_id) * FROM path_health ORDER BY tunnel_id, at DESC`),
    q<Row>(`SELECT ingress_node_id, egress_node_id, tunnel_id FROM client_assignments WHERE state IN ('active','draining')`),
  ]);

  const capabilities = new Map<string, { gre?: boolean | null; fou?: boolean | null; ipsec?: { available?: boolean } | null }>();
  for (const node of nodes) {
    capabilities.set(String(node.id), jsonValue(node.capabilities, {}));
  }
  const latest = new Map<string, Row>();
  for (const row of latestRows) latest.set(String(row.tunnel_id), row);

  const ingressSessions: Record<string, number> = {};
  const egressSessions: Record<string, number> = {};
  const domainLoad: Record<string, number> = {};
  for (const assignment of assignmentRows) {
    const ingressId = String(assignment.ingress_node_id);
    const egressId = String(assignment.egress_node_id);
    ingressSessions[ingressId] = (ingressSessions[ingressId] ?? 0) + 1;
    egressSessions[egressId] = (egressSessions[egressId] ?? 0) + 1;
    domainLoad[ingressId] = (domainLoad[ingressId] ?? 0) + 1;
    domainLoad[egressId] = (domainLoad[egressId] ?? 0) + 1;
    if (assignment.tunnel_id) {
      const key = String(assignment.tunnel_id);
      domainLoad[key] = (domainLoad[key] ?? 0) + 1;
    }
  }

  const ingress: IngressCandidate[] = nodes.map((node) => ({
    nodeId: String(node.id),
    label: String(node.name),
    adminState: (asString(node.admin_state) as AdminState | null) ?? "enabled",
    status: node.status as IngressCandidate["status"],
    sessions: ingressSessions[String(node.id)] ?? 0,
    capacitySessions: asNumber(node.capacity_sessions),
  }));

  const contexts: CandidateContext[] = [];
  for (const tunnel of tunnels) {
    const tunnelId = String(tunnel.id);
    const sourceCaps = capabilities.get(String(tunnel.source_node_id)) ?? {};
    const destCaps = capabilities.get(String(tunnel.dest_node_id)) ?? {};
    const profile = profileForTunnel({ fouPort: asNumber(tunnel.fou_port), ipsecEnabled: Boolean(tunnel.ipsec_enabled) });
    const sourceSupports = supportedProfiles(sourceCaps).some((p) => p.kind === profile.kind);
    const destSupports = supportedProfiles(destCaps).some((p) => p.kind === profile.kind);
    const capability = sourceSupports && destSupports
      ? { available: true, reason: null }
      : {
          available: false,
          reason: `${profile.label} is not confirmed on ${
            !sourceSupports ? String(tunnel.source_name) : String(tunnel.dest_name)
          } yet (capability discovery has not reported it).`,
        };

    const row = latest.get(tunnelId);
    const healthState: HealthState =
      row && HEALTH_STATES.includes(String(row.state) as HealthState) ? (String(row.state) as HealthState) : "down";
    const measuredAt = row ? String(row.at) : null;
    const ageSec = measuredAt ? (Date.now() - new Date(measuredAt).getTime()) / 1000 : Number.POSITIVE_INFINITY;
    const admission = healthAdmission(healthState);
    const adminState = (asString(tunnel.admin_state) as AdminState | null) ?? "enabled";
    const weight = asNumber(tunnel.weight) ?? 100;

    const domains = [
      String(tunnel.source_node_id),
      String(tunnel.dest_node_id),
      asString(tunnel.source_provider),
      asString(tunnel.dest_provider),
      asString(tunnel.source_country),
      asString(tunnel.dest_country),
      tunnelId,
      profile.kind,
    ].filter((value): value is string => value != null);

    const candidate: PathCandidate = {
      pathId: tunnelId,
      label: `${String(tunnel.source_name)} -> ${String(tunnel.dest_name)} (${profile.label})`,
      ingressNodeId: String(tunnel.source_node_id),
      egressNodeId: String(tunnel.dest_node_id),
      state: pathStateFromHealth(healthState),
      stale: ageSec > DEFAULT_HEALTH_STATE_THRESHOLDS.staleAfterSec,
      metrics: row ? rowMetrics(row) : null,
      adminState,
      capability,
      sessions: egressSessions[String(tunnel.dest_node_id)] ?? 0,
      capacitySessions: asNumber(tunnel.dest_capacity),
      consecutiveFailures: 0,
      weight: weight * admission.weightMultiplier,
      selectable: admission.selectable,
      ineligibleReason: admission.selectable ? null : admission.note,
      failureDomains: domains,
    };

    contexts.push({
      candidate,
      label: candidate.label,
      healthState,
      nodeIds: [candidate.ingressNodeId, candidate.egressNodeId],
      countries: [asString(tunnel.source_country), asString(tunnel.dest_country)],
      regionClasses: [tunnel.source_region_class, tunnel.dest_region_class].map((value) =>
        value === "iran" || value === "international" ? value : null,
      ),
      transport: profile.kind,
    });
  }

  return { ingress, contexts, domainLoad };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function rowToPolicy(row: Row): RoutingPolicy {
  return {
    mode: row.mode as FailoverMode,
    preferredNodeIds: jsonValue<string[]>(row.preferred_node_ids, []),
    preferredCountries: jsonValue<string[]>(row.preferred_countries, []),
    preferredRegionClasses: jsonValue<Array<"iran" | "international">>(row.preferred_region_classes, []),
    preferredTransports: jsonValue<RoutingPolicy["preferredTransports"]>(row.preferred_transports, []),
  };
}

/** Client policy wins over the global policy; both fall back to AUTO. */
async function resolvePolicy(clientId: string | null): Promise<RoutingPolicy> {
  const clientRow = clientId
    ? await q1<Row>(`SELECT * FROM routing_policies WHERE enabled = 1 AND scope = 'client' AND ref_id = ?`, clientId)
    : undefined;
  const row = clientRow ?? (await q1<Row>(`SELECT * FROM routing_policies WHERE enabled = 1 AND scope = 'global' AND ref_id = ''`));
  return row ? rowToPolicy(row) : DEFAULT_ROUTING_POLICY;
}

export async function getRoutingPolicy(scope: "global" | "client" | "group", refId = ""): Promise<RoutingPolicy | null> {
  const row = await q1<Row>(`SELECT * FROM routing_policies WHERE scope = ? AND ref_id = ?`, scope, refId);
  return row ? rowToPolicy(row) : null;
}

/**
 * The policy the engine will actually apply, as a complete object.
 *
 * An operator who never saved a policy has still chosen something: AUTO with no
 * preferences. Consumers (the matrix, the panel) must never receive null, since
 * "not configured" is a valid decision, not a missing value.
 */
export function effectiveRoutingPolicy(stored: RoutingPolicy | null): RoutingPolicy {
  return {
    mode: stored?.mode ?? DEFAULT_ROUTING_POLICY.mode,
    preferredNodeIds: stored?.preferredNodeIds ?? [],
    preferredCountries: stored?.preferredCountries ?? [],
    preferredRegionClasses: stored?.preferredRegionClasses ?? [],
    preferredTransports: stored?.preferredTransports ?? [],
  };
}

export interface RoutingPolicyInput {
  scope?: "global" | "client" | "group";
  refId?: string;
  mode: FailoverMode;
  preferredNodeIds?: string[];
  preferredCountries?: string[];
  preferredRegionClasses?: Array<"iran" | "international">;
  preferredTransports?: string[];
  minSwitchDelta?: number;
  holdDownSec?: number;
  enabled?: boolean;
}

export async function saveRoutingPolicy(input: RoutingPolicyInput, actor: { id: string; name: string }): Promise<RoutingPolicy> {
  if (!FAILOVER_MODES.includes(input.mode)) {
    throw unprocessable(`mode must be one of ${FAILOVER_MODES.join(", ")}`);
  }
  const scope = input.scope ?? "global";
  const refId = scope === "global" ? "" : input.refId ?? "";
  if (scope !== "global" && refId.length === 0) {
    throw badRequest(`A ${scope} policy needs a refId.`);
  }
  const list = (value: string[] | undefined, field: string): string => {
    if (value == null) return "[]";
    if (value.length > 32) throw unprocessable(`${field} may contain at most 32 entries.`);
    return JSON.stringify(value.map((entry) => String(entry).slice(0, 120)));
  };
  const minSwitchDelta = input.minSwitchDelta ?? 5;
  const holdDownSec = input.holdDownSec ?? 60;
  if (minSwitchDelta < 0 || minSwitchDelta > 100) throw unprocessable("minSwitchDelta must be between 0 and 100.");
  if (holdDownSec < 0 || holdDownSec > 86_400) throw unprocessable("holdDownSec must be between 0 and 86400.");

  const now = nowIso();
  await run(
    `INSERT INTO routing_policies (id, scope, ref_id, mode, preferred_node_ids, preferred_countries, preferred_region_classes, preferred_transports, weights, min_switch_delta, hold_down_sec, enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(scope, ref_id) DO UPDATE SET
       mode = excluded.mode,
       preferred_node_ids = excluded.preferred_node_ids,
       preferred_countries = excluded.preferred_countries,
       preferred_region_classes = excluded.preferred_region_classes,
       preferred_transports = excluded.preferred_transports,
       weights = excluded.weights,
       min_switch_delta = excluded.min_switch_delta,
       hold_down_sec = excluded.hold_down_sec,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
    uuid(),
    scope,
    refId,
    input.mode,
    list(input.preferredNodeIds, "preferredNodeIds"),
    list(input.preferredCountries, "preferredCountries"),
    list(input.preferredRegionClasses as string[] | undefined, "preferredRegionClasses"),
    list(input.preferredTransports, "preferredTransports"),
    "{}",
    minSwitchDelta,
    holdDownSec,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "routing.policy",
    entityType: "routing_policy",
    entityId: refId || "global",
    summary: `Routing policy (${scope}) set to ${input.mode}`,
  });
  const saved = await getRoutingPolicy(scope, refId);
  return saved ?? DEFAULT_ROUTING_POLICY;
}

// ---------------------------------------------------------------------------
// Matrix: the real state the panel renders (spec §16/§40)
// ---------------------------------------------------------------------------

export async function routingMatrix() {
  const [{ ingress, contexts }, telemetryRows, globalPolicy] = await Promise.all([
    buildTopology(),
    q<Row>(`SELECT node_id, telemetry FROM node_telemetry`),
    getRoutingPolicy("global", ""),
  ]);

  const telemetry = new Map<string, Partial<NodeTelemetry>>();
  for (const row of telemetryRows) {
    telemetry.set(String(row.node_id), jsonValue<Partial<NodeTelemetry>>(row.telemetry, {}));
  }

  const paths = contexts.map((context) => {
    const candidate = context.candidate;
    const profile = context.transport ? transportProfile(context.transport) : null;
    const ranked = rankPaths([candidate], { allowDegraded: true });
    const entry = ranked.ranked[0] ?? null;
    const exclusion = ranked.excluded[0] ?? null;
    return {
      tunnelId: candidate.pathId,
      label: candidate.label,
      sourceNodeId: candidate.ingressNodeId,
      destNodeId: candidate.egressNodeId,
      transport: context.transport,
      transportLabel: profile?.label ?? null,
      security: profile?.security ?? null,
      adminState: candidate.adminState,
      weight: candidate.weight ?? 100,
      healthState: context.healthState,
      state: candidate.state,
      stale: candidate.stale,
      metrics: candidate.metrics,
      bitrate: candidate.metrics?.throughputMbps ?? null,
      eligible: entry != null,
      score: entry?.score ?? null,
      reason: entry ? entry.reasons.join(" ") : exclusion?.reason ?? null,
    };
  });

  const nodes = ingress.map((node) => {
    const telemetryFor = telemetry.get(node.nodeId);
    const nodeHealth = worstHealth(
      contexts
        .filter((context) => context.candidate.ingressNodeId === node.nodeId || context.candidate.egressNodeId === node.nodeId)
        .map((context) => context.healthState),
    );
    const scored = scoreNode({
      metrics: {
        cpuUsagePct: telemetryFor?.cpuUsagePct ?? null,
        memoryUsagePct: telemetryFor?.memoryUsagePct ?? null,
        diskUsagePct: telemetryFor?.diskUsagePct ?? null,
        loadAvg1: telemetryFor?.loadAvg?.[0] ?? null,
        cpuCores: telemetryFor?.cpuCores ?? null,
        bandwidthUtilizationPct: null,
        latencyMs: null,
        lossPct: null,
        jitterMs: null,
        connectionSuccessPct: null,
      },
      sessions: node.sessions,
      capacitySessions: node.capacitySessions,
      health: nodeHealth,
    });
    return {
      nodeId: node.nodeId,
      label: node.label,
      status: node.status,
      adminState: node.adminState,
      sessions: node.sessions,
      capacitySessions: node.capacitySessions,
      health: nodeHealth,
      score: scored.score,
      components: scored.components,
      reasons: scored.reasons,
    };
  });

  return { generatedAt: nowIso(), policy: effectiveRoutingPolicy(globalPolicy), nodes, paths };
}

// ---------------------------------------------------------------------------
// Placement: explainable, sticky, policy-aware (spec §13/§14/§24)
// ---------------------------------------------------------------------------

export interface PlacementRequest {
  clientId: string;
  preferIngressNodeId?: string | null;
  allowDegraded?: boolean;
}

export async function decidePlacement(input: PlacementRequest, actor: { id: string; name: string }) {
  const client = await q1<Row>(`SELECT id, username, status FROM clients WHERE id = ?`, input.clientId);
  if (!client) throw notFound("Client not found");
  if (client.status !== "active") {
    throw badRequest(`Client ${String(client.username)} is ${String(client.status)}; placement only applies to active clients.`);
  }

  const policy = await resolvePolicy(input.clientId);
  const { ingress, contexts, domainLoad } = await buildTopology();
  const ordered = orderByPolicy(contexts, policy);
  const preferred = ordered.candidates.filter((entry) => entry.preferred).map((entry) => entry.candidate.candidate);
  const fallback = ordered.candidates.map((entry) => entry.candidate.candidate);

  const currentRow = await q1<Row>(`SELECT * FROM client_assignments WHERE client_id = ?`, input.clientId);
  const current = currentRow
    ? {
        ingressNodeId: String(currentRow.ingress_node_id),
        egressNodeId: String(currentRow.egress_node_id),
        pathId: asString(currentRow.tunnel_id),
      }
    : null;

  const baseOpts = {
    allowDegraded: input.allowDegraded ?? false,
    previousPathId: current?.pathId ?? null,
    diversity: true,
    domainLoad,
  };

  let decision = placeSession({
    ingress,
    paths: preferred.length > 0 ? preferred : fallback,
    current,
    preferIngressNodeId: input.preferIngressNodeId ?? null,
    opts: baseOpts,
  });

  // Last resort: retry with degraded paths enabled and the full candidate set,
  // never with invented health.
  if (decision.action === "reject") {
    decision = placeSession({
      ingress,
      paths: fallback,
      current,
      preferIngressNodeId: input.preferIngressNodeId ?? null,
      opts: { ...baseOpts, allowDegraded: true },
    });
  }

  const selected = decision.ingressNodeId
    ? contexts.find(
        (context) =>
          context.candidate.ingressNodeId === decision.ingressNodeId &&
          context.candidate.egressNodeId === decision.egressNodeId,
      ) ?? null
    : null;
  const now = nowIso();
  const reasonText = decision.reasons.join(" ");
  const selectedRanked = selected ? decision.ranked.find((entry) => entry.path.pathId === selected.candidate.pathId) ?? null : null;

  if ((decision.action === "create" || decision.action === "move") && selected) {
    await run(
      `INSERT INTO client_assignments (id, client_id, ingress_node_id, egress_node_id, tunnel_id, transport, state, reason, score, assigned_at, updated_at)
       VALUES (?,?,?,?,?,?,'active',?,?,?,?)
       ON CONFLICT(client_id) DO UPDATE SET
         ingress_node_id = excluded.ingress_node_id,
         egress_node_id = excluded.egress_node_id,
         tunnel_id = excluded.tunnel_id,
         transport = excluded.transport,
         state = 'active',
         reason = excluded.reason,
         score = excluded.score,
         updated_at = excluded.updated_at`,
      uuid(),
      input.clientId,
      selected.candidate.ingressNodeId,
      selected.candidate.egressNodeId,
      selected.candidate.pathId,
      selected.transport ?? null,
      reasonText,
      selectedRanked?.score ?? null,
      now,
      now,
    );
  } else if (decision.action === "keep") {
    await run(`UPDATE client_assignments SET updated_at = ?, state = 'active' WHERE client_id = ?`, now, input.clientId);
  }

  const eventKind = decision.action === "reject" ? "reject" : decision.action;
  await run(
    `INSERT INTO routing_events (id, at, kind, client_id, from_path, to_path, ingress_node_id, egress_node_id, tunnel_id, transport, score, reason, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uuid(),
    now,
    eventKind,
    input.clientId,
    current?.pathId ?? null,
    selected?.candidate.pathId ?? null,
    decision.ingressNodeId,
    decision.egressNodeId,
    selected?.candidate.pathId ?? null,
    selected?.transport ?? null,
    selectedRanked?.score ?? null,
    reasonText,
    JSON.stringify({
      action: decision.action,
      degradedOnly: decision.degradedOnly,
      policy: policy.mode,
      ranked: decision.ranked.slice(0, 5).map((entry) => ({
        pathId: entry.path.pathId,
        label: entry.path.label,
        score: entry.score,
      })),
      excluded: decision.excluded.slice(0, 20),
    }),
  );

  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "routing.place",
    entityType: "client",
    entityId: input.clientId,
    entityName: String(client.username),
    summary:
      decision.action === "reject"
        ? `No eligible path for ${String(client.username)}: ${reasonText}`
        : `${decision.action}: ${String(client.username)} -> ${selected?.candidate.label ?? "unknown path"}`,
  });

  return {
    client: { id: client.id, username: client.username },
    action: decision.action,
    policy,
    selected: selected
      ? {
          tunnelId: selected.candidate.pathId,
          label: selected.label,
          transport: selected.transport,
          healthState: selected.healthState,
          score: selectedRanked?.score ?? null,
        }
      : null,
    ingressNodeId: decision.ingressNodeId,
    egressNodeId: decision.egressNodeId,
    degradedOnly: decision.degradedOnly,
    reasons: decision.reasons,
    ranked: decision.ranked.map((entry) => ({
      pathId: entry.path.pathId,
      label: entry.path.label,
      score: entry.score,
      weightFactor: entry.weightFactor,
    })),
    excluded: decision.excluded,
  };
}

// ---------------------------------------------------------------------------
// Assignments, events and admin lifecycle
// ---------------------------------------------------------------------------

export async function listAssignments() {
  return q(
    `SELECT a.*, c.username, n1.name AS ingress_name, n2.name AS egress_name, t.name AS tunnel_name
     FROM client_assignments a
     JOIN clients c ON c.id = a.client_id
     JOIN nodes n1 ON n1.id = a.ingress_node_id
     JOIN nodes n2 ON n2.id = a.egress_node_id
     LEFT JOIN tunnels t ON t.id = a.tunnel_id
     ORDER BY a.updated_at DESC`,
  );
}

export async function listRoutingEvents(limit = 50) {
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  return q(
    `SELECT e.*, c.username FROM routing_events e LEFT JOIN clients c ON c.id = e.client_id ORDER BY e.at DESC LIMIT ?`,
    capped,
  );
}

export type AdminEntity = "node" | "tunnel";

/**
 * Set the administrative lifecycle. Disable and Drain stop NEW sessions;
 * existing ones are marked draining and are never killed by this call.
 */
export async function setAdminState(
  entity: AdminEntity,
  id: string,
  state: AdminState,
  actor: { id: string; name: string },
) {
  const table = entity === "node" ? "nodes" : "tunnels";
  const row = await q1<Row>(`SELECT id, name FROM ${table} WHERE id = ?`, id);
  if (!row) throw notFound(`${entity === "node" ? "Node" : "Tunnel"} not found`);
  const now = nowIso();
  await run(`UPDATE ${table} SET admin_state = ?, updated_at = ? WHERE id = ?`, state, now, id);

  if (entity === "node") {
    if (state === "enabled") {
      await run(
        `UPDATE client_assignments SET state = 'active', updated_at = ? WHERE state = 'draining' AND (ingress_node_id = ? OR egress_node_id = ?)`,
        now,
        id,
        id,
      );
    } else {
      await run(
        `UPDATE client_assignments SET state = 'draining', updated_at = ? WHERE state = 'active' AND (ingress_node_id = ? OR egress_node_id = ?)`,
        now,
        id,
        id,
      );
    }
  } else if (state === "enabled") {
    await run(`UPDATE client_assignments SET state = 'active', updated_at = ? WHERE state = 'draining' AND tunnel_id = ?`, now, id);
  } else {
    await run(`UPDATE client_assignments SET state = 'draining', updated_at = ? WHERE state = 'active' AND tunnel_id = ?`, now, id);
  }

  const reason =
    state === "enabled"
      ? `${entity} ${String(row.name)} is enabled again: new sessions may be placed here.`
      : state === "drained"
        ? `${entity} ${String(row.name)} is draining: existing sessions continue, new sessions are placed elsewhere.`
        : `${entity} ${String(row.name)} is administratively disabled.`;
  await run(
    `INSERT INTO routing_events (id, at, kind, from_path, to_path, reason, detail) VALUES (?,?,?,?,?,?,?)`,
    uuid(),
    now,
    "admin",
    null,
    null,
    reason,
    JSON.stringify({ entity, id, name: row.name, state }),
  );
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "routing.admin",
    entityType: entity,
    entityId: id,
    entityName: String(row.name),
    summary: reason,
  });
  return { entity, id, name: row.name, adminState: state };
}

// ---------------------------------------------------------------------------
// Benchmarking: queue a real measurement on the tunnel's source node
// ---------------------------------------------------------------------------

export interface BenchmarkRequest {
  pingCount?: number;
  iperfSeconds?: number | null;
}

export async function queueBenchmark(tunnelId: string, input: BenchmarkRequest, actor: { id: string; name: string }) {
  const tunnel = await q1<Row>(
    `SELECT id, name, source_node_id, local_tunnel_ip, remote_tunnel_ip FROM tunnels WHERE id = ?`,
    tunnelId,
  );
  if (!tunnel) throw notFound("Tunnel not found");

  const pingCount = input.pingCount ?? 20;
  if (!Number.isInteger(pingCount) || pingCount < 1 || pingCount > 200) {
    throw unprocessable("pingCount must be an integer between 1 and 200.");
  }
  const iperfSeconds = input.iperfSeconds ?? null;
  if (iperfSeconds != null && (!Number.isInteger(iperfSeconds) || iperfSeconds < 1 || iperfSeconds > 60)) {
    throw unprocessable("iperfSeconds must be between 1 and 60, or null to skip throughput.");
  }

  const op = await enqueueOperation({
    type: "RunBenchmark",
    nodeId: String(tunnel.source_node_id),
    refType: "tunnel",
    refId: tunnelId,
    requestedBy: actor.name,
    input: {
      interfaceName: String(tunnel.name),
      localTunnelIp: String(tunnel.local_tunnel_ip),
      remoteTunnelIp: String(tunnel.remote_tunnel_ip),
      pingCount,
      iperfSeconds,
    },
  });
  audit({
    actorId: actor.id,
    actorName: actor.name,
    action: "tunnel.benchmark",
    entityType: "tunnel",
    entityId: tunnelId,
    entityName: String(tunnel.name),
    summary: `Benchmark queued for ${String(tunnel.name)} (ping x${pingCount}${iperfSeconds ? `, iperf3 ${iperfSeconds}s` : ""})`,
  });
  return { operationId: op.id };
}

export async function pathHealthHistory(tunnelId: string, limit = 100) {
  const capped = Math.max(1, Math.min(1000, Math.floor(limit)));
  return q(`SELECT * FROM path_health WHERE tunnel_id = ? ORDER BY at DESC LIMIT ?`, tunnelId, capped);
}
