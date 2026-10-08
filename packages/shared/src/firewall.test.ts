import { describe, expect, it } from "vitest";
import {
  buildFirewallPlan,
  diffFirewallPlans,
  firewallPlanHash,
  isIPv4,
  isIPv6,
  isValidDomain,
  ruleToUfwArgs,
  ufwDeleteArgs,
  type FirewallRule,
} from "./firewall.js";

const base = {
  nodeName: "ir-01",
  role: "node" as const,
  sshPorts: [22],
  panelPorts: [80, 443],
  apiPort: null,
  adminSources: [],
  restrictPanel: false,
  inbounds: [],
  includeInactiveInbounds: false,
  tunnelPeers: [],
  extraRules: [],
  allowIcmp: true,
};

describe("firewall plan", () => {
  it("opens SSH, ICMP and every deployed inbound port, and nothing else", () => {
    const plan = buildFirewallPlan({
      ...base,
      inbounds: [
        { name: "ovpn-udp", port: 1194, proto: "udp", active: true },
        { name: "ovpn-tcp", port: 443, proto: "tcp", active: true },
      ],
    });
    const ids = plan.rules.map((r) => `${r.proto}:${r.port}:${r.from ?? "any"}`);
    expect(ids).toContain("tcp:22:any");
    expect(ids).toContain("udp:1194:any");
    expect(ids).toContain("tcp:443:any");
    expect(ids).toContain("icmp:null:any");
    // A node does not serve the panel.
    expect(plan.rules.some((r) => r.origin === "panel")).toBe(false);
    // The API port stays closed unless it was deliberately exposed.
    expect(plan.rules.some((r) => r.origin === "api")).toBe(false);
    expect(plan.publicPorts).toEqual([22, 443, 1194]);
  });

  it("keeps undeployed inbounds closed and says so", () => {
    const plan = buildFirewallPlan({
      ...base,
      inbounds: [{ name: "draft", port: 1194, proto: "udp", active: false }],
    });
    expect(plan.rules.some((r) => r.port === 1194)).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/not active yet|No OpenVPN inbound/i);
  });

  it("opens the panel ports only on the master host", () => {
    const plan = buildFirewallPlan({ ...base, role: "master" });
    const panel = plan.rules.filter((r) => r.origin === "panel");
    expect(panel.map((r) => r.port).sort()).toEqual([443, 80]);
    expect(panel.every((r) => r.from === null)).toBe(true);
  });

  it("restricts SSH and the panel to the administrative sources when configured", () => {
    const plan = buildFirewallPlan({
      ...base,
      role: "master",
      adminSources: ["203.0.113.9", "198.51.100.0/24"],
      restrictPanel: true,
    });
    const ssh = plan.rules.filter((r) => r.origin === "ssh");
    expect(ssh.map((r) => r.from).sort()).toEqual(["198.51.100.0/24", "203.0.113.9"]);
    expect(plan.rules.filter((r) => r.origin === "panel").every((r) => r.from !== null)).toBe(true);
    // Nothing is reachable from the whole internet any more.
    expect(plan.publicPorts).toEqual([]);
  });

  it("adds GRE, IPsec and FOU rules per tunnel peer", () => {
    const plan = buildFirewallPlan({
      ...base,
      tunnelPeers: [
        { name: "gre-1", peerAddress: "198.51.100.20", ipsec: false, fouPort: 5555 },
        { name: "gre-2", peerAddress: "203.0.113.30", ipsec: true, fouPort: null },
      ],
    });
    expect(plan.rules.some((r) => r.proto === "gre" && r.from === "198.51.100.20")).toBe(true);
    expect(plan.rules.some((r) => r.proto === "udp" && r.port === 5555 && r.from === "198.51.100.20")).toBe(true);
    expect(plan.rules.some((r) => r.proto === "esp" && r.from === "203.0.113.30")).toBe(true);
    expect(plan.rules.some((r) => r.proto === "udp" && r.port === 500 && r.from === "203.0.113.30")).toBe(true);
    expect(plan.rules.some((r) => r.proto === "udp" && r.port === 4500 && r.from === "203.0.113.30")).toBe(true);
  });

  it("warns about a tunnel peer without a usable address instead of opening GRE to the world", () => {
    const plan = buildFirewallPlan({
      ...base,
      tunnelPeers: [{ name: "gre-x", peerAddress: "", ipsec: false, fouPort: null }],
    });
    expect(plan.rules.some((r) => r.proto === "gre")).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/no usable IPv4 peer address/i);
  });

  it("publishes a stable hash for identical state and a different one after a change", () => {
    const a = buildFirewallPlan({ ...base, inbounds: [{ name: "i", port: 1194, proto: "udp", active: true }] });
    const b = buildFirewallPlan({ ...base, inbounds: [{ name: "i", port: 1194, proto: "udp", active: true }] });
    const c = buildFirewallPlan({ ...base, inbounds: [{ name: "i", port: 1195, proto: "udp", active: true }] });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(firewallPlanHash(a)).toBe(a.hash);
  });

  it("diffs two plans so an update knows what to withdraw", () => {
    const before = buildFirewallPlan({ ...base, inbounds: [{ name: "i", port: 1194, proto: "udp", active: true }] });
    const after = buildFirewallPlan({ ...base, inbounds: [{ name: "i", port: 1195, proto: "udp", active: true }] });
    const diff = diffFirewallPlans(before.rules, after.rules);
    expect(diff.added.map((r) => r.port)).toEqual([1195]);
    expect(diff.removed.map((r) => r.port)).toEqual([1194]);
    expect(diff.unchanged.length).toBeGreaterThan(0);
  });

  it("warns when no administrative source is configured", () => {
    const plan = buildFirewallPlan({ ...base });
    expect(plan.warnings.join(" ")).toMatch(/SSH is allowed from any address/i);
  });
});

