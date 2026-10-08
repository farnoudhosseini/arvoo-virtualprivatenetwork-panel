/**
 * Arvoo network controller engine.
 *
 * Pure, deterministic decision logic for the parts of the control plane that
 * choose where traffic goes: transport profiles, per-path health, path scoring,
 * client placement and failover planning.
 *
 * Design rules encoded here (each one is a requirement, not a preference):
 *  - Every decision is deterministic. Given the same inputs the engine returns
 *    the same answer, so an operator can always explain and reproduce it. There
 *    is no random selection anywhere in this module.
 *  - Selection is score-based, never "pick a random server": weighted latency,
 *    loss, jitter, capacity and health, with the weights configurable.
 *  - A client keeps ONE ingress and ONE active egress. Traffic is never spread
 *    packet-by-packet across egress nodes; load balancing happens at session
 *    level, which is why placement returns a single pair.
 *  - A healthy sticky assignment is not moved. The only reasons to move an
 *    existing client are health, admin state, or capability loss.
 *  - Nothing is promised that networking cannot deliver. GRE is labelled as
 *    encapsulation with no security, throughput that was never measured is
 *    reported as unknown rather than guessed, and no profile claims to defeat
 *    any specific blocking technique.
 */

import { computeMtu, type MtuLayer, type MtuLayerKind } from "./mtu";

// ---------------------------------------------------------------------------
// Admin lifecycle (spec: mesh / node / tunnel Enable-Disable-Drain-...)
// ---------------------------------------------------------------------------

/**
 * Administrative lifecycle shared by nodes and tunnels.
 *  - `enabled`: normal operation, eligible for new placements.
 *  - `disabled`: administratively taken out of the data path; not eligible.
 *  - `drained`: no NEW sessions are placed here, existing sessions keep working
 *    until they end on their own (or are moved by an explicit failover).
 */
export type AdminState = "enabled" | "disabled" | "drained";

export function isAdminEligible(state: AdminState): boolean {
  return state === "enabled";
}

/**
 * SPEC ITEM: "Foreign Node down / Iran Node down" — the controller must not
 * keep placing new sessions on a node that is administratively draining.
 */
export function adminStateReason(name: string, state: AdminState): string | null {
  if (state === "enabled") return null;
  if (state === "drained") return `${name} is draining: existing sessions continue, new sessions are placed elsewhere.`;
  return `${name} is administratively disabled.`;
}

// ---------------------------------------------------------------------------
// Transport profiles
// ---------------------------------------------------------------------------

export type TransportKind = "openvpn-udp" | "openvpn-tcp" | "gre" | "gre-fou" | "gre-ipsec";

/** Capabilities a profile needs before it may be offered at all. */
export type RequiredCapability = "gre" | "fou" | "ipsec";

export interface TransportProfile {
  kind: TransportKind;
  /** Short human label used in the panel. */
  label: string;
  /** Layer-4 transport actually used on the wire. */
  transport: "udp" | "tcp" | "ip-protocol-47";
  /** Default port; null when the transport has no port (raw GRE). */
  defaultPort: number | null;
  /**
   * Honest security label. `none` means no confidentiality: GRE alone is
   * encapsulation, not encryption.
   */
  security: "none" | "encrypted";
  /** Extra encapsulation bytes this profile adds for MTU math. */
  mtuLayers: MtuLayerKind[];
  /** Capabilities the two peering nodes must both report. */
  requires: RequiredCapability[];
  /** Where this profile makes sense; a hint, never a promise. */
  intent: "performance" | "udp-encapsulated" | "protected";
  notes: string[];
}

const PROFILES: Record<TransportKind, TransportProfile> = {
  "openvpn-udp": {
    kind: "openvpn-udp",
    label: "OpenVPN UDP",
    transport: "udp",
    defaultPort: 1194,
    security: "encrypted",
    mtuLayers: ["openvpn-udp", "tls-crypt"],
    requires: [],
    intent: "performance",
    notes: [
      "Preferred OpenVPN transport: no head-of-line blocking, lowest overhead.",
      "UDP reachability depends on the path; it is not guaranteed on every network.",
    ],
  },
  "openvpn-tcp": {
    kind: "openvpn-tcp",
    label: "OpenVPN TCP",
    transport: "tcp",
    defaultPort: 443,
    security: "encrypted",
    mtuLayers: ["openvpn-tcp", "tls-crypt"],
    requires: [],
    intent: "performance",
    notes: [
      "Fallback when UDP does not traverse the path. Costs an extra TCP header and can suffer head-of-line blocking.",
    ],
  },
  gre: {
    kind: "gre",
    label: "GRE",
    transport: "ip-protocol-47",
    defaultPort: null,
    security: "none",
    mtuLayers: ["ip4", "gre", "gre-key"],
    requires: ["gre"],
    intent: "performance",
    notes: [
      "GRE encapsulates: it provides no confidentiality or authentication. Use it on paths you already trust.",
      "Raw GRE is IP protocol 47; some paths drop it.",
    ],
  },
  "gre-fou": {
    kind: "gre-fou",
    label: "GRE over FOU",
    transport: "udp",
    defaultPort: 5555,
    security: "none",
    mtuLayers: ["ip4", "fou-udp", "gre", "gre-key"],
    requires: ["gre", "fou"],
    intent: "udp-encapsulated",
    notes: [
      "Wraps GRE in UDP so the path sees a UDP flow. Still no encryption.",
      "Needs the fou kernel module and a free UDP port on both nodes; GRO is disabled on the tunnel device to protect throughput.",
    ],
  },
  "gre-ipsec": {
    kind: "gre-ipsec",
    label: "GRE over IPsec",
    transport: "ip-protocol-47",
    defaultPort: null,
    security: "encrypted",
    mtuLayers: ["ip4", "gre", "gre-key", "ipsec-esp"],
    requires: ["gre", "ipsec"],
    intent: "protected",
    notes: [
      "Transport-mode IPsec (IKEv2/ESP) protects the GRE traffic between the two public endpoints.",
      "Adds ESP overhead and key-management state; only offered when both nodes report a working IPsec stack.",
    ],
  },
};

