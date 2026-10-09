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

// ---------------------------------------------------------------------------
// Reading the data plane back from the kernel (TestTunnel)
// ---------------------------------------------------------------------------

/**
 * What the kernel actually has for one GRE interface, read from
 * `ip -d link show <ifname>`. `-d` is required: the key, ttl and endpoints only
 * appear in the detailed dump, and a probe that cannot see them would have to
 * echo the requested configuration back instead of verifying it.
 *
 * `present: false` (empty/failed dump) is a different failure from "exists but
 * configured differently", and the caller must keep them apart.
 */
export interface GreLinkState {
  present: boolean;
  /** Administrative UP flag from `<...UP...>`; null when the interface is absent. */
  up: boolean | null;
  /** LOWER_UP: false means the GRE peer is not reachable over the public path. */
  carrier: boolean | null;
  localEndpoint: string | null;
  remoteEndpoint: string | null;
  ttl: number | null;
  mtu: number | null;
  /** Canonical key the kernel reports; null when the link carries no key field. */
  key: string | null;
}

const ABSENT_LINK: GreLinkState = {
  present: false,
  up: null,
  carrier: null,
  localEndpoint: null,
  remoteEndpoint: null,
  ttl: null,
  mtu: null,
  key: null,
};

/** Parse the output of `ip -d link show <ifname>`. Never throws on garbage. */
export function greLinkStateFromLinkShow(stdout: string): GreLinkState {
  // Header: "6: gre1@NONE: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1452 ..."
  if (!/^\d+:\s+\S+[@:]/m.test(stdout)) return ABSENT_LINK;

  const flags = (stdout.match(/<([^>]*)>/)?.[1] ?? "").split(/[\s,]+/).filter(Boolean);
  const ttlMatch = stdout.match(/(?:^|\s)ttl\s+(\d+)/);
  const mtuMatch = stdout.match(/(?:^|\s)mtu\s+(\d+)/);
  return {
    present: true,
    up: flags.includes("UP"),
    carrier: flags.includes("LOWER_UP"),
    localEndpoint: stdout.match(/(?:^|\s)local\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? null,
    remoteEndpoint: stdout.match(/(?:^|\s)remote\s+(\d{1,3}(?:\.\d{1,3}){3})/)?.[1] ?? null,
    ttl: ttlMatch ? Number(ttlMatch[1]) : null,
    mtu: mtuMatch ? Number(mtuMatch[1]) : null,
    key: greKeyFromLinkShow(stdout),
  };
}

/** Addresses assigned to an interface as CIDR, from `ip -4 addr show dev <if>`. */
export function tunnelAddressesFromAddrShow(stdout: string): string[] {
  const out: string[] = [];
  for (const match of stdout.matchAll(/^\s*inet\s+(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})/gm)) out.push(match[1]!);
  return out;
}

/** The interface `ip route get <ip>` selects, or null when the lookup printed none. */
export function routeDeviceFromRouteGet(stdout: string): string | null {
  return stdout.match(/(?:^|\s)dev\s+(\S+)/)?.[1] ?? null;
}

/**
 * The configuration the control plane expects on this node. Optional fields
 * that a payload does not carry stay undefined: the corresponding check is then
 * reported as `null` (not verifiable) instead of being silently passed.
 */
export interface ExpectedGreConfig {
  interfaceName: string;
  localEndpoint?: string | null;
  remoteEndpoint?: string | null;
  localTunnelIp?: string | null;
  remoteTunnelIp?: string | null;
  tunnelNetwork?: string | null;
  mtu?: number | null;
  ttl?: number | null;
  /** Canonical key, null for a keyless tunnel; undefined when not carried. */
  key?: string | null;
}

/** What the probe actually observed on the node. */
export interface ObservedGreState {
  link: GreLinkState;
  /** CIDRs currently assigned (`ip -4 addr show dev <if>`); [] when absent. */
  addresses: string[];
  /** Interface `ip route get <remoteTunnelIp>` selects; null when it failed. */
  routeDev: string | null;
  /** Real ICMP result across the tunnel; null when it was not attempted. */
  pingOk: boolean | null;
}

export interface GreVerification {
  /** `ok` is true only when every verifiable check passed. */
  ok: boolean;
  interfacePresent: boolean;
  ifUp: boolean | null;
  carrierUp: boolean | null;
  endpointVerified: boolean | null;
  ttlVerified: boolean | null;
  mtuVerified: boolean | null;
  keyVerified: boolean | null;
  addressVerified: boolean | null;
  routeOk: boolean | null;
  pingOk: boolean | null;
  /** MTU the kernel reports (never the one that was requested). */
  mtuDetected: number | null;
  /** Canonical key the kernel reports, when readable. */
  observedKey: string | null;
  /** Names of the checks that failed (null checks were not verifiable). */
  failedChecks: string[];
  /** One sanitized sentence per failure - IPs, MTU, key; never a secret. */
  failures: string[];
}

