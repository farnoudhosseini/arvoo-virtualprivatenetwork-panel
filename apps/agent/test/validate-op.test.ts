/**
 * The agent re-validates every privileged operation payload before any field is
 * used in a filesystem path, a systemd unit name or a command argument. These
 * tests pin that behaviour: a compromised or buggy control plane must not be
 * able to make the agent write outside its own directories or hand the kernel
 * nonsensical arguments.
 */
import { describe, expect, it } from "vitest";
import { validateOperationInput } from "../src/validate-op.js";

const validGre = {
  interfaceName: "gre-ir-01",
  localEndpoint: "203.0.113.10",
  remoteEndpoint: "198.51.100.20",
  localTunnelIp: "10.10.0.1",
  remoteTunnelIp: "10.10.0.2",
  tunnelNetwork: "10.10.0.0/30",
  mtu: 1400,
  ttl: 255,
  key: "1a2b3c",
  routes: [{ destination: "10.40.0.0/24", gateway: "10.10.0.2" }],
};

const validInbound = {
  inboundName: "ovpn-ir-01",
  port: 1194,
  protocol: "udp",
  maxClients: 250,
  clientNetwork: "10.40.0.0/24",
  configText: "port 1194\nproto udp\n",
  pki: {
    ca: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
    cert: "-----BEGIN CERTIFICATE-----\nSRV\n-----END CERTIFICATE-----",
    key: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----",
    tlsKey: "dGxzLWNyeXB0LWtleQ==",
    tlsMode: "tls-crypt",
    dhParam: null,
  },
  egress: null,
  clientConnectHook: null,
};

describe("validateOperationInput: accepted payloads", () => {
  it("accepts a well-formed GRE tunnel", () => {
    expect(validateOperationInput("CreateGRE", validGre)).toBeNull();
  });

  it("accepts a GRE tunnel without an optional key or routes", () => {
    expect(validateOperationInput("CreateGRE", { ...validGre, key: null, routes: [] })).toBeNull();
  });

  it("accepts a well-formed OpenVPN inbound", () => {
    expect(validateOperationInput("CreateOpenVPNInbound", validInbound)).toBeNull();
  });

  it("accepts the payload-free operations", () => {
    expect(validateOperationInput("InstallOpenVPN", {})).toBeNull();
    expect(validateOperationInput("CollectDiagnostics", {})).toBeNull();
    expect(validateOperationInput("SyncConfiguration", { anything: true })).toBeNull();
  });

  it("accepts the name-only operations with a safe name", () => {
    expect(validateOperationInput("RestartOpenVPN", { inboundName: "ovpn-ir-01" })).toBeNull();
    expect(validateOperationInput("StopOpenVPN", { inboundName: "ovpn-ir-01" })).toBeNull();
    expect(validateOperationInput("DeleteGRE", { interfaceName: "gre-ir-01" })).toBeNull();
  });
});

describe("validateOperationInput: path traversal is refused", () => {
  it("rejects traversal in an inbound name", () => {
    for (const name of ["../../etc/passwd", "..", ".", "/etc/cron.d/x", "ovpn/../x", "ovpn ir"]) {
      expect(validateOperationInput("CreateOpenVPNInbound", { ...validInbound, inboundName: name })).toMatch(
        /inboundName/,
      );
      expect(validateOperationInput("RestartOpenVPN", { inboundName: name })).toMatch(/inboundName/);
    }
  });

  it("rejects traversal in an interface name", () => {
    expect(validateOperationInput("CreateGRE", { ...validGre, interfaceName: "../../eth0" })).toMatch(/interfaceName/);
    expect(validateOperationInput("DeleteGRE", { interfaceName: "../x" })).toMatch(/interfaceName/);
  });

  it("rejects names longer than the filesystem and kernel allow", () => {
    const long = "g".repeat(64);
    expect(validateOperationInput("RestartOpenVPN", { inboundName: long })).toMatch(/inboundName/);
    // Linux interface names are limited to 15 characters.
    expect(validateOperationInput("DeleteGRE", { interfaceName: "gre-very-long-name" })).toMatch(/interfaceName/);
  });
});

describe("validateOperationInput: malformed values are refused", () => {
  it("rejects out-of-range ports and protocols", () => {
    expect(validateOperationInput("CreateOpenVPNInbound", { ...validInbound, port: 70000 })).toMatch(/port/);
    expect(validateOperationInput("CreateOpenVPNInbound", { ...validInbound, port: "1194" })).toMatch(/port/);
    expect(validateOperationInput("CreateOpenVPNInbound", { ...validInbound, protocol: "sctp" })).toMatch(/protocol/);
  });

  it("rejects invalid addresses and MTUs", () => {
    expect(validateOperationInput("CreateGRE", { ...validGre, remoteEndpoint: "not-an-ip" })).toMatch(/remoteEndpoint/);
    expect(validateOperationInput("CreateGRE", { ...validGre, remoteEndpoint: "999.1.1.1" })).toMatch(/remoteEndpoint/);
    expect(validateOperationInput("CreateGRE", { ...validGre, localTunnelIp: "10.10.0.0/24" })).toMatch(
      /localTunnelIp/,
    );
    expect(validateOperationInput("CreateGRE", { ...validGre, mtu: 9000 })).toMatch(/mtu/);
    expect(validateOperationInput("CreateGRE", { ...validGre, ttl: 0 })).toMatch(/ttl/);
    expect(validateOperationInput("CreateGRE", { ...validGre, tunnelNetwork: "10.10.0.0" })).toMatch(/tunnelNetwork/);
  });

  it("rejects a GRE key that is not hexadecimal", () => {
    expect(validateOperationInput("CreateGRE", { ...validGre, key: "zzzz" })).toMatch(/key/);
  });

  it("rejects routes with a bad destination or device", () => {
    expect(
      validateOperationInput("CreateGRE", { ...validGre, routes: [{ destination: "not-a-cidr" }] }),
    ).toMatch(/routes/);
    expect(
      validateOperationInput("CreateGRE", { ...validGre, routes: [{ destination: "10.0.0.0/8", device: "../x" }] }),
    ).toMatch(/device/);
  });

  it("rejects PKI material that is incomplete or oversized", () => {
    expect(
      validateOperationInput("CreateOpenVPNInbound", { ...validInbound, pki: { ...validInbound.pki, key: "" } }),
    ).toMatch(/pki.key/);
    expect(
      validateOperationInput("CreateOpenVPNInbound", {
        ...validInbound,
        pki: { ...validInbound.pki, tlsMode: "tls-crypt", tlsKey: null },
      }),
    ).toMatch(/tlsKey/);
    expect(
      validateOperationInput("CreateOpenVPNInbound", { ...validInbound, pki: { ...validInbound.pki, tlsMode: "x" } }),
    ).toMatch(/tlsMode/);
  });

  it("rejects egress networks that are not CIDRs", () => {
    expect(
      validateOperationInput("CreateOpenVPNInbound", {
        ...validInbound,
        egress: { masqueradeSourceNetworks: ["10.40.0.0/24", "bogus"], forwardFromSubnet: "10.40.0.0/24" },
      }),
    ).toMatch(/masqueradeSourceNetworks/);
  });

  it("rejects a non-object payload and unknown operation types", () => {
    expect(validateOperationInput("CreateGRE", null)).toBeTruthy();
    expect(validateOperationInput("CreateGRE", ["nope"])).toBeTruthy();
    expect(validateOperationInput("SomethingElse", {})).toMatch(/unknown operation type/);
  });
});
