import { describe, expect, it } from "vitest";
import type { PathMetrics } from "./controller";
import {
  DEFAULT_NODE_WEIGHTS,
  DEFAULT_ROUTING_POLICY,
  healthAdmission,
  nextHealthState,
  observationFromHistory,
  orderByPolicy,
  pathStateFromHealth,
  policyDecision,
  scoreNode,
  type HealthSample,
  type HealthState,
  type HealthStateRecord,
  type PolicyCandidateMeta,
} from "./routing";

const now = new Date("2026-10-08T12:00:00.000Z");
const iso = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();

const metrics = (over: Partial<PathMetrics> = {}): PathMetrics => ({
  latencyMs: 20,
  lossPct: 0.1,
  jitterMs: 2,
  throughputMbps: null,
  samples: 20,
  ...over,
});

const record = (state: HealthState, heldSec: number): HealthStateRecord => ({ state, since: iso(heldSec) });

describe("health state machine", () => {
  it("never reports a path healthy before it was measured", () => {
    const t = nextHealthState(null, { metrics: null, measuredAt: null }, now);
    expect(t.state).toBe("down");
    expect(t.reasons.join(" ")).toMatch(/never/i);
  });

  it("starts healthy from a first clean measurement", () => {
    const t = nextHealthState(null, { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 1 }, now);
    expect(t.state).toBe("healthy");
    expect(t.changed).toBe(true);
  });

  it("degrades and fails on soft metric growth, without probe failures", () => {
    const degraded = nextHealthState(
      record("healthy", 300),
      { metrics: metrics({ lossPct: 3 }), measuredAt: iso(0), consecutiveSuccesses: 3 },
      now,
    );
    expect(degraded.state).toBe("degraded");
    expect(degraded.hardFailure).toBe(false);
    expect(degraded.softDegradation).toBe(true);

    const failing = nextHealthState(
      record("degraded", 300),
      { metrics: metrics({ latencyMs: 600 }), measuredAt: iso(0), consecutiveSuccesses: 3 },
      now,
    );
    expect(failing.state).toBe("failing");
    expect(failing.hardFailure).toBe(false);
  });

  it("takes a path down after the configured consecutive failures, even with good old metrics", () => {
    const t = nextHealthState(
      record("healthy", 300),
      { metrics: metrics(), measuredAt: iso(0), consecutiveFailures: 3, consecutiveSuccesses: 0 },
      now,
    );
    expect(t.state).toBe("down");
    expect(t.hardFailure).toBe(true);
  });

  it("marks down immediately on an explicit hard failure", () => {
    const t = nextHealthState(record("healthy", 1), { metrics: null, measuredAt: iso(1), hardFailure: true }, now);
    expect(t.state).toBe("down");
    expect(t.changed).toBe(true);
  });

  it("cannot stay healthy on stale data and blocks improvement", () => {
    const t = nextHealthState(
      record("healthy", 2000),
      { metrics: metrics(), measuredAt: iso(1200), consecutiveSuccesses: 5 },
      now,
    );
    expect(t.state).toBe("failing");
    expect(t.softDegradation).toBe(true);
    expect(t.reasons.join(" ")).toMatch(/stale/i);
  });

  it("recovers gradually: down → recovering requires successes and the hold-down", () => {
    const held = nextHealthState(
      record("down", 10),
      { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 5 },
      now,
    );
    expect(held.state).toBe("down");
    expect(held.reasons.join(" ")).toMatch(/hold-down/i);

    const t = nextHealthState(
      record("down", 300),
      { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 2 },
      now,
    );
    expect(t.state).toBe("recovering");
    expect(t.since).toBe(now.toISOString());
  });

  it("never improves two steps in one evaluation", () => {
    const t = nextHealthState(
      record("down", 300),
      { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 10 },
      now,
    );
    expect(t.state).toBe("recovering");
  });

  it("recovers to healthy only after the full success streak", () => {
    const almost = nextHealthState(
      record("recovering", 300),
      { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 3 },
      now,
    );
    expect(almost.state).toBe("recovering");

    const done = nextHealthState(
      record("recovering", 300),
      { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 5 },
      now,
    );
    expect(done.state).toBe("healthy");
  });

  it("drops a recovering path back to failing when it fails again", () => {
    const t = nextHealthState(
      record("recovering", 300),
      { metrics: metrics({ latencyMs: 700 }), measuredAt: iso(0), consecutiveSuccesses: 2 },
      now,
    );
    expect(t.state).toBe("failing");
  });

  it("improves failing one step to degraded after the hold-down", () => {
    const t = nextHealthState(
      record("failing", 300),
      { metrics: metrics({ lossPct: 3 }), measuredAt: iso(0), consecutiveSuccesses: 3 },
      now,
    );
    expect(t.state).toBe("degraded");
  });

  it("needs a fully clean measurement to leave degraded", () => {
    const still = nextHealthState(
      record("degraded", 300),
      { metrics: metrics({ lossPct: 3 }), measuredAt: iso(0), consecutiveSuccesses: 3 },
      now,
    );
    expect(still.state).toBe("degraded");

    const t = nextHealthState(
      record("degraded", 300),
      { metrics: metrics(), measuredAt: iso(0), consecutiveSuccesses: 3 },
      now,
    );
    expect(t.state).toBe("healthy");
  });

  it("keeps the previous state when no new measurement arrived", () => {
    const t = nextHealthState(record("degraded", 30), { metrics: null, measuredAt: iso(30) }, now);
    expect(t.state).toBe("degraded");
    expect(t.changed).toBe(false);
    expect(t.since).toBe(iso(30));
  });

  it("is deterministic for identical input", () => {
    const args = [record("healthy", 300), { metrics: metrics({ latencyMs: 260 }), measuredAt: iso(0), consecutiveSuccesses: 2 }, now] as const;
    expect(nextHealthState(...args)).toEqual(nextHealthState(...args));
  });
});

