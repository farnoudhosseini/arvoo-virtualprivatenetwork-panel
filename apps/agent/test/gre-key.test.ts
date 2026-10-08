/**
 * What the agent actually hands the kernel for a keyed GRE tunnel.
 *
 * iproute2 parses `key` with base 0, so a bare hex string that contains letters
 * is rejected and a digits-only string is read as DECIMAL. The agent therefore
 * passes 0x-prefixed canonical hex, which keeps the exact 32-bit key field - and
 * this is the assertion that caught the production failure where the control
 * plane queued the decimal string "180879361".
 */
import { describe, expect, it } from "vitest";
import { canonicalGreKey } from "@arvoo/shared";
import { greLinkArgs } from "../src/ops.js";
import { validateOperationInput } from "../src/validate-op.js";
import type { GreOpInput } from "@arvoo/shared";

const tunnel: GreOpInput = {
  interfaceName: "ir01-de02",
  localEndpoint: "203.0.113.10",
  remoteEndpoint: "198.51.100.21",
  localTunnelIp: "10.200.0.1",
  remoteTunnelIp: "10.200.0.2",
  tunnelNetwork: "10.200.0.0/30",
  mtu: 1452,
  ttl: 255,
  key: "ac80001",
  fouPort: null,
  routes: [],
};

describe("greLinkArgs", () => {
  it("passes the key as 0x-prefixed hex", () => {
    const args = greLinkArgs(tunnel, canonicalGreKey(tunnel.key)!);
    expect(args).toEqual([
      "link",
      "add",
      "ir01-de02",
      "type",
      "gre",
      "local",
      "203.0.113.10",
      "remote",
      "198.51.100.21",
      "ttl",
      "255",
      "key",
      "0xac80001",
    ]);
    // The exact regression: nine decimal digits must never reach this argv.
    expect(args).not.toContain("180879361");
    expect(args.join(" ")).toContain("key 0xac80001");
  });

  it("keeps a digits-only key hexadecimal instead of letting base-0 read it as decimal", () => {
    // "26" is 0x26 (38) in the canonical scheme; without the prefix iproute2
    // would install key 26, a different 32-bit value on the wire.
    expect(greLinkArgs({ ...tunnel, key: "26" }, "26").at(-1)).toBe("0x26");
  });

  it("omits the key field entirely for a keyless tunnel", () => {
    const args = greLinkArgs({ ...tunnel, key: null }, null);
    expect(args).not.toContain("key");
    expect(args).toHaveLength(11);
  });
});

describe("the payload the control plane queues for a keyed GRE tunnel", () => {
  it("is accepted by the agent exactly as the panel now builds it", () => {
    // Same shape deployTunnel() enqueues, with the canonical key the API stores.
    const queued = {
      ...tunnel,
      key: "ac80001",
      routes: [] as Array<{ destination: string }>,
    };
    expect(validateOperationInput("CreateGRE", queued)).toBeNull();
    expect(queued.key).toBe(canonicalGreKey(queued.key));
  });

  it("is still refused when a legacy decimal key is queued (defence in depth)", () => {
    const legacy = { ...tunnel, key: "180879361" };
    expect(validateOperationInput("CreateGRE", legacy)).toMatch(/hexadecimal/i);
    expect(canonicalGreKey(legacy.key)).toBeNull();
  });
});
