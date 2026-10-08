/**
 * GRE planning helpers.
 *
 * Linux provides native GRE via iproute2/netlink; Arvoo never implements GRE
 * itself - it plans addressing/MTU and emits typed command descriptors
 * (argv arrays, no shell string concatenation) for the Node Agent to execute.
 */

import { computeMtu, greLayers, type MtuLayer } from "./mtu";
import type { GreOpInput } from "./types";

export function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`Invalid IPv4 octet: ${p}`);
    n = (n * 256 + v) >>> 0;
  }
  return n;
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** First two usable host addresses of a /30 (network+1, network+2). */
export function carve30(network: string): { local: string; remote: string } {
  const [addr, prefix] = network.split("/");
  if (prefix !== "30") throw new Error(`GRE transport network must be a /30, got ${network}`);
  const base = ipToInt(addr!);
  return { local: intToIp(base + 1), remote: intToIp(base + 2) };
}

/** Recommended GRE tunnel MTU for a physical path MTU and its encapsulation stack. */
export function computeGreMtu(
  pathMtu: number,
  opts: { keyed: boolean; ipVersion?: 4 | 6; fou?: boolean; ipsec?: boolean },
) {
  const layers: MtuLayer[] = greLayers({ keyed: opts.keyed, ipVersion: opts.ipVersion ?? 4 });
  // FOU wraps GRE in UDP, so the UDP header sits between the IP header and GRE.
  if (opts.fou) layers.splice(1, 0, { kind: "fou-udp" });
  if (opts.ipsec) layers.push({ kind: "ipsec-esp" });
  return computeMtu({ pathMtu, layers });
}

export interface GrePlanInput {
  interfaceName: string;
  sourceEndpoint: string;
  destEndpoint: string;
  tunnelNetwork: string;
  mtu: number;
  ttl: number;
  key: string | null;
  fouPort: number | null;
  routes: Array<{ destination: string; gateway?: string }>;
}

/**
 * Build the typed command descriptor the agent executes with iproute2.
 * Commands run through execFile with argv arrays - never a shell string.
 */
export function buildGreApplyInput(input: GrePlanInput): GreOpInput {
  const { local, remote } = carve30(input.tunnelNetwork);
  return {
    interfaceName: input.interfaceName,
    localEndpoint: input.sourceEndpoint,
    remoteEndpoint: input.destEndpoint,
    localTunnelIp: local,
    remoteTunnelIp: remote,
    tunnelNetwork: input.tunnelNetwork,
    mtu: input.mtu,
    ttl: input.ttl,
    key: input.key,
    fouPort: input.fouPort,
    routes: input.routes,
  };
}

export function validateGreName(name: string): string | null {
  if (!/^[a-z][a-z0-9-]{2,14}$/.test(name)) {
    return "Interface name must be 3-15 chars, lowercase letters/digits/dashes, starting with a letter.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// GRE keys
// ---------------------------------------------------------------------------
/**
 * GRE carries an optional 32-bit key field (RFC 2890). Control plane, node agent
 * and UI agree on exactly one canonical representation:
 *
 *   lowercase hexadecimal, 1-8 characters, no `0x` prefix, no leading zeros -
 *   the minimal hex spelling of the unsigned 32-bit value.
 *
 * `0` and `ffffffff` are both real keys, so "no key" is null and never the empty
 * string. Operators may type the canonical form case-insensitively, with or
 * without a `0x` prefix; the control plane canonicalises it before storing or
 * queueing it.
 *
 * A decimal integer is NOT a key: 180879361 is what the original generator
 * produced for the tunnel address 10.200.0.1, and the agent - correctly - refused
 * to hand nine decimal digits to the kernel. Use `canonicalGreKeyFromDecimal()`
 * for values written by that generator.
 */
export const GRE_KEY_MAX = 0xffffffff;

/** Canonical form: what the database, the operation queue and the UI carry. */
export const CANONICAL_GRE_KEY_RE = /^[0-9a-f]{1,8}$/;

/** Operator input: the canonical form, case-insensitively, optionally 0x-prefixed. */
export const GRE_KEY_INPUT_RE = /^(?:0[xX])?[0-9a-fA-F]{1,8}$/;

/** Single wording for the rule, shared by the API validator and the node agent. */
export const GRE_KEY_RULE = '1-8 hexadecimal digits (case-insensitive, max "ffffffff"), e.g. "ac80001"';

/** True for the canonical representation (lowercase hex, 1-8 characters). */
export function isValidGreKey(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_GRE_KEY_RE.test(value);
}

/**
 * Canonicalise a key from operator input, a queued payload or a legacy value.
 * Returns null when the value is not a representable 32-bit key. Digits are read
 * as hex digits, which is the only reading consistent with the canonical form.
 */
export function canonicalGreKey(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= GRE_KEY_MAX ? value.toString(16) : null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!GRE_KEY_INPUT_RE.test(raw)) return null;
  const hex = raw.replace(/^0x/i, "").toLowerCase().replace(/^0+/, "");
  return hex === "" ? "0" : hex;
}

/**
 * The argument handed to `ip link add ... key`: iproute2 parses tunnel keys with
 * base 0, so a bare hex string containing letters is rejected and a digits-only
 * string would be read as decimal. `0x` + canonical hex is unambiguous and keeps
 * the exact 32-bit value.
 */
export function greKeyCliValue(key: unknown): string | null {
  const canonical = canonicalGreKey(key);
  return canonical === null ? null : `0x${canonical}`;
}

/** A key built from 4 big-endian bytes (the API uses crypto.randomBytes(4)). */
export function greKeyFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 4) throw new Error("a GRE key is exactly 4 bytes");
  const value = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return value.toString(16);
}

/**
 * Convert a value the pre-0005 generator stored as a DECIMAL integer into the
 * canonical hex form without changing the key: 180879361 and "ac80001" are the
 * same 32-bit key field, only spelled differently. Returns null when the value is
 * not an unsigned 32-bit integer.
 */
export function canonicalGreKeyFromDecimal(value: string | number): string | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(n) || n < 0 || n > GRE_KEY_MAX) return null;
  return n.toString(16);
}

/**
 * Read the key the kernel reports for an interface (`ip -d link show`). Handles
 * both print styles iproute2 has used (`key ac80001`, `key 0xac80001`) without
 * touching `ikey`/`okey`, and returns the canonical form or null when the link
 * dump does not carry a key.
 */
export function greKeyFromLinkShow(stdout: string): string | null {
  const match = stdout.match(/(?:^|\s)key\s+(?:0x)?([0-9a-fA-F]{1,8})(?=\s|$)/);
  if (!match) return null;
  return canonicalGreKey(match[1]);
}
