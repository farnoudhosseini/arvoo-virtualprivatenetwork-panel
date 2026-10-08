import { describe, expect, it } from "vitest";
import { chooseMember, evaluateLbHealth, eligibleMembers, weightShares, type LbCandidate } from "./lb.js";

const member = (over: Partial<LbCandidate> & { id: string }): LbCandidate => ({
  weight: 100,
  enabled: true,
  drained: false,
  healthy: true,
  priority: 100,
  ...over,
});

describe("member eligibility", () => {
  it("excludes disabled, drained, unhealthy and zero-weight members", () => {
    const members = [
      member({ id: "ok" }),
      member({ id: "disabled", enabled: false }),
      member({ id: "drained", drained: true }),
      member({ id: "sick", healthy: false }),
      member({ id: "zero", weight: 0 }),
    ];
    expect(eligibleMembers(members).map((m) => m.id)).toEqual(["ok"]);
  });
});

describe("selection", () => {
  it("spreads weighted traffic by weight", () => {
    const members = [member({ id: "a", weight: 90 }), member({ id: "b", weight: 10 })];
    let a = 0;
    let b = 0;
    for (let i = 0; i < 1000; i++) {
      const pick = chooseMember(members, "weighted", () => i / 1000).member!;
      if (pick.id === "a") a++;
      else b++;
    }
    expect(a).toBeGreaterThan(850);
    expect(b).toBeGreaterThan(50);
    expect(a + b).toBe(1000);
  });

  it("prefers the lowest priority in failover mode", () => {
    const members = [member({ id: "backup", priority: 200, weight: 1000 }), member({ id: "primary", priority: 10, weight: 1 })];
    expect(chooseMember(members, "failover").member!.id).toBe("primary");
  });

  it("picks the least loaded member and breaks ties by weight", () => {
    const members = [
      member({ id: "busy", load: 40, weight: 900 }),
      member({ id: "quiet", load: 2, weight: 10 }),
      member({ id: "quiet2", load: 2, weight: 800 }),
    ];
    expect(chooseMember(members, "least-load").member!.id).toBe("quiet2");
  });

  it("falls back to an unhealthy member only when nothing healthy is left, and says so", () => {
    const members = [member({ id: "sick", healthy: false })];
    const selection = chooseMember(members, "weighted");
    expect(selection.member!.id).toBe("sick");
    expect(selection.degraded).toBe(true);
    expect(selection.reason).toMatch(/unhealthy/i);
  });

  it("returns no member with a clear reason when everything is drained", () => {
    const selection = chooseMember([member({ id: "d", drained: true })], "weighted");
    expect(selection.member).toBeNull();
    expect(selection.reason).toMatch(/disabled or drained/i);
  });
});

describe("shares", () => {
  it("reports the real weight share and zero for unusable members", () => {
    const shares = weightShares(
      [member({ id: "a", weight: 75 }), member({ id: "b", weight: 25 }), member({ id: "off", weight: 100, drained: true })],
      "weighted",
    );
    expect(shares.a).toBe(75);
    expect(shares.b).toBe(25);
    expect(shares.off).toBe(0);
  });

  it("gives everything to the primary in failover mode", () => {
    const shares = weightShares([member({ id: "a", priority: 1 }), member({ id: "b", priority: 2 })], "failover");
    expect(shares.a).toBe(100);
    expect(shares.b).toBe(0);
  });

  it("does not invent percentages for least-load", () => {
    const shares = weightShares([member({ id: "a" }), member({ id: "b" })], "least-load");
    expect(shares.a).toBe(0);
    expect(shares.b).toBe(0);
  });
});

describe("health", () => {
  const thresholds = { minSuccessRatePct: 80, maxLatencyMs: 200, maxLossPct: 5, requireNodeOnline: true };

  it("accepts a member that meets every threshold", () => {
    const result = evaluateLbHealth({ nodeOnline: true, successRatePct: 95, latencyMs: 40, lossPct: 1 }, thresholds);
    expect(result.healthy).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("states each unmet requirement", () => {
    const result = evaluateLbHealth({ nodeOnline: false, successRatePct: 50, latencyMs: 400, lossPct: 30 }, thresholds);
    expect(result.healthy).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/not reporting/i);
    expect(result.reasons.join(" ")).toMatch(/success rate/i);
    expect(result.reasons.join(" ")).toMatch(/latency/i);
    expect(result.reasons.join(" ")).toMatch(/loss/i);
  });

  it("treats a member that was never probed as unproven, not healthy", () => {
    const result = evaluateLbHealth({ nodeOnline: true, successRatePct: null, latencyMs: null, lossPct: null }, thresholds);
    expect(result.healthy).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/No health probe/i);
  });

  it("flags a failed deployment as unhealthy", () => {
    const result = evaluateLbHealth(
      { nodeOnline: true, successRatePct: 100, latencyMs: 10, lossPct: 0, inboundStatus: "error" },
      thresholds,
    );
    expect(result.healthy).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/deployment failed/i);
  });
});
