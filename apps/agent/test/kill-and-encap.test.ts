import { describe, expect, it } from "vitest";
import { validateOperationInput } from "../src/validate-op.js";
import { parseIperfMbps } from "../src/ops.js";

describe("KillClient validation", () => {
  const ok = { inboundName: "ovpn-ir-01", commonName: "alice.laptop" };

  it("accepts a normal inbound and common name", () => {
    expect(validateOperationInput("KillClient", ok)).toBeNull();
  });

  it("rejects whitespace and newlines that would inject management commands", () => {
    expect(validateOperationInput("KillClient", { ...ok, commonName: "alice\nkill bob" })).not.toBeNull();
    expect(validateOperationInput("KillClient", { ...ok, commonName: "alice bob" })).not.toBeNull();
  });

  it("rejects an unsafe inbound name", () => {
    expect(validateOperationInput("KillClient", { ...ok, inboundName: "../etc" })).not.toBeNull();
  });
});

describe("GRE over FOU validation", () => {
  const gre = {
    interfaceName: "gre-ir-01",
    localEndpoint: "203.0.113.10",
    remoteEndpoint: "198.51.100.20",
    localTunnelIp: "10.10.0.1",
    remoteTunnelIp: "10.10.0.2",
    tunnelNetwork: "10.10.0.0/30",
    mtu: 1400,
    ttl: 255,
    key: null,
    routes: [],
  };

  it("accepts raw GRE and GRE over FOU", () => {
    expect(validateOperationInput("CreateGRE", { ...gre, fouPort: null })).toBeNull();
    expect(validateOperationInput("CreateGRE", { ...gre, fouPort: 5555 })).toBeNull();
  });

  it("rejects privileged or out-of-range FOU ports", () => {
    expect(validateOperationInput("CreateGRE", { ...gre, fouPort: 80 })).not.toBeNull();
    expect(validateOperationInput("CreateGRE", { ...gre, fouPort: 70000 })).not.toBeNull();
  });
});

describe("IPsec and benchmark validation", () => {
  it("rejects a PSK containing whitespace or control characters", () => {
    const base = { interfaceName: "gre-ir-01", localPublicIp: "203.0.113.10", remotePublicIp: "198.51.100.20" };
    expect(validateOperationInput("ApplyIPsec", { ...base, psk: "abcdefghijklmnop" })).toBeNull();
    expect(validateOperationInput("ApplyIPsec", { ...base, psk: "short" })).not.toBeNull();
    expect(validateOperationInput("ApplyIPsec", { ...base, psk: "abcdefgh ijklmnop" })).not.toBeNull();
  });

  it("bounds ping and iperf durations", () => {
    const base = { interfaceName: "gre-ir-01", localTunnelIp: "10.10.0.1", remoteTunnelIp: "10.10.0.2" };
    expect(validateOperationInput("RunBenchmark", { ...base, pingCount: 20, iperfSeconds: 5 })).toBeNull();
    expect(validateOperationInput("RunBenchmark", { ...base, pingCount: 0 })).not.toBeNull();
    expect(validateOperationInput("RunBenchmark", { ...base, iperfSeconds: 3600 })).not.toBeNull();
  });
});

describe("iperf3 result parsing", () => {
  it("reads received throughput in Mbps from iperf3 JSON", () => {
    const json = JSON.stringify({ end: { sum_received: { bits_per_second: 780_000_000 } } });
    expect(parseIperfMbps(json)).toBe(780);
  });

  it("returns null for empty, invalid or incomplete output instead of guessing", () => {
    expect(parseIperfMbps("")).toBeNull();
    expect(parseIperfMbps("not json")).toBeNull();
    expect(parseIperfMbps(JSON.stringify({ end: {} }))).toBeNull();
  });
});
