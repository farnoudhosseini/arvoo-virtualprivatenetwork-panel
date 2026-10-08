/**
 * Management access secret (spec §14).
 *
 * An *additional* layer on top of authentication for the most privileged
 * operations: user administration, session-secret rotation, node approval/
 * revocation and the management endpoints themselves. It never replaces login,
 * RBAC or rate limiting.
 *
 * Properties this module guarantees:
 *
 *   * the value is random (32 bytes, base64url) and never predictable;
 *   * only a peppered HMAC of the value is stored, so a database dump does not
 *     reveal it, and the value is never written to settings, logs or HTML;
 *   * the value is returned exactly once, to the caller that created it;
 *   * rotation keeps the *previous* value valid for a configurable grace window
 *     (default 30 minutes) so a rollout across several administrators does not
 *     lock anyone out mid-change;
 *   * rotation is auditable and explicit - it can also run on a 6-hour schedule
 *     for hosts that require it, and the new value is written to a root-only
 *     file on the server so terminal operators can always recover access.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { getSetting, setSetting } from "./settings.js";

const SETTING_KEY = "security.managementSecret";

/** Defaults; both are overridable through the API/CLI for a given install. */
export const DEFAULT_AUTO_ROTATE_HOURS = 6;
export const DEFAULT_GRACE_MINUTES = 30;

/** Where a rotated value is written for emergency terminal access (root only). */
export const MANAGEMENT_SECRET_FILE = "/etc/arvoo/management-secret";

export interface ManagementSecretRecord {
  enabled: boolean;
  hash: string;
  previousHash?: string;
  rotatedAt: string;
  previousValidUntil?: string;
  nextRotationAt?: string;
  autoRotateHours: number;
  graceMinutes: number;
  version: number;
}

/** Public metadata. Never contains the secret itself, or any hash of it. */
export interface ManagementSecretStatus {
  enabled: boolean;
  rotatedAt: string | null;
  previousValidUntil: string | null;
  nextRotationAt: string | null;
  autoRotateHours: number;
  graceMinutes: number;
  version: number;
  /** Minutes since the last rotation, for "is this stale?" checks. */
  ageMinutes: number | null;
}

const EMPTY: ManagementSecretRecord = {
  enabled: false,
  hash: "",
  rotatedAt: "",
  autoRotateHours: DEFAULT_AUTO_ROTATE_HOURS,
  graceMinutes: DEFAULT_GRACE_MINUTES,
  version: 0,
};

function pepper(): string {
  return config.appSecret || "arvoo-dev-secret-do-not-use-in-production";
}

function digest(value: string): string {
  return createHmac("sha256", pepper()).update(value).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

async function read(): Promise<ManagementSecretRecord> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<ManagementSecretRecord>;
    return {
      enabled: Boolean(parsed.enabled),
      hash: parsed.hash ?? "",
      previousHash: parsed.previousHash,
      rotatedAt: parsed.rotatedAt ?? "",
      previousValidUntil: parsed.previousValidUntil,
      nextRotationAt: parsed.nextRotationAt,
      autoRotateHours: parsed.autoRotateHours ?? DEFAULT_AUTO_ROTATE_HOURS,
      graceMinutes: parsed.graceMinutes ?? DEFAULT_GRACE_MINUTES,
      version: parsed.version ?? 1,
    };
  } catch {
    // A corrupted record must not silently leave the gate open.
    return { ...EMPTY, enabled: true, hash: "" };
  }
}

async function write(record: ManagementSecretRecord): Promise<void> {
  await setSetting(SETTING_KEY, JSON.stringify(record));
}

export async function status(): Promise<ManagementSecretStatus> {
  const record = await read();
  const ageMinutes = record.rotatedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(record.rotatedAt)) / 60000))
    : null;
  return {
    enabled: record.enabled,
    rotatedAt: record.rotatedAt || null,
    previousValidUntil: record.previousValidUntil ?? null,
    nextRotationAt: record.nextRotationAt ?? null,
    autoRotateHours: record.autoRotateHours,
    graceMinutes: record.graceMinutes,
    version: record.version,
    ageMinutes,
  };
}

export type VerifyResult = "disabled" | "current" | "previous" | "rejected";

/**
 * Check a presented secret. Accepts the current value always (while enabled)
 * and the previous value until its grace window expires.
 */