describe("ufw command rendering", () => {
  const rule = (r: Partial<FirewallRule>): FirewallRule => ({
    id: "x",
    action: "allow",
    proto: "tcp",
    port: 22,
    from: null,
    comment: "c",
    origin: "ssh",
    ...r,
  });

  it("renders exactly the argv the agent executes", () => {
    expect(ruleToUfwArgs(rule({}))).toEqual(["allow", "22/tcp", "comment", "c"]);
    expect(ruleToUfwArgs(rule({ port: 1194, proto: "udp" }))).toEqual(["allow", "1194/udp", "comment", "c"]);
    expect(ruleToUfwArgs(rule({ from: "198.51.100.7" }))).toEqual([
      "allow",
      "from",
      "198.51.100.7",
      "to",
      "any",
      "port",
      "22",
      "proto",
      "tcp",
      "comment",
      "c",
    ]);
    expect(ruleToUfwArgs(rule({ proto: "gre", port: null, from: "198.51.100.7" }))).toEqual([
      "allow",
      "proto",
      "gre",
      "from",
      "198.51.100.7",
      "comment",
      "c",
    ]);
    expect(ruleToUfwArgs(rule({ proto: "icmp", port: null, from: null }))).toEqual(["allow", "proto", "icmp", "comment", "c"]);
  });

  it("deletes the same rule it added, without the comment", () => {
    expect(ufwDeleteArgs(rule({}))).toEqual(["delete", "allow", "22/tcp"]);
    expect(ufwDeleteArgs(rule({ proto: "esp", port: null, from: "203.0.113.1" }))).toEqual([
      "delete",
      "allow",
      "proto",
      "esp",
      "from",
      "203.0.113.1",
    ]);
  });
});

describe("address and domain validation", () => {
  it("accepts real DNS names and rejects IPs, single labels and bad characters", () => {
    expect(isValidDomain("vpn.example.com")).toBe(true);
    expect(isValidDomain("vpn-1.example.co.uk")).toBe(true);
    expect(isValidDomain("10.0.0.5")).toBe(false);
    expect(isValidDomain("localhost")).toBe(false);
    expect(isValidDomain("vpn..example.com")).toBe(false);
    expect(isValidDomain("-vpn.example.com")).toBe(false);
    expect(isValidDomain("vpn_example.com")).toBe(false);
    expect(isValidDomain("vpn.example.com.")).toBe(false);
    expect(isValidDomain("2001:db8::1")).toBe(false);
  });

  it("separates IPv4 from IPv6", () => {
    expect(isIPv4("203.0.113.7")).toBe(true);
    expect(isIPv4("203.0.113.999")).toBe(false);
    expect(isIPv6("2001:db8::1")).toBe(true);
    expect(isIPv6("203.0.113.7")).toBe(false);
  });
});
