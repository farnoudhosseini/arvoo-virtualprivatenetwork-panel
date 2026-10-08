import { q1, run, nowIso } from "../db/index.js";

type Settings = Record<string, string>;

const DEFAULTS: Settings = {
  "ui.siteName": "Arvoo",
  "retention.healthDays": "14",
  "retention.usageDays": "90",
  "retention.auditDays": "365",
  "security.sessionTtlSec": String(12 * 3600),
  "security.internal": "jwt",
};

export async function getSetting(key: string): Promise<string | null> {
  const row = await q1<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key);
  return row?.value ?? DEFAULTS[key] ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    nowIso(),
  );
}

export function allSettings(): Record<string, string> {
  return { ...DEFAULTS };
}

export async function publicSettings(): Promise<Record<string, string>> {
  const siteName = (await getSetting("ui.siteName")) ?? "Arvoo";
  const healthDays = (await getSetting("retention.healthDays")) ?? "14";
  const usageDays = (await getSetting("retention.usageDays")) ?? "90";
  const auditDays = (await getSetting("retention.auditDays")) ?? "365";
  const sessionTtlSec = (await getSetting("security.sessionTtlSec")) ?? String(12 * 3600);
  return {
    "ui.siteName": siteName,
    "retention.healthDays": healthDays,
    "retention.usageDays": usageDays,
    "retention.auditDays": auditDays,
    "security.sessionTtlSec": sessionTtlSec,
  };
}
