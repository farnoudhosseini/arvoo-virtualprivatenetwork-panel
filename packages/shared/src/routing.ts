/**
 * Arvoo routing intelligence: health state, node scoring and failover policy.
 *
 * This module is the stateful half of the routing engine. `controller.ts`
 * answers "given this snapshot, what is the best eligible path"; this module
 * answers "how did the snapshot become what it is" — hysteresis, recovery,
 * resource pressure and the policy that turns operator intent into candidate
 * tiers. It is still pure and deterministic: it never reads a clock other than
 * the `now` it is given and never invents a measurement.
 *
 * Design rules encoded here:
 *  - A soft failure (latency/loss/jitter growth) degrades a path gradually.
 *    Only real probe failures or an explicit hard failure can mark it down.
 *  - Recovery is never instant: `down → recovering → healthy` requires
 *    consecutive successes and a hold-down, so a flapping path cannot be
 *    handed new sessions the moment it blinks.
 *  - Improving takes at most one step per evaluation, and only after the
 *    minimum state duration; regressing is immediate. That asymmetry is what
 *    protects existing sessions from oscillation.
 *  - Unknown metrics are excluded and the remaining weights renormalise,
 *    exactly like the controller's scoring, so nothing is scored as perfect
 *    or useless merely because it was not measured.
 */

import type { PathMetrics, PathStateName, TransportKind } from "./controller";

// ---------------------------------------------------------------------------
// Health states (spec: HEALTHY → DEGRADED → FAILING → DOWN, and back through
// RECOVERING) with hysteresis and flapping prevention
// ---------------------------------------------------------------------------

export type HealthState = "healthy" | "degraded" | "failing" | "down" | "recovering";

export interface HealthStateRecord {
  state: HealthState;
  /** ISO timestamp of the last state change. */
  since: string;
}

export interface HealthObservation {
  /** Newest successful measurement; null when the newest probe failed. */
  metrics: PathMetrics | null;
  /** When `metrics` was measured (ISO). */
  measuredAt: string | null;
  /** Trailing probe failures, newest first. */
  consecutiveFailures?: number;
  /** Trailing successful probes with real numbers. */
  consecutiveSuccesses?: number;
  /**
   * Explicit hard failure the caller observed directly (interface missing,
   * handshake impossible). Unlike a slow metric, this is evidence, so it can
   * take a path down without waiting for three failed probes.
   */
  hardFailure?: boolean;
}

export interface HealthStateThresholds {
  degradedLossPct: number;
  failingLossPct: number;
  degradedLatencyMs: number;
  failingLatencyMs: number;
  degradedJitterMs: number;
  failingJitterMs: number;
  /** A measurement older than this cannot support `healthy`. */
  staleAfterSec: number;
  /** Consecutive failed probes that force the path down. */
  downAfterConsecutiveFailures: number;
  /** Successes needed before a down path is allowed into `recovering`. */
  recoveringAfterConsecutiveSuccesses: number;
  /** Successes needed before a recovering path is `healthy` again. */
  healthyAfterConsecutiveSuccesses: number;
  /** Minimum time a state is held before it may improve. */
  minimumStateDurationSec: number;
}

export const DEFAULT_HEALTH_STATE_THRESHOLDS: HealthStateThresholds = {
  degradedLossPct: 2,
  failingLossPct: 10,
  degradedLatencyMs: 250,
  failingLatencyMs: 500,
  degradedJitterMs: 60,
  failingJitterMs: 120,
  staleAfterSec: 900,
  downAfterConsecutiveFailures: 3,
  recoveringAfterConsecutiveSuccesses: 2,
  healthyAfterConsecutiveSuccesses: 5,
  minimumStateDurationSec: 60,
};

export interface HealthTransition {
  state: HealthState;
  since: string;
  /** Ordered explanation of the decisive evidence. */
  reasons: string[];
  /** True when the latest probe failed or the caller reported a hard failure. */
  hardFailure: boolean;
  /** True when the only evidence is a shrinking measurement, not a failure. */
  softDegradation: boolean;
  /** True when the state changed in this evaluation. */
  changed: boolean;
}