/** Every implemented profile. Protocols that are not implemented are absent. */
export function transportProfiles(): TransportProfile[] {
  return Object.values(PROFILES);
}

export function transportProfile(kind: TransportKind): TransportProfile {
  return PROFILES[kind];
}

/** The profile that describes an existing tunnel's encapsulation stack. */
export function profileForTunnel(tunnel: { fouPort: number | null; ipsecEnabled: boolean }): TransportProfile {
  if (tunnel.ipsecEnabled) return PROFILES["gre-ipsec"];
  if (tunnel.fouPort != null) return PROFILES["gre-fou"];
  return PROFILES.gre;
}

/** Which of the profiles the given node capabilities actually allow. */
export function supportedProfiles(caps: {
  gre?: boolean | null;
  fou?: boolean | null;
  ipsec?: { available?: boolean } | null;
}): TransportProfile[] {
  return transportProfiles().filter((profile) =>
    profile.requires.every((req) => {
      if (req === "gre") return caps.gre !== false;
      if (req === "fou") return caps.fou === true;
      return caps.ipsec?.available === true;
    }),
  );
}

/** Recommended MTU/MSS for a profile on a path with the given MTU. */
export function profileMtu(profile: TransportProfile, pathMtu: number, safetyMargin = 0) {
  return computeMtu({
    pathMtu,
    layers: profile.mtuLayers.map((kind) => ({ kind }) as MtuLayer),
    safetyMargin,
  });
}

// ---------------------------------------------------------------------------
// Path health (spec: UP / DEGRADED / DOWN per tunnel, with counters)
// ---------------------------------------------------------------------------

export type PathStateName = "up" | "degraded" | "down";

export interface PathMetrics {
  /** Median RTT in milliseconds across the measured samples. */
  latencyMs: number | null;
  /** Packet loss percentage (0-100). */
  lossPct: number | null;
  /** Mean deviation between samples, in milliseconds. */
  jitterMs: number | null;
  /** Received throughput in Mbit/s; null when it was never measured. */
  throughputMbps: number | null;
  /** Number of probes behind these numbers. */
  samples: number;
}

export interface HealthThresholds {
  /** Loss at or above this marks a path degraded. */
  degradedLossPct: number;
  /** Loss at or above this marks a path down. */
  downLossPct: number;
  /** Median latency at or above this marks a path degraded. */
  degradedLatencyMs: number;
  /** Median latency at or above this marks a path down. */
  downLatencyMs: number;
  /** Jitter at or above this marks a path degraded. */
  degradedJitterMs: number;
  /** A measurement older than this is stale and cannot support "up". */
  staleAfterSec: number;
  /** Consecutive failed checks that force a path down regardless of metrics. */
  downAfterConsecutiveFailures: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  degradedLossPct: 2,
  downLossPct: 20,
  degradedLatencyMs: 250,
  downLatencyMs: 800,
  degradedJitterMs: 60,
  staleAfterSec: 900,
  downAfterConsecutiveFailures: 3,
};

export interface HealthAssessment {
  state: PathStateName;
  /** Human-readable reasons, in the order they were evaluated. */
  reasons: string[];
  /** True when the newest measurement is older than staleAfterSec. */
  stale: boolean;
}

/**
 * Classify one path from its newest measurement.
 *
 * A path is never reported `up` on stale data: when the last measurement is
 * older than `staleAfterSec` the result is at best `degraded`. A path with no
 * measurement at all is `down` with an explicit "never measured" reason, so the
 * panel can never show a green tunnel that was never probed.
 */
export function assessPathHealth(
  metrics: PathMetrics | null,
  measuredAt: string | null,
  now: Date,
  thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
  consecutiveFailures = 0,
): HealthAssessment {
  const reasons: string[] = [];

  if (consecutiveFailures >= thresholds.downAfterConsecutiveFailures) {
    return {
      state: "down",
      reasons: [`${consecutiveFailures} consecutive health checks failed (threshold ${thresholds.downAfterConsecutiveFailures}).`],
      stale: false,
    };
  }

  if (!metrics || (!measuredAt && metrics.samples === 0)) {
    return { state: "down", reasons: ["No path measurement has been recorded yet."], stale: false };
  }

  const ageSec = measuredAt ? (now.getTime() - new Date(measuredAt).getTime()) / 1000 : Number.POSITIVE_INFINITY;
  const stale = ageSec > thresholds.staleAfterSec;
  if (stale) {
    reasons.push(
      `Last measurement is ${Math.round(ageSec)}s old (stale after ${thresholds.staleAfterSec}s), so the path cannot be reported healthy.`,
    );
  }

  if (metrics.lossPct != null && metrics.lossPct >= thresholds.downLossPct) {
    reasons.push(`Packet loss ${metrics.lossPct}% is above the down threshold ${thresholds.downLossPct}%.`);
    return { state: "down", reasons, stale };
  }

  let degraded = stale;

  if (metrics.latencyMs != null && metrics.latencyMs >= thresholds.downLatencyMs) {
    reasons.push(`Median latency ${metrics.latencyMs}ms is above the down threshold ${thresholds.downLatencyMs}ms.`);
    return { state: "down", reasons, stale };
  }

  if (metrics.lossPct != null && metrics.lossPct >= thresholds.degradedLossPct) {
    degraded = true;
    reasons.push(`Packet loss ${metrics.lossPct}% is above the degraded threshold ${thresholds.degradedLossPct}%.`);
  }
  if (metrics.latencyMs != null && metrics.latencyMs >= thresholds.degradedLatencyMs) {
    degraded = true;
    reasons.push(`Median latency ${metrics.latencyMs}ms is above the degraded threshold ${thresholds.degradedLatencyMs}ms.`);
  }
  if (metrics.jitterMs != null && metrics.jitterMs >= thresholds.degradedJitterMs) {
    degraded = true;
    reasons.push(`Jitter ${metrics.jitterMs}ms is above the degraded threshold ${thresholds.degradedJitterMs}ms.`);
  }
  if (consecutiveFailures > 0) {
    degraded = true;
    reasons.push(`${consecutiveFailures} consecutive health check(s) failed.`);
  }

  if (degraded) {
    if (reasons.length === 0) reasons.push("Path is marked degraded by policy.");
    return { state: "degraded", reasons, stale };
  }

  reasons.push(
    `Latency ${metrics.latencyMs ?? "n/a"}ms, loss ${metrics.lossPct ?? "n/a"}%, jitter ${metrics.jitterMs ?? "n/a"}ms within thresholds.`,
  );
  return { state: "up", reasons, stale };
}

