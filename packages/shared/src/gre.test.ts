/**
 * GRE key handling. The key is a 32-bit field (RFC 2890) and has exactly one
 * canonical representation - lowercase hexadecimal, 1-8 characters - because the
 * node agent refuses anything else. The regression this pins: the control plane
 * used to derive the key as a DECIMAL integer from the tunnel IP, so
 * 10.200.0.0/30 produced "180879361", nine characters, and every CreateGRE for
 * that tunnel was rejected before it could reach the kernel.
 */
import { describe, expect, it } from "vitest";
import {
  GRE_KEY_MAX,
  GRE_KEY_RULE,
  canonicalGreKey,
  canonicalGreKeyFromDecimal,
  greKeyCliValue,
  greKeyFromBytes,
  greKeyFromLinkShow,
  isValidGreKey,
} from "./gre.js";

describe("canonicalGreKey: accepted keys", () => {
  it("accepts a single-character key", () => {
    expect(canonicalGreKey("1")).toBe("1");
    expect(canonicalGreKey("a")).toBe("a");
  });

  it("accepts an 8-character key", () => {
    expect(canonicalGreKey("ac80001f")).toBe("ac80001f");
    expect(canonicalGreKey("ffffffff")).toBe("ffffffff");
  });

  it("accepts lowercase, uppercase and mixed-case hex", () => {
    expect(canonicalGreKey("1a2b3c4d")).toBe("1a2b3c4d");
    expect(canonicalGreKey("1A2B3C4D")).toBe("1a2b3c4d");
    expect(canonicalGreKey("Ac80001F")).toBe("ac80001f");
  });

  it("accepts the 0x prefix and strips leading zeros", () => {
    expect(canonicalGreKey("0xac80001")).toBe("ac80001");
    expect(canonicalGreKey("0XAC80001")).toBe("ac80001");
    expect(canonicalGreKey("00001234")).toBe("1234");
  });

  it("treats 0 and ffffffff as real keys", () => {
    expect(canonicalGreKey("0")).toBe("0");
    expect(canonicalGreKey("0x0")).toBe("0");
    expect(canonicalGreKey(0)).toBe("0");
    expect(canonicalGreKey("ffffffff")).toBe("ffffffff");
    expect(canonicalGreKey(GRE_KEY_MAX)).toBe("ffffffff");
  });

  it("accepts numbers as the exact 32-bit value", () => {
    expect(canonicalGreKey(0xac80001)).toBe("ac80001");
  });
});

describe("canonicalGreKey: rejected keys", () => {
  it("rejects a 9-digit value (100000000)", () => {
    expect(canonicalGreKey("100000000")).toBeNull();
  });

  it("rejects the decimal value that broke CreateGRE (180879361)", () => {
    expect(canonicalGreKey("180879361")).toBeNull();
    expect(canonicalGreKey(180879361)).toBe("ac80001"); // number = real 32-bit value
    expect(isValidGreKey("180879361")).toBe(false);
  });

  it("rejects non-hex characters (G1234567)", () => {
    expect(canonicalGreKey("G1234567")).toBeNull();
    expect(canonicalGreKey("1234567g")).toBeNull();
  });

  it("rejects an empty key", () => {
    expect(canonicalGreKey("")).toBeNull();
    expect(canonicalGreKey("   ")).toBeNull();
    expect(canonicalGreKey(null)).toBeNull();
    expect(canonicalGreKey(undefined)).toBeNull();
  });

  it("rejects values that are not unsigned 32-bit integers", () => {
    expect(canonicalGreKey(0x100000000)).toBeNull();
    expect(canonicalGreKey(-1)).toBeNull();
    expect(canonicalGreKey(1.5)).toBeNull();
  });
});

describe("isValidGreKey", () => {
  it("only accepts the canonical form", () => {
    expect(isValidGreKey("ac80001")).toBe(true);
    expect(isValidGreKey("AC80001")).toBe(false); // canonical is lowercase
    expect(isValidGreKey("0x1")).toBe(false);
    expect(isValidGreKey("0000abcd")).toBe(true);
  });
});

