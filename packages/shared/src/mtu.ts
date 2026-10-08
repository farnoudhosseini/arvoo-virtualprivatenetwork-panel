/**
 * Arvoo MTU / MSS engine.
 *
 * Computes recommended inner (tunnel) MTU and MSS by subtracting the real
 * per-encapsulation overhead of each layer on the path. No universal
 * hard-coded MTU: every value is derived from the detected path MTU and the
 * actual encapsulation stack.
 *
 * Overhead references:
 *  - GRE over IPv4: 20 (IP) + 4 (GRE base) = 24 bytes; GRE key adds 4 bytes.
 *  - OpenVPN in TLS mode over UDP/IPv4 with AEAD ciphers:
 *      20 (IP) + 8 (UDP) + 4 (opcode/peer-id) + 4 (packet-id) + 16 (GCM tag)
 *      = 52 bytes (without tls-crypt/tls-auth).
 *    tls-auth adds 16 bytes HMAC payload; tls-crypt adds 16 (HMAC) + 4? in
 *    practice tls-crypt overhead is 16 (HMAC) + 4 (packet id already counted)
 *    + encrypted packet-id: conservatively 20 extra bytes.
 *  - OpenVPN over TCP adds 20 (TCP) and no explicit-exit-notify.
 *  - IPv6 replaces the 20-byte IP header with 40 bytes.
 */

export type MtuLayerKind =
  | "ip4"
  | "ip6"
  | "gre"
  | "gre-key"
  | "fou-udp"
  | "ipsec-esp"
  | "openvpn-udp"
  | "openvpn-tcp"
  | "tls-auth"
  | "tls-crypt";

export interface MtuLayer {
  kind: MtuLayerKind;
}

export interface MtuEngineInput {
  /** Physical/interface MTU of the outer path (e.g. 1500, or agent-detected). */
  pathMtu: number;
  layers: MtuLayer[];
  /** Extra safety margin subtracted from the result (default 0). */
  safetyMargin?: number;
}

export interface MtuEngineResult {
  mtu: number;
  mss: number | null;
  totalOverhead: number;
  explanation: string[];
  warnings: string[];
}

const LAYER_OVERHEAD: Record<MtuLayerKind, { bytes: number; label: string }> = {
  ip4: { bytes: 20, label: "IPv4 header" },
  ip6: { bytes: 40, label: "IPv6 header" },
  gre: { bytes: 24, label: "GRE encapsulation (IP + GRE header)" },
  "gre-key": { bytes: 4, label: "GRE key field" },
  "fou-udp": { bytes: 8, label: "FOU UDP header" },
  // Transport-mode ESP with AES-GCM: ESP header 8 + IV 8 + trailer/padding up
  // to 4 + ICV 16 + outer IPv4 20 is 56 bytes; used as a conservative bound.
  "ipsec-esp": { bytes: 56, label: "IPsec ESP (AES-GCM, transport mode)" },
  "openvpn-udp": { bytes: 52, label: "OpenVPN over UDP with AEAD cipher" },
  "openvpn-tcp": { bytes: 72, label: "OpenVPN over TCP with AEAD cipher" },
  "tls-auth": { bytes: 16, label: "tls-auth HMAC" },
  "tls-crypt": { bytes: 20, label: "tls-crypt encryption + HMAC" },
};

export function computeMtu(input: MtuEngineInput): MtuEngineResult {
  const explanation: string[] = [];
  const warnings: string[] = [];
  let overhead = 0;

  for (const layer of input.layers) {
    const spec = LAYER_OVERHEAD[layer.kind];
    if (!spec) {
      warnings.push(`Unknown encapsulation layer "${layer.kind}" ignored.`);
      continue;
    }
    overhead += spec.bytes;
    explanation.push(`${spec.label}: -${spec.bytes} bytes`);
  }

  const margin = input.safetyMargin ?? 0;
  if (margin > 0) explanation.push(`Safety margin: -${margin} bytes`);

  let mtu = input.pathMtu - overhead - margin;
  if (mtu < 1200) {
    warnings.push(
      `Computed MTU ${mtu} is below 1200 bytes. Verify the path MTU; "Fragmentation needed" loss will occur if the real path is smaller than assumed.`,
    );
  }
  if (mtu < 576) mtu = 576;
  mtu = Math.min(mtu, 1500);

  // MSS clamps TCP payload: MTU - 40 (IPv4 20 + TCP 20). For IPv6 inner it is
  // -60, but VPN inner addressing is IPv4 in Arvoo V1.
  const mss = mtu - 40 > 0 ? mtu - 40 : null;

  explanation.unshift(`Path MTU ${input.pathMtu} bytes`);
  explanation.push(`Result: MTU ${mtu}, MSS ${mss ?? "n/a"}`);

  return { mtu, mss, totalOverhead: overhead + margin, explanation, warnings };
}

/** Overhead stack for GRE alone. */
export function greLayers(opts: { keyed: boolean; ipVersion: 4 | 6 }): MtuLayer[] {
  return [
    { kind: opts.ipVersion === 6 ? "ip6" : "ip4" },
    { kind: "gre" },
    ...(opts.keyed ? [{ kind: "gre-key" as const }] : []),
  ];
}

/**
 * Recommended OpenVPN tun MTU for a path that may traverse zero or more GRE
 * tunnels before the OpenVPN server.
 */
export function computeOpenVpnTunMtu(opts: {
  pathMtu: number;
  transport: "udp" | "tcp";
  ipVersion: 4 | 6;
  greHopCount: number;
  keyedGre: boolean;
  tlsMode: "tls-crypt" | "tls-auth" | "none";
  safetyMargin?: number;
}): MtuEngineResult {
  const layers: MtuLayer[] = [];
  for (let i = 0; i < opts.greHopCount; i++) {
    layers.push(...greLayers({ keyed: opts.keyedGre && i === 0, ipVersion: opts.ipVersion }));
  }
  layers.push({ kind: opts.ipVersion === 6 ? "ip6" : "ip4" });
  layers.push({ kind: opts.transport === "udp" ? "openvpn-udp" : "openvpn-tcp" });
  if (opts.tlsMode === "tls-auth") layers.push({ kind: "tls-auth" });
  if (opts.tlsMode === "tls-crypt") layers.push({ kind: "tls-crypt" });

  return computeMtu({ pathMtu: opts.pathMtu, layers, safetyMargin: opts.safetyMargin });
}

/** Validate a manual MTU override. */
export function validateMtuOverride(value: number, pathMtu: number): string | null {
  if (!Number.isInteger(value) || value < 576 || value > 16000) {
    return "MTU must be an integer between 576 and 16000.";
  }
  if (value > pathMtu) {
    return `MTU ${value} exceeds the detected path MTU ${pathMtu}; traffic larger than the path will be dropped or fragmented.`;
  }
  return null;
}