// ---------------------------------------------------------------------------
// Scoring (spec: score = latency + loss + capacity + health, weighted)
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  latency: number;
  loss: number;
  /** How much measured throughput matters. */
  capacity: number;
  /** How much current health state matters. */
  health: number;
  /** How much jitter matters (0 disables it). */
  jitter: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  latency: 0.35,
  loss: 0.25,
  capacity: 0.2,
  health: 0.15,
  jitter: 0.05,
};

export interface ScoreComponents {
  latency: number | null;
  loss: number | null;
  capacity: number | null;
  health: number | null;
  jitter: number | null;
}

export interface PathScore {
  /** 0-100, higher is better. Deterministic for identical input. */
  score: number;
  components: ScoreComponents;
  /** Which components actually contributed (missing ones are excluded). */
  weightsUsed: Partial<ScoringWeights>;
  reasons: string[];
}

export interface ScoreInput {
  pathId: string;
  metrics: PathMetrics | null;
  state: PathStateName;
  stale: boolean;
  /** Sessions currently committed to this egress. */
  sessions: number;
  /** Session capacity of the egress node; null = unknown (excluded, not guessed). */
  capacitySessions: number | null;
  /** Throughput that counts as a full score, in Mbit/s. */
  referenceThroughputMbps?: number;
  /** Latency that would score zero, in milliseconds. */
  referenceLatencyMs?: number;
  consecutiveFailures?: number;
}

export const REFERENCE_THROUGHPUT_MBPS = 500;
export const REFERENCE_LATENCY_MS = 300;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/**
 * Score one candidate path.
 *
 * Components that could not be measured are left out and the remaining weights
 * are renormalised, so a path with no throughput measurement is compared on the
 * numbers that do exist instead of being handed an invented one. The reasons
 * list always explains which components were used and why.
 */
export function scorePath(input: ScoreInput, weights: ScoringWeights = DEFAULT_WEIGHTS): PathScore {
  const reasons: string[] = [];
  const components: ScoreComponents = { latency: null, loss: null, capacity: null, health: null, jitter: null };

  // --- health -------------------------------------------------------------
  const failurePenalty = clamp((input.consecutiveFailures ?? 0) * 10, 0, 30);
  const base = input.state === "up" ? 100 : input.state === "degraded" ? 55 : 0;
  components.health = clamp(base - failurePenalty, 0, 100);
  reasons.push(
    `Health ${input.state}${input.stale ? " (stale measurement)" : ""}` +
      (failurePenalty > 0 ? ` with a -${failurePenalty} penalty for failed checks` : "") +
      `: ${components.health}/100`,
  );

  // --- latency ------------------------------------------------------------
  const referenceLatency = input.referenceLatencyMs ?? REFERENCE_LATENCY_MS;
  if (input.metrics?.latencyMs != null) {
    components.latency = round(clamp(100 * (1 - input.metrics.latencyMs / referenceLatency), 0, 100));
    reasons.push(`Latency ${input.metrics.latencyMs}ms vs ${referenceLatency}ms reference: ${components.latency}/100`);
  } else {
    reasons.push("Latency not measured: excluded from the score.");
  }

  // --- loss ---------------------------------------------------------------
  if (input.metrics?.lossPct != null) {
    components.loss = round(clamp(100 - input.metrics.lossPct * 10, 0, 100));
    reasons.push(`Packet loss ${input.metrics.lossPct}%: ${components.loss}/100`);
  } else {
    reasons.push("Packet loss not measured: excluded from the score.");
  }

  // --- jitter -------------------------------------------------------------
  if (input.metrics?.jitterMs != null) {
    components.jitter = round(clamp(100 - input.metrics.jitterMs * 2, 0, 100));
    reasons.push(`Jitter ${input.metrics.jitterMs}ms: ${components.jitter}/100`);
  }

  // --- capacity -----------------------------------------------------------
  // Capacity has two halves: measured throughput, and how full the egress node
  // already is. A saturated node scores 0 here without needing a measurement.
  const reference = input.referenceThroughputMbps ?? REFERENCE_THROUGHPUT_MBPS;
  const headroom =
    input.capacitySessions != null && input.capacitySessions > 0
      ? clamp(1 - input.sessions / input.capacitySessions, 0, 1)
      : null;
  if (input.metrics?.throughputMbps != null) {
    const throughputScore = clamp(100 * (input.metrics.throughputMbps / reference), 0, 100);
    // Headroom only pulls the component down, never up.
    components.capacity = round(headroom == null ? throughputScore : throughputScore * headroom);
    reasons.push(
      `Throughput ${input.metrics.throughputMbps}Mbps vs ${reference}Mbps reference` +
        (headroom == null
          ? `: ${components.capacity}/100 (session capacity unknown)`
          : ` with ${Math.round(headroom * 100)}% session headroom: ${components.capacity}/100`),
    );
  } else if (headroom != null) {
    components.capacity = round(100 * headroom);
    reasons.push(
      `Throughput not measured; capacity scored on session headroom only (${input.sessions}/${input.capacitySessions} sessions): ${components.capacity}/100`,
    );
  } else {
    reasons.push("Neither throughput nor session capacity is known: the capacity component is excluded.");
  }

  // --- weighted total -----------------------------------------------------
  const weightOf: Record<keyof ScoreComponents, number> = {
    latency: weights.latency,
    loss: weights.loss,
    capacity: weights.capacity,
    health: weights.health,
    jitter: weights.jitter,
  };

  let weighted = 0;
  let totalWeight = 0;
  const weightsUsed: Partial<ScoringWeights> = {};
  for (const key of Object.keys(components) as Array<keyof ScoreComponents>) {
    const value = components[key];
    const weight = weightOf[key];
    if (value == null || weight <= 0) continue;
    weighted += value * weight;
    totalWeight += weight;
    weightsUsed[key] = weight;
  }

  const score = totalWeight > 0 ? round(weighted / totalWeight) : 0;
  reasons.push(`Weighted score ${score}/100 from ${Object.keys(weightsUsed).join(", ") || "no measurable component"}.`);

  return { score, components, weightsUsed, reasons };
}

