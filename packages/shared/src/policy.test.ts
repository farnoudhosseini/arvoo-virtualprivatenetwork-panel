import { describe, expect, it } from "vitest";
import { evaluatePolicies } from "./policy";
import type { PolicyRuleRecord } from "./types";
import { billedBytes, isExpired, timeQuotaState, trafficQuotaState } from "./quota";

function rule(partial: Partial<PolicyRuleRecord>): PolicyRuleRecord {
  return {
    id: "r-" + Math.random().toString(36).slice(2),
    name: "rule",
    description: null,
    enabled: true,
    priority: 10,
    effectiveFrom: null,
    effectiveUntil: null,
    conditions: [],
    actions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

const ctx = (over: Partial<Parameters<typeof evaluatePolicies>[1]> = {}) => ({
  clientId: "c1",
  groupId: null,
  inboundId: "i1",
  nodeId: "n1",
  sourceIp: "5.6.7.8",
  timeOfDayMinutes: 600,
  dayOfWeek: 3,
  trafficUsedBilledBytes: 1000,
  activeSessions: 1,
  deviceCount: 1,
  now: new Date("2026-10-07T10:00:00Z"),
  ...over,
});

describe("policy engine", () => {
  it("no rules -> default decision", () => {
    const d = evaluatePolicies([], ctx());
    expect(d.deny).toBeNull();
    expect(d.multiplier).toBe(1);
  });

  it("applies multiplier from matching rule", () => {
    const d = evaluatePolicies(
      [rule({ conditions: [{ type: "client", op: "eq", value: "c1" }], actions: [{ type: "apply_multiplier", params: { multiplier: 1.5 } }] })],
      ctx(),
    );
    expect(d.multiplier).toBe(1.5);
    expect(d.matchedRuleIds).toHaveLength(1);
  });

  it("stacks multipliers across matching rules", () => {
    const d = evaluatePolicies(
      [
        rule({ priority: 1, actions: [{ type: "apply_multiplier", params: { multiplier: 2 } }] }),
        rule({ priority: 2, actions: [{ type: "apply_multiplier", params: { multiplier: 1.5 } }] }),
      ],
      ctx(),
    );
    expect(d.multiplier).toBe(3);
  });

  it("deny wins and records the rule name", () => {
    const d = evaluatePolicies(
      [rule({ name: "night-lock", conditions: [{ type: "timeOfDay", op: "lte", value: 360 }], actions: [{ type: "deny" }] })],
      ctx({ timeOfDayMinutes: 120 }),
    );
    expect(d.deny?.reason).toContain("night-lock");
  });

  it("respects priority: earlier rule wins for bandwidth", () => {
    const d = evaluatePolicies(
      [
        rule({ priority: 1, actions: [{ type: "limit_bandwidth", params: { downloadKbps: 10240, uploadKbps: 5120 } }] }),
        rule({ priority: 5, actions: [{ type: "limit_bandwidth", params: { downloadKbps: 100, uploadKbps: 100 } }] }),
      ],
      ctx(),
    );
    expect(d.bandwidthKbps).toEqual({ download: 10240, upload: 5120 });
  });

  it("inactive window rules are skipped", () => {
    const d = evaluatePolicies(
      [rule({ effectiveUntil: "2020-01-01T00:00:00Z", actions: [{ type: "deny" }] })],
      ctx(),
    );
    expect(d.deny).toBeNull();
  });

  it("matches device/session conditions", () => {
    const d = evaluatePolicies(
      [rule({ conditions: [{ type: "deviceCount", op: "gt", value: 2 }], actions: [{ type: "alert" }] })],
      ctx({ deviceCount: 5 }),
    );
    expect(d.alerts).toHaveLength(1);
    const d2 = evaluatePolicies(
      [rule({ conditions: [{ type: "deviceCount", op: "gt", value: 2 }], actions: [{ type: "alert" }] })],
      ctx({ deviceCount: 2 }),
    );
    expect(d2.alerts).toHaveLength(0);
  });
});

describe("quota math", () => {
  it("bills with multiplier", () => {
    expect(billedBytes({ rxBytes: 100, txBytes: 100, multiplier: 1.5 })).toBe(300);
    expect(billedBytes({ rxBytes: 1024 * 1024 * 1024, txBytes: 0, multiplier: 1 })).toBe(1073741824);
  });

  it("quota states", () => {
    const s = trafficQuotaState(50 * 1024 ** 3, 100 * 1024 ** 3);
    expect(s.usedPct).toBeCloseTo(50);
    expect(s.exceeded).toBe(false);
    expect(trafficQuotaState(120 * 1024 ** 3, 100 * 1024 ** 3).exceeded).toBe(true);
    expect(trafficQuotaState(1024, null).quotaBytes).toBeNull();
  });

  it("time quota states", () => {
    expect(timeQuotaState(3600 * 15, 3600 * 10).exceeded).toBe(true);
    expect(timeQuotaState(3600, null).quotaSec).toBeNull();
  });

  it("expiry", () => {
    expect(isExpired("2020-01-01T00:00:00Z", new Date("2026-01-01"))).toBe(true);
    expect(isExpired("2030-01-01T00:00:00Z", new Date("2026-01-01"))).toBe(false);
    expect(isExpired(null)).toBe(false);
  });
});
