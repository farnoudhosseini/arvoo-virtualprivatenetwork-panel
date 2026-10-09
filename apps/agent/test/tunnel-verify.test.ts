/**
 * TestTunnel / RunBenchmark against a simulated Linux node.
 *
 * The regression these tests pin: the old TestTunnel reported SUCCESS (with
 * `ok` derived from a single ping) after looking at an interface that merely
 * existed - wrong key, wrong MTU, wrong address, no route, no data plane and the
 * dashboard still showed it as tested fine. Here the kernel answers are supplied
 * through the same `exec` seam the runner uses, so the operation result itself is
 * asserted, not just the parsing helpers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/linux.js", () => ({ exec: vi.fn() }));

import { exec } from "../src/linux.js";
import { runBenchmark, testGre } from "../src/ops.js";
import { validateOperationInput } from "../src/validate-op.js";
import type { TestTunnelOpInput } from "@arvoo/shared";

const mockExec = vi.mocked(exec);

/** This file exercises the Linux code path on whatever host runs the suite. */
const hostPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "linux", configurable: true }));
afterAll(() => Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true }));

const LINK = [
  "6: gre1@NONE: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1452 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000",
  "    link/gre 94.101.187.150 peer 206.1.103.171",
  "    gre remote 206.1.103.171 local 94.101.187.150 ttl 255 key 0xac80001",
].join("\n");

const ADDR = ["    inet 10.200.0.1/30 scope global gre1"].join("\n");
const ROUTE = "10.200.0.2 dev gre1 src 10.200.0.1 uid 0 \n    cache";

const PING_OK = [
  "PING 10.200.0.2 (10.200.0.2) from 10.200.0.1 gre1: 56(84) bytes of data.",
  "64 bytes from 10.200.0.2: icmp_seq=1 ttl=64 time=12.3 ms",
  "--- 10.200.0.2 ping statistics ---",
  "5 packets transmitted, 5 received, 0% packet loss, time 8006ms",
  "rtt min/avg/max/mdev = 11.900/12.340/12.900/0.300 ms",
].join("\n");

const PING_SILENT = [
  "PING 10.200.0.2 (10.200.0.2) from 10.200.0.1 gre1: 56(84) bytes of data.",
  "--- 10.200.0.2 ping statistics ---",
  "5 packets transmitted, 0 received, 100% packet loss, time 4100ms",
].join("\n");

interface NodeAnswers {
  link?: string;
  linkCode?: number;
  addr?: string;
  route?: string;
  routeCode?: number;
  ping?: string;
  pingCode?: number;
}