// ---------------------------------------------------------------------------
// Ranking / path selection
// ---------------------------------------------------------------------------

export interface PathCandidate {
  /** Stable, unique identity of the path (a tunnel id). */
  pathId: string;
  /** Human label, e.g. "ir-1 → de-4 (GRE)". */
  label: string;
  ingressNodeId: string;
  egressNodeId: string;
  state: PathStateName;
  stale: boolean;
  metrics: PathMetrics | null;
  adminState: AdminState;
  /** Whether the encapsulation of this path is still available on both nodes. */
  capability: { available: boolean; reason: string | null };
  /** Sessions committed to this egress node. */
  sessions: number;
  /** null = unknown capacity; the capacity component is then excluded. */
  capacitySessions: number | null;
  consecutiveFailures: number;
  /**
   * Administrative weight, 100 = neutral. 0 removes the path from service
   * without touching it; lower weights reduce both rank and share.
   */
  weight?: number;
  /**
   * Caller-declared selectability for new sessions (health admission). The
   * sticky check for an existing assignment honours the same flag.
   */
  selectable?: boolean;
  /** Why the candidate is not selectable; shown instead of inventing a reason. */
  ineligibleReason?: string | null;
  /** Failure-domain keys (node ids, provider, country, transport) for diversity. */
  failureDomains?: string[];
}

export interface RankedPath {
  path: PathCandidate;
  /** Score after the administrative weight is applied. */
  score: number;
  /** Weight factor applied to the base score (1 = neutral). */
  weightFactor: number;
  reasons: string[];
}

export interface SelectionResult {
  selected: RankedPath | null;
  ranked: RankedPath[];
  /** Every candidate that was not eligible, with the reason why. */
  excluded: Array<{ pathId: string; reason: string }>;
}

export interface SelectionOptions {
  weights?: ScoringWeights;
  referenceThroughputMbps?: number;
  referenceLatencyMs?: number;
  /** Allow degraded paths to be selected (used for last-resort failover). */
  allowDegraded?: boolean;
  /** Exclude these path ids (e.g. the path that just failed). */
  excludePathIds?: string[];
  /**
   * Hold-down for new sessions: when this path is still eligible and the best
   * candidate does not beat it by more than `minSwitchDelta`, it stays
   * selected. This is what stops a one-point score difference from rotating
   * new sessions between near-equal paths.
   */
  previousPathId?: string | null;
  /** Score advantage a challenger needs before it takes over (default 5). */
  minSwitchDelta?: number;
  /** Spread new sessions across failure domains among near-equal candidates. */
  diversity?: boolean;
  /** Current session load per failure-domain key (node id, provider, country…). */
  domainLoad?: Record<string, number>;
  /** Score window that counts as near-equal for diversity (default 3). */
  diversityWindow?: number;
}

function ineligibilityReason(path: PathCandidate, opts: SelectionOptions): string | null {
  const admin = adminStateReason(path.label, path.adminState);
  if (admin) return admin;
  if (path.selectable === false) {
    return path.ineligibleReason ?? "The path is not selectable for new sessions right now.";
  }
  if (path.weight != null && path.weight <= 0) {
    return `Administratively weighted out of service (weight ${path.weight}).`;
  }
  if (!path.capability.available) {
    return `Encapsulation unavailable: ${path.capability.reason ?? "node capability missing"}`;
  }
  if (path.state === "down") return "Path is down.";
  if (path.state === "degraded" && !opts.allowDegraded) return "Path is degraded; only used as a last resort.";
  if (path.stale && !opts.allowDegraded) return "Health data is stale; the path cannot be trusted for new sessions.";
  if (path.capacitySessions != null && path.capacitySessions > 0 && path.sessions >= path.capacitySessions) {
    return `Egress node is at capacity (${path.sessions}/${path.capacitySessions} sessions).`;
  }
  if (opts.excludePathIds?.includes(path.pathId)) return "Excluded from this selection.";
  return null;
}