type Severity = "healthy" | "degraded" | "failing";

function classifySeverity(metrics: PathMetrics, thresholds: HealthStateThresholds): { severity: Severity; reasons: string[] } {
  const reasons: string[] = [];
  let severity: Severity = "healthy";

  if (metrics.lossPct != null && metrics.lossPct >= thresholds.failingLossPct) {
    severity = "failing";
    reasons.push(`Packet loss ${metrics.lossPct}% is above the failing threshold ${thresholds.failingLossPct}%.`);
  } else if (metrics.lossPct != null && metrics.lossPct >= thresholds.degradedLossPct) {
    severity = "degraded";
    reasons.push(`Packet loss ${metrics.lossPct}% is above the degraded threshold ${thresholds.degradedLossPct}%.`);
  }

  if (metrics.latencyMs != null && metrics.latencyMs >= thresholds.failingLatencyMs) {
    severity = "failing";
    reasons.push(`Median latency ${metrics.latencyMs}ms is above the failing threshold ${thresholds.failingLatencyMs}ms.`);
  } else if (metrics.latencyMs != null && metrics.latencyMs >= thresholds.degradedLatencyMs && severity !== "failing") {
    severity = "degraded";
    reasons.push(`Median latency ${metrics.latencyMs}ms is above the degraded threshold ${thresholds.degradedLatencyMs}ms.`);
  }

  if (metrics.jitterMs != null && metrics.jitterMs >= thresholds.failingJitterMs) {
    severity = "failing";
    reasons.push(`Jitter ${metrics.jitterMs}ms is above the failing threshold ${thresholds.failingJitterMs}ms.`);
  } else if (metrics.jitterMs != null && metrics.jitterMs >= thresholds.degradedJitterMs && severity !== "failing") {
    severity = "degraded";
    reasons.push(`Jitter ${metrics.jitterMs}ms is above the degraded threshold ${thresholds.degradedJitterMs}ms.`);
  }

  return { severity, reasons };
}

const HEALTH_ORDER: Record<HealthState, number> = {
  down: 0,
  failing: 1,
  degraded: 2,
  recovering: 3,
  healthy: 4,
};

function worse(a: HealthState, b: HealthState): HealthState {
  return HEALTH_ORDER[a] <= HEALTH_ORDER[b] ? a : b;
}

/**
 * Advance one path's health state.
 *
 * Deterministic and side-effect free: the caller persists the returned state.
 * `reasons` always explains the decisive evidence in evaluation order, so an
 * operator can reproduce why a path was marked down or why it recovered.
 */
