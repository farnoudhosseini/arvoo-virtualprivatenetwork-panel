import { q, q1, run, uuid, nowIso } from "../db/index.js";
import type { OperationType, OperationStatus } from "@arvoo/shared";
import { AppError } from "../lib/errors.js";

export interface EnqueueInput {
  type: OperationType;
  nodeId: string | null;
  refType?: "inbound" | "tunnel" | "route" | "node" | null;
  refId?: string | null;
  requestedBy?: string | null;
  input?: unknown;
}

export async function enqueueOperation(input: EnqueueInput): Promise<{ id: string; status: "queued" }> {
  const id = uuid();
  await run(
    `INSERT INTO operations (id, type, node_id, ref_type, ref_id, requested_by, status, progress, input, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.type,
    input.nodeId,
    input.refType ?? null,
    input.refId ?? null,
    input.requestedBy ?? "system",
    "queued",
    0,
    input.input ? JSON.stringify(input.input) : null,
    nowIso(),
  );
  await logOperation(id, "info", "queue", "Operation queued");
  return { id, status: "queued" };
}

export async function logOperation(
  operationId: string,
  level: "info" | "warn" | "error",
  step: string,
  message: string,
): Promise<void> {
  await run(
    `INSERT INTO operation_logs (id, operation_id, at, level, step, message) VALUES (?,?,?,?,?,?)`,
    uuid(),
    operationId,
    nowIso(),
    level,
    step,
    message,
  );
}

/**
 * Agent poll: claim the oldest queued operation for a node, if any.
 * No long-poll: the handler must never block the single-threaded control
 * plane; the agent polls on its own interval.
 */
export async function claimNextOperation(nodeId: string): Promise<unknown | null> {
  const next = await q1<{ id: string; type: string; input: string | null }>(
    `SELECT id, type, input FROM operations WHERE node_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    nodeId,
  );
  if (!next) return null;
  // Claim as a compare-and-set: only the poll that actually flips the row from
  // 'queued' to 'running' may execute it. Two pollers (a duplicated agent
  // process, or a retry while another poll is in flight) select the same
  // candidate, and exactly one of them gets a changed row - the loser receives
  // nothing instead of executing the same operation a second time.
  const claim = await run(
    `UPDATE operations SET status = 'running', progress = 5, claimed_at = ?, started_at = ? WHERE id = ? AND status = 'queued'`,
    nowIso(),
    nowIso(),
    next.id,
  );
  if (claim.changes === 0) return null;
  await logOperation(next.id, "info", "claim", "Operation claimed by node agent");
  return {
    id: next.id,
    type: next.type,
    input: next.input ? JSON.parse(next.input) : null,
  };
}

export async function completeOperation(
  operationId: string,
  status: Extract<OperationStatus, "success" | "failed">,
  payload: { output?: unknown; error?: string | null; progress?: number },
): Promise<void> {
  const op = await q1<{ node_id: string | null; type: string }>(`SELECT node_id, type FROM operations WHERE id = ?`, operationId);
  if (!op) throw new AppError(404, "Operation not found");

  await run(
    `UPDATE operations SET status = ?, progress = ?, output = ?, error = ?, finished_at = ? WHERE id = ?`,
    status,
    payload.progress ?? (status === "success" ? 100 : op.type === "RunBenchmark" ? 100 : 100),
    payload.output ? JSON.stringify(payload.output) : null,
    payload.error ?? null,
    nowIso(),
    operationId,
  );
  if (status === "failed") {
    await logOperation(operationId, "error", "result", payload.error ?? "Operation failed");
  } else {
    await logOperation(operationId, "info", "result", "Operation completed successfully");
  }
}

export async function progressOperation(operationId: string, progress: number, step: string, message: string): Promise<void> {
  await run(`UPDATE operations SET progress = ? WHERE id = ?`, Math.max(0, Math.min(100, progress)), operationId);
  await logOperation(operationId, "info", step, message);
}

/** Cancel operations stuck in running without updates (agent died). */
export async function sweepStaleOperations(olderThanSec = 600): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanSec * 1000).toISOString();
  const stale = await q<{ id: string }>(
    `SELECT id FROM operations WHERE status IN ('queued','running') AND created_at < ?`,
    cutoff,
  );
  for (const s of stale) {
    await run(
      `UPDATE operations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      "Operation timed out: node agent did not report a result",
      nowIso(),
      s.id,
    );
    await logOperation(s.id, "error", "timeout", "Operation timed out without agent response");
  }
  return stale.length;
}

export async function operationWithLogs(id: string) {
  const op = await q1(`SELECT * FROM operations WHERE id = ?`, id);
  if (!op) throw new AppError(404, "Operation not found");
  const logs = await q(`SELECT * FROM operation_logs WHERE operation_id = ? ORDER BY at ASC`, id);
  return { ...(op as object), logs };
}
