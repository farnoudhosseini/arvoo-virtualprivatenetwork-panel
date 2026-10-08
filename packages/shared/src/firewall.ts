/**
 * Firewall planning (UFW).
 *
 * The plan is built from *real* state - the inbound ports that are actually
 * deployed, the tunnels that actually exist on this node, the SSH port the host
 * listens on and the panel ports behind nginx. Nothing here reads from a mock
 * or invents an "expected" port list: if an inbound is not in the input, its
 * port is not opened.
 *
 * The same pure module is used by:
 *   * the control plane, to preview the plan (`GET /api/v1/firewall/plan`),
 *   * the node agent, to apply it with `ufw` on the node,
 *   * the CLI, to apply it on the master host itself.
 *
 * `ruleToUfwArgs` is the single place where a rule becomes a command line, so
 * preview and reality can never drift apart.
 */

export type FirewallProto = "tcp" | "udp" | "gre" | "esp" | "icmp";

export interface FirewallRule {
  /** Stable identity for diffing two plans (ports + source + protocol). */
  id: string;
  action: "allow";
  proto: FirewallProto;
  /** null for gre/esp/icmp (protocol-only rules). */
  port: number | null;
  /** Source address/CIDR, or null for "any". */
  from: string | null;
  comment: string;
  /** Why this rule exists: ssh, panel, inbound:<name>, tunnel:<name>, icmp, extra. */
  origin: string;
}

export interface FirewallExtraRule {
  port: number | null;
  proto: FirewallProto;
  from: string | null;
  comment: string;
}

export interface FirewallInboundInput {
  name: string;
  port: number;
  proto: "tcp" | "udp";
  /** Inbounds that are not active still get a rule only when `includeInactive`. */
  active: boolean;
}

export interface FirewallTunnelPeerInput {
  name: string;
  /** The peer's public address: only this address may open a GRE/ESP tunnel. */
  peerAddress: string;
  /** IPsec encapsulation requires IKE (udp/500,4500) and ESP from the peer. */
  ipsec: boolean;
  /** GRE-over-FOU encapsulation requires the UDP port from the peer. */
  fouPort: number | null;
}

export interface FirewallPlanInput {
  nodeName: string;
  role: "master" | "node";
  /** SSH ports that must stay reachable (default [22]). */
  sshPorts: number[];
  /** Panel ports served by nginx (master role, default [80, 443]). */
  panelPorts: number[];
  /**
   * Public API port. Null in the standard deployment: the API listens on
   * 127.0.0.1 and nginx is the only public entry point.
   */
  apiPort: number | null;
  /** Addresses/CIDRs allowed to reach SSH (and the panel when `restrictPanel`). */
  adminSources: string[];
  restrictPanel: boolean;
  inbounds: FirewallInboundInput[];
  includeInactiveInbounds: boolean;
  tunnelPeers: FirewallTunnelPeerInput[];
  extraRules: FirewallExtraRule[];
  allowIcmp: boolean;
}

export interface FirewallPlan {
  nodeName: string;
  role: "master" | "node";
  generatedAt: string;
  defaultDenyIncoming: true;
  rules: FirewallRule[];
  /** Ports that become reachable from the internet under this plan. */
  publicPorts: number[];
  warnings: string[];
  hash: string;
}

const PROTO_ORDER: Record<FirewallProto, number> = { tcp: 0, udp: 1, gre: 2, esp: 3, icmp: 4 };

/** RFC 1123 hostname: letters, digits, dashes, dots; no leading/trailing dash. */
export function isValidDomain(domain: string): boolean {
  if (domain.length < 4 || domain.length > 253) return false;
  if (domain !== domain.trim()) return false;
  if (domain.endsWith(".")) return false;
  // Reject IP literals: a domain field holding an IP would silently defeat the
  // "use the domain instead of the address" behaviour and hide DNS problems.
  if (isIPv4(domain)) return false;
  if (domain.includes(":")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
  );
}

export function isIPv4(value: string): boolean {
  const m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? m.slice(1).every((p) => Number(p) <= 255) : false;
}

export function isIPv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    // URL parsing rejects malformed addresses without pulling in a dependency.
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

/** A plan rule's identity: protocol + port + source. */
function ruleId(proto: FirewallProto, port: number | null, from: string | null): string {
  const source = from ?? "any";
  return `${proto}/${port ?? "-"}/${source}`;
}

function makeRule(
  proto: FirewallProto,
  port: number | null,
  from: string | null,
  comment: string,
  origin: string,
): FirewallRule {
  return { id: ruleId(proto, port, from), action: "allow", proto, port, from, comment, origin };
}

const MAX_IPV4_STRING = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

/** Only IPv4 addresses/CIDRs are accepted by the UFW rule builder below. */
function isSource(value: string): boolean {
  if (isIPv4(value)) return true;
  const m = value.match(/^(\d{1,3}\.){3}\d{1,3}\/(\d{1,2})$/);
  if (!m) return false;
  const [addr, prefix] = value.split("/") as [string, string];
  return isIPv4(addr) && Number(prefix) >= 0 && Number(prefix) <= 32;
}

