import { describe, expect, it } from "vitest";
import {
  assessSharedEndpoint,
  buildCompatibilityMatrix,
  formatCompatibilityMatrix,
  type ObservedInbound,
} from "./endpoint-sharing.js";

function inbound(overrides: Partial<ObservedInbound> = {}): ObservedInbound {
  return {
    name: "test-inbound",
    protocol: "vless",
    transport: "tcp",
    tls: "terminated-by-inbound",
    multiplexing: "none",
    ports: [443],
    ...overrides,
  };
}

describe("shared endpoint refusals (spec §8/§12/§17)", () => {
  it("refuses a UDP-only inbound: an HTTP website is a TCP service", () => {
    const verdict = assessSharedEndpoint(inbound({ name: "wg-de", protocol: "wireguard", transport: "udp", tls: "none" }));
    expect(verdict.possible).toBe(false);
    expect(verdict.risk).toBe("blocked");
    expect(verdict.method).toBe("none");
    expect(verdict.reasons.join(" ")).toMatch(/UDP only/i);
    expect(verdict.forbidden.join(" ")).toMatch(/do not proxy/i);
  });

  it("refuses an inbound that owns UDP and TCP together", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "ovpn-443", protocol: "openvpn", transport: "both", tls: "terminated-by-inbound" }),
    );
    expect(verdict.possible).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/both TCP and UDP/i);
  });

  it("refuses raw IP protocols that have no TCP/UDP socket at all", () => {
    const verdict = assessSharedEndpoint(inbound({ name: "gre-ir-de", protocol: "gre", rawIpProtocol: true, tls: "none" }));
    expect(verdict.possible).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/raw IP protocol/i);
  });

  it("refuses to share a port another process already owns", () => {
    const verdict = assessSharedEndpoint(inbound({ name: "xray-vless", ports: [443] }), { conflictingOwners: [443] });
    expect(verdict.possible).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/already owns/i);
  });

  it("refuses a Reality-style passthrough rather than changing what clients see", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "vless-reality", protocol: "vless", tls: "passthrough-sni", multiplexing: "none" }),
    );
    expect(verdict.possible).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/third-party destination|passes TLS through/i);
    expect(verdict.reasons.join(" ")).toMatch(/independent web endpoint/i);
  });

  it("refuses Shadowsocks: no TLS, no SNI, no HTTP semantics to split on", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "ss-01", protocol: "shadowsocks", tls: "none", multiplexing: "none" }),
    );
    expect(verdict.possible).toBe(false);
    expect(verdict.requiredChanges.join(" ")).toMatch(/no change/i);
    expect(verdict.rollback.join(" ")).toMatch(/nothing was changed/i);
  });
});

describe("shared endpoint approvals (spec §3/§9)", () => {
  it("prefers the inbound's own fallback mechanism over inserting a proxy", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "trojan-fallback", protocol: "trojan", tls: "terminated-by-inbound", multiplexing: "inbound-fallback" }),
      { webPort: 8080 },
    );
    expect(verdict.possible).toBe(true);
    expect(verdict.method).toBe("inbound-native-fallback");
    expect(verdict.risk).toBe("low");
    expect(verdict.webEndpoint).toEqual({ scheme: "https", port: 8080 });
    expect(verdict.requiredChanges.join(" ")).toMatch(/127\.0\.0\.1:8080/);
    // The native mechanism must not require a client change.
    expect(verdict.requiredChanges.join(" ")).not.toMatch(/client/i);
  });

  it("adds one virtual host when a web server already fronts the inbound", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "existing-nginx", protocol: "vless", alreadyBehindProxy: true, tls: "terminated-by-proxy" }),
      { webPort: 8080 },
    );
    expect(verdict.possible).toBe(true);
    expect(verdict.method).toBe("http-vhost");
    expect(verdict.risk).toBe("low");
    expect(verdict.requiredChanges.join(" ")).toMatch(/leave the existing proxy configuration untouched/i);
  });

  it("allows an ALPN split with passthrough TLS, at medium risk", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "alpn-inbound", protocol: "vless", tls: "terminated-by-inbound", multiplexing: "alpn" }),
    );
    expect(verdict.possible).toBe(true);
    expect(verdict.method).toBe("alpn-stream-split");
    expect(verdict.risk).toBe("medium");
    expect(verdict.requiredChanges.join(" ")).toMatch(/no re-termination/i);
  });

  it("marks an SNI listener replacement as high risk and spells out the move", () => {
    const verdict = assessSharedEndpoint(
      inbound({ name: "sni-split", protocol: "vless", tls: "terminated-by-inbound", multiplexing: "sni" }),
    );
    expect(verdict.possible).toBe(true);
    expect(verdict.method).toBe("sni-stream-split");
    expect(verdict.risk).toBe("high");
    expect(verdict.requiredChanges.join(" ")).toMatch(/loopback port/i);
  });

  it("joins an existing plain HTTP service with a normal vhost", () => {
    const verdict = assessSharedEndpoint(inbound({ name: "plain-web", protocol: "http", tls: "none" }));
    expect(verdict.possible).toBe(true);
    expect(verdict.method).toBe("http-vhost");
    expect(verdict.webEndpoint.scheme).toBe("http");
  });

  it("never proposes changing certificates, credentials or MTU", () => {
    const verdicts = [
      assessSharedEndpoint(inbound({ multiplexing: "inbound-fallback" })),
      assessSharedEndpoint(inbound({ alreadyBehindProxy: true })),
      assessSharedEndpoint(inbound({ multiplexing: "alpn" })),
      assessSharedEndpoint(inbound({ protocol: "wireguard", transport: "udp" })),
    ];
    for (const verdict of verdicts) {
      const text = [...verdict.requiredChanges, ...verdict.forbidden].join(" ");
      expect(text).toMatch(/certificate|TLS|client|MTU/i);
    }
  });
});

describe("compatibility matrix", () => {
  it("summarises mixed inbounds honestly", () => {
    const rows = buildCompatibilityMatrix(
      [
        inbound({ name: "IR-01/xray-reality", protocol: "vless", tls: "passthrough-sni" }),
        inbound({ name: "IR-01/trojan-443", protocol: "trojan", multiplexing: "inbound-fallback" }),
        inbound({ name: "DE-01/wg-51820", protocol: "wireguard", transport: "udp", ports: [51820], tls: "none" }),
      ],
      { webPort: 8080 },
    );

    expect(rows.map((row) => row.webSharingPossible)).toEqual([false, true, false]);
    expect(rows[1]?.method).toBe("inbound-native-fallback");

    const table = formatCompatibilityMatrix(rows);
    expect(table).toContain("Inbound");
    expect(table).toContain("IR-01/trojan-443");
    // The table must state refusals as clearly as approvals.
    expect(table.split("\n").filter((line) => line.includes("no")).length).toBeGreaterThanOrEqual(2);
  });
});
