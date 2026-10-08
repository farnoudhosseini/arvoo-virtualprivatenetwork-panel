import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS,
  assessPathHealth,
  buildNetworkPlan,
  classifyRisk,
  diffTunnelState,
  isAdminEligible,
  adminStateReason,
  placeSession,
  planFailover,
  profileForTunnel,
  profileMtu,
  rankPaths,
  scorePath,
  supportedProfiles,
  transportProfile,
  transportProfiles,
  type PathCandidate,
  type PathMetrics,
  type ScoringWeights,
} from "./controller";

const METRICS: PathMetrics = { latencyMs: 20, lossPct: 0.1, jitterMs: 2, throughputMbps: 400, samples: 10 };

/** A healthy candidate path; every field can be overridden per test. */
function candidate(over: Partial<PathCandidate> = {}): PathCandidate {
  return {
    pathId: "t-1",
    label: "ir-1 → de-1 (GRE)",
    ingressNodeId: "node-a",
    egressNodeId: "node-b",
    state: "up",
    stale: false,
    metrics: METRICS,
    adminState: "enabled",
    capability: { available: true, reason: null },
    sessions: 1,
    capacitySessions: 100,
    consecutiveFailures: 0,
    ...over,
  };
}

const MINIMAL_WEIGHTS: ScoringWeights = { latency: 1, loss: 0, capacity: 0, health: 0, jitter: 0 };

describe("admin lifecycle", () => {
  it("only enabled is eligible for new sessions", () => {
    expect(isAdminEligible("enabled")).toBe(true);
    expect(isAdminEligible("disabled")).toBe(false);
    expect(isAdminEligible("drained")).toBe(false);
    expect(adminStateReason("ir-1", "enabled")).toBeNull();
  });

  it("draining keeps existing sessions but refuses new ones, and says so", () => {
    const reason = adminStateReason("ir-1", "drained");
    expect(reason).toContain("draining");
    expect(reason).toContain("existing sessions continue");
  });
});

describe("transport profiles", () => {
  it("every implemented profile is labelled honestly about security", () => {
    const gre = transportProfile("gre");
    expect(gre.security).toBe("none");
    expect(gre.transport).toBe("ip-protocol-47");
    expect(gre.defaultPort).toBeNull();
    expect(gre.notes.join(" ")).toMatch(/no confidentiality/i);

    const fou = transportProfile("gre-fou");
    expect(fou.security).toBe("none");
    expect(fou.transport).toBe("udp");
    expect(fou.requires).toContain("fou");

    expect(transportProfile("gre-ipsec").security).toBe("encrypted");
    expect(transportProfile("openvpn-udp").security).toBe("encrypted");
    expect(transportProfiles()).toHaveLength(5);
  });

  it("describes an existing tunnel from its encapsulation fields", () => {
    expect(profileForTunnel({ fouPort: null, ipsecEnabled: false }).kind).toBe("gre");
    expect(profileForTunnel({ fouPort: 5555, ipsecEnabled: false }).kind).toBe("gre-fou");
    expect(profileForTunnel({ fouPort: 5555, ipsecEnabled: true }).kind).toBe("gre-ipsec");
  });

  it("only offers profiles both nodes' capabilities allow", () => {
    const kinds = (caps: Parameters<typeof supportedProfiles>[0]) =>
      supportedProfiles(caps).map((p) => p.kind);

    // OpenVPN is always available; GRE alone needs no probe to be trusted.
    expect(kinds({ gre: true, fou: false, ipsec: { available: false } })).toEqual([
      "openvpn-udp",
      "openvpn-tcp",
      "gre",
    ]);
    // FOU and IPsec are opt-in: reported false unless the node proved them.
    expect(kinds({ gre: true, fou: null, ipsec: null })).toEqual(["openvpn-udp", "openvpn-tcp", "gre"]);
    expect(kinds({ gre: null, fou: true, ipsec: { available: true } })).toHaveLength(5);
    // No GRE capability removes every GRE-based profile.
    expect(kinds({ gre: false, fou: true, ipsec: { available: true } })).toEqual(["openvpn-udp", "openvpn-tcp"]);
  });

  it("derives MTU from the real encapsulation stack", () => {
    expect(profileMtu(transportProfile("openvpn-udp"), 1500).mtu).toBe(1500 - 52 - 20);
    expect(profileMtu(transportProfile("openvpn-tcp"), 1500).mtu).toBe(1500 - 72 - 20);
    // Raw GRE: IPv4 + GRE header + the conservative 4-byte key field.
    expect(profileMtu(transportProfile("gre"), 1500).mtu).toBe(1500 - 20 - 24 - 4);
    expect(profileMtu(transportProfile("gre-fou"), 1500).mtu).toBe(1500 - 20 - 8 - 24 - 4);
    expect(profileMtu(transportProfile("gre-ipsec"), 1500).mtu).toBe(1500 - 20 - 24 - 4 - 56);
  });
});

