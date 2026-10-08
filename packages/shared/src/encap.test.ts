import { describe, expect, it } from "vitest";
import { computeGreMtu } from "./gre";
import { generateOpenVPNServerConfig } from "./openvpn";
import type { OpenVPNStructuredConfig } from "./types";

describe("GRE encapsulation MTU", () => {
  it("raw GRE subtracts the outer IPv4 header and the GRE header (20 + 24)", () => {
    expect(computeGreMtu(1500, { keyed: false }).mtu).toBe(1456);
  });

  it("FOU adds the 8-byte UDP header on top of GRE", () => {
    expect(computeGreMtu(1500, { keyed: false, fou: true }).mtu).toBe(1448);
  });

  it("IPsec ESP adds its overhead on top of GRE", () => {
    expect(computeGreMtu(1500, { keyed: false, ipsec: true }).mtu).toBe(1400);
  });

  it("FOU + IPsec stack together and the result never exceeds the path", () => {
    const r = computeGreMtu(1500, { keyed: true, fou: true, ipsec: true });
    expect(r.mtu).toBe(1500 - 20 - 24 - 4 - 8 - 56);
    expect(r.mtu).toBeLessThan(1500);
  });
});

describe("OpenVPN management socket", () => {
  const cfg: OpenVPNStructuredConfig = {
    port: 1194,
    listenAddress: "0.0.0.0",
    transport: "udp",
    device: "tun",
    topology: "subnet",
    serverNetwork: "10.40.0.0/24",
    dnsServers: [],
    redirectGateway: false,
    clientToClient: false,
    tunMtu: 1420,
    mssFix: 1360,
    fragment: null,
    dataCiphers: ["AES-256-GCM"],
    fallbackCipher: null,
    authDigest: "SHA256",
    tlsMode: "tls-crypt",
    tlsVersionMin: "1.2",
    keepaliveInterval: 10,
    keepaliveTimeout: 60,
    compression: "off",
    maxClients: 100,
    duplicateCn: false,
    logVerbosity: 3,
    performanceProfile: "balanced",
    pushRoutes: [],
    deploymentMode: "direct",
  } as unknown as OpenVPNStructuredConfig;

  it("exposes a unix management socket inside the inbound config directory", () => {
    const text = generateOpenVPNServerConfig(cfg, {
      inboundName: "ovpn-ir-01",
      configDir: "/etc/arvoo/openvpn/ovpn-ir-01",
    });
    expect(text).toContain("management /etc/arvoo/openvpn/ovpn-ir-01/mgmt.sock unix");
    expect(text).not.toMatch(/^management \d/m);
  });
});
