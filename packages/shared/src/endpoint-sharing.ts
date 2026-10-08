/**
 * Shared endpoint (web + existing inbound) decision rules — spec §2/§3/§8/§17.
 *
 * This module encodes one question and answers it honestly:
 *
 *   "Can a legitimate Arvoo web service share this observed inbound's endpoint
 *    without changing how existing clients connect?"
 *
 * It is pure: it takes what an inspection actually observed (transport, TLS
 * ownership, multiplexing, who owns the port) and returns a verdict with the
 * method, the risk, the exact changes required, and the rollback. It never
 * assumes a server it has not been told about, and its default for anything
 * unrecognised is "blocked", not "probably fine".
 *
 * Deliberate non-goals:
 *  - UDP is never proxied. There is no such thing as an HTTP reverse proxy for
 *    UDP, and a UDP inbound must never be put behind one (spec §8).
 *  - Raw IP protocols (GRE, ESP) are not TCP or UDP at all and are never shared.
 *  - TLS is never re-terminated just to add a website. Passthrough or the
 *    inbound's own mechanism only (spec §9).
 *  - If sharing would require the operator to change existing client configs,
 *    the answer is no (spec §4/§12).
 */

export type InboundTransport = "tcp" | "udp" | "both";

/** How TLS reaches the inbound today. */
export type TlsOwnership =
  | "none"
  | "terminated-by-inbound" // the inbound process ends TLS itself (e.g. Xray, Trojan)
  | "terminated-by-proxy" // a proxy (nginx/apache) ends TLS and forwards to the inbound
  | "passthrough-sni" // TLS is passed through untouched (e.g. Reality, stream split)
  | "unknown";

/** What the inbound can do to separate web traffic from its own traffic. */
export type Multiplexing =
  | "inbound-fallback" // the protocol itself forwards non-matching traffic to a web listener
  | "alpn" // protocol-aware ALPN routing in front of TLS
  | "sni" // SNI-based routing in front of TLS
  | "http-vhost" // plain HTTP Host-based virtual hosting
  | "none"
  | "unknown";

export interface ObservedInbound {
  /** Human label from the inspection, e.g. "xray-vless-reality". */
  name: string;
  /** Protocol family: vless/vmess/trojan/shadowsocks/openvpn/wireguard/gre/http/other. */
  protocol: string;
  transport: InboundTransport;
  tls: TlsOwnership;
  multiplexing: Multiplexing;
  /** Ports the inspection saw this inbound listening on. */
  ports?: number[];
  /** True when a proxy already sits in front of it (so adding a vhost is local). */
  alreadyBehindProxy?: boolean;
  /**
   * True when the inbound is a raw IP protocol (GRE, IPsec ESP/AH). Such
   * protocols have no TCP/UDP socket to share.
   */
  rawIpProtocol?: boolean;
  /** Evidence lines copied from the inspection, kept for the audit trail. */
  evidence?: string[];
}

export type ShareMethod =
  | "inbound-native-fallback"
  | "alpn-stream-split"
  | "sni-stream-split"
  | "http-vhost"
  | "none";

export type ShareRisk = "low" | "medium" | "high" | "blocked";

export interface ShareVerdict {
  /** True only when sharing can be done without touching existing client config. */
  possible: boolean;
  risk: ShareRisk;
  method: ShareMethod;
  /** Why this verdict was reached, in order of importance. */
  reasons: string[];
  /** Every change required, so the operator can refuse any of them. */
  requiredChanges: string[];
  /** Steps that put the server back exactly as it was. */
  rollback: string[];
  /** Where the web service should listen. */
  webEndpoint: { scheme: "http" | "https"; port: number } | { scheme: "separate"; port: number };
  /** Changes that must NOT be made, recorded so nobody "helpfully" makes them. */
  forbidden: string[];
}

export interface ShareOptions {
  /** Port the web service will listen on behind the split. */
  webPort?: number;
  /** The port a listener was observed on; used for ownership-conflict checks. */
  observedPorts?: number[];
  /**
   * Ports already owned by an unrelated process. Sharing is refused when the
   * endpoint we would add to is owned by something else entirely.
   */
  conflictingOwners?: number[];
  /** Plain HTTP + TLS-hosting operator (needs a certificate for the web name). */
  webHostname?: string | null;
}

const RAW_IP_PROTOCOLS = ["gre", "esp", "ah", "ipip", "sit", "vti"];

function isRawIp(protocol: string, provided?: boolean): boolean {
  if (provided) return true;
  return RAW_IP_PROTOCOLS.includes(protocol.toLowerCase());
}

/**
 * Assess whether the web service can share this inbound's endpoint.
 * Order matters: the cheapest, least invasive method that actually works wins.
 */