describe("path health", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");

  it("never reports a path up without a measurement", () => {
    const health = assessPathHealth(null, null, now);
    expect(health.state).toBe("down");
    expect(health.reasons.join(" ")).toMatch(/never|no path measurement/i);
    expect(health.stale).toBe(false);
  });

  it("classifies healthy, degraded and down samples by thresholds", () => {
    expect(assessPathHealth(METRICS, now.toISOString(), now).state).toBe("up");

    const lossy = assessPathHealth({ ...METRICS, lossPct: 5 }, now.toISOString(), now);
    expect(lossy.state).toBe("degraded");
    expect(lossy.reasons.join(" ")).toContain("degraded threshold");

    const dead = assessPathHealth({ ...METRICS, lossPct: 30 }, now.toISOString(), now);
    expect(dead.state).toBe("down");

    expect(assessPathHealth({ ...METRICS, latencyMs: 900 }, now.toISOString(), now).state).toBe("down");
    expect(assessPathHealth({ ...METRICS, jitterMs: 80 }, now.toISOString(), now).state).toBe("degraded");
  });

  it("refuses to call stale data healthy even when the numbers look good", () => {
    const old = new Date(now.getTime() - 16 * 60 * 1000).toISOString();
    const health = assessPathHealth(METRICS, old, now);
    expect(health.stale).toBe(true);
    expect(health.state).toBe("degraded");
    expect(health.reasons.join(" ")).toMatch(/stale/i);
  });

  it("forces a path down after the configured consecutive failures", () => {
    const health = assessPathHealth(METRICS, now.toISOString(), now, undefined, 3);
    expect(health.state).toBe("down");
    expect(health.reasons.join(" ")).toContain("3 consecutive");
  });
});

describe("path scoring", () => {
  it("is deterministic for identical input", () => {
    const input = {
      pathId: "t-1",
      metrics: METRICS,
      state: "up" as const,
      stale: false,
      sessions: 1,
      capacitySessions: 100,
    };
    expect(scorePath(input)).toEqual(scorePath(input));
  });

  it("excludes unmeasured components and renormalises the weights", () => {
    const scored = scorePath({
      pathId: "t-1",
      metrics: null,
      state: "up",
      stale: false,
      sessions: 1,
      capacitySessions: 100,
    });
    expect(Object.keys(scored.weightsUsed).sort()).toEqual(["capacity", "health"]);
    // capacity = 100 * (1 - 1/100) = 99, health = 100
    expect(scored.score).toBe(99.4);
  });

  it("rewards lower latency and penalises a saturated egress", () => {
    const base = { pathId: "t-1", state: "up" as const, stale: false, capacitySessions: 100, sessions: 0 };
    const fast = scorePath({ ...base, metrics: { ...METRICS, latencyMs: 10 } }, MINIMAL_WEIGHTS);
    const slow = scorePath({ ...base, metrics: { ...METRICS, latencyMs: 200 } }, MINIMAL_WEIGHTS);
    expect(fast.score).toBeGreaterThan(slow.score);

    const loaded = scorePath({ ...base, sessions: 100, metrics: METRICS });
    expect(loaded.components.capacity).toBe(0);
  });
});

