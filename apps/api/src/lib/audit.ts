import { run, uuid, nowIso } from "../db/index.js";
import type { AuditAction } from "@arvoo/shared";

export interface AuditEntry {
  actorId?: string | null;
  actorName?: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  summary: string;
  detail?: unknown;
  ip?: string | null;
}

export function audit(entry: AuditEntry): void {
  // Fire-and-forget: audit must never break the request path. Rejections are
  // surfaced on stderr instead of propagating to the caller.
  run(
    `INSERT INTO audit_logs (id, at, actor_id, actor_name, action, entity_type, entity_id, entity_name, summary, detail, ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    uuid(),
    nowIso(),
    entry.actorId ?? null,
    entry.actorName ?? null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.entityName ?? null,
    entry.summary,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.ip ?? null,
  ).catch((err: Error) => {
    console.error("[audit] failed to persist audit entry:", err.message);
  });
}