describe("observation from stored history", () => {
  const history: HealthSample[] = [
    { at: iso(30), metrics: null, ok: false },
    { at: iso(60), metrics: null, ok: false },
    { at: iso(90), metrics: metrics({ latencyMs: 30 }), ok: true },
    { at: iso(120), metrics: metrics({ latencyMs: 40 }), ok: true },
  ];

  it("counts trailing failures and keeps the newest real measurement", () => {
    const obs = observationFromHistory(history);
    expect(obs.consecutiveFailures).toBe(2);
    expect(obs.consecutiveSuccesses).toBe(0);
    expect(obs.metrics?.latencyMs).toBe(30);
    expect(obs.measuredAt).toBe(iso(90));
  });

  it("counts trailing successes and sorts unordered samples", () => {
    const successes: HealthSample[] = [
      { at: iso(30), metrics: null, ok: false },
      { at: iso(10), metrics: metrics({ latencyMs: 12 }), ok: true },
      { at: iso(20), metrics: metrics({ latencyMs: 15 }), ok: true },
    ];
    const obs = observationFromHistory(successes);
    expect(obs.consecutiveSuccesses).toBe(2);
    expect(obs.consecutiveFailures).toBe(0);
    expect(obs.measuredAt).toBe(iso(10));
    expect(observationFromHistory([...successes].reverse())).toEqual(obs);
  });

  it("reports nothing measured for an empty history", () => {
    expect(observationFromHistory([])).toEqual({
      metrics: null,
      measuredAt: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    });
  });
});

describe("health admission", () => {
  it("maps each state to selectability and weight", () => {
    expect(healthAdmission("healthy")).toMatchObject({ selectable: true, weightMultiplier: 1 });
    expect(healthAdmission("degraded")).toMatchObject({ selectable: true, weightMultiplier: 0.5 });
    expect(healthAdmission("recovering")).toMatchObject({ selectable: false, weightMultiplier: 0.25 });
    expect(healthAdmission("failing")).toMatchObject({ selectable: false, weightMultiplier: 0.1 });
    expect(healthAdmission("down")).toMatchObject({ selectable: false, weightMultiplier: 0 });
  });

  it("maps onto the controller's eligibility vocabulary", () => {
    expect(pathStateFromHealth("healthy")).toBe("up");
    expect(pathStateFromHealth("down")).toBe("down");
    expect(pathStateFromHealth("degraded")).toBe("degraded");
    expect(pathStateFromHealth("failing")).toBe("degraded");
    expect(pathStateFromHealth("recovering")).toBe("degraded");
  });
});