export function nextHealthState(
  previous: HealthStateRecord | null,
  observation: HealthObservation,
  now: Date,
  thresholds: HealthStateThresholds = DEFAULT_HEALTH_STATE_THRESHOLDS,
): HealthTransition {
  const reasons: string[] = [];
  const failures = Math.max(0, observation.consecutiveFailures ?? 0);
  const successes = Math.max(0, observation.consecutiveSuccesses ?? 0);
  const metrics = observation.metrics;
  const measuredAt = observation.measuredAt;
  const ageSec = measuredAt ? Math.max(0, (now.getTime() - new Date(measuredAt).getTime()) / 1000) : Number.POSITIVE_INFINITY;
  const stale = ageSec > thresholds.staleAfterSec;
  const heldSec = previous ? Math.max(0, (now.getTime() - new Date(previous.since).getTime()) / 1000) : Number.POSITIVE_INFINITY;
  const canImprove = heldSec >= thresholds.minimumStateDurationSec;

  const settle = (state: HealthState, extraReasons: string[], flags?: { hardFailure?: boolean; softDegradation?: boolean }): HealthTransition => {
    const changed = previous?.state !== state;
    return {
      state,
      since: changed || !previous ? now.toISOString() : previous.since,
      reasons: [...reasons, ...extraReasons],
      hardFailure: flags?.hardFailure ?? false,
      softDegradation: flags?.softDegradation ?? false,
      changed,
    };
  };

  // --- hard failure: real evidence, fail fast ---------------------------------
  if (observation.hardFailure === true) {
    reasons.push("An explicit hard failure was reported (reachability or encapsulation is broken).");
    return settle("down", ["Marked down immediately; hard failures do not wait for hysteresis."], { hardFailure: true });
  }
  if (failures >= thresholds.downAfterConsecutiveFailures) {
    reasons.push(
      `${failures} consecutive probe failures reached the down threshold ${thresholds.downAfterConsecutiveFailures}.`,
    );
    return settle("down", ["Marked down; recovery requires consecutive successes and the hold-down."], { hardFailure: true });
  }

  // --- no usable measurement --------------------------------------------------
  if (!metrics) {
    if (!previous) {
      reasons.push("No measurement has ever been recorded for this path.");
      return settle("down", ["A path that was never measured cannot be reported healthy."]);
    }
    if (previous.state === "down") {
      reasons.push("Still down and no successful measurement has arrived yet.");
      return settle("down", [], { hardFailure: failures > 0 });
    }
    if (stale) {
      reasons.push(`The last measurement is ${Math.round(ageSec)}s old (stale after ${thresholds.staleAfterSec}s).`);
      return settle("failing", ["No fresh evidence: the path cannot stay healthy on stale data."], { softDegradation: true });
    }
    reasons.push("No new measurement in this evaluation; the previous state is retained.");
    return settle(previous.state, [], {
      softDegradation: previous.state !== "healthy",
    });
  }

  // --- measurement present but stale -------------------------------------------
  if (stale) {
    reasons.push(`The last measurement is ${Math.round(ageSec)}s old (stale after ${thresholds.staleAfterSec}s).`);
    const capped = previous ? worse(previous.state, "failing") : "failing";
    if (previous?.state === "down") {
      reasons.push("Still down; a stale measurement cannot start recovery.");
      return settle("down", []);
    }
    return settle(capped, ["Stale data degrades the path and blocks any improvement."], { softDegradation: true });
  }

  const { severity, reasons: severityReasons } = classifySeverity(metrics, thresholds);
  reasons.push(...severityReasons);
  const healthyNow = severity === "healthy" && failures === 0;

  if (!previous) {
    const initial: HealthState =
      severity === "failing" ? "failing" : severity === "degraded" || failures > 0 ? "degraded" : "healthy";
    return settle(initial, [`Initial state from the first measurement: ${initial}.`], {
      softDegradation: initial !== "healthy",
    });
  }

  // --- recovery ladder: one step per evaluation, hold-down enforced -----------
  switch (previous.state) {
    case "down": {
      if (canImprove && successes >= thresholds.recoveringAfterConsecutiveSuccesses && severity !== "failing") {
        reasons.push(
          `${successes} consecutive successes (threshold ${thresholds.recoveringAfterConsecutiveSuccesses}) and the ${thresholds.minimumStateDurationSec}s hold-down have passed.`,
        );
        return settle("recovering", ["Entered recovering: probes answer again, but new sessions wait for the canary policy."], {
          softDegradation: true,
        });
      }
      reasons.push(
        canImprove
          ? `Down until ${thresholds.recoveringAfterConsecutiveSuccesses} consecutive successes arrive (currently ${successes}).`
          : `Down: the ${thresholds.minimumStateDurationSec}s hold-down since the last change has not passed (${Math.round(heldSec)}s).`,
      );
      return settle("down", [], { hardFailure: failures > 0 });
    }
    case "recovering": {
      if (severity === "failing") {
        reasons.push("Recovery failed: the path regressed to failing before completing.");
        return settle("failing", [], { softDegradation: true });
      }
      if (canImprove && healthyNow && successes >= thresholds.healthyAfterConsecutiveSuccesses) {
        reasons.push(
          `${successes} consecutive successes (threshold ${thresholds.healthyAfterConsecutiveSuccesses}) with healthy metrics.`,
        );
        return settle("healthy", ["Recovery complete: the path is healthy again."]);
      }
      reasons.push(
        `Still recovering: ${successes}/${thresholds.healthyAfterConsecutiveSuccesses} consecutive successes needed to return to healthy.`,
      );
      return settle("recovering", [], { softDegradation: true });
    }
    case "failing": {
      if (severity === "failing") {
        reasons.push("Failing condition persists.");
        return settle("failing", [], { softDegradation: true });
      }
      if (canImprove) {
        reasons.push(`Metrics improved below the failing thresholds and the ${thresholds.minimumStateDurationSec}s hold-down has passed.`);
        return settle("degraded", ["Improving one step at a time: failing → degraded."], { softDegradation: true });
      }
      reasons.push(
        `Improvement held for ${thresholds.minimumStateDurationSec}s since the last change (${Math.round(heldSec)}s elapsed).`,
      );
      return settle("failing", [], { softDegradation: true });
    }
    case "degraded": {
      if (severity === "failing") {
        reasons.push("Degraded condition worsened past the failing threshold.");
        return settle("failing", [], { softDegradation: true });
      }
      if (canImprove && healthyNow) {
        reasons.push(`Metrics are back within every degraded threshold and the hold-down has passed.`);
        return settle("healthy", ["Recovered from degraded to healthy."]);
      }
      reasons.push(
        healthyNow
          ? `Holding the degraded state for ${thresholds.minimumStateDurationSec}s before declaring it healthy.`
          : "Still degraded: at least one metric remains above its degraded threshold.",
      );
      return settle("degraded", [], { softDegradation: true });
    }
    case "healthy": {
      if (severity === "failing") {
        reasons.push("A metric crossed the failing threshold.");
        return settle("failing", ["Soft failure: marked failing and its selection weight is reduced."], { softDegradation: true });
      }
      if (severity === "degraded" || failures > 0) {
        if (failures > 0) reasons.push(`${failures} probe failure(s) recorded.`);
        return settle("degraded", ["Soft failure: marked degraded and its selection weight is reduced."], { softDegradation: true });
      }
      return settle("healthy", ["All measured metrics are within thresholds."]);
    }
  }
}

