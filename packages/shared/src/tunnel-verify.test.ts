/**
 * TestTunnel verification.
 *
 * The regression this pins: TestTunnel used to report `success` (and an `ok`
 * derived from a single ping) after looking at an interface that merely existed,
 * and it echoed the MTU it was given as `mtuDetected`. A tunnel whose key, MTU,
 * address or route did not match the panel - or that had no route at all - could
 * therefore look healthy on the dashboard. These cases come from real
 * `iproute2` output and are pure, so they run without root and without a node.
 */
import { describe, expect, it } from "vitest";
import {
  greLinkStateFromLinkShow,
  routeDeviceFromRouteGet,
  tunnelAddressesFromAddrShow,
  verifyGreTunnel,
  type ExpectedGreConfig,
  type ObservedGreState,
} from "./gre.js";

// `ip -d link show gre1` on a working keyed tunnel.
const LINK_UP_KEYED = [
  "6: gre1@NONE: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1452 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000",
  "    link/gre 94.101.187.150 peer 206.1.103.171",
  "    gre remote 206.1.103.171 local 94.101.187.150 ttl 255 key 0xac80001",
  "    promiscuity 0 numtxqueues 1 numrxqueues 1",
].join("\n");

// Same tunnel, but shut down and with a different key installed.
const LINK_DOWN_WRONG_KEY = [
  "6: gre1@NONE: <POINTOPOINT,NOARP> mtu 1476 qdisc noqueue state DOWN mode DEFAULT group default qlen 1000",
  "    gre remote 206.1.103.171 local 94.101.187.150 ttl 64 key 0x0badf00d",
].join("\n");

// Keyless GRE (no `key` field at all).
const LINK_KEYLESS = [
  "6: gre1@NONE: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1452 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000",
  "    gre remote 206.1.103.171 local 94.101.187.150 ttl 255",
].join("\n");

const ADDR = [
  "6: gre1@NONE: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1452 qdisc noqueue state UNKNOWN group default qlen 1000",
  "    inet 10.200.0.1/30 scope global gre1",
  "       valid_lft forever preferred_lft forever",
].join("\n");

const EXPECTED: ExpectedGreConfig = {
  interfaceName: "gre1",
  localEndpoint: "94.101.187.150",
  remoteEndpoint: "206.1.103.171",
  localTunnelIp: "10.200.0.1",
  remoteTunnelIp: "10.200.0.2",
  tunnelNetwork: "10.200.0.0/30",
  mtu: 1452,
  ttl: 255,
  key: "ac80001",
};

function observed(overrides: Partial<ObservedGreState> = {}): ObservedGreState {
  return {
    link: greLinkStateFromLinkShow(LINK_UP_KEYED),
    addresses: tunnelAddressesFromAddrShow(ADDR),
    routeDev: routeDeviceFromRouteGet("10.200.0.2 dev gre1 src 10.200.0.1 uid 0 \n    cache"),
    pingOk: true,
    ...overrides,
  };
}

describe("greLinkStateFromLinkShow", () => {
  it("reads flags, endpoints, ttl, mtu and the key from the detailed dump", () => {
    expect(greLinkStateFromLinkShow(LINK_UP_KEYED)).toEqual({
      present: true,
      up: true,
      carrier: true,
      localEndpoint: "94.101.187.150",
      remoteEndpoint: "206.1.103.171",
      ttl: 255,
      mtu: 1452,
      key: "ac80001",
    });
  });

  it("reports a shut-down interface as present but not up", () => {
    const state = greLinkStateFromLinkShow(LINK_DOWN_WRONG_KEY);
    expect(state.present).toBe(true);
    expect(state.up).toBe(false);
    expect(state.carrier).toBe(false);
    expect(state.ttl).toBe(64);
    expect(state.mtu).toBe(1476);
    expect(state.key).toBe("badf00d");
  });

  it("distinguishes a keyless link (key null) from a missing interface", () => {
    expect(greLinkStateFromLinkShow(LINK_KEYLESS).key).toBeNull();
    expect(greLinkStateFromLinkShow(LINK_KEYLESS).present).toBe(true);
  });

  it("reports absence for an empty dump instead of inventing state", () => {
    const state = greLinkStateFromLinkShow("");
    expect(state.present).toBe(false);
    expect(state.up).toBeNull();
    expect(state.carrier).toBeNull();
    expect(state.localEndpoint).toBeNull();
    expect(state.remoteEndpoint).toBeNull();
    expect(state.ttl).toBeNull();
    expect(state.mtu).toBeNull();
    expect(state.key).toBeNull();
  });
});

describe("tunnelAddressesFromAddrShow / routeDeviceFromRouteGet", () => {
  it("collects the assigned CIDRs", () => {
    expect(tunnelAddressesFromAddrShow(ADDR)).toEqual(["10.200.0.1/30"]);
    expect(tunnelAddressesFromAddrShow("")).toEqual([]);
  });

  it("reads the device the kernel would use for the remote tunnel address", () => {
    expect(routeDeviceFromRouteGet("10.200.0.2 dev gre1 src 10.200.0.1 uid 0 \n cache")).toBe("gre1");
    expect(routeDeviceFromRouteGet("10.200.0.2 dev gre10 src 10.200.0.1 uid 0")).toBe("gre10");
    expect(routeDeviceFromRouteGet("RTNETLINK answers: Network is unreachable")).toBeNull();
  });
});