describe("canonicalGreKeyFromDecimal: legacy decimal rows", () => {
  it("preserves the 32-bit value of the legacy generator", () => {
    // 10.200.0.1 -> ipToInt -> 180879361, the value stored by the old generator.
    expect(canonicalGreKeyFromDecimal("180879361")).toBe("ac80001");
    expect(canonicalGreKeyFromDecimal(180879361)).toBe("ac80001");
    expect(parseInt(canonicalGreKeyFromDecimal("180879361")!, 16)).toBe(180879361);
  });

  it("handles the ends of the range", () => {
    expect(canonicalGreKeyFromDecimal("0")).toBe("0");
    expect(canonicalGreKeyFromDecimal("4294967295")).toBe("ffffffff");
    expect(canonicalGreKeyFromDecimal("4294967296")).toBeNull();
    expect(canonicalGreKeyFromDecimal("-1")).toBeNull();
    expect(canonicalGreKeyFromDecimal("")).toBeNull();
    expect(canonicalGreKeyFromDecimal("ac80001")).toBeNull();
  });
});

describe("greKeyFromBytes: the generator", () => {
  it("formats the value as canonical hex", () => {
    expect(greKeyFromBytes(Uint8Array.of(0x0a, 0xc8, 0x00, 0x01))).toBe("ac80001");
    expect(greKeyFromBytes(Uint8Array.of(0x00, 0x00, 0x00, 0x00))).toBe("0");
    expect(greKeyFromBytes(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toBe("ffffffff");
    expect(greKeyFromBytes(Uint8Array.of(0x00, 0x00, 0x00, 0x2a))).toBe("2a");
  });

  it("never produces a value the agent rejects", () => {
    // Exhaustive over the high nibble plus a spread of low values: every 32-bit
    // key must be a valid canonical key, never a 9-digit decimal string.
    for (let hi = 0; hi < 256; hi++) {
      for (const lo of [0, 1, 0x7f, 0x80, 0xff]) {
        const key = greKeyFromBytes(Uint8Array.of(hi, lo, 0x80, 0x01));
        expect(isValidGreKey(key)).toBe(true);
        expect(key.length).toBeLessThanOrEqual(8);
      }
    }
  });

  it("refuses a buffer that is not 4 bytes", () => {
    expect(() => greKeyFromBytes(Uint8Array.of(1, 2, 3))).toThrow(/4 bytes/);
  });
});

describe("greKeyCliValue: the argument handed to iproute2", () => {
  it("is 0x-prefixed so base-0 parsing keeps the hex value", () => {
    expect(greKeyCliValue("ac80001")).toBe("0xac80001");
    expect(greKeyCliValue("26")).toBe("0x26"); // 0x26, not decimal 26
    expect(greKeyCliValue("0")).toBe("0x0");
    expect(greKeyCliValue("ffffffff")).toBe("0xffffffff");
  });

  it("returns nothing for a value the kernel must not receive", () => {
    expect(greKeyCliValue("180879361")).toBeNull();
    expect(GRE_KEY_RULE).toMatch(/hexadecimal/);
  });
});

describe("greKeyFromLinkShow: reading the key back from the kernel", () => {
  it("reads both iproute2 print styles", () => {
    const withPrefix = "6: gre1@NONE: <POINTOPOINT,NOARP,UP> mtu 1452\n    gre remote 1.2.3.4 local 5.6.7.8 ttl 255 key 0xac80001\n";
    expect(greKeyFromLinkShow(withPrefix)).toBe("ac80001");
    const withoutPrefix = "6: gre1@NONE: <POINTOPOINT,NOARP,UP> mtu 1452\n    gre remote 1.2.3.4 local 5.6.7.8 ttl 255 key ac80001\n";
    expect(greKeyFromLinkShow(withoutPrefix)).toBe("ac80001");
  });

  it("does not confuse ikey/okey with the key field", () => {
    const stdout = "    gre remote 1.2.3.4 local 5.6.7.8 ttl 255 ikey 0x11 okey 0x22\n";
    expect(greKeyFromLinkShow(stdout)).toBeNull();
  });

  it("reports nothing when the link dump has no key field", () => {
    expect(greKeyFromLinkShow("    gre remote 1.2.3.4 local 5.6.7.8 ttl 255\n")).toBeNull();
    expect(greKeyFromLinkShow("")).toBeNull();
  });
});