describe("path ranking", () => {
  it("excludes every ineligible path with a reason", () => {
    const result = rankPaths([
      candidate({ pathId: "down", state: "down" }),
      candidate({ pathId: "drained", adminState: "drained" }),
      candidate({ pathId: "no-cap", capability: { available: false, reason: "ipsec missing" } }),
      candidate({ pathId: "full", sessions: 100, capacitySessions: 100 }),
      candidate({ pathId: "stale", stale: true }),
      candidate({ pathId: "ok" }),
    ]);
    expect(result.selected?.path.pathId).toBe("ok");
    const excluded = Object.fromEntries(result.excluded.map((e) => [e.pathId, e.reason]));
    expect(excluded.down).toBe("Path is down.");
    expect(excluded.drained).toMatch(/draining/);
    expect(excluded["no-cap"]).toMatch(/ipsec missing/);
    expect(excluded.full).toMatch(/capacity/);
    expect(excluded.stale).toMatch(/stale/i);
  });

  it("orders deterministically: score, then latency, then path id", () => {
    const a = candidate({ pathId: "b", metrics: { ...METRICS, latencyMs: 30 } });
    const b = candidate({ pathId: "a", metrics: { ...METRICS, latencyMs: 30 } });
    const c = candidate({ pathId: "z", metrics: { ...METRICS, latencyMs: 5 } });

    const forward = rankPaths([a, b, c]).ranked.map((r) => r.path.pathId);
    const shuffled = rankPaths([c, a, b]).ranked.map((r) => r.path.pathId);
    expect(forward).toEqual(["z", "a", "b"]);
    expect(shuffled).toEqual(forward);
  });

  it("allows degraded paths when the caller explicitly accepts them", () => {
    const paths = [candidate({ state: "degraded" })];
    expect(rankPaths(paths).selected).toBeNull();
    expect(rankPaths(paths, { allowDegraded: true }).selected?.path.pathId).toBe("t-1");
  });
});

describe("session placement", () => {
  const ingress = [
    { nodeId: "node-a", label: "ir-1", adminState: "enabled" as const, status: "online" as const, sessions: 1, capacitySessions: 100 },
    { nodeId: "node-c", label: "ir-2", adminState: "enabled" as const, status: "online" as const, sessions: 0, capacitySessions: 100 },
  ];

  it("places a new client on the best path", () => {
    const decision = placeSession({
      ingress,
      paths: [candidate({ pathId: "slow", metrics: { ...METRICS, latencyMs: 200 } }), candidate({ pathId: "fast", metrics: { ...METRICS, latencyMs: 5 } })],
      current: null,
    });
    expect(decision.action).toBe("create");
    expect(decision.egressNodeId).toBe("node-b");
    expect(decision.ranked[0]!.path.pathId).toBe("fast");
  });

  it("keeps a healthy sticky assignment even when another path scores higher", () => {
    const current = { ingressNodeId: "node-a", egressNodeId: "node-b", pathId: "t-1" };
    const better = candidate({
      pathId: "t-9",
      label: "ir-2 → de-9",
      ingressNodeId: "node-c",
      egressNodeId: "node-d",
      metrics: { ...METRICS, latencyMs: 1, throughputMbps: 500 },
    });
    const decision = placeSession({ ingress, paths: [candidate(), better], current });
    expect(decision.action).toBe("keep");
    expect(decision.egressNodeId).toBe("node-b");
    expect(decision.reasons.join(" ")).toMatch(/sticky/i);
  });

  it("moves a client off a path that became unusable and explains why", () => {
    const current = { ingressNodeId: "node-a", egressNodeId: "node-b", pathId: "t-1" };
    const decision = placeSession({
      ingress,
      paths: [
        candidate({ pathId: "t-1", state: "down" }),
        candidate({ pathId: "t-2", label: "ir-2 → de-2", ingressNodeId: "node-c", egressNodeId: "node-d" }),
      ],
      current,
    });
    expect(decision.action).toBe("move");
    expect(decision.ingressNodeId).toBe("node-c");
    expect(decision.egressNodeId).toBe("node-d");
    expect(decision.reasons.join(" ")).toMatch(/no longer usable/i);
  });

  it("moves a client off an ingress that is draining", () => {
    const current = { ingressNodeId: "node-a", egressNodeId: "node-b", pathId: "t-1" };
    const decision = placeSession({
      ingress: [{ ...ingress[0]!, adminState: "drained" }, ingress[1]!],
      paths: [candidate(), candidate({ pathId: "t-2", label: "ir-2 → de-2", ingressNodeId: "node-c", egressNodeId: "node-d" })],
      current,
    });
    expect(decision.action).toBe("move");
    expect(decision.ingressNodeId).toBe("node-c");
  });

  it("rejects when no eligible path exists, listing the reasons", () => {
    const decision = placeSession({ ingress: [], paths: [candidate({ state: "down" })], current: null });
    expect(decision.action).toBe("reject");
    expect(decision.ingressNodeId).toBeNull();
    expect(decision.reasons.join(" ")).toMatch(/no eligible egress path/i);
    expect(decision.reasons.join(" ")).toMatch(/no ingress nodes/i);
  });

  it("honours a preferred ingress when it has an eligible path", () => {
    const decision = placeSession({
      ingress,
      paths: [
        candidate({ pathId: "best", label: "ir-1 → de-b", ingressNodeId: "node-a", egressNodeId: "node-b" }),
        candidate({ pathId: "worse", label: "ir-2 → de-w", ingressNodeId: "node-c", egressNodeId: "node-d", metrics: { ...METRICS, latencyMs: 300 } }),
      ],
      current: null,
      preferIngressNodeId: "node-c",
    });
    expect(decision.ingressNodeId).toBe("node-c");
    expect(decision.reasons.join(" ")).toMatch(/preferred ingress/i);
  });

  it("flags a degraded-only fallback so the caller can alert", () => {
    const decision = placeSession({
      ingress,
      paths: [candidate({ state: "degraded" })],
      current: null,
      opts: { allowDegraded: true },
    });
    expect(decision.action).toBe("create");
    expect(decision.degradedOnly).toBe(true);
  });
});

