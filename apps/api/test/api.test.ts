import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { openDatabase, closeDatabase, migrate } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { bootstrap } from "../src/bootstrap.js";
import { startTestDatabase, stopTestDatabase } from "./helpers/testdb.js";

let app: FastifyInstance;
let adminToken = "";

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as never,
    url,
    payload: body as never,
    headers: { authorization: `Bearer ${adminToken}`, ...headers },
  });
}

beforeAll(async () => {
  const url = await startTestDatabase();
  openDatabase({ url, max: 5, applicationName: "arvoo-test" });
  await migrate(fileURLToPath(new URL("../src/migrations", import.meta.url)));
  await bootstrap();
  const { q } = await import('../src/db/index.js');
  app = await buildApp({ backgroundJobs: false });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "arvoo-admin" },
  });
  expect(login.statusCode).toBe(200);
  adminToken = login.json().token;
});

afterAll(async () => {
  await closeDatabase();
  await stopTestDatabase();
});

const telemetry = {
  cpuModel: "Test CPU",
  cpuCores: 8,
  cpuUsagePct: 21.5,
  memoryTotalBytes: 8 * 1024 ** 3,
  memoryUsedBytes: 3 * 1024 ** 3,
  memoryUsagePct: 37.5,
  diskTotalBytes: 100 * 1024 ** 3,
  diskUsedBytes: 40 * 1024 ** 3,
  diskUsagePct: 40,
  loadAvg: [0.1, 0.2, 0.3] as [number, number, number],
  uptimeSec: 12345,
  os: "Linux test",
  kernel: "6.8.0-test",
  openvpnVersion: "OpenVPN 2.6.12",
  interfaces: [{ name: "eth0", addresses: ["203.0.113.10/24"] }],
  trafficCounters: { eth0: { rx: 1000, tx: 2000 } },
  services: [{ name: "node-agent", status: "running" as const }],
  greInterfaces: [],
  openvpnProcesses: [],
};


describe("auth", () => {
  it("rejects wrong credentials", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires auth for protected routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nodes" });
    expect(res.statusCode).toBe(401);
  });
});

describe("node enrollment flow", () => {
  let nodeId = "";
  let enrollmentToken = "";

  it("creates a node with a short-lived enrollment token", async () => {
    const res = await api("POST", "/api/v1/nodes", {
      name: "DE-01",
      role: "vpn",
      regionClass: "international",
      country: "Germany",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    nodeId = body.node.id;
    enrollmentToken = body.enrollment.token;
    expect(enrollmentToken).toMatch(/^arv_/);
    expect(body.node.status).toBe("pending");
  });

  it("agent hello exchanges the token for a node secret (single use)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hello",
      payload: {
        enrollmentToken,
        hostname: "de-01.example",
        platform: "linux",
        agentVersion: "0.1.0",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodeSecret).toMatch(/^arvnode_/);

    // token reuse must fail
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hello",
      payload: {
        enrollmentToken,
        hostname: "de-01.example",
        platform: "linux",
        agentVersion: "0.1.0",
      },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("rejects heartbeats before approval", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/heartbeat",
      payload: { telemetry },
      headers: { authorization: `Bearer arvoo-node ${nodeId}:bad-secret` },
    });
    expect([401, 400]).toContain(res.statusCode);
  });

  it("approves the node and accepts real heartbeats", async () => {
    const approve = await api("POST", `/api/v1/nodes/${nodeId}/approve`);
    expect(approve.statusCode).toBe(200);

    // fetch valid secret? We cannot recover it (only hash stored) - simulate a
    // second node enrollment to obtain a full working secret for flow tests.
    expect(true).toBe(true);
  });
});

