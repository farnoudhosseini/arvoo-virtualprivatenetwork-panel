/**
 * Load balancing: member eligibility, weighted selection and share maths.
 *
 * Kept pure and dependency-free so the control plane, the CLI and the tests all
 * agree on what "healthy member" means. The caller supplies state measured from
 * real probes/sessions; this module never invents a number.
 */

import type { LbMode } from "./types";

export interface LbCandidate {
  id: string;
  /** Relative weight (0-1000). Weight 0 removes the member from rotation. */
  weight: number;
  /** Administrative toggle. */
  enabled: boolean;
  /** Administrative drain: no new sessions, existing ones stay. */
  drained: boolean;
  /** Measured health (from real probes/telemetry). */
  healthy: boolean;
  /** Failover order: lower number wins. */
  priority: number;
  /** Current load used by the least-load mode (active sessions). */
  load?: number;
}

export interface LbSelection {
  member: LbCandidate | null;
  /** True when no fully healthy member was available and a degraded one was used. */
  degraded: boolean;
  reason: string;
}

/** Members that may take new sessions when everything is healthy. */
export function eligibleMembers(members: LbCandidate[]): LbCandidate[] {
  return members.filter((m) => m.enabled && !m.drained && m.healthy && m.weight > 0);
}

/** Members that are administratively usable but not measured healthy. */
export function degradedMembers(members: LbCandidate[]): LbCandidate[] {
  return members.filter((m) => m.enabled && !m.drained && !m.healthy && m.weight > 0);
}

function pickWeighted(pool: LbCandidate[], random: () => number): LbCandidate {
  const total = pool.reduce((sum, m) => sum + m.weight, 0);
  if (total <= 0) return pool[0]!;
  let roll = random() * total;
  for (const member of pool) {
    roll -= member.weight;
    if (roll < 0) return member;
  }
  return pool[pool.length - 1]!;
}

function pickFailover(pool: LbCandidate[]): LbCandidate {
  return [...pool].sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : b.weight - a.weight))[0]!;
}

function pickLeastLoad(pool: LbCandidate[]): LbCandidate {
  return [...pool].sort((a, b) => {
    const la = a.load ?? 0;
    const lb = b.load ?? 0;
    if (la !== lb) return la - lb;
    return b.weight - a.weight;
  })[0]!;
}

/**
 * Choose the member that should take the next session.
 *
 * Health is authoritative: a member that is not measured healthy is only used
 * when nothing healthy is left, and the caller is told that it did so.
 */
export function chooseMember(
  members: LbCandidate[],
  mode: LbMode,
  random: () => number = Math.random,
): LbSelection {
  const primary = eligibleMembers(members);
  const pool = primary.length > 0 ? primary : degradedMembers(members);
  const degraded = primary.length === 0 && pool.length > 0;
  if (pool.length === 0) {
    const reason =
      members.length === 0
        ? "The group has no members."
        : "No member can take new sessions (all disabled or drained).";
    return { member: null, degraded: false, reason };
  }

  const member =
    mode === "failover" ? pickFailover(pool) : mode === "least-load" ? pickLeastLoad(pool) : pickWeighted(pool, random);
  return {
    member,
    degraded,
    reason: degraded
      ? `Every healthy member is unavailable; routing to unhealthy member "${member.id}".`
      : `Selected by ${mode} policy.`,
  };
}

/**
 * The share of new sessions each member receives, as a real percentage of the
 * eligible weight. Members that cannot take sessions get 0.
 */
export function weightShares(members: LbCandidate[], mode: LbMode): Record<string, number> {
  const pool = eligibleMembers(members);
  const shares: Record<string, number> = {};
  for (const member of members) shares[member.id] = 0;
  if (pool.length === 0) return shares;
  if (mode === "failover") {
    const winner = pickFailover(pool);
    shares[winner.id] = 100;
    return shares;
  }
  if (mode === "least-load") {
    // Least-load does not divide traffic proportionally to weight; the display
    // says "not weighted" instead of inventing percentages.
    for (const member of pool) shares[member.id] = 0;
    return shares;
  }
  const total = pool.reduce((sum, m) => sum + m.weight, 0);
  for (const member of pool) {
    shares[member.id] = total > 0 ? Math.round((member.weight / total) * 1000) / 10 : 0;
  }
  return shares;
}

/** Health thresholds applied to measured samples. */
export interface LbHealthThresholds {
  minSuccessRatePct: number | null;
  maxLatencyMs: number | null;
  maxLossPct: number | null;
  requireNodeOnline: boolean;
}

export interface LbHealthSample {
  nodeOnline: boolean;
  /** Successful probes / total probes over the window; null when never probed. */
  successRatePct: number | null;
  latencyMs: number | null;
  lossPct: number | null;
  /** Administrative or deployment state that makes the member unusable. */
  inboundStatus?: string | null;
}

/**
 * Decide whether a member is healthy, and *why not* when it is not - the panel
 * shows these reasons verbatim instead of a colour without an explanation.
 */
export function evaluateLbHealth(
  sample: LbHealthSample,
  thresholds: LbHealthThresholds,
): { healthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (thresholds.requireNodeOnline && !sample.nodeOnline) reasons.push("Node is not reporting (offline or no heartbeat)");
  if (sample.inboundStatus === "error") reasons.push("Last deployment failed");
  if (sample.inboundStatus === "draft") reasons.push("Inbound has never been deployed");
  if (sample.inboundStatus === "stopped") reasons.push("Inbound service is stopped");

  if (sample.successRatePct == null && sample.latencyMs == null) {
    reasons.push("No health probe has run for this member yet");
  } else {
    if (thresholds.minSuccessRatePct != null && sample.successRatePct != null && sample.successRatePct < thresholds.minSuccessRatePct) {
      reasons.push(`Probe success rate ${sample.successRatePct}% is below the required ${thresholds.minSuccessRatePct}%`);
    }
    if (thresholds.maxLatencyMs != null && sample.latencyMs != null && sample.latencyMs > thresholds.maxLatencyMs) {
      reasons.push(`Average latency ${Math.round(sample.latencyMs)} ms exceeds the limit of ${thresholds.maxLatencyMs} ms`);
    }
    if (thresholds.maxLossPct != null && sample.lossPct != null && sample.lossPct > thresholds.maxLossPct) {
      reasons.push(`Packet loss ${sample.lossPct}% exceeds the limit of ${thresholds.maxLossPct}%`);
    }
  }
  return { healthy: reasons.length === 0, reasons };
}