describe("failover planning", () => {
  it("does nothing while the current path is eligible", () => {
    const plan = planFailover({ ingressNodeId: "node-a", egressNodeId: "node-b" }, [candidate()]);
    expect(plan.action).toBe("keep");
    expect(plan.steps).toHaveLength(0);
  });

  it("plans drain → select → apply → verify when the current path fails", () => {
    const plan = planFailover(
      { ingressNodeId: "node-a", egressNodeId: "node-b" },
      [
        candidate({ pathId: "t-1", state: "down" }),
        candidate({ pathId: "t-2", label: "ir-2 → de-2", ingressNodeId: "node-c", egressNodeId: "node-d" }),
      ],
    );
    expect(plan.action).toBe("switch");
    expect(plan.to?.pathId).toBe("t-2");
    expect(plan.steps.join(" ")).toMatch(/drain/i);
    expect(plan.steps.join(" ")).toMatch(/apply the egress route/i);
    expect(plan.steps.at(-1)).toMatch(/verify/i);
  });

  it("reports none-available with an alert instead of inventing a path", () => {
    const plan = planFailover(
      { ingressNodeId: "node-a", egressNodeId: "node-b" },
      [candidate({ pathId: "t-1", state: "down" })],
    );
    expect(plan.action).toBe("none-available");
    expect(plan.to).toBeNull();
    expect(plan.steps.join(" ")).toMatch(/alert/i);
  });
});