// ---------------------------------------------------------------------------
// History → observation (a failed probe is recorded, no numbers are invented)
// ---------------------------------------------------------------------------

export interface HealthSample {
  at: string;
  /** null when the probe failed. */
  metrics: PathMetrics | null;
  ok: boolean;
}

/**
 * Derive the observation the state machine needs from stored probe history.
 * Samples may arrive in any order; they are sorted newest-first internally.
 */
export function observationFromHistory(samples: HealthSample[]): HealthObservation {
  const ordered = [...samples].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const newest = ordered[0];
  if (!newest) {
    return { metrics: null, measuredAt: null, consecutiveFailures: 0, consecutiveSuccesses: 0 };
  }

  let consecutiveFailures = 0;
  for (const sample of ordered) {
    if (sample.ok) break;
    consecutiveFailures++;
  }

  let consecutiveSuccesses = 0;
  for (const sample of ordered) {
    if (!sample.ok || !sample.metrics) break;
    consecutiveSuccesses++;
  }

  const newestWithMetrics = ordered.find((s) => s.metrics != null);
  return {
    metrics: newestWithMetrics?.metrics ?? null,
    measuredAt: newestWithMetrics?.at ?? null,
    consecutiveFailures,
    consecutiveSuccesses,
  };
}

// ---------------------------------------------------------------------------
// Admission: what each state means for new sessions
// ---------------------------------------------------------------------------

export interface HealthAdmission {
  /** Whether new sessions may be placed at all. */
  selectable: boolean;
  /** Multiplier applied to the node/tunnel admin weight (0-1). */
  weightMultiplier: number;
  /** Panel-ready explanation. */
  note: string;
}

