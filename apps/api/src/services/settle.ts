import { q1 } from "../db/index.js";
import { completeOperation } from "./operations.js";
import { onDeploymentOperationSettled, onEgressOperationSettled } from "./inbounds.js";
import { onGreOperationSettled, recordTunnelTest } from "./tunnels.js";
import { recordPathHealth } from "./routing.js";
import { onFirewallOperationSettled } from "./firewall.js";

/**
 * Single settlement entry point: marks the operation done and routes the
 * result to the owning domain service.
 */
export async function settleOperation(
  operationId: string,
  success: boolean,
  payload: { output?: unknown; error?: string | null },
): Promise<void> {
  const op = await q1<{ type: string }>(`SELECT type FROM operations WHERE id = ?`, operationId);
  if (!op) return;

  await completeOperation(operationId, success ? "success" : "failed", {
    output: payload.output ?? null,
    error: payload.error ?? null,
  });

  switch (op.type) {
    case "CreateOpenVPNInbound":
      await onDeploymentOperationSettled(operationId, success, payload.error ?? null);
      break;
    case "ApplyFirewallPolicy":
      await onEgressOperationSettled(operationId, success, payload.error ?? null);
      break;
    case "CreateGRE":
      await onGreOperationSettled(operationId, success, payload.output, payload.error ?? null);
      break;
    case "ConfigureFirewall": {
      const result = (payload.output ?? {}) as { rules?: unknown; enabled?: boolean; verified?: boolean };
      await onFirewallOperationSettled(operationId, success, result, payload.error ?? null);
      break;
    }
    case "TestTunnel": {
      const result = (payload.output ?? {}) as {
        ok?: boolean;
        latencyMs?: number | null;
        lossPct?: number | null;
        samples?: number | null;
      };
      const tunnelOp = await q1<{ ref_id: string | null }>(`SELECT ref_id FROM operations WHERE id = ?`, operationId);
      if (tunnelOp?.ref_id) {
        await recordTunnelTest(tunnelOp.ref_id, {
          ok: Boolean(result.ok),
          latencyMs: result.latencyMs ?? null,
          lossPct: result.lossPct ?? null,
        });
        // The same probe is real path-health evidence, recorded once.
        await recordPathHealth(tunnelOp.ref_id, {
          ok: success && Boolean(result.ok),
          metrics: {
            latencyMs: result.latencyMs ?? null,
            lossPct: result.lossPct ?? null,
            jitterMs: null,
            throughputMbps: null,
            samples: result.samples ?? 5,
          },
          source: "test",
          detail: success ? null : payload.error ?? "tunnel test failed",
        });
      }
      break;
    }
    case "RunBenchmark": {
      const result = (payload.output ?? {}) as {
        latencyMs?: number | null;
        jitterMs?: number | null;
        lossPct?: number | null;
        throughputMbps?: number | null;
        samples?: number | null;
      };
      const tunnelOp = await q1<{ ref_id: string | null }>(`SELECT ref_id FROM operations WHERE id = ?`, operationId);
      if (tunnelOp?.ref_id) {
        await recordPathHealth(tunnelOp.ref_id, {
          ok: success,
          metrics: {
            latencyMs: result.latencyMs ?? null,
            lossPct: result.lossPct ?? null,
            jitterMs: result.jitterMs ?? null,
            throughputMbps: result.throughputMbps ?? null,
            samples: result.samples ?? null,
          },
          source: "benchmark",
          detail: success ? null : payload.error ?? "benchmark failed",
        });
      }
      break;
    }
    default:
      break;
  }
}