/** Sum of the current session load over a candidate's failure domains. */
function domainLoadOf(path: PathCandidate, domainLoad: Record<string, number> | undefined): number {
  if (!domainLoad || !path.failureDomains?.length) return 0;
  return path.failureDomains.reduce((sum, domain) => sum + (domainLoad[domain] ?? 0), 0);
}

/**
 * Rank candidate paths by score. Ties break deterministically: better latency
 * first, then path id, so the same inputs always produce the same order.
 */
export function rankPaths(candidates: PathCandidate[], opts: SelectionOptions = {}): SelectionResult {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const ranked: RankedPath[] = [];
  const excluded: Array<{ pathId: string; reason: string }> = [];

  for (const path of candidates) {
    const reason = ineligibilityReason(path, opts);
    if (reason) {
      excluded.push({ pathId: path.pathId, reason });
      continue;
    }
    const scored = scorePath(
      {
        pathId: path.pathId,
        metrics: path.metrics,
        state: path.state,
        stale: path.stale,
        sessions: path.sessions,
        capacitySessions: path.capacitySessions,
        referenceThroughputMbps: opts.referenceThroughputMbps,
        referenceLatencyMs: opts.referenceLatencyMs,
        consecutiveFailures: path.consecutiveFailures,
      },
      weights,
    );
    const weightFactor = path.weight == null ? 1 : clamp(path.weight / 100, 0, 1);
    const effective = round(scored.score * weightFactor);
    ranked.push({
      path,
      score: effective,
      weightFactor,
      reasons: [
        weightFactor === 1
          ? `${path.label}: score ${effective}`
          : `${path.label}: score ${effective} (base ${scored.score}, administrative weight ${path.weight})`,
        ...scored.reasons,
      ],
    });
  }

  ranked.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    const la = a.path.metrics?.latencyMs ?? Number.POSITIVE_INFINITY;
    const lb = b.path.metrics?.latencyMs ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.path.pathId < b.path.pathId ? -1 : a.path.pathId > b.path.pathId ? 1 : 0;
  });

  // --- hold-down: near-equal challengers do not take over new sessions -------
  let heldDown = false;
  const minSwitchDelta = opts.minSwitchDelta ?? 5;
  if (opts.previousPathId) {
    const best = ranked[0];
    const previousIndex = ranked.findIndex((r) => r.path.pathId === opts.previousPathId);
    if (best && previousIndex > 0) {
      const previous = ranked[previousIndex]!;
      if (best.score - previous.score <= minSwitchDelta) {
        ranked.splice(previousIndex, 1);
        previous.reasons.unshift(
          `Hold-down: the current selection is still eligible and within ${minSwitchDelta} points of the best candidate (${previous.score} vs ${best.score}); new sessions stay on ${previous.path.label}.`,
        );
        ranked.unshift(previous);
        heldDown = true;
      }
    }
  }

  // --- failure-domain diversity among near-equal candidates (spec §20) -------
  const diversityWindow = opts.diversityWindow ?? 3;
  const domainLoad = opts.domainLoad;
  if (!heldDown && opts.diversity && domainLoad && ranked.length > 1) {
    const top = ranked[0]!;
    const withinWindow = ranked.filter((r) => top.score - r.score <= diversityWindow);
    if (withinWindow.length > 1) {
      const chosen = withinWindow.reduce((best, candidate) =>
        domainLoadOf(candidate.path, domainLoad) < domainLoadOf(best.path, domainLoad) ? candidate : best,
      );
      if (chosen !== top) {
        ranked.splice(ranked.indexOf(chosen), 1);
        chosen.reasons.unshift(
          `Diversity: ${chosen.path.label} is within ${diversityWindow} points of the best candidate and its failure domains hold fewer sessions (${domainLoadOf(chosen.path, domainLoad)} vs ${domainLoadOf(top.path, domainLoad)}).`,
        );
        ranked.unshift(chosen);
      }
    }
  }

  return { selected: ranked[0] ?? null, ranked, excluded };
}

/** Best path for a single ingress node. */
export function selectBestPath(
  candidates: PathCandidate[],
  ingressNodeId: string,
  opts: SelectionOptions = {},
): SelectionResult {
  return rankPaths(
    candidates.filter((c) => c.ingressNodeId === ingressNodeId),
    opts,
  );
}

// ---------------------------------------------------------------------------
// Placement: one client → one ingress → one active egress, sticky
// ---------------------------------------------------------------------------

export interface IngressCandidate {
  nodeId: string;
  label: string;
  adminState: AdminState;
  /** Node liveness as reported by heartbeats. */
  status: "pending" | "online" | "offline" | "degraded" | "maintenance" | "error" | "unknown";
  /** Sessions already placed on this ingress. */
  sessions: number;
  /** null = unknown capacity; it is excluded from scoring, never guessed. */
  capacitySessions: number | null;
}

export interface StickyAssignment {
  ingressNodeId: string;
  egressNodeId: string;
  /** Path id from the decision that created the assignment, when persisted. */
  pathId?: string | null;
}

export interface PlacementInput {
  ingress: IngressCandidate[];
  /** Every candidate egress path, each knowing which ingress node it starts from. */
  paths: PathCandidate[];
  /** The client's current assignment, if it already has one. */
  current: StickyAssignment | null;
  /** Prefer a specific ingress when the client has no assignment yet. */
  preferIngressNodeId?: string | null;
  opts?: SelectionOptions;
}