describe("verifyGreTunnel: healthy and broken tunnels", () => {
  it("passes a tunnel that matches the expected configuration in every check", () => {
    const check = verifyGreTunnel(EXPECTED, observed());
    expect(check.ok).toBe(true);
    expect(check.failedChecks).toEqual([]);
    expect(check.failures).toEqual([]);
    expect(check.ifUp).toBe(true);
    expect(check.endpointVerified).toBe(true);
    expect(check.addressVerified).toBe(true);
    expect(check.mtuVerified).toBe(true);
    expect(check.ttlVerified).toBe(true);
    expect(check.keyVerified).toBe(true);
    expect(check.routeOk).toBe(true);
    expect(check.mtuDetected).toBe(1452);
    expect(check.observedKey).toBe("ac80001");
  });

  it("fails when the interface exists but the kernel installed another key", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ link: greLinkStateFromLinkShow(LINK_DOWN_WRONG_KEY) }));
    expect(check.interfacePresent).toBe(true);
    expect(check.ok).toBe(false);
    expect(check.keyVerified).toBe(false);
    expect(check.mtuVerified).toBe(false);
    expect(check.ttlVerified).toBe(false);
    expect(check.failedChecks).toContain("key");
    expect(check.failures.join(" ")).toContain("0xbadf00d");
    expect(check.failures.join(" ")).toContain("expected 0xac80001");
  });

  it("fails when the kernel has no key but the tunnel is keyed", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ link: greLinkStateFromLinkShow(LINK_KEYLESS) }));
    expect(check.keyVerified).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.failures.join(" ")).toContain("none");
  });

  it("fails when a keyless tunnel carries a key", () => {
    const check = verifyGreTunnel({ ...EXPECTED, key: null }, observed());
    expect(check.keyVerified).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.failures.join(" ")).toContain("keyless");
  });

  it("fails an interface that is administratively down", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ link: { ...observed().link, up: false } }));
    expect(check.ifUp).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.failedChecks).toContain("ifUp");
  });

  it("fails when the tunnel address is not assigned", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ addresses: ["10.200.0.1/32"] }));
    expect(check.addressVerified).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.failures.join(" ")).toContain("10.200.0.1/30 is not assigned to gre1");
  });

  it("fails when the remote tunnel address is not routed via the interface", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ routeDev: "eth0" }));
    expect(check.routeOk).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.failedChecks).toContain("route");
    expect(check.failures.join(" ")).toContain("via eth0 instead of gre1");
  });

  it("fails when no route to the remote tunnel address exists", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ routeDev: null }));
    expect(check.routeOk).toBe(false);
    expect(check.failures.join(" ")).toContain("no route");
  });

  it("fails when the interface does not exist at all", () => {
    const check = verifyGreTunnel(
      EXPECTED,
      observed({ link: greLinkStateFromLinkShow(""), addresses: [], routeDev: null, pingOk: false }),
    );
    expect(check.interfacePresent).toBe(false);
    expect(check.ifUp).toBeNull();
    expect(check.ok).toBe(false);
    expect(check.failedChecks).toContain("interface");
    expect(check.failures[0]).toBe("interface gre1 does not exist on this node");
    // Unverifiable checks stay null - they must never be reported as passed.
    expect(check.keyVerified).toBeNull();
    expect(check.mtuVerified).toBeNull();
    expect(check.routeOk).toBeNull();
  });

  it("fails a configured-but-silent tunnel (blocked ICMP) and says so", () => {
    const check = verifyGreTunnel(EXPECTED, observed({ pingOk: false }));
    expect(check.ok).toBe(false);
    expect(check.failedChecks).toEqual(["ping"]);
    expect(check.failures.join(" ")).toContain("ICMP to 10.200.0.2 across gre1 produced no replies");
  });

  it("mentions a missing carrier when ICMP is silent without it", () => {
    const link = { ...observed().link, carrier: false };
    const check = verifyGreTunnel(EXPECTED, observed({ link, pingOk: false }));
    expect(check.carrierUp).toBe(false);
    expect(check.failures.join(" ")).toContain("no carrier");
  });

  it("reports an incorrect tunnel IP and endpoint without leaking anything else", () => {
    const link = { ...observed().link, localEndpoint: "94.101.187.151", remoteEndpoint: "206.1.103.170" };
    const check = verifyGreTunnel(EXPECTED, observed({ link }));
    expect(check.endpointVerified).toBe(false);
    expect(check.ok).toBe(false);
    expect(check.failures.join(" ")).toContain("expected 94.101.187.150/206.1.103.171");
  });

  it("leaves checks it cannot verify null for a payload that omits them", () => {
    // The legacy TestTunnel payload carried only the interface, remote IP and MTU.
    const legacy = { interfaceName: "gre1", remoteTunnelIp: "10.200.0.2", mtu: 1452 };
    const check = verifyGreTunnel(legacy, observed({ pingOk: true }));
    expect(check.endpointVerified).toBeNull();
    expect(check.keyVerified).toBeNull();
    expect(check.ttlVerified).toBeNull();
    expect(check.addressVerified).toBeNull();
    expect(check.ok).toBe(true);
    expect(check.mtuVerified).toBe(true);
  });

  it("still fails a legacy payload when the interface is missing or silent", () => {
    const legacy = { interfaceName: "gre1", remoteTunnelIp: "10.200.0.2", mtu: 1452 };
    expect(verifyGreTunnel(legacy, observed({ link: greLinkStateFromLinkShow(""), pingOk: false })).ok).toBe(false);
    expect(verifyGreTunnel(legacy, observed({ pingOk: false })).ok).toBe(false);
  });

  it("refuses to pass a key the canonical rule rejects", () => {
    const check = verifyGreTunnel({ ...EXPECTED, key: "180879361" }, observed());
    expect(check.keyVerified).toBe(false);
    expect(check.ok).toBe(false);
  });

  it("accepts the exact 32-bit key when it is spelled the same way on both sides", () => {
    const check = verifyGreTunnel({ ...EXPECTED, key: "0xac80001" }, observed());
    expect(check.keyVerified).toBe(true);
    expect(check.ok).toBe(true);
  });
});
