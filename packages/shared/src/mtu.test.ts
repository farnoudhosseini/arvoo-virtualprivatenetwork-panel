import { describe, expect, it } from "vitest";
import { computeMtu, computeOpenVpnTunMtu, validateMtuOverride } from "./mtu";
import { computeGreMtu } from "./gre";

describe("MTU engine", () => {
  it("plain OpenVPN over UDP/IPv4 subtracts 52 bytes", () => {
    const r = computeMtu({
      pathMtu: 1500,
      layers: [{ kind: "ip4" }, { kind: "openvpn-udp" }],
    });
    // 20 (IP) + 52 (OpenVPN) = 72 -> 1428
    expect(r.mtu).toBe(1428);
    expect(r.mss).toBe(1388);
    expect(r.warnings).toHaveLength(0);
  });

  it("GRE + OpenVPN UDP stacks overhead", () => {
    const r = computeMtu({
      pathMtu: 1500,
      layers: [{ kind: "gre" }, { kind: "ip4" }, { kind: "openvpn-udp" }],
    });
    // 24 (GRE) + 20 (IP) + 52 (OpenVPN) = 96 -> 1404
    expect(r.mtu).toBe(1404);
    expect(r.explanation.some((l) => l.includes("GRE"))).toBe(true);
  });

  it("keyed GRE adds 4 bytes", () => {
    const plain = computeGreMtu(1500, { keyed: false });
    const keyed = computeGreMtu(1500, { keyed: true });
    expect(keyed.mtu).toBe(plain.mtu - 4);
  });

  it("low path MTU produces a warning", () => {
    const r = computeMtu({
      pathMtu: 1280,
      layers: [{ kind: "gre" }, { kind: "ip4" }, { kind: "openvpn-udp" }, { kind: "tls-crypt" }],
    });
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("TCP transport has larger overhead than UDP", () => {
    const udp = computeOpenVpnTunMtu({
      pathMtu: 1500, transport: "udp", ipVersion: 4, greHopCount: 0, keyedGre: false, tlsMode: "none",
    });
    const tcp = computeOpenVpnTunMtu({
      pathMtu: 1500, transport: "tcp", ipVersion: 4, greHopCount: 0, keyedGre: false, tlsMode: "none",
    });
    expect(tcp.mtu).toBe(udp.mtu - 20);
  });

  it("rejects invalid manual overrides", () => {
    expect(validateMtuOverride(1200, 1500)).toBeNull();
    expect(validateMtuOverride(2000, 1500)).toMatch(/exceeds/);
    expect(validateMtuOverride(12.5, 1500)).toMatch(/integer/);
  });
});