export function healthAdmission(state: HealthState): HealthAdmission {
  switch (state) {
    case "healthy":
      return { selectable: true, weightMultiplier: 1, note: "Healthy: full weight." };
    case "degraded":
      return {
        selectable: true,
        weightMultiplier: 0.5,
        note: "Degraded: half weight; the caller must explicitly allow degraded paths.",
      };
    case "recovering":
      return {
        selectable: false,
        weightMultiplier: 0.25,
        note: "Recovering: canary only; not selectable without an explicit recovery policy.",
      };
    case "failing":
      return { selectable: false, weightMultiplier: 0.1, note: "Failing: excluded from new sessions." };
    case "down":
      return { selectable: false, weightMultiplier: 0, note: "Down: excluded from new sessions." };
  }
}

/** Map the five-state machine onto the controller's eligibility vocabulary. */
export function pathStateFromHealth(state: HealthState): PathStateName {
  if (state === "healthy") return "up";
  if (state === "down") return "down";
  return "degraded";
}

// ---------------------------------------------------------------------------
// Node scoring (spec: latency + loss + capacity + success + resources + stability)
// ---------------------------------------------------------------------------

export interface NodeScoreMetrics {
  cpuUsagePct: number | null;
  memoryUsagePct: number | null;
  diskUsagePct: number | null;
  loadAvg1: number | null;
  cpuCores: number | null;
  /** 0-100 out of the node's provisioned bandwidth; null when unknown. */
  bandwidthUtilizationPct: number | null;
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  /** Successful connection establishment ratio, 0-100. */
  connectionSuccessPct: number | null;
}

export interface NodeScoreInput {
  metrics: NodeScoreMetrics;
  sessions: number;
  /** null = unknown capacity; the capacity component is then excluded. */
  capacitySessions: number | null;
  /** Worst health among the node's paths/transports; null when nothing measured. */
  health: HealthState | null;
  consecutiveFailures?: number;
}

export interface NodeScoringWeights {
  latency: number;
  loss: number;
  capacity: number;
  success: number;
  resources: number;
  stability: number;
}

export const DEFAULT_NODE_WEIGHTS: NodeScoringWeights = {
  latency: 0.2,
  loss: 0.15,
  capacity: 0.2,
  success: 0.15,
  resources: 0.2,
  stability: 0.1,
};