export function assessSharedEndpoint(inbound: ObservedInbound, options: ShareOptions = {}): ShareVerdict {
  const webPort = options.webPort ?? 8080;
  const reasons: string[] = [];
  const requiredChanges: string[] = [];
  const forbidden: string[] = [
    "Do not proxy, terminate or otherwise touch the inbound's UDP traffic.",
    "Do not change client configuration, credentials, ciphers or MTU.",
    "Do not restart the inbound service; a graceful reload of the web server only.",
  ];
  const rollback = [
    "Remove the added web server block (or stream block) file.",
    "Run `nginx -t` and reload the web server gracefully.",
    "Re-check that the inbound's listener and a test client connection are unchanged.",
  ];

  const protocol = inbound.protocol.toLowerCase();

  // ---- Hard refusals -------------------------------------------------------
  if (isRawIp(protocol, inbound.rawIpProtocol)) {
    reasons.push(
      `${inbound.name} is a raw IP protocol (${protocol.toUpperCase()}) with no TCP or UDP socket; there is nothing to share an endpoint with.`,
    );
    return blocked(inbound, reasons, requiredChanges, rollback, forbidden, webPort);
  }

  if (inbound.transport === "udp") {
    reasons.push(
      `${inbound.name} listens on UDP only. An HTTP/HTTPS website is a TCP service, and UDP cannot be reverse-proxied; sharing the same port number is impossible, not merely risky.`,
    );
    return blocked(inbound, reasons, requiredChanges, rollback, forbidden, webPort);
  }

  if (inbound.transport === "both") {
    reasons.push(
      `${inbound.name} owns both TCP and UDP on its port. Even when the TCP side could be split, the UDP side cannot — a partial split leaves the endpoint semantics confusing for existing clients.`,
    );
    return blocked(inbound, reasons, requiredChanges, rollback, forbidden, webPort);
  }

  const conflicting = (options.conflictingOwners ?? []).filter((port) => (inbound.ports ?? []).includes(port));
  if (conflicting.length > 0) {
    reasons.push(
      `Another process already owns ${conflicting.join(", ")}; adding a listener there would fight over the socket instead of sharing it.`,
    );
    return blocked(inbound, reasons, requiredChanges, rollback, forbidden, webPort);
  }

  // ---- Preferred: the inbound's own mechanism ------------------------------
  if (inbound.alreadyBehindProxy) {
    reasons.push(
      `A web server already fronts ${inbound.name}, so the web service is added as one more virtual host and the inbound keeps its socket and its TLS.`,
    );
    requiredChanges.push(
      `Add an isolated server block for the web hostname and forward it to the web service on 127.0.0.1:${webPort}.`,
      "Leave the existing proxy configuration untouched.",
    );
    return verdict(inbound, "low", "http-vhost", {
      possible: true,
      reasons,
      requiredChanges,
      rollback,
      forbidden,
      scheme: "https",
      port: webPort,
    });
  }

  if (inbound.multiplexing === "inbound-fallback" || protocol === "trojan") {
    reasons.push(
      `${inbound.name} supports its own fallback mechanism: traffic that is not recognised as the inbound protocol is handed to a local web listener. This is the protocol's designed mechanism, so it adds no extra proxy hop, no re-termination and no client change.`,
    );
    requiredChanges.push(
      `Point the inbound's fallback target at the web service on 127.0.0.1:${webPort}.`,
      "Reload the inbound's own configuration if and only if the protocol requires it to pick up a fallback change; prefer a reload over a restart.",
    );
    return verdict(inbound, "low", "inbound-native-fallback", {
      possible: true,
      reasons,
      requiredChanges,
      rollback,
      forbidden,
      scheme: "https",
      port: webPort,
    });
  }

  if (inbound.multiplexing === "alpn") {
    reasons.push(
      `${inbound.name} can be routed by ALPN in front of TLS, so HTTP/HTTPS traffic can be separated without terminating TLS and without touching the inbound's own settings.`,
    );
    requiredChanges.push(
      `Add a stream{} block that proxies ALPN http/1.1 and h2 to 127.0.0.1:${webPort} and everything else to the inbound's listener.`,
      "Keep TLS passthrough: no certificate replacement, no re-termination.",
    );
    return verdict(inbound, "medium", "alpn-stream-split", {
      possible: true,
      reasons,
      requiredChanges,
      rollback,
      forbidden,
      scheme: "https",
      port: webPort,
    });
  }

  if (inbound.multiplexing === "sni" && inbound.tls === "terminated-by-inbound") {
    reasons.push(
      `${inbound.name} ends TLS itself and routes by SNI, so a distinct hostname can be served by the web service with TLS passthrough.`,
    );
    reasons.push(
      "Risk: the split happens before the TLS handshake, so a misconfiguration is visible to clients. Rehearse the plan and keep the rollback ready.",
    );
    requiredChanges.push(
      `Add a stream{} block with ssl_preread: the web hostname goes to 127.0.0.1:${webPort}, every other SNI goes to the inbound's listener.`,
      "The inbound must be moved to a loopback port and the original port becomes the splitter. That move is a listener replacement: schedule it, and expect the inbound to reload.",
    );
    return verdict(inbound, "high", "sni-stream-split", {
      possible: true,
      reasons,
      requiredChanges,
      rollback,
      forbidden,
      scheme: "https",
      port: webPort,
    });
  }

  if (protocol === "http") {
    reasons.push(`${inbound.name} is plain HTTP, so the web service joins it as an ordinary virtual host.`);
    requiredChanges.push(`Add a server block for the web hostname and forward to 127.0.0.1:${webPort}.`);
    return verdict(inbound, "low", "http-vhost", {
      possible: true,
      reasons,
      requiredChanges,
      rollback,
      forbidden,
      scheme: "http",
      port: webPort,
    });
  }

  // ---- Everything else: leave it alone ------------------------------------
  if (inbound.multiplexing === "sni") {
    reasons.push(
      `${inbound.name} routes by SNI but does not end TLS itself. Splitting in front of it would mean inserting a TLS layer the clients never negotiated with, which changes what existing clients see.`,
    );
  } else if (inbound.tls === "passthrough-sni") {
    reasons.push(
      `${inbound.name} passes TLS through to a third-party destination whose handshake must stay authoritative. Adding our own virtual host would either change that destination or break the handshake, both of which change existing client behaviour.`,
    );
  } else {
    reasons.push(
      `No mechanism was found that separates web traffic from ${inbound.name}'s traffic without changing how existing clients connect (multiplexing: ${inbound.multiplexing}).`,
    );
  }
  reasons.push(
    `Use an independent web endpoint instead (for example 443 on a dedicated address, or ${webPort} behind the operator's own hostname). Correctness beats forcing uniformity.`,
  );
  return blocked(inbound, reasons, requiredChanges, rollback, forbidden, webPort);
}

