import { describe, expect, it } from "vitest";
import {
  generateClientOvpn,
  generateOpenVPNServerConfig,
  profileAdjustments,
} from "./openvpn";
import { validateOpenVPNConfig } from "./validate";
import type { OpenVPNStructuredConfig } from "./types";

function baseConfig(overrides: Partial<OpenVPNStructuredConfig> = {}): OpenVPNStructuredConfig {
  return {
    port: 1194,
    listenAddress: "0.0.0.0",
    transport: "udp",
    device: "tun",
    topology: "subnet",
    serverNetwork: "10.40.0.0/24",
    dnsServers: ["1.1.1.1"],
    redirectGateway: true,
    clientToClient: false,
    tunMtu: 1420,
    mssFix: 1360,
    fragment: null,
    dataCiphers: ["AES-256-GCM", "AES-128-GCM"],
    fallbackCipher: null,
    authDigest: "SHA256",
    tlsMode: "tls-crypt",
    tlsVersionMin: "1.2",
    keepaliveInterval: 10,
    keepaliveTimeout: 60,
    maxClients: 100,
    performanceProfile: "balanced",
    compression: "off",
    duplicateCn: false,
    pushRoutes: [],
    logVerbosity: 3,
    deploymentMode: "direct",
    tunnelId: null,
    egressNodeId: null,
    ...overrides,
  };
}

describe("OpenVPN generator", () => {
  it("generates a complete valid server config", () => {
    const text = generateOpenVPNServerConfig(baseConfig(), {
      inboundName: "ovpn-de-01",
      configDir: "/etc/arvoo/openvpn/ovpn-de-01",
      openvpnVersion: "2.6.12",
    });
    expect(text).toContain("port 1194");
    expect(text).toContain("proto udp4");
    expect(text).toContain("server 10.40.0.0 255.255.255.0");
    expect(text).toContain("data-ciphers AES-256-GCM:AES-128-GCM");
    expect(text).toContain("tls-crypt /etc/arvoo/openvpn/ovpn-de-01/pki/tls-crypt.key");
    expect(text).toContain("client-connect /etc/arvoo/openvpn/ovpn-de-01/hooks/client-connect");
    expect(text).toContain("# Node OpenVPN version: 2.6.12");
    // no compression directive
    expect(text).not.toMatch(/^comp-lzo/m);
    expect(text).not.toMatch(/^cipher /m);
  });

  it("maps transport tcp to tcp4 and emits per-profile keepalive from config", () => {
    // The UI/API sets keepalive defaults per profile when the profile is chosen.
    const text = generateOpenVPNServerConfig(
      baseConfig({ transport: "tcp", performanceProfile: "low-latency", keepaliveInterval: 5, keepaliveTimeout: 30 }),
      { inboundName: "x", configDir: "/etc/arvoo/openvpn/x" },
    );
    expect(text).toContain("proto tcp4");
    expect(text).toContain("tcp-nodelay");
    expect(text).toContain("keepalive 5 30");
  });

  it("throughput profile enlarges socket buffers", () => {
    const adj = profileAdjustments("throughput");
    expect(adj.sndbuf).toBe(524288);
    expect(adj.keepaliveTimeout).toBe(120);
  });

  it("compatibility profile forces tls-auth and allows CBC fallback", () => {
    const cfg = baseConfig({
      performanceProfile: "compatibility",
      tlsMode: "none",
      fallbackCipher: "AES-256-CBC",
    });
    const v = validateOpenVPNConfig(cfg);
    expect(v.valid).toBe(true);
    const text = generateOpenVPNServerConfig(cfg, { inboundName: "x", configDir: "/d" });
    expect(text).toContain("tls-auth /d/pki/tls-auth.key 0");
    expect(text).toContain("data-ciphers-fallback AES-256-CBC");
  });

  it("through-tunnel mode emits egress routing comment", () => {
    const text = generateOpenVPNServerConfig(baseConfig({ deploymentMode: "through-tunnel" }), {
      inboundName: "x",
      configDir: "/d",
    });
    expect(text).toContain("# --- Egress routing (through-tunnel deployment) ---");
  });
});

describe("OpenVPN validation", () => {
  it("accepts the balanced default", () => {
    const v = validateOpenVPNConfig(baseConfig());
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
  });

  it("rejects CBC outside compatibility profile", () => {
    const v = validateOpenVPNConfig(baseConfig({ dataCiphers: ["AES-256-CBC"] }));
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.field === "dataCiphers")).toBe(true);
  });

  it("rejects maxClients above subnet capacity", () => {
    const v = validateOpenVPNConfig(baseConfig({ serverNetwork: "10.40.0.0/30", maxClients: 100 }));
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.field === "maxClients")).toBe(true);
  });

  it("rejects mss above tun-mtu-40", () => {
    const v = validateOpenVPNConfig(baseConfig({ mssFix: 2000 }));
    expect(v.valid).toBe(false);
  });

  it("requires a tunnel for through-tunnel deployment", () => {
    const v = validateOpenVPNConfig(baseConfig({ deploymentMode: "through-tunnel", tunnelId: null }));
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.field === "tunnelId")).toBe(true);
  });
});

describe("client ovpn", () => {
  it("embeds PKI inline and includes remote", () => {
    const text = generateClientOvpn({
      serverAddress: "203.0.113.10",
      port: 1194,
      transport: "udp",
      ca: "CA-BODY",
      cert: "CERT-BODY",
      key: "KEY-BODY",
      tlsMode: "tls-crypt",
      tlsKey: "TLSKEY",
      tlsVersionMin: "1.2",
      dataCiphers: ["AES-256-GCM"],
      fallbackCipher: null,
      authDigest: "SHA256",
      tunMtu: 1420,
      mssFix: 1360,
      redirectGateway: true,
      dnsServers: ["1.1.1.1"],
      pushRoutes: [],
      profileName: "client-A",
      verifyX509Name: "server-ovpn-inbound-01",
    });
    expect(text).toContain("remote 203.0.113.10 1194");
    expect(text).toContain("<ca>\nCA-BODY\n</ca>");
    expect(text).toContain("<tls-crypt>\nTLSKEY\n</tls-crypt>");
    expect(text).not.toMatch(/^tls-crypt\s*$/m);
    expect(text).toContain('verify-x509-name "server-ovpn-inbound-01" name');
    expect(text).toContain("remote-cert-tls server");
    expect(text).toContain("redirect-gateway def1");
  });

  it("emits key-direction 1 and inline tls-auth without a bare directive", () => {
    const text = generateClientOvpn({
      serverAddress: "203.0.113.10",
      port: 443,
      transport: "tcp",
      ca: "CA",
      cert: "CERT",
      key: "KEY",
      tlsMode: "tls-auth",
      tlsKey: "STATICKEY",
      tlsVersionMin: "1.2",
      dataCiphers: ["AES-256-GCM"],
      fallbackCipher: "AES-256-CBC",
      authDigest: "SHA256",
      tunMtu: 1420,
      mssFix: null,
      redirectGateway: false,
      dnsServers: [],
      pushRoutes: [],
      profileName: "compat-client",
      verifyX509Name: "server-x",
    });
    expect(text).toContain("key-direction 1");
    expect(text).toContain("<tls-auth>\nSTATICKEY\n</tls-auth>");
    expect(text).not.toMatch(/^tls-auth\s*$/m);
    expect(text).toContain('verify-x509-name "server-x" name');
  });
});
