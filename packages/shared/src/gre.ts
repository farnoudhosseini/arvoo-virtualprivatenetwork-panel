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