export interface PlacementDecision {
  action: "create" | "keep" | "move" | "reject";
  ingressNodeId: string | null;
  egressNodeId: string | null;
  /** Why this decision was made, in evaluation order. */
  reasons: string[];
  ranked: RankedPath[];
  excluded: Array<{ pathId: string; reason: string }>;
  /** True when the only remaining option was degraded — the caller should alert. */
  degradedOnly: boolean;
}

function ingressEligibility(node: IngressCandidate, allowDegraded: boolean): string | null {
  const admin = adminStateReason(node.label, node.adminState);
  if (admin) return admin;
  if (node.status === "online") return null;
  const blocking = node.status === "degraded" && allowDegraded;
  if (blocking) return null;
  return `${node.label} is ${node.status}, so new sessions are not placed there.`;
}

/**
 * Decide where one client session belongs.
 *
 * Sticky first: if the client already has an assignment whose ingress and
 * egress are both still eligible, that assignment is kept and nothing else is
 * even considered. Only when it is no longer eligible does the engine pick a
 * replacement, and it reports the reason. This is what keeps TCP sessions, NAT
 * state and accounting stable — connections are never re-homed while healthy.
 */
export function placeSession(input: PlacementInput): PlacementDecision {
  const opts = input.opts ?? {};
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const allowDegraded = opts.allowDegraded ?? false;

  const ingressReasons = new Map<string, string>();
  const eligibleIngress = new Set<string>();
  for (const node of input.ingress) {
    const reason = ingressEligibility(node, allowDegraded);
    if (reason) {
      ingressReasons.set(node.nodeId, reason);
      continue;
    }
    if (node.capacitySessions != null && node.capacitySessions > 0 && node.sessions >= node.capacitySessions) {
      ingressReasons.set(node.nodeId, `${node.label} is at capacity (${node.sessions}/${node.capacitySessions} sessions).`);
      continue;
    }
    eligibleIngress.add(node.nodeId);
  }

  const pathsOnEligibleIngress = input.paths.filter((p) => eligibleIngress.has(p.ingressNodeId));
  const selection = rankPaths(pathsOnEligibleIngress, { ...opts, allowDegraded });

  const rejected: Array<{ pathId: string; reason: string }> = [
    ...input.paths
      .filter((p) => !eligibleIngress.has(p.ingressNodeId))
      .map((p) => ({ pathId: p.pathId, reason: ingressReasons.get(p.ingressNodeId) ?? "Ingress node is not eligible." })),
    ...selection.excluded,
  ];

  // --- sticky path: keep a healthy existing assignment ----------------------
  if (input.current) {
    const sameIngress = input.ingress.find((n) => n.nodeId === input.current!.ingressNodeId);
    const sameIngressProblem = sameIngress
      ? ingressEligibility(sameIngress, allowDegraded)
      : "The ingress node of the current assignment no longer exists.";
    if (sameIngressProblem) {
      // fall through to re-placement below
    } else {
      const currentPath = input.paths.find(
        (p) => p.pathId === input.current!.pathId ||
          (p.ingressNodeId === input.current!.ingressNodeId && p.egressNodeId === input.current!.egressNodeId),
      );
      if (!currentPath) {
        // fall through: the path itself is gone
      } else {
        const problem = ineligibilityReason(currentPath, opts);
        if (!problem) {
          const scored = scorePath(
            {
              pathId: currentPath.pathId,
              metrics: currentPath.metrics,
              state: currentPath.state,
              stale: currentPath.stale,
              sessions: currentPath.sessions,
              capacitySessions: currentPath.capacitySessions,
              referenceThroughputMbps: opts.referenceThroughputMbps,
              referenceLatencyMs: opts.referenceLatencyMs,
              consecutiveFailures: currentPath.consecutiveFailures,
            },
            weights,
          );
          return {
            action: "keep",
            ingressNodeId: currentPath.ingressNodeId,
            egressNodeId: currentPath.egressNodeId,
            reasons: [
              `Keeping the existing sticky assignment ${currentPath.label} while it is healthy (score ${scored.score}); sessions are not moved without a health or admin reason.`,
              ...scored.reasons,
            ],
            ranked: selection.ranked,
            excluded: rejected,
            degradedOnly: currentPath.state !== "up" || currentPath.stale,
          };
        }
        // Existing path became unusable: re-place and record why.
        const replacement = selection.selected;
        if (!replacement) {
          return {
            action: "reject",
            ingressNodeId: null,
            egressNodeId: null,
            reasons: [
              `Current assignment ${currentPath.label} is no longer usable: ${problem}`,
              "No eligible replacement path is available right now.",
            ],
            ranked: [],
            excluded: rejected,
            degradedOnly: false,
          };
        }
        return {
          action: "move",
          ingressNodeId: replacement.path.ingressNodeId,
          egressNodeId: replacement.path.egressNodeId,
          reasons: [
            `Current assignment ${currentPath.label} is no longer usable: ${problem}`,
            `Replacing it with ${replacement.path.label} (score ${replacement.score}).`,
            ...replacement.reasons,
          ],
          ranked: selection.ranked,
          excluded: rejected,
          degradedOnly: replacement.path.state !== "up" || replacement.path.stale,
        };
      }
    }
  }

  // --- new placement -------------------------------------------------------
  let preferred = selection.ranked;
  if (input.preferIngressNodeId) {
    const onPreferred = selection.ranked.filter((r) => r.path.ingressNodeId === input.preferIngressNodeId);
    if (onPreferred.length > 0) preferred = onPreferred;
  }

  const best = preferred[0] ?? selection.selected;
  if (!best) {
    const reasons = ["No eligible egress path is available."];
    if (input.ingress.length === 0) reasons.push("No ingress nodes are configured for this pool.");
    for (const [nodeId, reason] of ingressReasons) reasons.push(`Ingress ${nodeId}: ${reason}`);
    for (const ex of selection.excluded) reasons.push(`Path ${ex.pathId}: ${ex.reason}`);
    return { action: "reject", ingressNodeId: null, egressNodeId: null, reasons, ranked: [], excluded: rejected, degradedOnly: false };
  }

  const action = input.current ? "move" : "create";
  const reasons = input.current
    ? [`Previous assignment is no longer available; placing a new one.`]
    : [`Placing a new session on the best available path: ${best.path.label} (score ${best.score}).`];
  if (input.preferIngressNodeId && best.path.ingressNodeId === input.preferIngressNodeId) {
    reasons.push(`Preferred ingress ${input.preferIngressNodeId} was chosen: it has an eligible path.`);
  }
  reasons.push(...best.reasons);

  return {
    action,
    ingressNodeId: best.path.ingressNodeId,
    egressNodeId: best.path.egressNodeId,
    reasons,
    ranked: selection.ranked,
    excluded: rejected,
    degradedOnly: best.path.state !== "up" || best.path.stale,
  };
}