export interface NodeScore {
  score: number;
  components: {
    latency: number | null;
    loss: number | null;
    capacity: number | null;
    success: number | null;
    resources: number | null;
    stability: number | null;
  };
  weightsUsed: Partial<NodeScoringWeights>;
  reasons: string[];
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Score one node for new-session placement.
 *
 * Every component is 0-100 (higher is better). Components without a real
 * measurement are omitted and the weights renormalise, so an unmeasured node is
 * never silently ranked first or last.
 */
export function scoreNode(input: NodeScoreInput, weights: NodeScoringWeights = DEFAULT_NODE_WEIGHTS): NodeScore {
  const reasons: string[] = [];
  const components: NodeScore["components"] = {
    latency: null,
    loss: null,
    capacity: null,
    success: null,
    resources: null,
    stability: null,
  };

  const m = input.metrics;

  if (m.latencyMs != null) {
    components.latency = round1(clamp01(1 - m.latencyMs / 300) * 100);
    reasons.push(`Latency ${m.latencyMs}ms scores ${components.latency}/100.`);
  }
  if (m.lossPct != null) {
    components.loss = round1(clamp01(1 - m.lossPct / 20) * 100);
    reasons.push(`Packet loss ${m.lossPct}% scores ${components.loss}/100.`);
  }
  if (m.connectionSuccessPct != null) {
    components.success = round1(clamp01(m.connectionSuccessPct / 100) * 100);
    reasons.push(`Connection success ${m.connectionSuccessPct}% scores ${components.success}/100.`);
  }

  // Capacity combines session headroom with bandwidth utilization. Utilization
  // only pulls the score down; an unknown capacity leaves the component out.
  const sessionUtil = input.capacitySessions != null && input.capacitySessions > 0 ? input.sessions / input.capacitySessions : null;
  const bandwidthUtil = m.bandwidthUtilizationPct != null ? m.bandwidthUtilizationPct / 100 : null;
  const utilizations = [sessionUtil, bandwidthUtil].filter((v): v is number => v != null);
  if (utilizations.length > 0) {
    const utilization = Math.max(...utilizations);
    components.capacity = round1(clamp01(1 - utilization) * 100);
    reasons.push(
      `Capacity ${(utilization * 100).toFixed(1)}% used` +
        (sessionUtil != null ? ` (${input.sessions}/${input.capacitySessions} sessions)` : "") +
        (bandwidthUtil != null ? ` (bandwidth ${m.bandwidthUtilizationPct}%)` : "") +
        `: ${components.capacity}/100.`,
    );
  } else {
    reasons.push("Capacity not measured (no session limit and no bandwidth figure): excluded from the score.");
  }

  // Resource pressure: CPU, memory, disk and load average, worst one wins.
  const pressures: Array<{ label: string; value: number }> = [];
  if (m.cpuUsagePct != null) pressures.push({ label: "CPU", value: m.cpuUsagePct });
  if (m.memoryUsagePct != null) pressures.push({ label: "memory", value: m.memoryUsagePct });
  if (m.diskUsagePct != null) pressures.push({ label: "disk", value: m.diskUsagePct });
  if (m.loadAvg1 != null && m.cpuCores != null && m.cpuCores > 0) {
    pressures.push({ label: "load average", value: clamp01(m.loadAvg1 / m.cpuCores) * 100 });
  }
  if (pressures.length > 0) {
    const worst = pressures.reduce((a, b) => (b.value > a.value ? b : a));
    components.resources = round1(clamp01(1 - worst.value / 100) * 100);
    reasons.push(`Worst resource pressure is ${worst.label} at ${worst.value.toFixed(1)}%: ${components.resources}/100.`);
  } else {
    reasons.push("No resource telemetry: the resource component is excluded.");
  }

  if (input.health != null) {
    const base = input.health === "healthy" ? 100 : input.health === "degraded" ? 60 : input.health === "recovering" ? 45 : input.health === "failing" ? 20 : 0;
    const penalty = Math.min(30, (input.consecutiveFailures ?? 0) * 10);
    components.stability = round1(clamp01((base - penalty) / 100) * 100);
    reasons.push(`Stability from health=${input.health}${penalty > 0 ? ` with a -${penalty} failure penalty` : ""}: ${components.stability}/100.`);
  } else {
    reasons.push("No aggregate health state: the stability component is excluded.");
  }

  let weighted = 0;
  let totalWeight = 0;
  const weightsUsed: Partial<NodeScoringWeights> = {};
  for (const key of Object.keys(components) as Array<keyof NodeScore["components"]>) {
    const value = components[key];
    const weight = weights[key];
    if (value == null || weight <= 0) continue;
    weighted += value * weight;
    totalWeight += weight;
    weightsUsed[key] = weight;
  }
  const score = totalWeight > 0 ? round1(weighted / totalWeight) : 0;
  reasons.push(`Weighted node score ${score}/100 from ${Object.keys(weightsUsed).join(", ") || "no measurable component"}.`);

  return { score, components, weightsUsed, reasons };
}

// ---------------------------------------------------------------------------
// Failover policy (spec: AUTO / PREFERRED_NODE / PREFERRED_REGION /
// PREFERRED_TRANSPORT / STRICT)
// ---------------------------------------------------------------------------

export type FailoverMode = "auto" | "preferred-node" | "preferred-region" | "preferred-transport" | "strict";

export interface RoutingPolicy {
  mode: FailoverMode;
  /** Node ids that define "preferred" in preferred-node mode. */
  preferredNodeIds?: string[];
  /** Countries (case-insensitive) that define the preferred region. */
  preferredCountries?: string[];
  /** Region classes ("iran" / "international") that count as preferred. */
  preferredRegionClasses?: Array<"iran" | "international">;
  /** Transport kinds that define "preferred" in preferred-transport mode. */
  preferredTransports?: TransportKind[];
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { mode: "auto" };

export interface PolicyCandidateMeta {
  /** Every node id the candidate depends on (ingress and egress). */
  nodeIds: string[];
  countries: Array<string | null>;
  regionClasses: Array<"iran" | "international" | null>;
  transport: TransportKind | null;
}

export interface RoutingPolicyDecision {
  preferred: boolean;
  /** Human explanation of the tiering decision, shown in the audit trail. */
  reason: string | null;
}

/**
 * Decide whether a candidate is preferred, acceptable, or (in strict mode)
 * excluded. Preference is a tier, not a filter: preferred candidates are tried
 * first, everything else remains a fallback — except in strict mode, where the
 * operator has explicitly asked for no fallback.
 */
export function policyDecision(meta: PolicyCandidateMeta, policy: RoutingPolicy): RoutingPolicyDecision {
  const matchesNode = (policy.preferredNodeIds ?? []).some((id) => meta.nodeIds.includes(id));
  const matchesCountry = (policy.preferredCountries ?? []).some(
    (country) => meta.countries.some((c) => c != null && c.toLowerCase() === country.toLowerCase()),
  );
  const matchesRegionClass = (policy.preferredRegionClasses ?? []).some(
    (rc) => meta.regionClasses.some((c) => c === rc),
  );
  const matchesTransport = (policy.preferredTransports ?? []).some((t) => meta.transport === t);

  switch (policy.mode) {
    case "auto":
      return { preferred: false, reason: null };
    case "preferred-node":
      return matchesNode
        ? { preferred: true, reason: `Matches the preferred node policy (${policy.preferredNodeIds?.join(", ")}).` }
        : { preferred: false, reason: "Not on a preferred node; usable as fallback." };
    case "preferred-region": {
      if (matchesCountry || matchesRegionClass) {
        const what = matchesCountry ? "country" : "region class";
        return { preferred: true, reason: `Matches the preferred region by ${what}.` };
      }
      return { preferred: false, reason: "Outside the preferred region; usable as fallback." };
    }
    case "preferred-transport":
      return matchesTransport
        ? { preferred: true, reason: `Matches the preferred transport (${policy.preferredTransports?.join(", ")}).` }
        : { preferred: false, reason: "Not the preferred transport; usable as fallback." };
    case "strict":
      return matchesNode || matchesCountry || matchesRegionClass || matchesTransport
        ? { preferred: true, reason: "Matches the strict policy; other candidates are excluded." }
        : { preferred: false, reason: "Strict mode: candidates outside the preference are excluded, not used as fallback." };
  }
}

export interface PolicyOrdering<T extends PolicyCandidateMeta> {
  /** In preference order: preferred tier first, then fallbacks. */
  candidates: Array<{ candidate: T; preferred: boolean; reason: string | null }>;
  /** In strict mode, candidates the policy refuses to use at all. */
  excluded: Array<{ candidate: T; reason: string }>;
}

/**
 * Tier candidates by policy without ever reordering within a tier by anything
 * but the caller's existing order — scoring stays with the controller.
 */
export function orderByPolicy<T extends PolicyCandidateMeta>(candidates: T[], policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): PolicyOrdering<T> {
  const preferred: PolicyOrdering<T>["candidates"] = [];
  const fallback: PolicyOrdering<T>["candidates"] = [];
  const excluded: PolicyOrdering<T>["excluded"] = [];

  for (const candidate of candidates) {
    const decision = policyDecision(candidate, policy);
    if (policy.mode === "strict" && !decision.preferred) {
      excluded.push({ candidate, reason: decision.reason ?? "Excluded by the strict routing policy." });
      continue;
    }
    (decision.preferred ? preferred : fallback).push({ candidate, preferred: decision.preferred, reason: decision.reason });
  }
  return { candidates: [...preferred, ...fallback], excluded };
}