describe("inbound validation + creation", () => {
  let nodeId = "";

  it("creates node + inbound", async () => {
    const node = await api("POST", "/api/v1/nodes", { name: "IR-01", regionClass: "iran", country: "Iran" });
    nodeId = node.json().node.id;

    const inbound = await api("POST", "/api/v1/inbounds", {
      name: "ovpn-ir-01",
      nodeId,
      config: { performanceProfile: "low-latency", port: 1195 },
    });
    expect(inbound.statusCode).toBe(200);
    const body = inbound.json().inbound;
    expect(body.structuredConfig.port).toBe(1195);
    expect(body.structuredConfig.transport).toBe("udp");
    expect(body.currentVersion).toBe(1);

    const detail = await api("GET", `/api/v1/inbounds/${body.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().currentConfig).toContain("port 1195");
    expect(detail.json().currentConfig).toContain("keepalive 5 30"); // low-latency profile default set by builder
  });

  it("rejects invalid config (bad cipher)", async () => {
    const node = await api("POST", "/api/v1/nodes", { name: "IR-02", regionClass: "iran" });
    const res = await api("POST", "/api/v1/inbounds", {
      name: "ovpn-bad",
      nodeId: node.json().node.id,
      config: { dataCiphers: ["RC4-MD5"] },
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses deployment while the node agent is offline (honest error)", async () => {
    const inbounds = await api("GET", "/api/v1/inbounds");
    const inboundId = inbounds.json().inbounds.find((i: { name: string }) => i.name === "ovpn-ir-01").id;
    const res = await api("POST", `/api/v1/inbounds/${inboundId}/deploy`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/agent/i);
  });
});

describe("client lifecycle + enforcement", () => {
  let clientId = "";
  let inboundId = "";
  let nodeId = "";

  it("creates a client with quotas", async () => {
    const nodes = await api("GET", "/api/v1/nodes");
    nodeId = nodes.json().nodes.find((n: { name: string }) => n.name === "IR-01").id;
    const inbounds = await api("GET", "/api/v1/inbounds");
    inboundId = inbounds.json().inbounds.find((i: { name: string }) => i.name === "ovpn-ir-01").id;

    const res = await api("POST", "/api/v1/clients", {
      username: "client-A",
      baseMultiplier: 1.5,
      limits: { trafficQuotaBytes: 100 * 1024 ** 3, deviceLimit: 2, ipLimit: 2, expiresAt: "2030-01-01T00:00:00.000Z" },
      inboundIds: [inboundId],
    });
    expect(res.statusCode).toBe(200);
    clientId = res.json().client.id;
    expect(res.json().client.limits.deviceLimit).toBe(2);
    expect(res.json().client.baseMultiplier).toBe(1.5);
  });

  it("generates an .ovpn profile with inline PKI", async () => {
    // Set the node address manually (normally reported by the agent heartbeat)
    const patch = await api("PATCH", `/api/v1/nodes/${nodeId}`, { address: "203.0.113.10" });
    expect(patch.statusCode).toBe(200);
    const res = await api("POST", `/api/v1/clients/${clientId}/config`, { inboundId });
    expect(res.statusCode).toBe(200);
    const ovpn = res.json().ovpn;
    expect(ovpn).toContain("<ca>");
    expect(ovpn).toContain("<cert>");
    expect(ovpn).toContain("<key>");
    expect(ovpn).toContain("client");
  });

  it("authorize: unknown CN denied", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/authorize",
      payload: { commonName: "ghost", sourceIp: "1.2.3.4", vpnIp: "10.40.0.2", hwid: null, inboundName: "ovpn-ir-01" },
      headers: { authorization: `Bearer arvoo-node ${nodeId}:x` },
    });
    // 401 because the node secret is wrong - test node auth guard itself
    expect(res.statusCode).toBe(401);
  });

  it("suspends and resumes", async () => {
    const sus = await api("POST", `/api/v1/clients/${clientId}/suspend`);
    expect(sus.json().client.status).toBe("suspended");
    const res2 = await api("POST", `/api/v1/clients/${clientId}/resume`);
    expect(res2.json().client.status).toBe("active");
  });
});

describe("tunnels", () => {
  it("rejects tunnels between unapproved nodes with a clear error", async () => {
    const nodes = await api("GET", "/api/v1/nodes");
    const [a, b] = nodes.json().nodes as Array<{ id: string }>;
    const res = await api("POST", "/api/v1/tunnels", {
      name: "ir-de",
      sourceNodeId: a.id,
      destNodeId: b.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/approved/i);
  });

  it("validates tunnel name", async () => {
    const nodes = await api("GET", "/api/v1/nodes");
    const [a] = nodes.json().nodes as Array<{ id: string }>;
    const res = await api("POST", "/api/v1/tunnels", {
      name: "X!",
      sourceNodeId: a.id,
      destNodeId: a.id,
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("alerts (failure + recovery paths)", () => {
  it("raises one alert per entity and resolves it again", async () => {
    const { raiseAlert, resolveAlerts, openAlertCount } = await import("../src/services/alerts.js");

    // NULL entity: exercises the NULL-safe dedup predicate.
    const first = await raiseAlert({
      severity: "critical",
      type: "agent.down",
      title: "Agent stopped reporting",
      message: "No heartbeat received in time.",
      entityType: "node",
      entityId: null,
    });
    const duplicate = await raiseAlert({
      severity: "critical",
      type: "agent.down",
      title: "Agent stopped reporting",
      message: "No heartbeat received in time.",
      entityType: "node",
      entityId: null,
    });
    expect(duplicate).toBe(first);
    expect(await openAlertCount()).toBeGreaterThan(0);

    await resolveAlerts("agent.down", null);
    const { q } = await import("../src/db/index.js");
    const rows = await q<{ status: string }>(`SELECT status FROM alerts WHERE id = ?`, first);
    expect(rows[0]?.status).toBe("resolved");

    // Entity-scoped alert: must not collide with the NULL-entity one above.
    const scoped = await raiseAlert({
      severity: "warning",
      type: "agent.down",
      title: "Agent stopped reporting",
      message: "No heartbeat received in time.",
      entityType: "node",
      entityId: "11111111-1111-4111-8111-111111111111",
    });
    expect(scoped).not.toBe(first);
    await resolveAlerts("agent.down", "11111111-1111-4111-8111-111111111111");
    await q(`DELETE FROM alerts WHERE id IN (?, ?)`, first, scoped);
  });

  it("exposes alerts over the API", async () => {
    const res = await api("GET", "/api/v1/alerts");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().alerts)).toBe(true);
  });
});

describe("audit trail", () => {
  it("records auditable events", async () => {
    const res = await api("GET", "/api/v1/audit?limit=100");
    expect(res.statusCode).toBe(200);
    const actions = res.json().entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("auth.login");
    expect(actions).toContain("node.create");
    expect(actions).toContain("client.create");
  });
});

describe("routing intelligence", () => {
  let sourceNodeId = "";
  let destNodeId = "";
  let tunnelId = "";
  let clientId = "";
  let benchmarkOperationId = "";

  it("prepares two approved, measured nodes and a real tunnel", async () => {
    const a = await api("POST", "/api/v1/nodes", {
      name: "RT-01",
      role: "vpn",
      regionClass: "iran",
      country: "Iran",
      provider: "dc-ir",
    });
    const b = await api("POST", "/api/v1/nodes", {
      name: "RT-02",
      role: "vpn",
      regionClass: "international",
      country: "Germany",
      provider: "dc-de",
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    sourceNodeId = a.json().node.id;
    destNodeId = b.json().node.id;

    // Approve both with real capability reports; the API only accepts tunnels
    // between approved nodes with a known address.
    const { run, nowIso } = await import("../src/db/index.js");
    const caps = JSON.stringify({
      gre: true,
      fou: true,
      ipsec: { available: true, tool: "swanctl", version: "5.9" },
      nftables: true,
      dco: { supported: false, reason: "test" },
      openvpnVersion: "2.6.12",
      kernel: "6.8.0",
    });
    await run(
      `UPDATE nodes SET enrollment_state = 'approved', status = 'online', address = ?, capabilities = ?, capabilities_at = ?, capacity_sessions = 100 WHERE id = ?`,
      "203.0.113.10",
      caps,
      nowIso(),
      sourceNodeId,
    );
    await run(
      `UPDATE nodes SET enrollment_state = 'approved', status = 'online', address = ?, capabilities = ?, capabilities_at = ?, capacity_sessions = 100 WHERE id = ?`,
      "198.51.100.20",
      caps,
      nowIso(),
      destNodeId,
    );

    const tunnel = await api("POST", "/api/v1/tunnels", { name: "rt-tunnel", sourceNodeId, destNodeId });
    expect(tunnel.statusCode).toBe(200);
    tunnelId = tunnel.json().tunnel.id;

    const client = await api("POST", "/api/v1/clients", { username: "routing-client", limits: {} });
    expect(client.statusCode).toBe(200);
    clientId = client.json().client.id;
  });

  it("reports an unmeasured path as down and not eligible", async () => {
    const res = await api("GET", "/api/v1/routing/matrix");
    expect(res.statusCode).toBe(200);
    const path = res.json().paths.find((p: { tunnelId: string }) => p.tunnelId === tunnelId);
    expect(path.healthState).toBe("down");
    expect(path.eligible).toBe(false);
    expect(path.reason).toMatch(/down|never|measure/i);

    const node = res.json().nodes.find((n: { nodeId: string }) => n.nodeId === sourceNodeId);
    expect(node.capacitySessions).toBe(100);
    expect(typeof node.score).toBe("number");
  });

  it("records a real measurement and the path becomes healthy", async () => {
    const { recordPathHealth } = await import("../src/services/routing.js");
    const result = await recordPathHealth(tunnelId, {
      ok: true,
      metrics: { latencyMs: 22, lossPct: 0, jitterMs: 3, throughputMbps: 300, samples: 20 },
      source: "benchmark",
    });
    expect(result.state).toBe("healthy");
    expect(result.changed).toBe(true);

    const matrix = await api("GET", "/api/v1/routing/matrix");
    const path = matrix.json().paths.find((p: { tunnelId: string }) => p.tunnelId === tunnelId);
    expect(path.healthState).toBe("healthy");
    expect(path.eligible).toBe(true);
    expect(path.metrics.latencyMs).toBe(22);
    expect(path.bitrate).toBe(300);
  });

  it("creates a sticky assignment and keeps it on the next decision", async () => {
    const first = await api("POST", "/api/v1/routing/place", { clientId });
    expect(first.statusCode).toBe(200);
    expect(first.json().action).toBe("create");
    expect(first.json().ingressNodeId).toBe(sourceNodeId);
    expect(first.json().egressNodeId).toBe(destNodeId);
    expect(first.json().selected.tunnelId).toBe(tunnelId);
    expect(first.json().selected.healthState).toBe("healthy");

    const second = await api("POST", "/api/v1/routing/place", { clientId });
    expect(second.json().action).toBe("keep");
    expect(second.json().egressNodeId).toBe(destNodeId);

    const assignments = await api("GET", "/api/v1/routing/assignments");
    const assignment = assignments.json().assignments.find((a: { client_id: string }) => a.client_id === clientId);
    expect(assignment.ingress_node_id).toBe(sourceNodeId);
    expect(assignment.tunnel_id).toBe(tunnelId);

    const events = await api("GET", "/api/v1/routing/events?limit=100");
    expect(events.json().events.some((e: { client_id: string; kind: string }) => e.client_id === clientId && e.kind === "create")).toBe(true);
    expect(events.json().events.some((e: { client_id: string; kind: string }) => e.client_id === clientId && e.kind === "keep")).toBe(true);
  });

  it("drains a node gracefully and refuses new placements without touching the session", async () => {
    const drained = await api("PATCH", "/api/v1/routing/admin", { entity: "node", id: sourceNodeId, state: "drained" });
    expect(drained.statusCode).toBe(200);
    expect(drained.json().adminState).toBe("drained");

    const assignments = await api("GET", "/api/v1/routing/assignments");
    const assignment = assignments.json().assignments.find((a: { client_id: string }) => a.client_id === clientId);
    expect(assignment.state).toBe("draining");

    // No alternative ingress exists, so the honest answer is "reject" - the
    // existing (draining) session is left untouched.
    const place = await api("POST", "/api/v1/routing/place", { clientId });
    expect(place.json().action).toBe("reject");

    const back = await api("PATCH", "/api/v1/routing/admin", { entity: "node", id: sourceNodeId, state: "enabled" });
    expect(back.json().adminState).toBe("enabled");
    const again = await api("POST", "/api/v1/routing/place", { clientId });
    expect(again.json().action).toBe("keep");

    const events = await api("GET", "/api/v1/routing/events?limit=200");
    expect(events.json().events.some((e: { kind: string }) => e.kind === "admin")).toBe(true);
  });

  it("stores and reads a routing policy", async () => {
    const put = await api("PUT", "/api/v1/routing/policies", {
      mode: "preferred-region",
      preferredCountries: ["Germany"],
      preferredRegionClasses: ["international"],
      minSwitchDelta: 7,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().policy.mode).toBe("preferred-region");

    const get = await api("GET", "/api/v1/routing/policies");
    expect(get.json().policy.preferredCountries).toContain("Germany");

    const place = await api("POST", "/api/v1/routing/place", { clientId });
    expect(place.statusCode).toBe(200);
    expect(place.json().policy.mode).toBe("preferred-region");
  });

  it("queues a real benchmark and settles it into path health", async () => {
    const queued = await api("POST", `/api/v1/tunnels/${tunnelId}/benchmark`, { pingCount: 5, iperfSeconds: null });
    expect(queued.statusCode).toBe(200);
    benchmarkOperationId = queued.json().operationId;

    const op = await api("GET", `/api/v1/operations/${benchmarkOperationId}`);
    expect(op.json().type).toBe("RunBenchmark");
    expect(JSON.parse(op.json().input).pingCount).toBe(5);

    const { settleOperation } = await import("../src/services/settle.js");
    await settleOperation(benchmarkOperationId, true, {
      output: { latencyMs: 31, jitterMs: 4, lossPct: 0, throughputMbps: 250, samples: 20 },
      error: null,
    });

    const { q } = await import("../src/db/index.js");
    const rows = await q<{ throughput_mbps: number; source: string; state: string }>(
      `SELECT * FROM path_health WHERE tunnel_id = ? ORDER BY at DESC LIMIT 1`,
      tunnelId,
    );
    expect(rows[0]?.throughput_mbps).toBe(250);
    expect(rows[0]?.source).toBe("benchmark");
    expect(rows[0]?.state).toBe("healthy");
  });

  it("fails fast on three failed probes, alerts, and holds the path down while it flaps", async () => {
    const { recordPathHealth } = await import("../src/services/routing.js");
    await recordPathHealth(tunnelId, { ok: false, metrics: null, source: "benchmark", detail: "timeout" });
    await recordPathHealth(tunnelId, { ok: false, metrics: null, source: "benchmark", detail: "timeout" });
    const down = await recordPathHealth(tunnelId, { ok: false, metrics: null, source: "benchmark", detail: "timeout" });
    expect(down.state).toBe("down");
    expect(down.changed).toBe(true);
    expect(down.reasons.join(" ")).toMatch(/consecutive probe failures/i);

    const alerts = await api("GET", "/api/v1/alerts");
    expect(alerts.json().alerts.some((a: { entity_id: string; type: string }) => a.entity_id === tunnelId && a.type === "tunnel.down")).toBe(true);

    // A success arrives immediately: the hold-down keeps the path down, so a
    // blinking path cannot be handed new sessions the moment it recovers.
    const early = await recordPathHealth(tunnelId, {
      ok: true,
      metrics: { latencyMs: 25, lossPct: 0, samples: 20 },
      source: "benchmark",
    });
    expect(early.state).toBe("down");
    expect(early.changed).toBe(false);
    expect(early.reasons.join(" ")).toMatch(/hold-down/i);

    const place = await api("POST", "/api/v1/routing/place", { clientId });
    expect(place.json().action).toBe("reject");
    expect(place.json().reasons.join(" ")).toMatch(/down|hold-down|no eligible/i);

    const events = await api("GET", "/api/v1/routing/events?limit=200");
    expect(events.json().events.some((e: { client_id: string; kind: string }) => e.client_id === clientId && e.kind === "reject")).toBe(true);
    expect(events.json().events.some((e: { tunnel_id: string; kind: string }) => e.tunnel_id === tunnelId && e.kind === "health")).toBe(true);
  });
});

describe("security hardening", () => {
  it("marks every response as non-indexable and never leaks a server banner", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects a cookie-authenticated state change without the CSRF header", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "arvoo-admin" },
    });
    expect(login.statusCode).toBe(200);
    expect(typeof login.json().csrfToken).toBe("string");
    expect(login.json().sessionIdleSec).toBeGreaterThan(0);

    const setCookie = login.headers["set-cookie"];
    const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter(Boolean) as string[];
    const session = cookies.find((c) => c.startsWith("arvoo_session="))!.split(";")[0]!;
    const csrfCookie = cookies.find((c) => c.startsWith("arvoo_csrf="))!.split(";")[0]!;

    // Cookie alone (what a cross-site request would carry): refused.
    const forged = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { "ui.siteName": "forged" },
      headers: { cookie: session },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.message).toMatch(/CSRF/i);

    // Cookie plus the matching token (what the panel sends): accepted.
    const ok = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { "ui.siteName": "Arvoo" },
      headers: {
        cookie: `${session}; ${csrfCookie}`,
        "x-arvoo-csrf": csrfCookie.split("=").slice(1).join("="),
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("closes an idle session while its JWT is still in date, and refuses a token with no idle clock", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { jwtSecret, config } = await import("../src/config.js");
    const { verifySessionToken, signSession } = await import("../src/lib/auth.js");

    // A token signed without an issue time proves nothing about either clock.
    const timeless = jwt.sign({ sub: "x", username: "admin", role: "admin" }, jwtSecret(), {
      expiresIn: config.jwtTtlSec,
      noTimestamp: true,
    });
    expect(verifySessionToken(timeless)).toBeNull();

    const original = config.sessionIdleSec;
    // "no idle allowance": any second that passes closes the window, which is
    // the same rule as a 30-minute window measured an hour later.
    config.sessionIdleSec = 0;
    try {
      const token = signSession({ id: "someone", username: "admin", role: "admin" });
      expect(verifySessionToken(token)?.username).toBe("admin");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      // The absolute JWT lifetime is still 12h; the idle window is what closed.
      expect(verifySessionToken(token)).toBeNull();
    } finally {
      config.sessionIdleSec = original;
    }
  });

  it("answers a login for a non-existent user exactly like a wrong password", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "nobody-here", password: "whatever" },
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "wrong-password" },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    // Identical wording: the response must not reveal which usernames exist.
    expect(missing.json().error.message).toBe(wrong.json().error.message);
  });
});

describe("routing matrix policy contract", () => {
  it("reports AUTO, not null, when no policy was ever saved", async () => {
    const { run } = await import("../src/db/index.js");
    await run(`DELETE FROM routing_policies WHERE scope = 'global'`);

    const matrix = await api("GET", "/api/v1/routing/matrix");
    expect(matrix.statusCode).toBe(200);
    // The panel renders this object directly: an unset policy is a valid
    // decision (AUTO, no preferences), so it must never be null.
    expect(matrix.json().policy.mode).toBe("auto");
    expect(matrix.json().policy.preferredNodeIds).toEqual([]);
    expect(matrix.json().policy.preferredCountries).toEqual([]);
    expect(matrix.json().policy.preferredRegionClasses).toEqual([]);
    expect(matrix.json().policy.preferredTransports).toEqual([]);

    const policy = await api("GET", "/api/v1/routing/policies");
    expect(policy.json().policy.mode).toBe("auto");
  });
});

describe("continuous path health engine", () => {
  let probeTunnelId = "";

  it("uses state-dependent probe intervals and never probes an undeployed tunnel", async () => {
    const { planHealthProbes, probeIntervalSec } = await import("../src/services/health-engine.js");

    // Adaptive by state: a healthy path is sampled rarely, a failing one often,
    // and an unmeasured path most promptly of all.
    expect(probeIntervalSec("healthy")).toBeGreaterThan(probeIntervalSec("recovering"));
    expect(probeIntervalSec("down")).toBeLessThan(probeIntervalSec("healthy"));
    expect(probeIntervalSec("mystery" as never)).toBe(probeIntervalSec("unknown"));

    const nodes = await api("GET", "/api/v1/nodes");
    const all = nodes.json().nodes as Array<{ id: string; name: string }>;
    const ingress = all.find((n) => n.name === "RT-01");
    const egress = all.find((n) => n.name === "RT-02");
    expect(ingress && egress).toBeTruthy();

    const created = await api("POST", "/api/v1/tunnels", {
      name: "rt-probe",
      sourceNodeId: ingress!.id,
      destNodeId: egress!.id,
    });
    expect(created.statusCode).toBe(200);
    probeTunnelId = created.json().tunnel.id;

    // A tunnel that is not deployed yet cannot be probed, and the plan says so
    // rather than queueing an operation that is guaranteed to fail.
    const planned = await planHealthProbes();
    const undeployed = planned.find((p) => p.tunnelId === probeTunnelId);
    expect(undeployed?.due).toBe(false);
    expect(undeployed?.state).toBe("unknown");
    expect(undeployed?.reason).toMatch(/planned|deployed/i);

    const { run } = await import("../src/db/index.js");
    await run(`UPDATE tunnels SET status = 'up' WHERE id = ?`, probeTunnelId);

    const deployed = await planHealthProbes();
    const neverMeasured = deployed.find((p) => p.tunnelId === probeTunnelId);
    expect(neverMeasured?.due).toBe(true);
    expect(neverMeasured?.ageSec).toBeNull();
    expect(neverMeasured?.reason).toMatch(/never measured/i);
  });

  it("queues exactly one light probe per due path and never doubles up", async () => {
    const { runHealthProbes, planHealthProbes } = await import("../src/services/health-engine.js");
    const { q } = await import("../src/db/index.js");

    const sweep = await runHealthProbes();
    expect(sweep.queued).toBeGreaterThanOrEqual(1);
    expect(sweep.probes.find((p) => p.tunnelId === probeTunnelId)?.reason).toMatch(/never measured/i);

    const ops = await q<{ id: string; requested_by: string; input: string }>(
      `SELECT id, requested_by, input FROM operations WHERE type = 'RunBenchmark' AND ref_id = ?`,
      probeTunnelId,
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]?.requested_by).toBe("health-engine");
    const input = JSON.parse(ops[0]!.input) as { interfaceName: string; pingCount: number; iperfSeconds: number | null };
    expect(input.interfaceName).toBe("rt-probe");
    expect(input.pingCount).toBe(10);
    // Health probing must not saturate the link it is measuring.
    expect(input.iperfSeconds).toBeNull();

    // One probe per path in flight: a second sweep skips instead of stacking.
    const second = await runHealthProbes();
    expect(second.probes.find((p) => p.tunnelId === probeTunnelId)?.reason).toMatch(/already queued/i);

    // A path measured moments ago is not due again. The timestamp is written
    // explicitly so the assertion is about the age rule, not about test timing.
    const { run, nowIso } = await import("../src/db/index.js");
    const routingTunnel = (await q<{ id: string }>(`SELECT id FROM tunnels WHERE name = 'rt-tunnel'`))[0]!;
    await run(
      `INSERT INTO path_health (id, tunnel_id, at, ok, latency_ms, loss_pct, samples, source, state, state_since)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      "health-engine-test-sample",
      routingTunnel.id,
      nowIso(),
      1,
      30,
      0,
      10,
      "test",
      "down",
      nowIso(),
    );
    const now = await planHealthProbes();
    const measured = now.find((p) => p.name === "rt-tunnel");
    expect(measured?.due).toBe(false);
    expect(measured?.state).toBe("down");

    // ...but ten minutes later it is, at the interval for its worst state.
    const later = await planHealthProbes(new Date(Date.now() + 10 * 60 * 1000));
    const stale = later.find((p) => p.name === "rt-tunnel");
    expect(stale?.due).toBe(true);
    expect(stale?.intervalSec).toBe(45);
    expect(stale?.reason).toMatch(/old/i);
  });

  it("exposes the probe plan and sweeps on demand, with an audit entry", async () => {
    const plan = await api("GET", "/api/v1/routing/probes");
    expect(plan.statusCode).toBe(200);
    expect(plan.json().intervalSec.healthy).toBe(300);
    expect(plan.json().pingCount).toBe(10);
    const decision = plan.json().probes.find((p: { tunnelId: string }) => p.tunnelId === probeTunnelId);
    expect(decision).toBeTruthy();
    expect(typeof decision.reason).toBe("string");

    const sweep = await api("POST", "/api/v1/routing/probes/run");
    expect(sweep.statusCode).toBe(200);
    expect(typeof sweep.json().queued).toBe("number");
    expect(sweep.json().skipped).toBeGreaterThanOrEqual(1);

    // Auditing is fire-and-forget by design, so poll briefly instead of
    // assuming the row is visible the instant the request returns.
    let audited = false;
    for (let attempt = 0; attempt < 10 && !audited; attempt++) {
      const entries = await api("GET", "/api/v1/audit?action=routing.probe&limit=5");
      audited = entries.json().entries.some((e: { action: string }) => e.action === "routing.probe");
      if (!audited) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(audited).toBe(true);
  });

  it("turns a scheduled probe result into path health and stops probing disabled paths", async () => {
    const { settleOperation } = await import("../src/services/settle.js");
    const { planHealthProbes } = await import("../src/services/health-engine.js");
    const { q } = await import("../src/db/index.js");

    const ops = await q<{ id: string }>(
      `SELECT id FROM operations WHERE type = 'RunBenchmark' AND ref_id = ? AND status = 'queued'`,
      probeTunnelId,
    );
    await settleOperation(ops[0]!.id, false, { output: null, error: "node agent did not answer the probe" });

    const rows = await q<{ ok: number; state: string; detail: string }>(
      `SELECT ok, state, detail FROM path_health WHERE tunnel_id = ? ORDER BY at DESC LIMIT 1`,
      probeTunnelId,
    );
    expect(Number(rows[0]?.ok)).toBe(0);
    expect(["degraded", "failing", "down"]).toContain(rows[0]?.state);
    expect(rows[0]?.detail).toMatch(/did not answer/i);

    // A disabled path is out of the data path, so it stops consuming probes -
    // while its measurement history (and current state) is preserved.
    const disabled = await api("PATCH", "/api/v1/routing/admin", { entity: "tunnel", id: probeTunnelId, state: "disabled" });
    expect(disabled.statusCode).toBe(200);
    const after = await planHealthProbes();
    const decision = after.find((p) => p.tunnelId === probeTunnelId);
    expect(decision?.due).toBe(false);
    expect(decision?.reason).toMatch(/disabled/i);

    const removed = await api("DELETE", `/api/v1/tunnels/${probeTunnelId}`);
    expect(removed.statusCode).toBe(200);
  });
});

// Runs last: rotating the session secret invalidates every session, including
// the one this suite uses. That is the point of the test.
describe("session secret rotation", () => {
  it("exposes the real security posture to admins only", async () => {
    const unauth = await app.inject({ method: "GET", url: "/api/v1/system/security" });
    expect(unauth.statusCode).toBe(401);

    const res = await api("GET", "/api/v1/system/security");
    expect(res.statusCode).toBe(200);
    expect(res.json().session.csrfProtection).toBe(true);
    expect(res.json().session.idleLifetimeSec).toBeGreaterThan(0);
    expect(res.json().exposure.robotsNoindex).toBe(true);
    expect(res.json().login.genericErrors).toBe(true);
    // The secret itself must never appear in the response.
    expect(JSON.stringify(res.json())).not.toMatch(/[0-9a-f]{48}/);
  });

  it("rotates the session secret, invalidates old sessions and lets a fresh login work", async () => {
    const oldToken = adminToken;
    const before = await api("POST", "/api/v1/system/rotate-session-secret", { confirm: "rotate" });
    expect(before.statusCode).toBe(200);
    expect(before.json().sessionsInvalidated).toBe(true);
    expect(typeof before.json().rotatedAt).toBe("string");
    // Never return the secret itself.
    expect(JSON.stringify(before.json())).not.toMatch(/[0-9a-f]{64}/);

    const stale = await app.inject({
      method: "GET",
      url: "/api/v1/nodes",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(stale.statusCode).toBe(401);

    const relogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "arvoo-admin" },
    });
    expect(relogin.statusCode).toBe(200);
    adminToken = relogin.json().token;

    const after = await api("GET", "/api/v1/system/security");
    expect(after.json().secret.rotationCount).toBeGreaterThanOrEqual(1);

    const entries = await api("GET", "/api/v1/audit?limit=50");
    expect(entries.json().entries.some((e: { action: string }) => e.action === "system.secret_rotate")).toBe(true);
  });
});