// ---------------------------------------------------------------------------
// Failover planning (spec: health failure → drain → replacement → apply → verify)
// ---------------------------------------------------------------------------

export interface FailoverPlan {
  action: "keep" | "switch" | "none-available";
  from: { ingressNodeId: string; egressNodeId: string } | null;
  to: { ingressNodeId: string; egressNodeId: string; pathId: string; label: string; score: number } | null;
  /** Ordered steps the caller must carry out for an actual switch. */
  steps: string[];
  reasons: string[];
}

/**
 * Plan the failover for one assignment.
 *
 * This function only plans: it never claims a path is up. The caller applies
 * the plan and then verifies the new path before reporting success, which is
 * why the returned steps end with a verification step.
 */
export function planFailover(
  current: StickyAssignment | null,
  paths: PathCandidate[],
  opts: SelectionOptions = {},
): FailoverPlan {
  if (!current) {
    const selection = rankPaths(paths, opts);
    if (!selection.selected) {
      return {
        action: "none-available",
        from: null,
        to: null,
        steps: [],
        reasons: ["No assignment to fail over and no eligible path is available."],
      };
    }
    const best = selection.selected;
    return {
      action: "switch",
      from: null,
      to: {
        ingressNodeId: best.path.ingressNodeId,
        egressNodeId: best.path.egressNodeId,
        pathId: best.path.pathId,
        label: best.path.label,
        score: best.score,
      },
      steps: placementSteps(best.path, null),
      reasons: ["No existing assignment; selecting the best available path.", ...best.reasons],
    };
  }

  const currentPath = paths.find(
    (p) => p.ingressNodeId === current.ingressNodeId && p.egressNodeId === current.egressNodeId,
  );

  if (currentPath) {
    const problem = ineligibilityReason(currentPath, opts);
    if (!problem) {
      return {
        action: "keep",
        from: current,
        to: null,
        steps: [],
        reasons: [`Current path ${currentPath.label} is still eligible: no failover needed.`],
      };
    }
  }

  const selection = rankPaths(
    paths.filter((p) => !(p.ingressNodeId === current.ingressNodeId && p.egressNodeId === current.egressNodeId)),
    opts,
  );

  const reasons = [
    currentPath
      ? `Current path is unusable: ${ineligibilityReason(currentPath, opts) ?? "unknown"}`
      : `Current path (${current.ingressNodeId} → ${current.egressNodeId}) is no longer present in the topology.`,
  ];

  if (!selection.selected) {
    return {
      action: "none-available",
      from: current,
      to: null,
      steps: [
        "Drain the failing assignment: stop placing new sessions on it.",
        "Alert: no eligible replacement path exists — the client will lose service until a path recovers.",
      ],
      reasons,
    };
  }

  const best = selection.selected;
  reasons.push(`Replacement: ${best.path.label} (score ${best.score}).`, ...best.reasons);

  return {
    action: "switch",
    from: current,
    to: {
      ingressNodeId: best.path.ingressNodeId,
      egressNodeId: best.path.egressNodeId,
      pathId: best.path.pathId,
      label: best.path.label,
      score: best.score,
    },
    steps: placementSteps(best.path, current),
    reasons,
  };
}

/**
 * The ordered actions an actual failover performs. Deliberately explicit: drain,
 * select, apply the route, then VERIFY before anything is reported as healthy.
 */
function placementSteps(path: PathCandidate, from: StickyAssignment | null): string[] {
  return [
    from
      ? `Drain the existing assignment (${from.ingressNodeId} → ${from.egressNodeId}) so no new session lands on it.`
      : "No previous assignment to drain.",
    `Select ${path.label} as the active egress.`,
    `Apply the egress route on ${path.ingressNodeId} toward ${path.egressNodeId}.`,
    "Verify the new path with a real measurement before reporting the failover as complete.",
  ];
}

// ---------------------------------------------------------------------------
// Network plan (spec: Validate → Plan → show diff → Apply → Verify)
// ---------------------------------------------------------------------------

export type PlanResource = "gre" | "ipsec" | "route" | "firewall" | "openvpn" | "address";
export type PlanAction = "create" | "update" | "noop" | "remove";