/**
 * Build the firewall plan for one host. Pure: the caller supplies the state.
 * Rules are sorted so two runs over the same state produce the same plan (and
 * therefore the same hash and the same diff).
 */
export function buildFirewallPlan(input: FirewallPlanInput): FirewallPlan {
  const rules: FirewallRule[] = [];
  const warnings: string[] = [];

  const sshPorts = input.sshPorts.length > 0 ? input.sshPorts : [22];
  const adminSources = input.adminSources.filter((s) => isSource(s));
  if (input.adminSources.length > adminSources.length) {
    warnings.push("Some SSH source addresses were ignored: only IPv4 addresses and CIDRs are supported.");
  }

  // --- SSH ---------------------------------------------------------------
  for (const port of sshPorts) {
    if (adminSources.length === 0) {
      rules.push(makeRule("tcp", port, null, "Arvoo managed: SSH (any source)", "ssh"));
    } else {
      for (const src of adminSources) {
        rules.push(makeRule("tcp", port, src, `Arvoo managed: SSH from ${src}`, "ssh"));
      }
    }
  }
  if (adminSources.length === 0) {
    warnings.push(
      "SSH is allowed from any address. Add your administrative address(es) in the firewall policy to restrict it.",
    );
  }

  // --- Panel (master) -----------------------------------------------------
  if (input.role === "master") {
    const panelPorts = input.panelPorts.length > 0 ? input.panelPorts : [80, 443];
    for (const port of panelPorts) {
      if (input.restrictPanel && adminSources.length > 0) {
        for (const src of adminSources) {
          rules.push(makeRule("tcp", port, src, `Arvoo managed: panel from ${src}`, "panel"));
        }
      } else {
        rules.push(makeRule("tcp", port, null, "Arvoo managed: panel (nginx)", "panel"));
      }
    }
    if (panelPorts.length === 0) {
      warnings.push("The panel was expected on ports 80/443 but the policy lists none: the panel would be unreachable.");
    }
  }

  // --- API (only when deliberately exposed) -------------------------------
  if (input.apiPort != null) {
    rules.push(makeRule("tcp", input.apiPort, null, "Arvoo managed: public API", "api"));
    warnings.push(
      `The API port ${input.apiPort} is opened publicly. The default deployment keeps it on 127.0.0.1 behind nginx.`,
    );
  }

  // --- OpenVPN inbounds ---------------------------------------------------
  const inbounds = input.inbounds.filter((i) => i.active || input.includeInactiveInbounds);
  for (const inbound of inbounds) {
    if (!Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) {
      warnings.push(`Inbound "${inbound.name}" has an invalid port (${String(inbound.port)}) and was skipped.`);
      continue;
    }
    rules.push(makeRule(inbound.proto, inbound.port, null, `Arvoo managed: inbound ${inbound.name}`, `inbound:${inbound.name}`));
  }
  const inactiveSkipped = input.inbounds.filter((i) => !i.active).length;
  if (input.role === "node" && inactiveSkipped > 0 && !input.includeInactiveInbounds) {
    warnings.push(
      `${inactiveSkipped} inbound(s) are not active yet; their ports stay closed until they are deployed.`,
    );
  }
  if (input.role === "node" && inbounds.length === 0) {
    warnings.push("No OpenVPN inbound is deployed on this node: enabling UFW now opens no VPN port.");
  }

  // --- GRE / IPsec / FOU tunnels -----------------------------------------
  for (const peer of input.tunnelPeers) {
    if (!isSource(peer.peerAddress)) {
      warnings.push(
        `Tunnel "${peer.name}" has no usable IPv4 peer address (${peer.peerAddress || "empty"}); GRE/OESP rules were not added.`,
      );
      continue;
    }
    if (peer.ipsec) {
      rules.push(makeRule("esp", null, peer.peerAddress, `Arvoo managed: IPsec ESP ${peer.name}`, `tunnel:${peer.name}`));
      rules.push(makeRule("udp", 500, peer.peerAddress, `Arvoo managed: IPsec IKE ${peer.name}`, `tunnel:${peer.name}`));
      rules.push(makeRule("udp", 4500, peer.peerAddress, `Arvoo managed: IPsec NAT-T ${peer.name}`, `tunnel:${peer.name}`));
    }
    if (peer.fouPort != null) {
      rules.push(makeRule("udp", peer.fouPort, peer.peerAddress, `Arvoo managed: FOU ${peer.name}`, `tunnel:${peer.name}`));
    }
    // GRE itself is protocol 47 and is always required for a GRE tunnel, also
    // when it is encapsulated: the inner protocol still has to reach the host.
    rules.push(makeRule("gre", null, peer.peerAddress, `Arvoo managed: GRE ${peer.name}`, `tunnel:${peer.name}`));
  }

  // --- ICMP ---------------------------------------------------------------
  if (input.allowIcmp) {
    rules.push(makeRule("icmp", null, null, "Arvoo managed: ICMP (ping/traceroute)", "icmp"));
  }

  // --- Operator additions -------------------------------------------------
  for (const extra of input.extraRules) {
    if (extra.proto === "tcp" || extra.proto === "udp") {
      if (extra.port == null || !Number.isInteger(extra.port) || extra.port < 1 || extra.port > 65535) {
        warnings.push(`Extra rule for ${extra.proto} was skipped: a port between 1 and 65535 is required.`);
        continue;
      }
    }
    if (extra.from != null && !isSource(extra.from)) {
      warnings.push(`Extra rule on port ${String(extra.port)} was skipped: "${extra.from}" is not an IPv4 address or CIDR.`);
      continue;
    }
    rules.push(makeRule(extra.proto, extra.port, extra.from, extra.comment || "Arvoo managed: operator rule", "extra"));
  }

  // Deduplicate (same protocol/port/source reached from two origins) and sort.
  const merged = new Map<string, FirewallRule>();
  for (const rule of rules) {
    const existing = merged.get(rule.id);
    if (!existing) {
      merged.set(rule.id, rule);
      continue;
    }
    if (!existing.origin.includes(rule.origin)) {
      merged.set(rule.id, { ...existing, origin: `${existing.origin},${rule.origin}` });
    }
  }
  const sorted = [...merged.values()].sort((a, b) => {
    if (PROTO_ORDER[a.proto] !== PROTO_ORDER[b.proto]) return PROTO_ORDER[a.proto] - PROTO_ORDER[b.proto];
    const ap = a.port ?? -1;
    const bp = b.port ?? -1;
    if (ap !== bp) return ap - bp;
    return (a.from ?? "").localeCompare(b.from ?? "");
  });

  const publicPorts = [
    ...new Set(
      sorted
        .filter((r) => r.from === null && r.port != null && (r.proto === "tcp" || r.proto === "udp"))
        .map((r) => r.port as number),
    ),
  ].sort((a, b) => a - b);

  if (!sshPorts.some((p) => Number.isInteger(p) && p > 0 && p < 65536)) {
    warnings.push("No valid SSH port is configured; the plan would lock out remote administration.");
  }

  const base: Omit<FirewallPlan, "hash"> = {
    nodeName: input.nodeName,
    role: input.role,
    generatedAt: new Date().toISOString(),
    defaultDenyIncoming: true,
    rules: sorted,
    publicPorts,
    warnings,
  };
  return { ...base, hash: firewallPlanHash(base) };
}