function verdict(
  inbound: ObservedInbound,
  risk: ShareRisk,
  method: ShareMethod,
  payload: {
    possible: boolean;
    reasons: string[];
    requiredChanges: string[];
    rollback: string[];
    forbidden: string[];
    scheme: "http" | "https";
    port: number;
  },
): ShareVerdict {
  return {
    possible: payload.possible,
    risk,
    method,
    reasons: payload.reasons,
    requiredChanges: payload.requiredChanges,
    rollback: payload.rollback,
    webEndpoint: { scheme: payload.scheme, port: payload.port },
    forbidden: payload.forbidden,
  };
}

function blocked(
  inbound: ObservedInbound,
  reasons: string[],
  requiredChanges: string[],
  rollback: string[],
  forbidden: string[],
  webPort: number,
): ShareVerdict {
  if (requiredChanges.length === 0) {
    requiredChanges.push(`No change to ${inbound.name}. Deploy the web service on its own endpoint.`);
  }
  return {
    possible: false,
    risk: "blocked",
    method: "none",
    reasons,
    requiredChanges,
    rollback: ["Nothing was changed, so nothing needs rolling back; confirm the inbound is still listening on its original socket."],
    webEndpoint: { scheme: "separate", port: webPort },
    forbidden,
  };
}

/** One row of the compatibility matrix the operator signs off (spec §2). */
export interface CompatibilityRow {
  inbound: string;
  ports: number[];
  transport: InboundTransport;
  tls: TlsOwnership;
  webSharingPossible: boolean;
  method: ShareMethod;
  risk: ShareRisk;
  reason: string;
}

export function buildCompatibilityMatrix(
  inbounds: ObservedInbound[],
  options: ShareOptions = {},
): CompatibilityRow[] {
  return inbounds.map((inbound) => {
    const result = assessSharedEndpoint(inbound, options);
    return {
      inbound: inbound.name,
      ports: inbound.ports ?? [],
      transport: inbound.transport,
      tls: inbound.tls,
      webSharingPossible: result.possible,
      method: result.method,
      risk: result.risk,
      reason: result.reasons[0] ?? "",
    };
  });
}

/** Render the matrix as a fixed-width table for logs, tickets and docs. */
export function formatCompatibilityMatrix(rows: CompatibilityRow[]): string {
  const header = ["Inbound", "Ports", "Transport", "Web sharing", "Method", "Risk"];
  const body = rows.map((row) => [
    row.inbound,
    row.ports.join(",") || "-",
    row.transport,
    row.webSharingPossible ? "yes" : "no",
    row.method,
    row.risk,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}