export interface PlanStep {
  resource: PlanResource;
  /** Stable identity, owned by Arvoo: e.g. `arvoo:tunnel:<uuid>`, `arvoo:route:<uuid>`. */
  id: string;
  action: PlanAction;
  nodeId: string | null;
  summary: string;
  /** Risk class drives the confirmation prompt before Apply. */
  risk: "none" | "service-affecting" | "management-affecting" | "destructive";
  /** Human explanation of the risk, shown in the diff. */
  riskReason: string | null;
}

export interface NetworkPlan {
  createdAt: string;
  steps: PlanStep[];
  summary: Record<PlanAction, number>;
  /** Steps that could not be planned because something is missing. */
  blocked: Array<{ id: string; reason: string }>;
  /** True when applying this plan needs an explicit confirmation. */
  requiresConfirmation: boolean;
  warnings: string[];
}

/**
 * A step is dangerous when it can cut the path an operator manages the node
 * through, or when it removes state that cannot be recreated from the plan.
 */
export function classifyRisk(step: Omit<PlanStep, "risk" | "riskReason">): { risk: PlanStep["risk"]; riskReason: string | null } {
  if (step.action === "remove") {
    return {
      risk: step.resource === "openvpn" || step.resource === "gre" ? "destructive" : "service-affecting",
      riskReason: `Removing ${step.resource} ${step.id} interrupts any traffic currently using it.`,
    };
  }
  if (step.action === "create" || step.action === "update") {
    if (step.resource === "firewall") {
      // A mis-ordered firewall change is the classic way to lock yourself out.
      return {
        risk: "management-affecting",
        riskReason: "Firewall changes can interrupt SSH, DNS and the agent's control connection.",
      };
    }
    if (step.resource === "route") {
      return {
        risk: "management-affecting",
        riskReason: "Route changes can move management traffic; Arvoo keeps management traffic on its own rules and never flushes the main table.",
      };
    }
    if (step.resource === "ipsec") {
      return {
        risk: "service-affecting",
        riskReason: "Bringing up IPsec re-keys the tunnel; traffic over it is interrupted for the duration of the exchange.",
      };
    }
    if (step.resource === "openvpn") {
      return {
        risk: "service-affecting",
        riskReason: "Restarting an OpenVPN inbound disconnects its currently connected clients.",
      };
    }
    if (step.resource === "address") {
      return {
        risk: "service-affecting",
        riskReason: "Changing tunnel addressing requires the peer to change at the same time.",
      };
    }
  }
  return { risk: "none", riskReason: null };
}

export function buildNetworkPlan(
  steps: Array<Omit<PlanStep, "risk" | "riskReason">>,
  blocked: Array<{ id: string; reason: string }> = [],
  warnings: string[] = [],
  now: Date = new Date(),
): NetworkPlan {
  const planned: PlanStep[] = steps.map((step) => ({ ...step, ...classifyRisk(step) }));
  const summary: Record<PlanAction, number> = { create: 0, update: 0, noop: 0, remove: 0 };
  for (const step of planned) summary[step.action]++;

  return {
    createdAt: now.toISOString(),
    steps: planned,
    summary,
    blocked,
    requiresConfirmation: planned.some((s) => s.risk !== "none") || blocked.length > 0,
    warnings,
  };
}

export interface TunnelDesiredState {
  /** `arvoo:tunnel:<id>` */
  id: string;
  tunnelId: string;
  interfaceName: string;
  nodeId: string;
  nodeName: string;
  mtu: number;
  fouPort: number | null;
  ipsecEnabled: boolean;
  /** Set when the last observed state differs from this one. */
  observed: {
    interfacePresent: boolean | null;
    mtu: number | null;
    fouPort: number | null;
    ipsecPresent: boolean | null;
  } | null;
}

/**
 * Diff desired tunnel state against what the agent observed.
 *
 * A missing observation is reported as an update (the node must be asked to
 * apply the configuration), never as "already correct".
 */
export function diffTunnelState(tunnel: TunnelDesiredState): Omit<PlanStep, "risk" | "riskReason"> {
  const observed = tunnel.observed;
  if (!observed || observed.interfacePresent !== true) {
    return {
      resource: "gre",
      id: tunnel.id,
      action: "create",
      nodeId: tunnel.nodeId,
      summary: `Create GRE interface ${tunnel.interfaceName} on ${tunnel.nodeName} (MTU ${tunnel.mtu}${
        tunnel.fouPort ? `, FOU ${tunnel.fouPort}` : ""
      }${tunnel.ipsecEnabled ? ", over IPsec" : ""}).`,
    };
  }
  const drift: string[] = [];
  if (observed.mtu !== null && observed.mtu !== tunnel.mtu) drift.push(`MTU ${observed.mtu} → ${tunnel.mtu}`);
  if ((observed.fouPort ?? null) !== tunnel.fouPort) drift.push(`FOU ${observed.fouPort ?? "none"} → ${tunnel.fouPort ?? "none"}`);
  if (tunnel.ipsecEnabled && observed.ipsecPresent !== true) drift.push("IPsec missing → apply");

  if (drift.length === 0) {
    return {
      resource: "gre",
      id: tunnel.id,
      action: "noop",
      nodeId: tunnel.nodeId,
      summary: `${tunnel.interfaceName} on ${tunnel.nodeName} already matches the desired state.`,
    };
  }
  return {
    resource: "gre",
    id: tunnel.id,
    action: "update",
    nodeId: tunnel.nodeId,
    summary: `Update ${tunnel.interfaceName} on ${tunnel.nodeName}: ${drift.join(", ")}.`,
  };
}

/** Risk labels for the confirmation dialog, in the panel's words. */
export const RISK_LABEL: Record<PlanStep["risk"], string> = {
  none: "Safe",
  "service-affecting": "Service affecting",
  "management-affecting": "Management affecting",
  destructive: "Destructive",
};
