/**
 * CleanupNode: the operation a node runs when it is decommissioned.
 *
 * What matters here is scope and honesty. The agent may only remove resources the
 * control plane names (an unrelated interface or OpenVPN instance on the host must
 * survive), the call must be safe to repeat, and anything that failed must be
 * reported by name - the panel keeps the node's state at `partial` from that
 * report instead of claiming the host is clean.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/linux.js", () => ({ exec: vi.fn() }));

import { exec } from "../src/linux.js";
import { cleanupNode } from "../src/ops.js";
import { validateOperationInput } from "../src/validate-op.js";

const mockExec = vi.mocked(exec);

const hostPlatform = process.platform;
beforeAll(() => Object.defineProperty(process, "platform", { value: "linux", configurable: true }));
afterAll(() => Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true }));

/** Every privileged command the agent issued, for scope assertions. */
let issued: string[][] = [];

interface Behaviour {
  /** Raw stderr to answer `ip link del` with, or undefined for success. */
  linkDel?: Record<string, { code: number; stderr: string }>;
  /** Raw stderr to answer `systemctl stop` with. */
  systemctlStop?: { code: number; stderr: string };
}

function host(behaviour: Behaviour = {}): void {
  issued = [];
  mockExec.mockImplementation(async (...call: unknown[]) => {
    const [cmd, args] = call as [string, string[]];
    issued.push([cmd, ...args]);
    const flat = args.join(" ");
    if (cmd === "ip" && args[0] === "link" && args[1] === "del") {
      const answer = behaviour.linkDel?.[args[2]!];
      if (answer) return { code: answer.code, stdout: "", stderr: answer.stderr };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "systemctl" && flat.startsWith("stop")) {
      const answer = behaviour.systemctlStop;
      if (answer) return { code: answer.code, stdout: "", stderr: answer.stderr };
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

// Braces matter: returning the mock from a hook would register it as a cleanup
// callback and Vitest would call it with no arguments.
beforeEach(() => {
  mockExec.mockReset();
});

describe("CleanupNode validation (privileged boundary)", () => {
  it("accepts the payload the control plane builds, including an empty one", () => {
    expect(validateOperationInput("CleanupNode", { interfaceNames: [], inboundNames: [] })).toBeNull();
    expect(validateOperationInput("CleanupNode", { interfaceNames: ["nl-tunnel"], inboundNames: ["ovpn-ir-01"] })).toBeNull();
    expect(validateOperationInput("CleanupNode", { interfaceNames: ["a"], inboundNames: [], fouPorts: [5555] })).toBeNull();
  });

  it("refuses names that are not names at all", () => {
    expect(validateOperationInput("CleanupNode", { interfaceNames: ["../etc"], inboundNames: [] })).not.toBeNull();
    expect(validateOperationInput("CleanupNode", { interfaceNames: ["x; rm -rf /"], inboundNames: [] })).not.toBeNull();
    expect(validateOperationInput("CleanupNode", { interfaceNames: ["a".repeat(16)], inboundNames: [] })).not.toBeNull();
    expect(validateOperationInput("CleanupNode", { interfaceNames: [], inboundNames: [".."] })).not.toBeNull();
  });

  it("bounds the payload instead of accepting an unbounded list", () => {
    const many = Array.from({ length: 129 }, (_v, i) => `if${i}`);
    expect(validateOperationInput("CleanupNode", { interfaceNames: many, inboundNames: [] })).toMatch(/at most/);
    expect(validateOperationInput("CleanupNode", { interfaceNames: [], inboundNames: [], fouPorts: [80] })).not.toBeNull();
    expect(validateOperationInput("CleanupNode", { interfaceNames: "nl-tunnel", inboundNames: [] })).not.toBeNull();
    expect(validateOperationInput("CleanupNode", null)).not.toBeNull();
  });
});

describe("CleanupNode execution", () => {
  it("removes exactly the named interfaces and inbounds", async () => {
    host();
    const result = await cleanupNode({ interfaceNames: ["nl-tunnel", "nl-two"], inboundNames: ["ovpn-ir-01"] });
    expect(result.success).toBe(true);
    const output = result.output as { removed: string[]; absent: string[]; failed: unknown[] };
    expect(output.removed).toEqual(["interface:nl-tunnel", "interface:nl-two", "inbound:ovpn-ir-01"]);
    expect(output.absent).toEqual([]);
    expect(output.failed).toEqual([]);

    // Scope: every link the agent deleted was one it was told to delete.
    const deleted = issued.filter((c) => c[0] === "ip" && c[1] === "link" && c[2] === "del").map((c) => c[3]);
    expect(deleted.sort()).toEqual(["nl-tunnel", "nl-two"]);
  });

  it("is a no-op with an empty payload - never a licence to clean the host", async () => {
    host();
    const result = await cleanupNode({ interfaceNames: [], inboundNames: [] });
    expect(result.success).toBe(true);
    expect(issued).toEqual([]);
  });

  it("treats an already-absent resource as success, so a re-run converges", async () => {
    host({ linkDel: { "nl-tunnel": { code: 1, stderr: 'Cannot find device "nl-tunnel"' } } });
    const first = await cleanupNode({ interfaceNames: ["nl-tunnel"], inboundNames: [] });
    expect(first.success).toBe(true);
    expect((first.output as { absent: string[] }).absent).toEqual(["interface:nl-tunnel"]);
    expect((first.output as { removed: string[] }).removed).toEqual([]);

    // Running it twice must be safe.
    const second = await cleanupNode({ interfaceNames: ["nl-tunnel"], inboundNames: [] });
    expect(second.success).toBe(true);
  });

  it("reports a real failure by name, keeps going, and never claims success", async () => {
    host({ linkDel: { "nl-locked": { code: 2, stderr: "RTNETLINK answers: Operation not permitted" } } });
    const result = await cleanupNode({ interfaceNames: ["nl-locked", "nl-fine"], inboundNames: ["ovpn-ir-01"] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("interface:nl-locked");
    expect(result.error).toContain("Operation not permitted");

    const output = result.output as { removed: string[]; failed: Array<{ name: string }> };
    // The other resources were still processed - one failure does not abort the run.
    expect(output.removed).toContain("interface:nl-fine");
    expect(output.removed).toContain("inbound:ovpn-ir-01");
    expect(output.failed.map((f) => f.name)).toEqual(["interface:nl-locked"]);
  });

  it("treats a missing systemd instance as already removed, and a real stop failure as a failure", async () => {
    host({ systemctlStop: { code: 5, stderr: "Failed to stop arvoo-openvpn@ovpn-ir-01.service: Unit not found." } });
    const missing = await cleanupNode({ interfaceNames: [], inboundNames: ["ovpn-ir-01"] });
    expect(missing.success).toBe(true);
    expect((missing.output as { removed: string[] }).removed).toEqual(["inbound:ovpn-ir-01"]);

    host({ systemctlStop: { code: 1, stderr: "Failed to stop: access denied" } });
    const denied = await cleanupNode({ interfaceNames: [], inboundNames: ["ovpn-ir-01"] });
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("inbound:ovpn-ir-01");
    expect(denied.error).toContain("access denied");
  });

  it("fails honestly on a non-Linux host instead of pretending the host was cleaned", async () => {
    host();
    Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true });
    const result = await cleanupNode({ interfaceNames: ["nl-tunnel"], inboundNames: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires a Linux node/i);
    expect(issued).toEqual([]);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  });
});
