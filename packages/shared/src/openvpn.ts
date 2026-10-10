/**
 * OpenVPN server configuration generator.
 *
 * Produces a deterministic server configuration from a structured config
 * object. The generator reasons about transport, encapsulation and the chosen
 * performance profile; it never invents undocumented options. Inline PKI
 * material is NOT embedded here - the agent writes cert/key files next to the
 * config on the node.
 */

import type {
  OpenVPNStructuredConfig,
  PerformanceProfile,
  OpenVPNAuthMode,
} from "./types";

export interface ProfileNotes {
  label: string;
  rationale: string;
}

export const PERFORMANCE_PROFILES: Record<PerformanceProfile, ProfileNotes> = {
  balanced: {
    label: "Balanced",
    rationale:
      "Safe general-purpose defaults: sane socket buffers, standard keepalive. Works on UDP or TCP.",
  },
  "low-latency": {
    label: "Low Latency",
    rationale:
      "Minimises RTT: tcp-nodelay, modest buffers, tight keepalive, fast-io on UDP. Best for interactive use.",
  },
  throughput: {
    label: "High Throughput",
    rationale:
      "Maximises Mbps: large socket buffers (512KB), longer keepalive. Prefer for downloads on stable links.",
  },
  "tcp-boost": {
    label: "TCP Boost",
    rationale:
      "Optimised for TCP transport under restrictive networks (e.g. UDP blocked): large buffers, TCP_NODELAY, tuned MSS/MTU for tunnel overhead.",
  },
  compatibility: {
    label: "Compatibility",
    rationale:
      "Maximum client compatibility: conservative TLS settings, AES-256-CBC fallback cipher, tls-auth instead of tls-crypt.",
  },
};

export const SUPPORTED_DATA_CIPHERS = [
  "AES-256-GCM",
  "AES-128-GCM",
  "CHACHA20-POLY1305",
] as const;

export const COMPAT_CIPHERS = [...SUPPORTED_DATA_CIPHERS, "AES-256-CBC"] as const;

export interface ProfileAdjustments {
  sndbuf: number;
  rcvbuf: number;
  keepaliveInterval: number;
  keepaliveTimeout: number;
  fastIo: boolean;
  tcpNodelay: boolean;
  explicitExitNotify: boolean;
  tlsMode: "tls-crypt" | "tls-auth" | "none";
  /** Preferred tun-mtu hint for this profile (null = leave config value). */
  preferredTunMtu: number | null;
  preferredMssFix: number | null;
  txqueuelen: number;
}

export function profileAdjustments(profile: PerformanceProfile): ProfileAdjustments {
  switch (profile) {
    case "low-latency":
      return {
        sndbuf: 212992,
        rcvbuf: 212992,
        keepaliveInterval: 5,
        keepaliveTimeout: 30,
        fastIo: true,
        tcpNodelay: true,
        explicitExitNotify: true,
        tlsMode: "tls-crypt",
        preferredTunMtu: 1400,
        preferredMssFix: 1360,
        txqueuelen: 100,
      };
    case "throughput":
      return {
        sndbuf: 1048576,
        rcvbuf: 1048576,
        keepaliveInterval: 10,
        keepaliveTimeout: 120,
        fastIo: true,
        tcpNodelay: true,
        explicitExitNotify: true,
        tlsMode: "tls-crypt",
        preferredTunMtu: 1400,
        preferredMssFix: 1360,
        txqueuelen: 500,
      };
    case "tcp-boost":
      // Tuned for TCP-only paths (UDP filtered). Large buffers + nodelay reduce
      // ACK compression delay; MSS/MTU leave headroom for GRE+OpenVPN overhead.
      return {
        sndbuf: 1048576,
        rcvbuf: 1048576,
        keepaliveInterval: 8,
        keepaliveTimeout: 45,
        fastIo: false, // fast-io is UDP-only
        tcpNodelay: true,
        explicitExitNotify: false,
        tlsMode: "tls-crypt",
        preferredTunMtu: 1360,
        preferredMssFix: 1320,
        txqueuelen: 1000,
      };
    case "compatibility":
      return {
        sndbuf: 0,
        rcvbuf: 0,
        keepaliveInterval: 10,
        keepaliveTimeout: 60,
        fastIo: false,
        tcpNodelay: false,
        explicitExitNotify: false,
        tlsMode: "tls-auth",
        preferredTunMtu: null,
        preferredMssFix: null,
        txqueuelen: 100,
      };
    case "balanced":
    default:
      return {
        sndbuf: 393216,
        rcvbuf: 393216,
        keepaliveInterval: 10,
        keepaliveTimeout: 60,
        fastIo: true,
        tcpNodelay: true,
        explicitExitNotify: true,
        tlsMode: "tls-crypt",
        preferredTunMtu: 1400,
        preferredMssFix: 1360,
        txqueuelen: 200,
      };
  }
}