describe("node scoring", () => {
  const base = {
    metrics: {
      cpuUsagePct: null,
      memoryUsagePct: null,
      diskUsagePct: null,
      loadAvg1: null,
      cpuCores: null,
      bandwidthUtilizationPct: null,
      latencyMs: null,
      lossPct: null,
      jitterMs: null,
      connectionSuccessPct: null,
    },
    sessions: 0,
    capacitySessions: null,
    health: null,
  };

  it("is deterministic and renormalises around unmeasured components", () => {
    const input = { ...base, metrics: { ...base.metrics, connectionSuccessPct: 80 } };
    const scored = scoreNode(input);
    expect(scored.score).toBe(80);
    expect(Object.keys(scored.weightsUsed)).toEqual(["success"]);
    expect(scoreNode(input)).toEqual(scored);
  });

  it("scores capacity from session headroom and never guesses an unknown one", () => {
    const half = scoreNode({ ...base, sessions: 50, capacitySessions: 100 });
    expect(half.components.capacity).toBe(50);

    const full = scoreNode({ ...base, sessions: 100, capacitySessions: 100 });
    expect(full.components.capacity).toBe(0);

    const unknown = scoreNode({ ...base, sessions: 10, capacitySessions: null });
    expect(unknown.components.capacity).toBeNull();
    expect(Object.keys(unknown.weightsUsed)).not.toContain("capacity");
  });

  it("takes the worst resource pressure, including load per core", () => {
    const disk = scoreNode({ ...base, metrics: { ...base.metrics, diskUsagePct: 80 } });
    expect(disk.components.resources).toBe(20);

    const load = scoreNode({ ...base, metrics: { ...base.metrics, loadAvg1: 4, cpuCores: 8 } });
    expect(load.components.resources).toBe(50);
  });

  it("derives stability from the health state and failure streak", () => {
    const t = scoreNode({ ...base, health: "degraded", consecutiveFailures: 2 });
    expect(t.components.stability).toBe(40);
    const down = scoreNode({ ...base, health: "down" });
    expect(down.components.stability).toBe(0);
  });

  it("ships defaults that sum to one", () => {
    const total = Object.values(DEFAULT_NODE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("failover policy", () => {
  const meta = (over: Partial<PolicyCandidateMeta> = {}): PolicyCandidateMeta => ({
    nodeIds: ["n1", "n2"],
    countries: ["Germany", "Iran"],
    regionClasses: ["international", "iran"],
    transport: "gre",
    ...over,
  });

  it("auto mode never prefers or excludes", () => {
    const decision = policyDecision(meta(), DEFAULT_ROUTING_POLICY);
    expect(decision).toMatchObject({ preferred: false, reason: null });
    const ordered = orderByPolicy([meta(), meta()]);
    expect(ordered.excluded).toHaveLength(0);
    expect(ordered.candidates.every((c) => !c.preferred)).toBe(true);
  });

  it("preferred-node tiers preferred candidates first", () => {
    const preferred = meta({ nodeIds: ["n9"] });
    const fallback = meta();
    const ordered = orderByPolicy([fallback, preferred], { mode: "preferred-node", preferredNodeIds: ["n9"] });
    expect(ordered.candidates[0]!.candidate).toBe(preferred);
    expect(ordered.candidates[0]!.preferred).toBe(true);
    expect(ordered.candidates[1]!.reason).toMatch(/fallback/i);
  });

  it("preferred-region matches country case-insensitively and by region class", () => {
    expect(policyDecision(meta(), { mode: "preferred-region", preferredCountries: ["germany"] }).preferred).toBe(true);
    expect(policyDecision(meta({ countries: [null] }), { mode: "preferred-region", preferredRegionClasses: ["iran"] }).preferred).toBe(true);
    expect(policyDecision(meta({ countries: [null], regionClasses: [null] }), { mode: "preferred-region", preferredCountries: ["france"] }).preferred).toBe(false);
  });

  it("preferred-transport matches the encapsulation kind", () => {
    expect(policyDecision(meta({ transport: "gre-ipsec" }), { mode: "preferred-transport", preferredTransports: ["gre-ipsec"] }).preferred).toBe(true);
    expect(policyDecision(meta({ transport: "gre" }), { mode: "preferred-transport", preferredTransports: ["gre-fou"] }).preferred).toBe(false);
  });

  it("strict mode excludes candidates outside the preference instead of falling back", () => {
    const matching = meta({ nodeIds: ["n9"] });
    const other = meta();
    const ordered = orderByPolicy([other, matching], { mode: "strict", preferredNodeIds: ["n9"] });
    expect(ordered.candidates.map((c) => c.candidate)).toEqual([matching]);
    expect(ordered.excluded).toHaveLength(1);
    expect(ordered.excluded[0]!.reason).toMatch(/strict/i);
  });
});
