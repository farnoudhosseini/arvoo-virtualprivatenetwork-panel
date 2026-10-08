/**
 * Arvoo client policy engine.
 *
 * Rules are ordered by priority (lower first) and evaluated against a context.
 * A rule matches when ALL of its conditions match. Matching actions accumulate
 * with first-wins semantics per action type, except multiplier which
 * multiplies (base * rule1 * rule2...) so stacked scheduled rules compose.
 */

import type {
  PolicyAction,
  PolicyCondition,
  PolicyConditionOp,
  PolicyRuleRecord,
} from "./types";

export interface PolicyContext {
  clientId: string;
  groupId: string | null;
  inboundId: string | null;
  nodeId: string | null;
  sourceIp: string | null;
  /** Minutes since local midnight (0-1439). */
  timeOfDayMinutes: number;
  /** 0 = Sunday ... 6 = Saturday. */
  dayOfWeek: number;
  trafficUsedBilledBytes: number;
  activeSessions: number;
  deviceCount: number;
  now: Date;
}

export interface PolicyDecision {
  deny: { reason: string } | null;
  suspend: boolean;
  bandwidthKbps: { download: number; upload: number } | null;
  sessionLimit: number | null;
  deviceLimit: number | null;
  multiplier: number;
  alerts: string[];
  matchedRuleIds: string[];
}

const EMPTY: PolicyDecision = {
  deny: null,
  suspend: false,
  bandwidthKbps: null,
  sessionLimit: null,
  deviceLimit: null,
  multiplier: 1,
  alerts: [],
  matchedRuleIds: [],
};

function matchesOp(op: PolicyConditionOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as never);
    case "not_in":
      return !(Array.isArray(expected) && expected.includes(actual as never));
    case "lt":
      return (actual as number) < (expected as number);
    case "lte":
      return (actual as number) <= (expected as number);
    case "gt":
      return (actual as number) > (expected as number);
    case "gte":
      return (actual as number) >= (expected as number);
    default:
      return false;
  }
}

function conditionActual(type: PolicyCondition["type"], ctx: PolicyContext): unknown {
  switch (type) {
    case "client":
      return ctx.clientId;
    case "group":
      return ctx.groupId;
    case "inbound":
      return ctx.inboundId;
    case "node":
      return ctx.nodeId;
    case "sourceIp":
      return ctx.sourceIp;
    case "timeOfDay":
      return ctx.timeOfDayMinutes;
    case "dayOfWeek":
      return ctx.dayOfWeek;
    case "trafficUsedBytes":
      return ctx.trafficUsedBilledBytes;
    case "activeSessions":
      return ctx.activeSessions;
    case "deviceCount":
      return ctx.deviceCount;
    default:
      return undefined;
  }
}

function ruleActive(rule: PolicyRuleRecord, now: Date): boolean {
  if (!rule.enabled) return false;
  if (rule.effectiveFrom && new Date(rule.effectiveFrom) > now) return false;
  if (rule.effectiveUntil && new Date(rule.effectiveUntil) < now) return false;
  return true;
}

function ruleMatches(rule: PolicyRuleRecord, ctx: PolicyContext): boolean {
  for (const cond of rule.conditions) {
    const actual = conditionActual(cond.type, ctx);
    // timeOfDay supports range via two conditions (gte/lte); dayOfWeek uses in.
    if (!matchesOp(cond.op, actual, cond.value)) return false;
  }
  return true;
}

export function evaluatePolicies(
  rules: PolicyRuleRecord[],
  ctx: PolicyContext,
): PolicyDecision {
  const decision: PolicyDecision = { ...EMPTY, multiplier: 1, alerts: [], matchedRuleIds: [] };

  const active = rules
    .filter((r) => ruleActive(r, ctx.now))
    .sort((a, b) => a.priority - b.priority);

  for (const rule of active) {
    if (!ruleMatches(rule, ctx)) continue;
    decision.matchedRuleIds.push(rule.id);

    for (const action of rule.actions as PolicyAction[]) {
      switch (action.type) {
        case "deny":
          if (!decision.deny) {
            decision.deny = {
              reason: `Denied by policy "${rule.name}"`,
            };
          }
          break;
        case "suspend":
          decision.suspend = true;
          break;
        case "limit_bandwidth": {
          const p = (action.params ?? {}) as { downloadKbps?: number; uploadKbps?: number };
          if (!decision.bandwidthKbps) {
            decision.bandwidthKbps = {
              download: p.downloadKbps ?? 0,
              upload: p.uploadKbps ?? 0,
            };
          }
          break;
        }
        case "limit_sessions": {
          const p = (action.params ?? {}) as { max: number };
          if (decision.sessionLimit == null) decision.sessionLimit = p.max ?? 0;
          break;
        }
        case "limit_devices": {
          const p = (action.params ?? {}) as { max: number };
          if (decision.deviceLimit == null) decision.deviceLimit = p.max ?? 0;
          break;
        }
        case "apply_multiplier": {
          const p = (action.params ?? {}) as { multiplier: number };
          const m = Number(p.multiplier);
          if (Number.isFinite(m) && m > 0) decision.multiplier *= m;
          break;
        }
        case "alert":
          decision.alerts.push(rule.name);
          break;
        default:
          break;
      }
    }
  }

  return decision;
}