describe("network plan", () => {
  it("classifies risk by what the step can break", () => {
    const step = (over: Partial<Parameters<typeof classifyRisk>[0]>) => ({
      resource: "gre" as const,
      id: "arvoo:tunnel:1",
      action: "create" as const,
      nodeId: "node-a",
      summary: "…",
      ...over,
    });
    expect(classifyRisk(step({ action: "remove", resource: "gre" })).risk).toBe("destructive");
    expect(classifyRisk(step({ action: "remove", resource: "openvpn" })).risk).toBe("destructive");
    expect(classifyRisk(step({ action: "remove", resource: "route" })).risk).toBe("service-affecting");
    expect(classifyRisk(step({ resource: "firewall" })).risk).toBe("management-affecting");
    expect(classifyRisk(step({ resource: "route" })).risk).toBe("management-affecting");
    expect(classifyRisk(step({ resource: "ipsec" })).risk).toBe("service-affecting");
    expect(classifyRisk(step({ resource: "openvpn" })).risk).toBe("service-affecting");
    expect(classifyRisk(step({ resource: "gre", action: "noop" })).risk).toBe("none");
  });

  it("summarises the diff and requires confirmation for risky or blocked plans", () => {
    const now = new Date("2026-10-08T12:00:00.000Z");
    const plan = buildNetworkPlan(
      [
        { resource: "gre", id: "g1", action: "create", nodeId: "node-a", summary: "create" },
        { resource: "gre", id: "g2", action: "noop", nodeId: "node-b", summary: "noop" },
        { resource: "firewall", id: "f1", action: "update", nodeId: "node-a", summary: "firewall" },
      ],
      [],
      [],
      now,
    );
    expect(plan.summary).toEqual({ create: 1, update: 1, noop: 1, remove: 0 });
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.steps.find((s) => s.id === "f1")?.riskReason).toMatch(/SSH/);
    expect(plan.createdAt).toBe(now.toISOString());

    const safe = buildNetworkPlan([{ resource: "gre", id: "g2", action: "noop", nodeId: null, summary: "noop" }]);
    expect(safe.requiresConfirmation).toBe(false);

    const blocked = buildNetworkPlan([], [{ id: "g3", reason: "node offline" }]);
    expect(blocked.requiresConfirmation).toBe(true);
  });
});

describe("tunnel desired-state diff", () => {
  const desired = {
    id: "arvoo:tunnel:1",
    tunnelId: "t1",
    interfaceName: "gre-ir-01",
    nodeId: "node-a",
    nodeName: "ir-1",
    mtu: 1400,
    fouPort: null as number | null,
    ipsecEnabled: false,
    observed: null as null | { interfacePresent: boolean | null; mtu: number | null; fouPort: number | null; ipsecPresent: boolean | null },
  };

  it("asks the node to create the interface when nothing was observed", () => {
    const step = diffTunnelState(desired);
    expect(step.action).toBe("create");
    expect(step.summary).toMatch(/create GRE interface/i);
  });

  it("reports drift as an update and a match as a noop", () => {
    const matching = diffTunnelState({
      ...desired,
      observed: { interfacePresent: true, mtu: 1400, fouPort: null, ipsecPresent: null },
    });
    expect(matching.action).toBe("noop");

    const drifted = diffTunnelState({
      ...desired,
      fouPort: 5555,
      observed: { interfacePresent: true, mtu: 1360, fouPort: null, ipsecPresent: null },
    });
    expect(drifted.action).toBe("update");
    expect(drifted.summary).toContain("MTU 1360 → 1400");
    expect(drifted.summary).toContain("FOU none → 5555");
  });

  it("notices a missing IPsec association the node never confirmed", () => {
    const step = diffTunnelState({
      ...desired,
      ipsecEnabled: true,
      observed: { interfacePresent: true, mtu: 1400, fouPort: null, ipsecPresent: false },
    });
    expect(step.action).toBe("update");
    expect(step.summary).toContain("IPsec missing");
  });
});