/**
 * Compare the expected configuration against the kernel state and the ICMP
 * result. Pure: no I/O, so the "interface exists but the data plane is broken"
 * cases are unit-testable without root and without a real node.
 */
export function verifyGreTunnel(expected: ExpectedGreConfig, observed: ObservedGreState): GreVerification {
  const { link } = observed;
  const name = expected.interfaceName;
  const failedChecks: string[] = [];
  const failures: string[] = [];

  const interfacePresent = link.present;
  const ifUp = link.present ? link.up : null;
  const carrierUp = link.present ? link.carrier : null;

  if (!interfacePresent) {
    failedChecks.push("interface");
    failures.push(`interface ${name} does not exist on this node`);
  } else if (ifUp === false) {
    failedChecks.push("ifUp");
    failures.push(`interface ${name} is administratively down`);
  }

  let endpointVerified: boolean | null = null;
  if (link.present && expected.localEndpoint && expected.remoteEndpoint) {
    endpointVerified = link.localEndpoint === expected.localEndpoint && link.remoteEndpoint === expected.remoteEndpoint;
    if (!endpointVerified) {
      failedChecks.push("endpoint");
      failures.push(
        `kernel has local/remote ${link.localEndpoint ?? "unset"}/${link.remoteEndpoint ?? "unset"}, expected ${expected.localEndpoint}/${expected.remoteEndpoint}`,
      );
    }
  }

  let ttlVerified: boolean | null = null;
  if (link.present && expected.ttl != null) {
    ttlVerified = link.ttl === expected.ttl;
    if (!ttlVerified) {
      failedChecks.push("ttl");
      failures.push(`kernel reports ttl ${link.ttl ?? "unset"}, expected ${expected.ttl}`);
    }
  }

  let mtuVerified: boolean | null = null;
  if (link.present && expected.mtu != null) {
    mtuVerified = link.mtu === expected.mtu;
    if (!mtuVerified) {
      failedChecks.push("mtu");
      failures.push(`kernel reports mtu ${link.mtu ?? "unset"}, expected ${expected.mtu}`);
    }
  }

  let keyVerified: boolean | null = null;
  if (link.present && expected.key !== undefined) {
    if (expected.key === null) {
      keyVerified = link.key === null;
      if (!keyVerified) {
        failedChecks.push("key");
        failures.push(`this tunnel is configured keyless but the kernel installed GRE key 0x${link.key}`);
      }
    } else {
      const want = canonicalGreKey(expected.key);
      keyVerified = want !== null && link.key === want;
      if (!keyVerified) {
        failedChecks.push("key");
        failures.push(`kernel reports GRE key ${link.key === null ? "none" : `0x${link.key}`}, expected 0x${want ?? expected.key}`);
      }
    }
  }

  let addressVerified: boolean | null = null;
  if (link.present && expected.localTunnelIp) {
    const prefix = expected.tunnelNetwork?.match(/\/(\d{1,2})$/)?.[1] ?? null;
    const want = prefix === null ? expected.localTunnelIp : `${expected.localTunnelIp}/${prefix}`;
    addressVerified = observed.addresses.includes(want);
    if (!addressVerified) {
      failedChecks.push("address");
      failures.push(
        `address ${want} is not assigned to ${name} (assigned: ${observed.addresses.length > 0 ? observed.addresses.join(", ") : "none"})`,
      );
    }
  }

  let routeOk: boolean | null = null;
  if (link.present && expected.remoteTunnelIp) {
    routeOk = observed.routeDev === expected.interfaceName;
    if (!routeOk) {
      failedChecks.push("route");
      failures.push(
        `the kernel routes ${expected.remoteTunnelIp} via ${observed.routeDev ?? "no route"} instead of ${name}`,
      );
    }
  }

  const pingOk = observed.pingOk;
  if (pingOk === false && interfacePresent) {
    failedChecks.push("ping");
    failures.push(
      `ICMP to ${expected.remoteTunnelIp ?? "the remote tunnel address"} across ${name} produced no replies` +
        (link.carrier === false ? " and the interface has no carrier" : ""),
    );
  }

  const verified = [endpointVerified, ttlVerified, mtuVerified, keyVerified, addressVerified, routeOk];
  const ok = interfacePresent && ifUp !== false && pingOk !== false && verified.every((check) => check !== false);

  return {
    ok,
    interfacePresent,
    ifUp,
    carrierUp,
    endpointVerified,
    ttlVerified,
    mtuVerified,
    keyVerified,
    addressVerified,
    routeOk,
    pingOk,
    mtuDetected: link.mtu,
    observedKey: link.key,
    failedChecks,
    failures,
  };
}
