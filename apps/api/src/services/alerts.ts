import { run, q, q1, uuid, nowIso } from "../db/index.js";
import type { AlertSeverity } from "@arvoo/shared";

export async function raiseAlert(input: {
  severity: AlertSeverity;
  type: string;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
}): Promise<string> {
  // Deduplicate: keep a single open alert per (type, entity, severity).
  // `IS NOT DISTINCT FROM` is PostgreSQL's NULL-safe equality: it matches the
  // row when the entity is NULL and the argument is NULL, exactly like SQLite's
  // "IS ?" did - which is a syntax error in PostgreSQL.
  const existing = await q1<{ id: string }>(
    `SELECT id FROM alerts WHERE type = ? AND severity = ? AND status IN ('open','acknowledged')
     AND entity_id IS NOT DISTINCT FROM ? LIMIT 1`,
    input.type,
    input.severity,
    input.entityId ?? null,
  );
  if (existing) return existing.id;

  const id = uuid();
  await run(
    `INSERT INTO alerts (id, severity, type, title, message, entity_type, entity_id, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.severity,
    input.type,
    input.title,
    input.message,
    input.entityType ?? null,
    input.entityId ?? null,
    "open",
    nowIso(),
  );
  return id;
}

/** Resolve open alerts matching a type + entity (recovery path). */
export async function resolveAlerts(type: string, entityId?: string | null): Promise<void> {
  await run(
    `UPDATE alerts SET status = 'resolved', resolved_at = ?
     WHERE type = ? AND status IN ('open','acknowledged')
     AND entity_id IS NOT DISTINCT FROM ?`,
    nowIso(),
    type,
    entityId ?? null,
  );
}

export async function openAlertCount(): Promise<number> {
  const row = await q1<{ c: number }>(`SELECT COUNT(*) AS c FROM alerts WHERE status = 'open'`);
  return row?.c ?? 0;
}

export async function recentOpenAlerts(limit = 50) {
  return q(`SELECT * FROM alerts WHERE status != 'resolved' ORDER BY created_at DESC LIMIT ?`, limit);
}