/**
 * FNV-1a over the canonical rule list. Dependency-free so the agent, the CLI
 * and the control plane all compute the identical value.
 */
export function firewallPlanHash(plan: Omit<FirewallPlan, "hash"> | FirewallPlan): string {
  const canonical = JSON.stringify({
    nodeName: plan.nodeName,
    role: plan.role,
    rules: plan.rules.map((r) => [r.proto, r.port, r.from, r.action]),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Translate a rule into `ufw` arguments.
 *
 * These are the exact argv arrays the agent and CLI execute (no shell), which
 * is why the plan can be previewed byte-for-byte before it is applied.
 */
export function ruleToUfwArgs(rule: FirewallRule, withComment = true): string[] {
  const args: string[] = ["allow"];
  if (rule.proto === "icmp") {
    args.push("proto", "icmp");
  } else if (rule.proto === "gre" || rule.proto === "esp") {
    args.push("proto", rule.proto);
    if (rule.from) args.push("from", rule.from);
  } else if (rule.port != null) {
    if (rule.from) {
      args.push("from", rule.from, "to", "any", "port", String(rule.port), "proto", rule.proto);
    } else {
      args.push(`${rule.port}/${rule.proto}`);
    }
  }
  if (withComment && rule.comment) args.push("comment", rule.comment);
  return args;
}

export function ufwDeleteArgs(rule: FirewallRule): string[] {
  // UFW matches the delete on the rule itself, so the comment is omitted.
  return ["delete", ...ruleToUfwArgs(rule, false)];
}

export interface FirewallPlanDiff {
  added: FirewallRule[];
  removed: FirewallRule[];
  unchanged: FirewallRule[];
}

/** What an "Update UFW" run would change compared to the last applied plan. */
export function diffFirewallPlans(
  previous: FirewallRule[] | null | undefined,
  next: FirewallRule[],
): FirewallPlanDiff {
  const prev = previous ?? [];
  const prevIds = new Map(prev.map((r) => [r.id, r]));
  const nextIds = new Map(next.map((r) => [r.id, r]));
  return {
    added: next.filter((r) => !prevIds.has(r.id)),
    removed: prev.filter((r) => !nextIds.has(r.id)),
    unchanged: next.filter((r) => prevIds.has(r.id)),
  };
}