function ipNet(network: string): { addr: string; mask: string } {
  // "10.40.0.0/24" -> addr "10.40.0.0", mask "255.255.255.0"
  const [addr, prefixStr] = network.split("/");
  const prefix = Number(prefixStr ?? "24");
  if (!addr || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) {
    throw new Error(`Invalid server network: ${network}`);
  }
  const bits = 0xffffffff << (32 - prefix);
  const mask = [(bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join(".");
  return { addr, mask };
}

/**
 * Generate the OpenVPN server configuration text.
 * `openvpnVersion` is the version reported by the node agent - kept in the
 * header for auditability. The generated directives are valid for OpenVPN 2.5+.
 */
export function generateOpenVPNServerConfig(
  cfg: OpenVPNStructuredConfig,
  ctx: { openvpnVersion?: string | null; inboundName: string; configDir: string },
): string {
  const adj = profileAdjustments(cfg.performanceProfile);
  const tlsMode = cfg.tlsMode === "none" ? adj.tlsMode : cfg.tlsMode;
  const net = ipNet(cfg.serverNetwork);
  const lines: string[] = [];

  const push = (s = "") => lines.push(s);

  push(`# ---------------------------------------------------------------`);
  push(`# Arvoo generated OpenVPN server configuration`);
  push(`# Inbound:  ${ctx.inboundName}`);
  push(`# Version:  generated ${new Date().toISOString()}`);
  push(`# Profile:  ${PERFORMANCE_PROFILES[cfg.performanceProfile].label} - ${PERFORMANCE_PROFILES[cfg.performanceProfile].rationale}`);
  if (ctx.openvpnVersion) push(`# Node OpenVPN version: ${ctx.openvpnVersion}`);
  push(`# Do not edit by hand: regenerate from the Arvoo control plane.`);
  push(`# ---------------------------------------------------------------`);
  push();

  push(`# --- Core ---`);
  push(`port ${cfg.port}`);
  // Omit `local 0.0.0.0` — OpenVPN then binds all interfaces; an explicit
  // 0.0.0.0 has been observed to confuse some builds / ss checks.
  if (cfg.listenAddress && cfg.listenAddress !== "0.0.0.0") {
    push(`local ${cfg.listenAddress}`);
  }
  push(`proto ${cfg.transport === "udp" ? "udp4" : "tcp4"}`);
  push(`dev ${cfg.device}`);
  push(`topology ${cfg.topology}`);
  push(`server ${net.addr} ${net.mask}`);
  push();
  if (cfg.deploymentMode === "through-tunnel") {
    push(`# --- Egress routing (through-tunnel deployment) ---`);
    push(`# Client traffic is routed out through the GRE tunnel on this node.`);
    push(`# Forwarding/NAT for ${cfg.serverNetwork} is provisioned by the Arvoo agent.`);
    push();
  }

  const authMode = cfg.authMode ?? "certificate";

  push(`# --- PKI ---`);
  push(`ca ${ctx.configDir}/pki/ca.crt`);
  push(`cert ${ctx.configDir}/pki/server.crt`);
  push(`key ${ctx.configDir}/pki/server.key`);
  // ECDH only — no discrete-log DH file. Required by OpenVPN when --dh is omitted
  // (otherwise: "Options error: You must define DH file (--dh)").
  push(`dh none`);
  if (tlsMode === "tls-crypt") push(`tls-crypt ${ctx.configDir}/pki/tls-crypt.key`);
  if (tlsMode === "tls-auth") push(`tls-auth ${ctx.configDir}/pki/tls-auth.key 0`);
  if (authMode === "password") {
    // Username/password is the only factor; the client certificate is accepted
    // but not required (CERT_REQUIRED would defeat password-only deployments).
    push(`verify-client-cert optional`);
  } else {
    push(`verify-client-cert require`);
  }
  push(`remote-cert-tls client`);
  push(`tls-version-min ${cfg.tlsVersionMin}`);
  push();

  push(`# --- Cryptography ---`);
  push(`data-ciphers ${cfg.dataCiphers.join(":")}`);
  if (cfg.fallbackCipher) push(`data-ciphers-fallback ${cfg.fallbackCipher}`);
  push(`auth ${cfg.authDigest}`);
  if (cfg.compression === "off") {
    push(`# Compression disabled: CRIME/BREACH-style attacks and wasted CPU.`);
  }
  push();

  push(`# --- Performance ---`);
  const tunMtu = cfg.tunMtu || adj.preferredTunMtu || 1400;
  const mssFix = cfg.mssFix ?? adj.preferredMssFix;
  push(`tun-mtu ${tunMtu}`);
  if (mssFix != null) push(`mssfix ${mssFix}`);
  if (cfg.fragment != null) push(`fragment ${cfg.fragment}`);
  // Always set socket buffers for TCP and for throughput-oriented profiles.
  if (adj.sndbuf > 0) {
    push(`sndbuf ${adj.sndbuf}`);
    push(`rcvbuf ${adj.rcvbuf}`);
    push(`push "sndbuf ${adj.sndbuf}"`);
    push(`push "rcvbuf ${adj.rcvbuf}"`);
  }
  if (adj.txqueuelen > 0) push(`txqueuelen ${adj.txqueuelen}`);
  if (adj.fastIo && cfg.transport === "udp") push(`fast-io`);
  // TCP_NODELAY is critical on TCP transport under high RTT (e.g. IR↔TR).
  if (adj.tcpNodelay && cfg.transport === "tcp") push(`tcp-nodelay`);
  push(`keepalive ${cfg.keepaliveInterval} ${cfg.keepaliveTimeout}`);
  if (cfg.transport === "udp" && adj.explicitExitNotify) push(`explicit-exit-notify 1`);
  push();

  push(`# --- Client routing ---`);
  if (cfg.redirectGateway) push(`push "redirect-gateway def1 bypass-dhcp"`);
  for (const r of cfg.pushRoutes) push(`push "route ${r}"`);
  for (const dns of cfg.dnsServers) push(`push "dhcp-option DNS ${dns}"`);
  // Windows OpenVPN Connect: force VPN DNS so DoH/YouTube does not bypass the tunnel.
  push(`push "block-outside-dns"`);
  if (cfg.clientToClient) push(`client-to-client`);
  push();

  push(`# --- Security / hardening ---`);
  // Do NOT drop to nobody: auth-user-pass-verify hooks must read node-secret
  // and reach the control plane. Privilege drop is left to systemd hardening.
  push(`persist-key`);
  push(`persist-tun`);
  push(`max-clients ${cfg.maxClients}`);
  if (cfg.duplicateCn) push(`duplicate-cn`);
  push();

  push(`# --- Client admission (Arvoo enforcement hooks) ---`);
  push(`script-security 2`);
  if (authMode !== "certificate") {
    // The node verifies username/password against hashes pushed by the control
    // plane; the plaintext password exists only inside this TLS session.
    push(`auth-user-pass-verify ${ctx.configDir}/hooks/auth-user-pass via-file`);
    push(`username-as-common-name`);
  }
  push(`client-connect ${ctx.configDir}/hooks/client-connect`);
  push(`client-disconnect ${ctx.configDir}/hooks/client-disconnect`);
  push();

  push(`# --- Logging / status ---`);
  // status-version 3 produces CLIENT_LIST CSV that the agent parses for usage.
  push(`status /var/log/arvoo/openvpn/${ctx.inboundName}/status.log 1`);
  push(`status-version 3`);
  push(`management /run/arvoo/openvpn/${ctx.inboundName}/mgmt.sock unix`);
  push(`log-append /var/log/arvoo/openvpn/${ctx.inboundName}/openvpn.log`);
  push(`verb ${cfg.logVerbosity}`);
  push();

  return lines.join("\n");
}

/**
 * Format raw entropy as an OpenVPN static key (V1).
 *
 * OpenVPN requires exactly this format for `tls-auth`/`tls-crypt` keys - a raw
 * blob or a hex string is rejected at start-up - so both the server key file
 * and the inline key in client profiles are produced from here.
 */
export function formatStaticKeyV1(raw: Buffer): string {
  if (raw.length !== 256) {
    throw new Error(`An OpenVPN static key must be exactly 256 bytes (got ${raw.length})`);
  }
  const hex = raw.toString("hex");
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 32) lines.push(hex.slice(i, i + 32));
  return [
    "#",
    "# 2048 bit OpenVPN static key",
    "#",
    "-----BEGIN OpenVPN Static key V1-----",
    ...lines,
    "-----END OpenVPN Static key V1-----",
    "",
  ].join("\n");
}

/** True when the text is a usable OpenVPN static key file. */
export function isStaticKeyV1(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    text.includes("-----BEGIN OpenVPN Static key V1-----") &&
    text.includes("-----END OpenVPN Static key V1-----")
  );
}