export async function verify(candidate: string | undefined): Promise<VerifyResult> {
  const record = await read();
  if (!record.enabled) return "disabled";
  if (!candidate) return "rejected";
  const candidateHash = digest(candidate);
  if (record.hash && safeEqualHex(candidateHash, record.hash)) return "current";
  if (
    record.previousHash &&
    record.previousValidUntil &&
    Date.parse(record.previousValidUntil) > Date.now() &&
    safeEqualHex(candidateHash, record.previousHash)
  ) {
    return "previous";
  }
  return "rejected";
}

export interface RotationResult {
  /** Plaintext, returned exactly once - never stored in this form. */
  secret: string;
  status: ManagementSecretStatus;
  reason: string;
}

/**
 * Rotate the management secret. The current value stays valid for the grace
 * window (`graceMinutes`), so concurrent administrators are not locked out.
 * Pass `value` to install an operator-chosen secret instead of a generated one.
 */
export async function rotate(options: {
  reason: string;
  value?: string;
  graceMinutes?: number;
  autoRotateHours?: number;
}): Promise<RotationResult> {
  const record = await read();
  const now = Date.now();
  const graceMinutes = options.graceMinutes ?? record.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const autoRotateHours = options.autoRotateHours ?? record.autoRotateHours ?? DEFAULT_AUTO_ROTATE_HOURS;
  const secret = options.value ?? generateSecret();

  const next: ManagementSecretRecord = {
    enabled: true,
    hash: digest(secret),
    previousHash: record.hash || undefined,
    rotatedAt: new Date(now).toISOString(),
    // Grace of 0 means the previous value is retired at once - represented as
    // no validity window at all rather than a window that ended in the past.
    previousValidUntil:
      record.hash && graceMinutes > 0 ? new Date(now + graceMinutes * 60000).toISOString() : undefined,
    nextRotationAt:
      autoRotateHours > 0 ? new Date(now + autoRotateHours * 3600_000).toISOString() : undefined,
    autoRotateHours,
    graceMinutes,
    version: (record.version ?? 0) + 1,
  };
  await write(next);
  return { secret, status: await status(), reason: options.reason };
}

export async function disable(): Promise<ManagementSecretStatus> {
  const record = await read();
  await write({ ...record, enabled: false, hash: "", previousHash: undefined, previousValidUntil: undefined });
  return status();
}

export async function setPolicy(options: { autoRotateHours?: number; graceMinutes?: number }): Promise<ManagementSecretStatus> {
  const record = await read();
  const autoRotateHours = options.autoRotateHours ?? record.autoRotateHours;
  const graceMinutes = options.graceMinutes ?? record.graceMinutes;
  const next: ManagementSecretRecord = { ...record, autoRotateHours, graceMinutes };
  // Keep the schedule consistent with the new interval instead of firing
  // immediately after a policy change.
  if (record.enabled && autoRotateHours > 0) {
    next.nextRotationAt = new Date(Date.now() + autoRotateHours * 3600_000).toISOString();
  }
  if (autoRotateHours <= 0) next.nextRotationAt = undefined;
  await write(next);
  return status();
}

/**
 * Called periodically by the API. Rotates only when the schedule is due, and
 * writes the new value to a root-only file so an operator can always recover
 * access from the terminal even if every administrator loses the value.
 */
export async function maybeAutoRotate(): Promise<{ rotated: boolean; reason?: string }> {
  const record = await read();
  if (!record.enabled || !record.nextRotationAt || record.autoRotateHours <= 0) return { rotated: false };
  if (Date.parse(record.nextRotationAt) > Date.now()) return { rotated: false };
  // Safe rollover (spec §14): a scheduled rotation always leaves a grace
  // window, even if the policy was set to 0. A timer must never be the reason
  // an administrator is locked out.
  const result = await rotate({
    reason: "scheduled",
    graceMinutes: Math.max(record.graceMinutes ?? 0, DEFAULT_GRACE_MINUTES),
  });
  await persistToFile(result.secret);
  return { rotated: true, reason: result.reason };
}

/**
 * Best-effort write of the current value to the root-only recovery file. Never
 * logs the value, and never fails the caller: on a non-Linux/dev host the file
 * simply cannot be written.
 */
export async function persistToFile(secret: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(MANAGEMENT_SECRET_FILE), { recursive: true, mode: 0o750 });
    await writeFile(MANAGEMENT_SECRET_FILE, `${secret}\n`, { mode: 0o600 });
    await chmod(MANAGEMENT_SECRET_FILE, 0o600);
    return true;
  } catch {
    return false;
  }
}
