/**
 * Continuous path health engine (spec §11/§32/§34/§70).
 *
 * The routing engine can only be as truthful as its measurements. Until now a
 * path was only probed when an operator clicked Test/Benchmark, so a path that
 * silently went bad kept its last good numbers. This service closes that gap:
 *
 *  - It plans probes for every deployed tunnel whose newest measurement is
 *    older than its adaptive interval. Healthy paths are probed rarely;
 *    degraded, failing and down paths are probed more often, because that is
 *    where change matters.
 *  - It never piles up work: if a RunBenchmark for a tunnel is already queued
 *    or running, the probe is skipped, not duplicated.
 *  - Probes are light (ICMP ping). Throughput is only measured by an explicit
 *    benchmark, because saturating a link for health is not health.
 *  - A tunnel that was never measured is probed promptly and then backs off;
 *    an unmeasured path is reported down by the engine, never assumed good.
 *
 * The probe results take the normal path: the agent executes RunBenchmark, the
 * operation settles, and `recordPathHealth` advances the hysteretic state.
 */
import { q } from "../db/index.js";
import { enqueueOperation } from "./operations.js";
import type { HealthState } from "@arvoo/shared";

type Row = Record<string, unknown>;

/** Probe intervals per health state, in seconds. */
export const PROBE_INTERVAL_SEC: Record<HealthState | "unknown", number> = {
  healthy: 300,
  degraded: 120,
  recovering: 60,
  failing: 60,
  down: 45,
  unknown: 15,
};

/** Safety valve: at most this many probes are queued per sweep. */
export const PROBE_MAX_PER_SWEEP = 25;

/** ICMP echo count per health probe (light by design). */
export const PROBE_PING_COUNT = 10;

const HEALTH_STATES: HealthState[] = ["healthy", "degraded", "failing", "down", "recovering"];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function probeIntervalSec(state: HealthState | "unknown"): number {
  return PROBE_INTERVAL_SEC[state] ?? PROBE_INTERVAL_SEC.unknown;
}

export interface ProbeDecision {
  tunnelId: string;
  name: string;
  /** Newest recorded health state; `unknown` when nothing was ever measured. */
  state: HealthState | "unknown";
  intervalSec: number;
  /** Age of the newest measurement, or null when there is none. */
  ageSec: number | null;
  due: boolean;
  reason: string;
  sourceNodeId: string;
  localTunnelIp: string;
  remoteTunnelIp: string;
}

/**
 * Decide which tunnels are due for a health probe. Pure read: no operations
 * are queued here, so the plan can be inspected (and tested) on its own.
 */
export async function planHealthProbes(now: Date = new Date()): Promise<ProbeDecision[]> {
  const rows = await q<Row>(
    `SELECT t.id, t.name, t.status, t.admin_state, t.source_node_id, t.local_tunnel_ip, t.remote_tunnel_ip,
            latest.at AS measured_at, latest.state AS health_state
     FROM tunnels t
     LEFT JOIN (
       SELECT DISTINCT ON (tunnel_id) tunnel_id, at, state
       FROM path_health
       ORDER BY tunnel_id, at DESC
     ) latest ON latest.tunnel_id = t.id
     ORDER BY latest.at ASC NULLS FIRST, t.name ASC`,
  );

  return rows.map((row) => {
    const tunnelId = String(row.id);
    const name = String(row.name);
    const status = String(row.status);
    const adminState = String(row.admin_state ?? "enabled");
    const rawState = asString(row.health_state);
    const state: HealthState | "unknown" =
      rawState && HEALTH_STATES.includes(rawState as HealthState) ? (rawState as HealthState) : "unknown";
    const measuredAt = asString(row.measured_at);
    const ageSec = measuredAt ? Math.max(0, (now.getTime() - new Date(measuredAt).getTime()) / 1000) : null;
    const intervalSec = probeIntervalSec(state);

    let due = false;
    let reason: string;
    if (adminState === "disabled") {
      reason = "Administratively disabled: it is not in the data path, so it is not probed.";
    } else if (!["up", "degraded", "down", "error"].includes(status)) {
      reason = `Tunnel is ${status}: probing starts once it is deployed.`;
    } else if (ageSec == null) {
      due = true;
      reason = "Never measured: an unmeasured path cannot be reported healthy.";
    } else if (ageSec >= intervalSec) {
      due = true;
      reason = `Last measurement is ${Math.round(ageSec)}s old (interval for state ${state} is ${intervalSec}s).`;
    } else {
      reason = `Measured ${Math.round(ageSec)}s ago; next probe after ${intervalSec}s.`;
    }

    return {
      tunnelId,
      name,
      state,
      intervalSec,
      ageSec,
      due,
      reason,
      sourceNodeId: String(row.source_node_id),
      localTunnelIp: String(row.local_tunnel_ip),
      remoteTunnelIp: String(row.remote_tunnel_ip),
    };
  });
}

export interface HealthSweepResult {
  planned: number;
  due: number;
  queued: number;
  /** Due but skipped because a benchmark is already in flight. */
  skipped: number;
  probes: Array<{ tunnelId: string; name: string; reason: string }>;
}

/**
 * Queue the due probes. Returns what was done and why everything else was not,
 * so a scheduled sweep is as auditable as a manual action.
 */
export async function runHealthProbes(now: Date = new Date()): Promise<HealthSweepResult> {
  const plan = await planHealthProbes(now);
  const due = plan.filter((probe) => probe.due).slice(0, PROBE_MAX_PER_SWEEP);

  const probes: HealthSweepResult["probes"] = [];
  let queued = 0;
  let skipped = 0;

  for (const probe of due) {
    const active = await q<{ id: string }>(
      `SELECT id FROM operations
       WHERE type = 'RunBenchmark' AND ref_type = 'tunnel' AND ref_id = ? AND status IN ('queued','running')
       LIMIT 1`,
      probe.tunnelId,
    );
    if (active.length > 0) {
      skipped++;
      probes.push({ tunnelId: probe.tunnelId, name: probe.name, reason: "A benchmark is already queued or running." });
      continue;
    }

    await enqueueOperation({
      type: "RunBenchmark",
      nodeId: probe.sourceNodeId,
      refType: "tunnel",
      refId: probe.tunnelId,
      requestedBy: "health-engine",
      input: {
        interfaceName: probe.name,
        localTunnelIp: probe.localTunnelIp,
        remoteTunnelIp: probe.remoteTunnelIp,
        pingCount: PROBE_PING_COUNT,
        iperfSeconds: null,
      },
    });
    queued++;
    probes.push({ tunnelId: probe.tunnelId, name: probe.name, reason: probe.reason });
  }

  return { planned: plan.length, due: due.length, queued, skipped, probes };
}