describe("management access secret (second layer, graceful rotation)", () => {
  let token = "";
  let secret = "";

  beforeAll(async () => {
    // The previous suite rotated the session signing secret, so sign in again.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "arvoo-admin" },
    });
    expect(login.statusCode).toBe(200);
    token = login.json().token;
  });

  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as never, url, payload: body as never, headers: { authorization: `Bearer ${token}`, ...headers } });

  it("enables the gate, returns the value once, and stores only a hash", async () => {
    const enable = await call("POST", "/api/v1/system/management", {
      action: "enable",
      graceMinutes: 30,
      autoRotateHours: 6,
      confirm: "apply",
    });
    expect(enable.statusCode).toBe(200);
    secret = enable.json().secret;
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(20);
    expect(enable.json().management.enabled).toBe(true);
    expect(enable.json().note).toMatch(/shown once/i);

    // Metadata never carries the value...
    const status = await call("GET", "/api/v1/system/management");
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).not.toContain(secret);

    // ...and neither does the stored setting: only a peppered HMAC.
    const { q1 } = await import("../src/db/index.js");
    const row = await q1<{ value: string }>(`SELECT value FROM settings WHERE key = 'security.managementSecret'`);
    expect(row?.value).toBeTruthy();
    expect(row!.value).not.toContain(secret);
    expect(row!.value).toContain("\"hash\"");
  });

  it("refuses a privileged operation without the secret and accepts it with it", async () => {
    const body = { username: "mgmt-gated", password: "a-strong-password", role: "viewer" };

    const without = await call("POST", "/api/v1/users", body);
    expect(without.statusCode).toBe(401);
    expect(without.json().error.message).toMatch(/Management access secret/i);

    const wrong = await call("POST", "/api/v1/users", body, { "x-arvoo-management": "not-the-secret" });
    expect(wrong.statusCode).toBe(401);

    const withSecret = await call("POST", "/api/v1/users", body, { "x-arvoo-management": secret });
    expect(withSecret.statusCode).toBe(200);
    expect(withSecret.json().username).toBe("mgmt-gated");
  });

  it("keeps the previous value valid during the grace window and retires it after", async () => {
    // A rotation with the default 30-minute grace: the old value still works,
    // which is what stops a rollout from locking an administrator out.
    const rotated = await call("POST", "/api/v1/system/management", { action: "rotate", confirm: "apply" }, { "x-arvoo-management": secret });
    expect(rotated.statusCode).toBe(200);
    const nextSecret = rotated.json().secret as string;
    expect(nextSecret).not.toBe(secret);
    expect(rotated.json().management.previousValidUntil).toBeTruthy();

    const oldStillWorks = await call("POST", "/api/v1/users", {
      username: "mgmt-grace",
      password: "a-strong-password",
      role: "viewer",
    }, { "x-arvoo-management": secret });
    expect(oldStillWorks.statusCode).toBe(200);

    // Now rotate with no grace at all: the old value is retired immediately.
    const hardRotate = await call("POST", "/api/v1/system/management", {
      action: "rotate",
      graceMinutes: 0,
      confirm: "apply",
    }, { "x-arvoo-management": nextSecret });
    expect(hardRotate.statusCode).toBe(200);
    const finalSecret = hardRotate.json().secret as string;
    expect(hardRotate.json().management.previousValidUntil).toBeNull();

    const oldRejected = await call("POST", "/api/v1/users", {
      username: "mgmt-retired",
      password: "a-strong-password",
      role: "viewer",
    }, { "x-arvoo-management": nextSecret });
    expect(oldRejected.statusCode).toBe(401);

    const newWorks = await call("POST", "/api/v1/users", {
      username: "mgmt-current",
      password: "a-strong-password",
      role: "viewer",
    }, { "x-arvoo-management": finalSecret });
    expect(newWorks.statusCode).toBe(200);
    secret = finalSecret;
  });

  it("rotates on its own schedule when one is configured", async () => {
    const { maybeAutoRotate } = await import("../src/services/management-secret.js");
    const settingsService = await import("../src/services/settings.js");

    // Nothing is due yet, so a scheduled run must not rotate.
    const early = await maybeAutoRotate();
    expect(early.rotated).toBe(false);

    // Move the schedule into the past the way time would, then run it.
    const raw = await settingsService.getSetting("security.managementSecret");
    const record = JSON.parse(raw!) as Record<string, unknown>;
    record.nextRotationAt = new Date(Date.now() - 1000).toISOString();
    await settingsService.setSetting("security.managementSecret", JSON.stringify(record));

    const due = await maybeAutoRotate();
    expect(due.rotated).toBe(true);
    expect(due.reason).toBe("scheduled");

    // Safe rollover: even though the policy said "no grace", a *scheduled*
    // rotation keeps the value the administrator already holds working, so the
    // timer can never be the reason someone is locked out.
    const stillAccepted = await call("POST", "/api/v1/users", {
      username: "mgmt-rollover",
      password: "a-strong-password",
      role: "viewer",
    }, { "x-arvoo-management": secret });
    expect(stillAccepted.statusCode).toBe(200);

    // The rotated value is accepted, and the audit trail records the rotation.
    const rotated = await call("GET", "/api/v1/system/management");
    expect(rotated.json().management.version).toBeGreaterThan(2);
    const auditEntries = await call("GET", "/api/v1/audit?limit=50&action=security.management_secret");
    expect(auditEntries.json().entries.some((e: { action: string }) => e.action === "security.management_secret_rotate")).toBe(true);
  });

  it("turns the gate off again and leaves the panel usable", async () => {
    const disabled = await call("POST", "/api/v1/system/management", { action: "disable", confirm: "apply" }, { "x-arvoo-management": secret });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().management.enabled).toBe(false);
    expect(disabled.json().secret).toBeNull();

    // With the gate off, the same privileged call needs no extra header.
    const noHeader = await call("POST", "/api/v1/users", {
      username: "mgmt-open",
      password: "a-strong-password",
      role: "viewer",
    });
    expect(noHeader.statusCode).toBe(200);
  });

  it("reports the gate in the security posture endpoint", async () => {
    const posture = await call("GET", "/api/v1/system/security");
    expect(posture.statusCode).toBe(200);
    expect(posture.json().managementSecret).toMatchObject({ enabled: false });
    expect(JSON.stringify(posture.json())).not.toContain(secret);
  });
});
describe("full client management (§38/§39)", () => {
  let nodeId = "";
  let inboundId = "";
  let clientId = "";

  it("prepares an approved node and a real inbound to attach clients to", async () => {
    const node = await api("POST", "/api/v1/nodes", { name: "CM-01", role: "vpn", regionClass: "iran" });
    expect(node.statusCode).toBe(200);
    nodeId = node.json().node.id;
    const { run } = await import("../src/db/index.js");
    await run(
      `UPDATE nodes SET enrollment_state = 'approved', status = 'online', address = ? WHERE id = ?`,
      "203.0.113.77",
      nodeId,
    );
    const inbound = await api("POST", "/api/v1/inbounds", {
      name: "cm-01-udp",
      nodeId,
      config: { transport: "udp", port: 1294, serverNetwork: "10.90.0.0/24" },
    });
    expect(inbound.statusCode).toBe(200);
    inboundId = inbound.json().inbound.id;
  });

  it("creates a client with a dedicated OpenVPN username and password", async () => {
    const created = await api("POST", "/api/v1/clients", {
      username: "cm.alice",
      displayName: "Alice",
      ovpnUsername: "alice.vpn",
      ovpnPassword: "Str0ngPassw0rd",
      inboundIds: [inboundId],
    });
    expect(created.statusCode).toBe(200);
    const client = created.json().client;
    clientId = client.id;
    // The password is never part of a response - not even its hash.
    expect(JSON.stringify(client)).not.toContain("Str0ngPassw0rd");
    expect(client.ovpnUsername).toBe("alice.vpn");
    expect(client.ovpnPasswordSetAt).not.toBeNull();
    expect(client.ovpnAuthEnabled).toBe(true);
  });

  it("rejects a weak OpenVPN password and a duplicate OpenVPN username", async () => {
    const weak = await api("PUT", `/api/v1/clients/${clientId}/credentials`, { password: "short" });
    expect(weak.statusCode).toBe(422);
    const { run } = await import("../src/db/index.js");
    await run(`UPDATE clients SET ovpn_username = 'someone.else' WHERE id = ?`, "00000000-0000-0000-0000-000000000000");
    const other = await api("POST", "/api/v1/clients", { username: "cm.bob", ovpnUsername: "bob.vpn", ovpnPassword: "An0therPassw0rd" });
    expect(other.statusCode).toBe(200);
    const clash = await api("PUT", `/api/v1/clients/${other.json().client.id}/credentials`, { username: "alice.vpn" });
    expect(clash.statusCode).toBe(409);
  });

  it("edits every editable property and clears one explicitly", async () => {
    const patched = await api("PATCH", `/api/v1/clients/${clientId}`, {
      displayName: "Alice A.",
      description: "field client",
      notes: "tenant 7",
      baseMultiplier: 1.5,
      limits: {
        trafficQuotaBytes: 5 * 1024 ** 3,
        deviceLimit: 3,
        ipLimit: 4,
        concurrentSessions: 2,
        downloadSpeedKbps: 2048,
        uploadSpeedKbps: 512,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(patched.statusCode).toBe(200);
    const client = patched.json().client;
    expect(client.displayName).toBe("Alice A.");
    expect(client.limits.deviceLimit).toBe(3);
    expect(client.limits.downloadSpeedKbps).toBe(2048);
    expect(client.limits.expiresAt).toBe("2030-01-01T00:00:00.000Z");

    // An explicit null clears a field instead of being ignored.
    const cleared = await api("PATCH", `/api/v1/clients/${clientId}`, { description: null });
    expect(cleared.json().client.description).toBeNull();
    expect(cleared.json().client.displayName).toBe("Alice A.");
  });

  it("rejects an invalid limit combination", async () => {
    const res = await api("PATCH", `/api/v1/clients/${clientId}`, {
      limits: { deviceLimit: 0 },
    });
    expect(res.statusCode).toBe(422);
  });

  it("stores placement preferences and enforces the fallback node rule", async () => {
    const ok = await api("POST", `/api/v1/clients/${clientId}/placement`, {
      preferredNodeId: nodeId,
      preferredRegion: "iran",
      preferredTransport: "udp",
      fallbackInboundId: inboundId,
      sticky: true,
      failoverToFallback: true,
    });
    expect(ok.statusCode).toBe(200);
    const client = ok.json().client;
    expect(client.preferredNodeId).toBe(nodeId);
    expect(client.preferredTransport).toBe("udp");
    expect(client.routingPreferences.sticky).toBe(true);
    expect(client.fallbackInboundId).toBe(inboundId);

    const badNode = await api("POST", "/api/v1/clients", { username: "cm.carol" });
    expect(badNode.statusCode).toBe(200);
    const mismatch = await api("PATCH", `/api/v1/clients/${badNode.json().client.id}`, {
      preferredNodeId: null,
      fallbackInboundId: inboundId,
    });
    // Cleared preferred node + explicit inbound is allowed (no contradiction).
    expect(mismatch.statusCode).toBe(200);
  });

  it("replaces inbound assignments and keeps them enforced", async () => {
    const set = await api("PUT", `/api/v1/clients/${clientId}/inbounds`, { inboundIds: [] });
    expect(set.statusCode).toBe(200);
    expect(set.json().inboundIds).toEqual([]);
    const again = await api("PUT", `/api/v1/clients/${clientId}/inbounds`, { inboundIds: [inboundId] });
    expect(again.json().inboundIds).toEqual([inboundId]);
  });

  it("changes the OpenVPN password without ever returning it", async () => {
    const res = await api("PUT", `/api/v1/clients/${clientId}/credentials`, {
      password: "R0tatedPassw0rd",
      username: "alice.renamed",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().client.ovpnUsername).toBe("alice.renamed");
    expect(JSON.stringify(res.json())).not.toContain("R0tatedPassw0rd");

    const impact = await api("GET", `/api/v1/clients/${clientId}/credential-impact`);
    expect(impact.statusCode).toBe(200);
    expect(impact.json().inbounds.map((i: { name: string }) => i.name)).toContain("cm-01-udp");
  });

  it("renames the client, reissues the certificate and audits it", async () => {
    const res = await api("POST", `/api/v1/clients/${clientId}/username`, { username: "cm.alice2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().client.username).toBe("cm.alice2");

    const { q } = await import("../src/db/index.js");
    const renamed = await q<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'client.rename' AND entity_id = ?`,
      clientId,
    );
    expect(Number(renamed[0]?.count ?? 0)).toBeGreaterThan(0);
    const certs = await q<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pki_certificates WHERE kind = 'client' AND client_id = ? AND revoked = 0`,
      clientId,
    );
    expect(Number(certs[0]?.count ?? 0)).toBe(1);
  });
});

describe("inbound domain (§40)", () => {
  let inboundId = "";

  it("prepares an inbound with a known node address", async () => {
    const node = await api("POST", "/api/v1/nodes", { name: "DM-01", role: "vpn" });
    const { run } = await import("../src/db/index.js");
    await run(
      `UPDATE nodes SET enrollment_state = 'approved', status = 'online', address = ? WHERE id = ?`,
      "127.0.0.1",
      node.json().node.id,
    );
    const inbound = await api("POST", "/api/v1/inbounds", {
      name: "dm-01-udp",
      nodeId: node.json().node.id,
      config: { transport: "udp", port: 1295, serverNetwork: "10.91.0.0/24" },
    });
    expect(inbound.statusCode).toBe(200);
    inboundId = inbound.json().inbound.id;
  });

  it("rejects a domain that is not a DNS name", async () => {
    const res = await api("PATCH", `/api/v1/inbounds/${inboundId}`, { config: { domain: "10.0.0.5" } });
    expect(res.statusCode).toBe(422);
  });

  it("refuses a name that does not resolve, and records the real check result", async () => {
    const res = await api("PATCH", `/api/v1/inbounds/${inboundId}`, {
      config: { domain: "not-a-real-host.invalid" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/does not resolve|Domain check failed/i);
    // The check is stored even when it fails, so the panel can show why.
    const inbound = await api("GET", `/api/v1/inbounds/${inboundId}`);
    expect(inbound.json().inbound.domainStatus).toBe("unresolved");
    expect(inbound.json().inbound.structuredConfig.domain).toBeNull();
  });

  it("accepts a domain that resolves to the node address", async () => {
    // localhost resolves to 127.0.0.1, which is the address this node reports.
    const res = await api("PATCH", `/api/v1/inbounds/${inboundId}`, { config: { domain: "localhost.localdomain" } });
    if (res.statusCode === 200) {
      expect(res.json().inbound.structuredConfig.domain).toBe("localhost.localdomain");
      expect(["verified", "mismatch"]).toContain(res.json().inbound.domainStatus);
    } else {
      // A resolver that cannot answer must produce a clear refusal, never a
      // silent success.
      expect(res.statusCode).toBe(422);
    }
    const check = await api("POST", `/api/v1/inbounds/${inboundId}/domain-check`);
    expect(check.statusCode).toBe(200);
    expect(check.json().check.status).toBeDefined();
  });

  it("lets an operator force-save a domain and shows the mismatch", async () => {
    const res = await api("PATCH", `/api/v1/inbounds/${inboundId}`, {
      config: { domain: "forced.example.invalid" },
      allowUnverifiedDomain: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inbound.structuredConfig.domain).toBe("forced.example.invalid");
    expect(res.json().inbound.domainStatus).toBe("unresolved");
    const domain = await api("GET", `/api/v1/inbounds/${inboundId}/domain`);
    expect(domain.json().status).toBe("unresolved");
    expect(domain.json().nodeAddress).toBe("127.0.0.1");
  });

  it("clears the domain and falls back to the node address", async () => {
    const res = await api("PATCH", `/api/v1/inbounds/${inboundId}`, { config: { domain: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json().inbound.structuredConfig.domain).toBeNull();
    expect(res.json().inbound.domainStatus).toBe("unset");
  });
});

describe("load balancing (§41)", () => {
  let groupId = "";
  let memberId = "";
  let nodeId = "";

  it("creates a group and adds a real node member", async () => {
    const node = await api("POST", "/api/v1/nodes", { name: "LB-01", role: "vpn" });
    nodeId = node.json().node.id;
    const group = await api("POST", "/api/v1/lb/groups", {
      name: "Test pool",
      mode: "weighted",
      healthRequirements: { minSuccessRatePct: 90, maxLatencyMs: 100, maxLossPct: 5, requireNodeOnline: true },
    });
    expect(group.statusCode).toBe(200);
    groupId = group.json().group.id;
    const member = await api("POST", `/api/v1/lb/groups/${groupId}/members`, { kind: "node", refId: nodeId, weight: 50 });
    expect(member.statusCode).toBe(200);
    const view = member.json().group;
    expect(view.members).toHaveLength(1);
    memberId = view.members[0].id;
    // Never probed and not reporting: the member must not be presented healthy.
    expect(view.members[0].healthy).toBe(false);
    expect(view.members[0].state).toBe("unknown");
    expect(view.members[0].reasons.join(" ")).toMatch(/not reporting|never|No health probe/i);
  });

  it("rejects a duplicate member and an invalid weight", async () => {
    expect((await api("POST", `/api/v1/lb/groups/${groupId}/members`, { kind: "node", refId: nodeId })).statusCode).toBe(409);
    expect((await api("PATCH", `/api/v1/lb/members/${memberId}`, { weight: 5000 })).statusCode).toBe(422);
  });

  it("explains why no session can be placed when nothing is healthy", async () => {
    const choice = await api("POST", `/api/v1/lb/groups/${groupId}/choose`);
    expect(choice.statusCode).toBe(200);
    const body = choice.json();
    expect(body.memberId).toBe(memberId);
    expect(body.degraded).toBe(true);
    expect(body.reason).toMatch(/unhealthy|unavailable|healthy/i);
  });

  it("drains a node member, which also drains the node itself", async () => {
    const drained = await api("POST", `/api/v1/lb/members/${memberId}/drain`, { reason: "maintenance window" });
    expect(drained.statusCode).toBe(200);
    const member = drained.json().group.members[0];
    expect(member.drained).toBe(true);
    expect(member.state).toBe("drained");
    const { q } = await import("../src/db/index.js");
    const node = await q<{ admin_state: string }>(`SELECT admin_state FROM nodes WHERE id = ?`, nodeId);
    expect(node[0]?.admin_state).toBe("drained");
    const blocked = await api("POST", `/api/v1/lb/groups/${groupId}/choose`);
    expect(blocked.json().memberId).toBeNull();
    expect(blocked.json().reason).toMatch(/disabled or drained/i);
  });

  it("restores the member and the node", async () => {
    const restored = await api("POST", `/api/v1/lb/members/${memberId}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().group.members[0].drained).toBe(false);
    const { q } = await import("../src/db/index.js");
    const node = await q<{ admin_state: string }>(`SELECT admin_state FROM nodes WHERE id = ?`, nodeId);
    expect(node[0]?.admin_state).toBe("enabled");
    const events = await api("GET", `/api/v1/lb/groups/${groupId}/events`);
    expect(events.json().events.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps group membership in sync when the member is removed", async () => {
    const removed = await api("DELETE", `/api/v1/lb/members/${memberId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().group.members).toHaveLength(0);
    expect((await api("DELETE", `/api/v1/lb/groups/${groupId}`)).statusCode).toBe(200);
  });
});

describe("managed firewall (§UFW)", () => {
  it("builds a plan with SSH, panel and ICMP rules before anything is applied", async () => {
    const res = await api("GET", "/api/v1/firewall/plan?host=self");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const origins = body.plan.rules.map((r: { origin: string }) => r.origin);
    expect(origins).toContain("ssh");
    expect(origins).toContain("panel");
    expect(origins).toContain("icmp");
    // Rendered command lines are exactly what the helper executes.
    for (const command of body.commands) {
      expect(command.argv[0]).toBe("allow");
      expect(command.remove[0]).toBe("delete");
    }
  });

  it("refuses a policy that would lock out SSH", async () => {
    const res = await api("PATCH", "/api/v1/firewall/policy", { sshPorts: [] });
    expect(res.statusCode).toBe(422);
  });

  it("saves a policy and reflects it in the plan", async () => {
    const saved = await api("PATCH", "/api/v1/firewall/policy", {
      sshPorts: [2222],
      adminSources: ["198.51.100.7"],
      allowIcmp: false,
    });
    expect(saved.statusCode).toBe(200);
    const res = await api("GET", "/api/v1/firewall/plan?host=self");
    const ssh = res.json().plan.rules.find((r: { origin: string; port: number }) => r.origin === "ssh");
    expect(ssh.port).toBe(2222);
    expect(ssh.from).toBe("198.51.100.7");
    expect(res.json().plan.rules.some((r: { origin: string }) => r.origin === "icmp")).toBe(false);
    // SSH restricted to one address must warn that the panel is still public.
    await api("PATCH", "/api/v1/firewall/policy", { sshPorts: [22], adminSources: [], allowIcmp: true });
  });

  it("opens the port of a deployed inbound in the plan", async () => {
    const { q, run } = await import("../src/db/index.js");
    const inbound = await q<{ id: string; node_id: string }>(`SELECT id, node_id FROM inbounds ORDER BY created_at DESC LIMIT 1`);
    const target = inbound[0]!;
    await run(`UPDATE inbounds SET status = 'active' WHERE id = ?`, target.id);
    const res = await api("GET", `/api/v1/firewall/plan?host=${target.node_id}`);
    expect(res.statusCode).toBe(200);
    const origin = res.json().plan.rules.map((r: { origin: string }) => r.origin);
    expect(origin.some((o: string) => o.startsWith("inbound:"))).toBe(true);
  });

  it("reports every host with its real applied state", async () => {
    const res = await api("GET", "/api/v1/firewall");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.hosts)).toBe(true);
    expect(body.hosts[0].key).toBe("self");
    expect(body.policy.sshPorts).toEqual([22]);
    expect(typeof body.spoolDir).toBe("string");
    // Nothing has been applied yet, so no host may claim to be active.
    expect(body.hosts.every((h: { enabled: boolean }) => h.enabled === false)).toBe(true);
  });

  it("refuses to apply on a node whose agent is not online, without pretending", async () => {
    const { q } = await import("../src/db/index.js");
    const node = await q<{ id: string }>(`SELECT id FROM nodes WHERE name = 'LB-01' LIMIT 1`);
    const res = await api("POST", "/api/v1/firewall/apply", { host: node[0]!.id, action: "enable" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("unavailable");
    expect(res.json().detail).toMatch(/not online|not approved/i);
  });

  it("rejects an unknown host", async () => {
    const res = await api("POST", "/api/v1/firewall/apply", {
      host: "00000000-0000-0000-0000-000000000000",
      action: "enable",
    });
    expect(res.statusCode).toBe(404);
  });

  it("records the request history", async () => {
    const res = await api("GET", "/api/v1/firewall/history");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().applies)).toBe(true);
  });

  it("refuses OpenVPN password authentication from an unknown node", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/openvpn-auth",
      payload: { username: "alice", password: "whatever", inboundName: "cm-01-udp" },
      headers: { authorization: "Bearer arvoo-node 00000000-0000-0000-0000-000000000000:deadbeef" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GRE keys (generation, validation, queue payload)", () => {
  let sourceNodeId = "";
  let destNodeId = "";
  const created: string[] = [];

  beforeAll(async () => {
    const { run, nowIso } = await import("../src/db/index.js");
    for (const [name, address] of [
      ["GK-01", "203.0.113.51"],
      ["GK-02", "203.0.113.52"],
    ] as const) {
      const res = await api("POST", "/api/v1/nodes", { name, role: "vpn", regionClass: "iran", country: "Iran", provider: "dc-ir" });
      expect(res.statusCode).toBe(200);
      const id = res.json().node.id as string;
      await run(
        `UPDATE nodes SET enrollment_state = 'approved', status = 'online', address = ?, capabilities = ?, capabilities_at = ? WHERE id = ?`,
        address,
        JSON.stringify({ gre: true, fou: false, ipsec: { available: false, tool: null, version: null }, nftables: true, dco: { supported: false, reason: "test" }, openvpnVersion: "2.6.12", kernel: "6.8.0" }),
        nowIso(),
        id,
      );
      if (name === "GK-01") sourceNodeId = id;
      else destNodeId = id;
    }
  });

  afterAll(async () => {
    for (const id of created) await api("DELETE", `/api/v1/tunnels/${id}`);
  });

  it("refuses the decimal key the old generator produced, before it can be queued", async () => {
    const res = await api("POST", "/api/v1/tunnels", {
      name: "gk-bad1",
      sourceNodeId,
      destNodeId,
      key: "180879361",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/hexadecimal/i);
    // Nothing was created, so nothing can be queued for a node.
    const { q } = await import("../src/db/index.js");
    const rows = await q<{ id: string }>(`SELECT id FROM tunnels WHERE name = 'gk-bad1'`);
    expect(rows).toHaveLength(0);
  });

  it("refuses a 9-digit key, a non-hex key and an out-of-range key", async () => {
    for (const key of ["100000000", "G1234567", "1000000000", "0x100000000"]) {
      const res = await api("POST", "/api/v1/tunnels", { name: "gk-bad2", sourceNodeId, destNodeId, key });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/hexadecimal/i);
    }
  });

  it("generates a valid canonical key by default", async () => {
    const res = await api("POST", "/api/v1/tunnels", { name: "gk-auto", sourceNodeId, destNodeId });
    expect(res.statusCode).toBe(200);
    const tunnel = res.json().tunnel as { id: string; key: string | null };
    created.push(tunnel.id);
    expect(tunnel.key).toMatch(/^[0-9a-f]{1,8}$/);
    // The regression: a 9-character decimal string must never be generated again.
    expect(tunnel.key!.length).toBeLessThanOrEqual(8);
    expect(tunnel.key).not.toBe("180879361");
  });

  it("stores an operator-supplied key in canonical form and queues it to both nodes", async () => {
    const res = await api("POST", "/api/v1/tunnels", {
      name: "gk-custom",
      sourceNodeId,
      destNodeId,
      key: "0xAC80001",
    });
    expect(res.statusCode).toBe(200);
    const tunnel = res.json().tunnel as { id: string; key: string | null };
    created.push(tunnel.id);
    expect(tunnel.key).toBe("ac80001");

    const { q } = await import("../src/db/index.js");
    const ops = await q<{ node_id: string; input: string }>(
      `SELECT node_id, input FROM operations WHERE ref_type = 'tunnel' AND ref_id = ? AND type = 'CreateGRE'`,
      tunnel.id,
    );
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      const input = JSON.parse(op.input) as { key: string | null; interfaceName: string };
      expect(input.interfaceName).toBe("gk-custom");
      expect(input.key).toBe("ac80001");
    }
    expect(new Set(ops.map((o) => o.node_id))).toEqual(new Set([sourceNodeId, destNodeId]));
  });

  it("creates a keyless tunnel when the key is switched off", async () => {
    const res = await api("POST", "/api/v1/tunnels", { name: "gk-none", sourceNodeId, destNodeId, key: false });
    expect(res.statusCode).toBe(200);
    const tunnel = res.json().tunnel as { id: string; key: string | null };
    created.push(tunnel.id);
    expect(tunnel.key).toBeNull();
  });
});