/**
 * Generate a client .ovpn profile with inline PKI material.
 */
export function generateClientOvpn(opts: {
  /** Domain when configured, otherwise the node's real address. */
  serverAddress: string;
  /**
   * The exact CN the generated server certificate carries. Pinning the wrong
   * name makes every client refuse the server, so the control plane passes the
   * same value the PKI service put into the certificate.
   */
  verifyX509Name?: string;
  /** Client authentication mode; password modes add `auth-user-pass`. */
  authMode?: OpenVPNAuthMode;
  port: number;
  transport: "udp" | "tcp";
  ca: string;
  cert: string;
  key: string;
  tlsMode: "tls-crypt" | "tls-auth" | "none";
  tlsKey: string | null;
  tlsVersionMin: "1.2" | "1.3";
  dataCiphers: string[];
  fallbackCipher: string | null;
  authDigest: string;
  tunMtu: number;
  mssFix: number | null;
  redirectGateway: boolean;
  dnsServers: string[];
  pushRoutes: string[];
  profileName: string;
}): string {
  const inline = (name: string, body: string) =>
    `<${name}>\n${body.trim()}\n</${name}>\n`;

  const lines: string[] = [];
  lines.push(`# Arvoo client profile: ${opts.profileName}`);
  lines.push(`client`);
  lines.push(`dev tun`);
  lines.push(`proto ${opts.transport}`);
  lines.push(`remote ${opts.serverAddress} ${opts.port}`);
  lines.push(`resolv-retry infinite`);
  lines.push(`nobind`);
  lines.push(`persist-key`);
  lines.push(`persist-tun`);
  lines.push(`remote-cert-tls server`);
  // Explicit "name" type: match the certificate Common Name. OpenVPN Connect
  // (OpenVPN 3) is strict about this; omitting the type or quoting incorrectly
  // produces "Peer certificate verification failure".
  const x509Name = opts.verifyX509Name ?? "server-name";
  lines.push(`verify-x509-name "${x509Name}" name`);
  lines.push(`tls-version-min ${opts.tlsVersionMin}`);
  lines.push(`data-ciphers ${opts.dataCiphers.join(":")}`);
  if (opts.fallbackCipher) lines.push(`data-ciphers-fallback ${opts.fallbackCipher}`);
  lines.push(`auth ${opts.authDigest}`);
  lines.push(`tun-mtu ${opts.tunMtu}`);
  if (opts.mssFix != null) lines.push(`mssfix ${opts.mssFix}`);
  if (opts.redirectGateway) lines.push(`redirect-gateway def1 bypass-dhcp`);
  for (const dns of opts.dnsServers) lines.push(`dhcp-option DNS ${dns}`);
  lines.push(`block-outside-dns`);
  for (const r of opts.pushRoutes) lines.push(`route ${r}`);
  if (opts.authMode === "password" || opts.authMode === "certificate+password") {
    // Prompts for the OpenVPN username/password issued in the panel. These are
    // not the panel login and not the node identity.
    lines.push(`auth-user-pass`);
  }
  lines.push(`verb 3`);
  lines.push(``);
  lines.push(inline("ca", opts.ca));
  lines.push(inline("cert", opts.cert));
  lines.push(inline("key", opts.key));
  // Inline blocks are the directive themselves — do not emit a bare
  // `tls-crypt` / `tls-auth` line before the block (invalid for OpenVPN Connect).
  if (opts.tlsMode === "tls-crypt" && opts.tlsKey) {
    lines.push(inline("tls-crypt", opts.tlsKey));
  }
  if (opts.tlsMode === "tls-auth" && opts.tlsKey) {
    lines.push(`key-direction 1`);
    lines.push(inline("tls-auth", opts.tlsKey));
  }
  return lines.join("\n");
}
