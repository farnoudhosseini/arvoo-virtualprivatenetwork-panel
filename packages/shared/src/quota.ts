/**
 * Quota & usage accounting math (pure functions, unit tested).
 */

export interface UsageInput {
  rxBytes: number;
  txBytes: number;
  /** Effective multiplier (base * policy multipliers). */
  multiplier: number;
}

export function billedBytes(input: UsageInput): number {
  const raw = Math.max(0, input.rxBytes) + Math.max(0, input.txBytes);
  return Math.round(raw * input.multiplier);
}

export interface QuotaState {
  quotaBytes: number | null;
  usedBytes: number;
  remainingBytes: number | null;
  usedPct: number | null;
  exceeded: boolean;
}

export function trafficQuotaState(usedBilledBytes: number, quotaBytes: number | null): QuotaState {
  if (quotaBytes == null) {
    return { quotaBytes: null, usedBytes: usedBilledBytes, remainingBytes: null, usedPct: null, exceeded: false };
  }
  const remaining = Math.max(0, quotaBytes - usedBilledBytes);
  return {
    quotaBytes,
    usedBytes: usedBilledBytes,
    remainingBytes: remaining,
    usedPct: quotaBytes > 0 ? Math.min(100, (usedBilledBytes / quotaBytes) * 100) : usedBilledBytes > 0 ? 100 : 0,
    exceeded: usedBilledBytes >= quotaBytes,
  };
}

export interface TimeQuotaState {
  quotaSec: number | null;
  usedSec: number;
  remainingSec: number | null;
  usedPct: number | null;
  exceeded: boolean;
}

export function timeQuotaState(usedSec: number, quotaSec: number | null): TimeQuotaState {
  if (quotaSec == null) {
    return { quotaSec: null, usedSec, remainingSec: null, usedPct: null, exceeded: false };
  }
  return {
    quotaSec,
    usedSec,
    remainingSec: Math.max(0, quotaSec - usedSec),
    usedPct: quotaSec > 0 ? Math.min(100, (usedSec / quotaSec) * 100) : usedSec > 0 ? 100 : 0,
    exceeded: usedSec >= quotaSec,
  };
}

export function isExpired(expiresAt: string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}

export function isStarted(startsAt: string | null, now: Date = new Date()): boolean {
  if (!startsAt) return true;
  return new Date(startsAt).getTime() <= now.getTime();
}