describe("weights", () => {
  it("ships sane defaults that sum to one", () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("administrative weight, health admission and stability", () => {
  it("halves the ranking score of a weight-50 path and removes a weight-0 path", () => {
    const heavy = candidate({ pathId: "heavy", weight: 100 });
    const light = candidate({ pathId: "light", weight: 50 });
    const ranked = rankPaths([heavy, light]).ranked;
    const heavyRanked = ranked.find((r) => r.path.pathId === "heavy")!;
    const lightRanked = ranked.find((r) => r.path.pathId === "light")!;
    expect(lightRanked.weightFactor).toBe(0.5);
    expect(lightRanked.score).toBeCloseTo(heavyRanked.score / 2, 1);
    expect(ranked[0]!.path.pathId).toBe("heavy");

    const off = rankPaths([candidate({ pathId: "off", weight: 0 })]);
    expect(off.selected).toBeNull();
    expect(off.excluded[0]!.reason).toMatch(/weighted out/i);
  });

  it("excludes a candidate the caller marked unselectable, with its own reason", () => {
    const result = rankPaths([
      candidate({ selectable: false, ineligibleReason: "Failing: excluded from new sessions." }),
      candidate({ pathId: "ok" }),
    ]);
    expect(result.selected?.path.pathId).toBe("ok");
    expect(result.excluded[0]!.reason).toContain("Failing");
  });

  it("does not invent a capacity score when the capacity is unknown", () => {
    const scored = scorePath({
      pathId: "t-1",
      metrics: METRICS,
      state: "up",
      stale: false,
      sessions: 0,
      capacitySessions: null,
    });
    // Throughput is real (400 of 500 reference) and headroom cannot be applied.
    expect(scored.components.capacity).toBe(80);

    const nothing = scorePath({
      pathId: "t-1",
      metrics: null,
      state: "up",
      stale: false,
      sessions: 0,
      capacitySessions: null,
    });
    expect(nothing.components.capacity).toBeNull();
    expect(Object.keys(nothing.weightsUsed)).not.toContain("capacity");
  });

  it("holds new sessions on the current near-equal path instead of thrashing", () => {
    const paths = [candidate({ pathId: "heavy", weight: 100 }), candidate({ pathId: "light", weight: 95 })];
    const held = rankPaths(paths, { previousPathId: "light" });
    expect(held.selected?.path.pathId).toBe("light");
    expect(held.selected?.reasons[0]).toMatch(/hold-down/i);

    // A clearly better challenger is allowed to take over.
    const better = candidate({ pathId: "better", metrics: { ...METRICS, latencyMs: 1, throughputMbps: 500 } });
    const switched = rankPaths([candidate({ pathId: "light", weight: 95 }), better], { previousPathId: "light" });
    expect(switched.selected?.path.pathId).toBe("better");
  });

  it("spreads near-equal candidates across the least-loaded failure domains", () => {
    const paths = [
      candidate({ pathId: "a", failureDomains: ["dc-1", "de"] }),
      candidate({ pathId: "b", failureDomains: ["dc-2", "nl"] }),
      candidate({ pathId: "c", failureDomains: ["dc-3", "us"] }),
    ];
    const plain = rankPaths(paths);
    expect(plain.selected?.path.pathId).toBe("a");

    const spread = rankPaths(paths, { diversity: true, domainLoad: { "dc-1": 10, "dc-2": 0, "dc-3": 0 } });
    expect(spread.selected?.path.pathId).toBe("b");
    expect(spread.selected?.reasons[0]).toMatch(/diversity/i);
  });

  it("lets the hold-down win over diversity so a stable selection is not rotated", () => {
    const paths = [
      candidate({ pathId: "a", weight: 95, failureDomains: ["dc-1"] }),
      candidate({ pathId: "b", weight: 100, failureDomains: ["dc-2"] }),
    ];
    const decision = rankPaths(paths, { previousPathId: "a", diversity: true, domainLoad: { "dc-1": 10, "dc-2": 0 } });
    expect(decision.selected?.path.pathId).toBe("a");
    expect(decision.selected?.reasons[0]).toMatch(/hold-down/i);
  });

  it("moves an existing assignment whose path is no longer selectable", () => {
    const decision = placeSession({
      ingress: [
        { nodeId: "node-a", label: "ir-1", adminState: "enabled", status: "online", sessions: 1, capacitySessions: 100 },
        { nodeId: "node-c", label: "ir-2", adminState: "enabled", status: "online", sessions: 0, capacitySessions: 100 },
      ],
      paths: [
        candidate({ pathId: "t-1", selectable: false, ineligibleReason: "Failing: excluded from new sessions." }),
        candidate({ pathId: "t-2", label: "ir-2 → de-2", ingressNodeId: "node-c", egressNodeId: "node-d" }),
      ],
      current: { ingressNodeId: "node-a", egressNodeId: "node-b", pathId: "t-1" },
    });
    expect(decision.action).toBe("move");
    expect(decision.reasons.join(" ")).toContain("Failing");
  });
});