/** Answer each privileged command the way a real node would. */
function node(answers: NodeAnswers = {}): void {
  const cfg = { link: LINK, linkCode: 0, addr: ADDR, route: ROUTE, routeCode: 0, ping: PING_OK, pingCode: 0, ...answers };
  mockExec.mockImplementation(async (...call: unknown[]) => {
    const [cmd, args] = call as [string, string[]];
    const flat = args.join(" ");
    if (cmd === "ip" && flat.startsWith("-d link show")) return { code: cfg.linkCode, stdout: cfg.link, stderr: "" };
    if (cmd === "ip" && flat.startsWith("-4 addr show")) return { code: 0, stdout: cfg.addr, stderr: "" };
    if (cmd === "ip" && flat.startsWith("route get")) return { code: cfg.routeCode, stdout: cfg.route, stderr: "" };
    if (cmd === "ping") return { code: cfg.pingCode, stdout: cfg.ping, stderr: "" };
    if (cmd === "iperf3") return { code: 0, stdout: JSON.stringify({ end: { sum_received: { bits_per_second: 780_000_000 } } }), stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected command: ${cmd} ${flat}` };
  });
}

const tunnel: TestTunnelOpInput = {
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

// Braces matter: a hook that returns the mock would register the mock itself as
// a cleanup callback, and Vitest would then call it with no arguments.
beforeEach(() => {
  mockExec.mockReset();
});

describe("TestTunnel: a tunnel that really works", () => {
  it("passes every check and returns real measurements", async () => {
    node();
    const result = await testGre(tunnel);
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.ok).toBe(true);
    expect(output.failedChecks).toEqual([]);
    expect(output.keyVerified).toBe(true);
    expect(output.mtuDetected).toBe(1452);
    expect(output.pingOk).toBe(true);
    expect(output.samples).toBe(5);
    expect(output.latencyMs).toBe(12.34);
  });
});

describe("TestTunnel: an interface that exists is not a working tunnel", () => {
  it("fails when the kernel installed another GRE key (the old code said OK)", async () => {
    node({ link: LINK.replace("key 0xac80001", "key 0x0badf00d") });
    const result = await testGre(tunnel);
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.interfacePresent).toBe(true);
    expect(output.pingOk).toBe(true); // the data plane works... with the wrong key
    expect(output.keyVerified).toBe(false);
    expect(output.ok).toBe(false);
    expect(output.failedChecks).toEqual(["key"]);
    expect(result.error).toContain("failed verification");
    expect(result.error).toContain("0xbadf00d");
  });

  it("fails when the MTU in the kernel is not the one the panel expects", async () => {
    node({ link: LINK.replace("mtu 1452", "mtu 1476") });
    const result = await testGre(tunnel);
    const output = result.output as Record<string, unknown>;
    expect(output.mtuDetected).toBe(1476); // read from the kernel, not echoed
    expect(output.mtuVerified).toBe(false);
    expect(output.ok).toBe(false);
    expect(result.success).toBe(false);
  });

  it("fails when the tunnel address is not assigned", async () => {
    node({ addr: "    inet 10.200.0.9/30 scope global gre1" });
    const result = await testGre(tunnel);
    const output = result.output as Record<string, unknown>;
    expect(output.addressVerified).toBe(false);
    expect(result.error).toContain("10.200.0.1/30 is not assigned");
  });

  it("fails when traffic to the peer is routed outside the tunnel", async () => {
    node({ route: "10.200.0.2 dev eth0 src 94.101.187.150 uid 0" });
    const result = await testGre(tunnel);
    const output = result.output as Record<string, unknown>;
    expect(output.routeOk).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("via eth0 instead of gre1");
  });

  it("fails when the interface is silent (blocked or dead ICMP)", async () => {
    node({ ping: PING_SILENT, pingCode: 1 });
    const result = await testGre(tunnel);
    const output = result.output as Record<string, unknown>;
    expect(output.interfacePresent).toBe(true);
    expect(output.pingOk).toBe(false);
    expect(output.lossPct).toBe(100);
    expect(output.ok).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("produced no replies");
  });

  it("fails when the interface does not exist, and says which interface", async () => {
    node({ link: "", linkCode: 1 });
    const result = await testGre(tunnel);
    const output = result.output as Record<string, unknown>;
    expect(output.interfacePresent).toBe(false);
    expect(output.keyVerified).toBeNull();
    expect(result.success).toBe(false);
    expect(result.error).toContain("interface gre1 does not exist on this node");
  });

  it("still verifies what it can when the panel did not send the full configuration", async () => {
    node();
    // The legacy payload carried the interface, the peer address and the MTU, so
    // the interface, MTU, route and ICMP checks still run; the rest is reported
    // as not verifiable (null) instead of being assumed to have passed.
    const result = await testGre({ interfaceName: "gre1", remoteTunnelIp: "10.200.0.2", mtu: 1452 });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.keyVerified).toBeNull();
    expect(output.endpointVerified).toBeNull();
    expect(output.addressVerified).toBeNull();
    expect(output.mtuVerified).toBe(true);
    expect(output.routeOk).toBe(true);
  });

  it("fails a legacy payload whose route does not use the interface", async () => {
    node({ route: "10.200.0.2 dev eth0 src 94.101.187.150 uid 0" });
    const result = await testGre({ interfaceName: "gre1", remoteTunnelIp: "10.200.0.2", mtu: 1452 });
    expect(result.success).toBe(false);
    expect((result.output as Record<string, unknown>).routeOk).toBe(false);
  });
});

describe("RunBenchmark: real measurements or an explicit failure", () => {
  it("reports the replies it actually received", async () => {
    node();
    const result = await runBenchmark({ interfaceName: "gre1", localTunnelIp: "10.200.0.1", remoteTunnelIp: "10.200.0.2", pingCount: 5 });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.samples).toBe(5);
    expect(output.latencyMs).toBe(12.34);
    expect(output.lossPct).toBe(0);
    expect(output.warning).toBeNull();
  });

  it("fails with an explicit cause when the tunnel answers nothing", async () => {
    node({ ping: PING_SILENT, pingCode: 1 });
    const result = await runBenchmark({ interfaceName: "gre1", localTunnelIp: "10.200.0.1", remoteTunnelIp: "10.200.0.2", pingCount: 5 });
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.samples).toBe(0);
    expect(result.error).toContain("100% packet loss");
    expect(result.error).toContain("10.200.0.2");
  });

  it("fails instead of reporting an empty success when ping printed nothing (timeout)", async () => {
    node({ ping: "", pingCode: 124 });
    const result = await runBenchmark({ interfaceName: "gre1", localTunnelIp: "10.200.0.1", remoteTunnelIp: "10.200.0.2", pingCount: 5 });
    expect(result.success).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.samples).toBeNull();
    expect(result.error).toContain("did not answer ICMP");
  });

  it("keeps partial connectivity and reports it as a warning", async () => {
    node({
      ping: [
        "--- 10.200.0.2 ping statistics ---",
        "10 packets transmitted, 8 received, 20% packet loss, time 10000ms",
        "rtt min/avg/max/mdev = 11.900/13.100/15.900/0.700 ms",
      ].join("\n"),
    });
    const result = await runBenchmark({ interfaceName: "gre1", localTunnelIp: "10.200.0.1", remoteTunnelIp: "10.200.0.2", pingCount: 10 });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(output.samples).toBe(8);
    expect(output.lossPct).toBe(20);
    expect(output.warning).toContain("Partial connectivity");
    expect(output.warning).toContain("20%");
  });

  it("adds throughput only when iperf3 produced it", async () => {
    node();
    const result = await runBenchmark({ interfaceName: "gre1", localTunnelIp: "10.200.0.1", remoteTunnelIp: "10.200.0.2", pingCount: 5, iperfSeconds: 5 });
    const output = result.output as Record<string, unknown>;
    expect(output.throughputMbps).toBe(780);
  });
});

describe("the TestTunnel payload the panel queues", () => {
  it("is accepted exactly as testTunnel() builds it", () => {
    expect(validateOperationInput("TestTunnel", tunnel)).toBeNull();
  });

  it("still accepts an older payload that only carried the interface, peer and MTU", () => {
    expect(validateOperationInput("TestTunnel", { interfaceName: "gre1", remoteTunnelIp: "10.200.0.2", mtu: 1452 })).toBeNull();
  });

  it("rejects a malformed expectation instead of comparing against it", () => {
    expect(validateOperationInput("TestTunnel", { ...tunnel, localEndpoint: "94.101.187.150.1" })).not.toBeNull();
    expect(validateOperationInput("TestTunnel", { ...tunnel, localTunnelIp: "not-an-ip" })).not.toBeNull();
    expect(validateOperationInput("TestTunnel", { ...tunnel, tunnelNetwork: "10.200.0.0/33" })).not.toBeNull();
    expect(validateOperationInput("TestTunnel", { ...tunnel, ttl: 0 })).not.toBeNull();
  });

  it("refuses a legacy decimal key here too (defence in depth)", () => {
    expect(validateOperationInput("TestTunnel", { ...tunnel, key: "180879361" })).toMatch(/hexadecimal/i);
  });
});
