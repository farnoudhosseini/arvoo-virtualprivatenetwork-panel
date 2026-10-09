import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { q, q1, run, uuid, nowIso, pingDatabase } from "../db/index.js";
import bcrypt from "bcryptjs";
import {
  requireAuth,
  requireRole,
  signSession,
  setSessionCookie,
  setCsrfCookie,
  clearSessionCookie,
  refreshSession,
  sessionRemainingSec,
  verifySessionToken,
  type AuthUser,
} from "../lib/auth.js";
import { LOGIN_TIMING_DUMMY_HASH, burnPasswordComparison } from "../lib/security.js";
import { badRequest, conflict, notFound, unauthorized, unprocessable } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import * as nodesService from "../services/nodes.js";
import * as inboundsService from "../services/inbounds.js";
import * as clientsService from "../services/clients.js";
import * as tunnelsService from "../services/tunnels.js";
import * as routingService from "../services/routing.js";
import * as healthEngine from "../services/health-engine.js";
import * as operationsService from "../services/operations.js";
import * as dashboardService from "../services/dashboard.js";
import * as settingsService from "../services/settings.js";
import { settleOperation } from "../services/settle.js";
import { raiseAlert } from "../services/alerts.js";
import { sha256 } from "../lib/crypto.js";
import { randomBytes } from "node:crypto";
import { SECURITY_HEADERS } from "../lib/security.js";
import * as managementSecret from "../services/management-secret.js";
import * as loadBalancer from "../services/loadbalancer.js";
import * as firewallService from "../services/firewall.js";
import { diffFirewallPlans, isValidDomain, normalizeAuthMode, ruleToUfwArgs, ufwDeleteArgs } from "@arvoo/shared";
import { MANAGEMENT_SECRET_FILE } from "../services/management-secret.js";
import { validateOpenVPNConfig } from "@arvoo/shared";
import { config } from "../config.js";

function actor(request: FastifyRequest, minRole: "operator" | "admin" | "viewer" = "viewer"): { id: string; name: string; role: string } {
  const user = minRole === "viewer" ? requireAuth(request) : requireRole(minRole)(request);
  return { id: user.id, name: user.username, role: user.role };
}

/**
 * Management access gate (spec §14).
 *
 * When the management secret is enabled it is required, in addition to a valid
 * admin session, for the most privileged operations. It is a second layer, not
 * a replacement: the session check always runs first, and a rejected secret
 * never widens access.
 */
function managementHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["x-arvoo-management"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function requireManagement(request: FastifyRequest, what: string): Promise<void> {
  const result = await managementSecret.verify(managementHeader(request));
  if (result === "disabled") {
    // Enabling is optional; a disabled gate changes nothing about the session
    // and RBAC checks that already passed.
    return;
  }
  if (result === "current") return;
  if (result === "previous") {
    audit({
      actorId: "system",
      actorName: "management-secret",
      action: "security.management_secret_previous_used",
      summary: `The previous management secret was accepted for: ${what}`,
      ip: request.ip,
    });
    return;
  }
  throw unauthorized(
    `Management access secret required for: ${what}. Provide it in the x-arvoo-management header. ` +
      "On the server it is readable at " + MANAGEMENT_SECRET_FILE + " (root only).",
  );
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw unprocessable(
      "Validation failed: " + result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      result.error.flatten(),
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Agent authentication (node secret, not user JWT)
// ---------------------------------------------------------------------------

async function agentNode(request: FastifyRequest): Promise<{ nodeId: string }> {
  const header = request.headers.authorization ?? "";
  const match = header.match(/^Bearer arvoo-node (\S+):(\S+)$/);
  if (!match) throw unauthorized("Node authentication required");
  const [, nodeId, secret] = match;
  const node = await q1<{ id: string; node_secret_hash: string; enrollment_state: string }>(
    `SELECT id, node_secret_hash, enrollment_state FROM nodes WHERE id = ?`,
    nodeId,
  );
  if (!node || !node.node_secret_hash) throw unauthorized("Unknown node identity");
  if (node.enrollment_state !== "approved") throw unauthorized("Node enrollment is not approved yet");
  if (sha256(secret!) !== node.node_secret_hash) throw unauthorized("Invalid node secret");
  return { nodeId: node.id };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRoutes(app: FastifyInstance): void {
  // ---- Health -------------------------------------------------------------
  // Public (no auth). Reports application + PostgreSQL state; 503 when the
  // database is unreachable so orchestrators and install.sh detect a
  // degraded backend instead of a false-positive 200.
  const healthPayload = async (reply: FastifyReply) => {
    const dbOk = await pingDatabase();
    const body = {
      status: dbOk ? "ok" : "error",
      service: "arvoo-control-plane",
      database: dbOk ? "ok" : "error",
      at: nowIso(),
    };
    return dbOk ? body : reply.code(503).send(body);
  };
  app.get("/health", async (_request, reply) => healthPayload(reply));
  app.get("/api/v1/health", async (_request, reply) => healthPayload(reply));

  // ---- Auth ---------------------------------------------------------------
  const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { username, password } = parse(loginSchema, request.body);
    const user = await q1<{ id: string; username: string; password_hash: string; role: string; active: number }>(
      `SELECT * FROM users WHERE username = ?`,
      username,
    );
    // When the account does not exist, spend the same bcrypt work anyway: a
    // fast rejection would tell an attacker which usernames are real.
    if (!user) {
      burnPasswordComparison((candidate) => bcrypt.compareSync(candidate, LOGIN_TIMING_DUMMY_HASH), password);
    }
    if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
      audit({ action: "auth.failed", actorName: username, summary: `Failed login attempt for "${username}"`, ip: request.ip });
      throw unauthorized("Invalid username or password");
    }
    const authUser: AuthUser = { id: user.id, username: user.username, role: user.role as AuthUser["role"] };
    // A fresh session per login (no fixation) plus the CSRF token the panel
    // echoes back on state changes.
    const token = signSession(authUser);
    setSessionCookie(request, reply, token);
    const csrfToken = setCsrfCookie(request, reply);
    await run(`UPDATE users SET last_login_at = ? WHERE id = ?`, nowIso(), user.id);
    audit({ action: "auth.login", actorId: user.id, actorName: user.username, summary: "Signed in", ip: request.ip });
    return { token, csrfToken, sessionIdleSec: config.sessionIdleSec, user: authUser };
  });

  /**
   * Sliding idle window. The panel calls this before the window closes, so an
   * operator who is working is never logged out mid-task, while an abandoned
   * session still dies on schedule. The absolute lifetime cannot be extended.
   */
  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : request.cookies?.arvoo_session;
    if (!token) throw unauthorized();
    const refreshed = refreshSession(token);
    if (!refreshed) throw unauthorized("Session cannot be refreshed: sign in again");
    const user = verifySessionToken(refreshed)!;
    setSessionCookie(request, reply, refreshed);
    const csrfToken = setCsrfCookie(request, reply);
    return { token: refreshed, csrfToken, sessionIdleSec: config.sessionIdleSec, user };
  });

  app.get("/api/v1/auth/session", async (request) => {
    const user = requireAuth(request);
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : request.cookies?.arvoo_session ?? "";
    return { user, sessionIdleSec: config.sessionIdleSec, remainingSec: sessionRemainingSec(token) };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (request) => {
    return { user: requireAuth(request) };
  });

  // ---- Users --------------------------------------------------------------
  const userSchema = z.object({
    username: z.string().min(3).max(63),
    password: z.string().min(8).max(128),
    displayName: z.string().max(120).optional().nullable(),
    role: z.enum(["admin", "operator", "viewer"]),
  });

  app.get("/api/v1/users", async (request) => {
    actor(request, "operator");
    return q(`SELECT id, username, display_name, role, active, last_login_at, created_at FROM users ORDER BY username`);
  });

  app.post("/api/v1/users", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "creating a user");
    const input = parse(userSchema, request.body);
    if (await q1(`SELECT id FROM users WHERE username = ?`, input.username)) {
      throw conflict(`User "${input.username}" already exists`);
    }
    const id = uuid();
    const now = nowIso();
    await run(
      `INSERT INTO users (id, username, password_hash, display_name, role, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)`,
      id,
      input.username,
      bcrypt.hashSync(input.password, 10),
      input.displayName ?? null,
      input.role,
      now,
      now,
    );
    audit({ actorId: a.id, actorName: a.name, action: "user.create", entityType: "user", entityId: id, entityName: input.username, summary: `Created user ${input.username} (${input.role})` });
    return q1(`SELECT id, username, display_name, role, active, created_at FROM users WHERE id = ?`, id);
  });

  app.patch("/api/v1/users/:id", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "changing a user account");
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      password: z.string().min(8).max(128).optional(),
      role: z.enum(["admin", "operator", "viewer"]).optional(),
      active: z.boolean().optional(),
      displayName: z.string().max(120).optional().nullable(),
    }), request.body);
    const target = await q1<{ id: string; username: string }>(`SELECT id, username FROM users WHERE id = ?`, id);
    if (!target) throw notFound("User not found");
    if (body.password) await run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, bcrypt.hashSync(body.password, 10), nowIso(), id);
    if (body.role) await run(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, body.role, nowIso(), id);
    if (body.active !== undefined) {
      if (id === a.id && !body.active) throw badRequest("You cannot disable your own account.");
      await run(`UPDATE users SET active = ?, updated_at = ? WHERE id = ?`, body.active ? 1 : 0, nowIso(), id);
    }
    if (body.displayName !== undefined) await run(`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`, body.displayName, nowIso(), id);
    audit({ actorId: a.id, actorName: a.name, action: body.active === false ? "user.disable" : "user.update", entityType: "user", entityId: id, entityName: target.username, summary: `Updated user ${target.username}` });
    return { ok: true };
  });

  // ---- Dashboard / topology / metrics -------------------------------------
  app.get("/api/v1/dashboard", async (request) => {
    requireAuth(request);
    return {
      stats: await dashboardService.dashboardStats(),
      trafficSeries: await dashboardService.trafficSeriesLast24h(),
      recentActivity: await q(`SELECT * FROM audit_logs ORDER BY at DESC LIMIT 12`),
      alerts: await q(`SELECT * FROM alerts WHERE status != 'resolved' ORDER BY created_at DESC LIMIT 8`),
    };
  });

  app.get("/api/v1/topology", async (request) => {
    requireAuth(request);
    return dashboardService.topology();
  });

  app.get("/api/v1/metrics/nodes/:id/health", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return { samples: await nodesService.healthSamples(id, since) };
  });

  // ---- Nodes --------------------------------------------------------------
  const nodeSchema = z.object({
    name: z.string().min(2).max(63),
    hostname: z.string().max(255).optional().nullable(),
    address: z.string().max(255).optional().nullable(),
    region: z.string().max(120).optional().nullable(),
    country: z.string().max(120).optional().nullable(),
    provider: z.string().max(120).optional().nullable(),
    role: z.enum(["master", "vpn", "edge", "gateway", "transit", "custom"]).optional(),
    regionClass: z.enum(["iran", "international"]).optional(),
    tags: z.array(z.string().max(40)).max(16).optional(),
    description: z.string().max(2000).optional().nullable(),
  });

  app.get("/api/v1/nodes", async (request) => {
    requireAuth(request);
    return { nodes: await nodesService.listNodes() };
  });

  app.post("/api/v1/nodes", async (request) => {
    const a = actor(request, "operator");
    const input = parse(nodeSchema, request.body);
    const { node, enrollmentToken, expiresAt } = await nodesService.createNode(input, a);
    audit({ actorId: a.id, actorName: a.name, action: "node.create", entityType: "node", entityId: node.id, entityName: node.name, summary: `Created node ${node.name}` });
    return { node, enrollment: { token: enrollmentToken, expiresAt, ttlMinutes: config.agent.enrollmentTokenTtlMin } };
  });

  app.get("/api/v1/nodes/:id", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const node = await nodesService.getNode(id);
    const telemetry = await nodesService.latestTelemetry(id);
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return {
      node,
      telemetry: telemetry?.telemetry ?? null,
      telemetryAt: telemetry?.at ?? null,
      healthSamples: await nodesService.healthSamples(id, since),
      tunnels: await q(
        `SELECT t.*, n1.name AS source_name, n2.name AS dest_name FROM tunnels t
         JOIN nodes n1 ON n1.id = t.source_node_id JOIN nodes n2 ON n2.id = t.dest_node_id
         WHERE t.source_node_id = ? OR t.dest_node_id = ?`,
        id, id,
      ),
      inbounds: await q(`SELECT id, name, status, current_version, protocol FROM inbounds WHERE node_id = ?`, id),
      operations: await q(`SELECT * FROM operations WHERE node_id = ? ORDER BY created_at DESC LIMIT 20`, id),
    };
  });

  app.patch("/api/v1/nodes/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(nodeSchema.partial(), request.body);
    const node = await nodesService.getNode(id);
    await run(
      `UPDATE nodes SET name = ?, hostname = ?, address = COALESCE(?, address), region = ?, country = ?, provider = ?, role = ?, region_class = ?, tags = ?, description = ?, updated_at = ? WHERE id = ?`,
      body.name ?? node.name,
      body.hostname ?? node.hostname,
      body.address ?? null,
      body.region ?? node.region,
      body.country ?? node.country,
      body.provider ?? node.provider,
      body.role ?? node.role,
      body.regionClass ?? node.regionClass,
      JSON.stringify(body.tags ?? node.tags),
      body.description ?? node.description,
      nowIso(),
      id,
    );
    audit({ actorId: a.id, actorName: a.name, action: "node.update", entityType: "node", entityId: id, entityName: node.name, summary: `Updated node ${node.name}` });
    return { node: await nodesService.getNode(id) };
  });

  app.get("/api/v1/nodes/:id/dependencies", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    return { dependencies: await nodesService.nodeDependencies(id) };
  });

  app.delete("/api/v1/nodes/:id", async (request) => {
    const a = actor(request, "operator");
    await requireManagement(request, "deleting a node");
    const { id } = request.params as { id: string };
    const { force } = parse(z.object({ force: z.coerce.boolean().optional() }), request.query ?? {});
    const node = await nodesService.getNode(id);
    const result = await nodesService.deleteNode(id, a, { force: force === true });
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "node.delete",
      entityType: "node",
      entityId: id,
      entityName: node.name,
      summary:
        `Deleted node ${node.name}` +
        (result.forced ? " (forced)" : "") +
        (result.cancelledOperations > 0 ? `; cancelled ${result.cancelledOperations} in-flight operation(s)` : "") +
        (result.pendingCleanup ? `; PENDING HOST CLEANUP: ${result.pendingCleanup}` : "; host cleanup complete"),
    });
    return { ok: true, deleted: result };
  });

  // ---- Node credential lifecycle ------------------------------------------
  app.get("/api/v1/nodes/:id/token", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    return { token: await nodesService.nodeTokenStatus(id) };
  });

  // Revealing a credential is a privileged, audited action: the management gate
  // applies when it is enabled, and the audit entry never contains the value.
  app.post("/api/v1/nodes/:id/token/reveal", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "revealing a node credential");
    const { id } = request.params as { id: string };
    const token = await nodesService.revealNodeToken(id);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "node.token.reveal",
      entityType: "node",
      entityId: id,
      entityName: token.nodeName,
      summary: `Revealed the active agent credential for node ${token.nodeName}`,
      ip: request.ip,
    });
    return { token };
  });

  app.post("/api/v1/nodes/:id/token/rotate", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "rotating a node credential");
    const { id } = request.params as { id: string };
    // The new credential is returned in the same response, so the operator can
    // install it on the node immediately; the previous one is already invalid.
    return { token: await nodesService.rotateNodeToken(id, a) };
  });

  app.post("/api/v1/nodes/:id/token/revoke", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "revoking a node credential");
    const { id } = request.params as { id: string };
    return { token: await nodesService.revokeNodeToken(id, a) };
  });

  app.post("/api/v1/nodes/:id/decommission", async (request) => {
    const a = actor(request, "operator");
    await requireManagement(request, "decommissioning a node");
    const { id } = request.params as { id: string };
    return { decommission: await nodesService.decommissionNode(id, a) };
  });

  app.post("/api/v1/nodes/:id/enrollment-token", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const { token, expiresAt } = await nodesService.issueEnrollmentToken(id, a.id);
    return { token, expiresAt };
  });

  app.post("/api/v1/nodes/:id/approve", async (request) => {
    const a = actor(request, "operator");
    await requireManagement(request, "approving a node");
    const { id } = request.params as { id: string };
    const node = await nodesService.approveNode(id);
    audit({ actorId: a.id, actorName: a.name, action: "node.approve", entityType: "node", entityId: id, entityName: node.name, summary: `Approved node ${node.name}` });
    return { node };
  });

  app.post("/api/v1/nodes/:id/revoke", async (request) => {
    const a = actor(request, "operator");
    await requireManagement(request, "revoking a node");
    const { id } = request.params as { id: string };
    const node = await nodesService.revokeNodeEnrollment(id);
    audit({ actorId: a.id, actorName: a.name, action: "node.revoke", entityType: "node", entityId: id, entityName: node.name, summary: `Revoked enrollment for node ${node.name}` });
    return { node };
  });

  // ---- Agent API ----------------------------------------------------------
  const helloSchema = z.object({
    enrollmentToken: z.string().min(10),
    hostname: z.string().min(1).max(255),
    platform: z.string().max(255),
    agentVersion: z.string().max(63),
  });

  // Agent endpoints are token-authenticated, not session-authenticated, so they
  // carry their own rate limits: enrollment attempts are the most sensitive.
  app.post("/api/v1/agent/hello", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = parse(helloSchema, request.body);
    const tokenHash = sha256(input.enrollmentToken);
    const tokenRow = await q1<{ id: string; node_id: string; expires_at: string; used_at: string | null }>(
      `SELECT * FROM enrollment_tokens WHERE token_hash = ?`,
      tokenHash,
    );
    if (!tokenRow) throw unauthorized("Invalid enrollment token");
    if (tokenRow.used_at) throw unauthorized("Enrollment token already used");
    if (new Date(tokenRow.expires_at).getTime() < Date.now()) throw unauthorized("Enrollment token expired");

    // One minting path for enrollment and rotation: cryptographically random
    // secret, hash for authentication, encrypted copy so the active credential
    // can be revealed later by an authorized administrator.
    const secret = await nodesService.issueNodeCredential(tokenRow.node_id);
    await run(
      `UPDATE nodes SET enrollment_state = 'enrolled', status = 'pending', hostname = ?, agent_version = ?, agent_platform = ?, updated_at = ? WHERE id = ?`,
      input.hostname,
      input.agentVersion,
      input.platform,
      nowIso(),
      tokenRow.node_id,
    );
    await run(`UPDATE enrollment_tokens SET used_at = ? WHERE id = ?`, nowIso(), tokenRow.id);
    reply.code(200);
    return { nodeId: tokenRow.node_id, nodeSecret: secret, heartbeatIntervalSec: config.agent.heartbeatIntervalSec };
  });

  const telemetrySchema = z.object({
    cpuModel: z.string().max(255).nullable().optional(),
    cpuCores: z.number().int().min(0).max(4096),
    cpuUsagePct: z.number().min(0).max(100).nullable(),
    memoryTotalBytes: z.number().min(0),
    memoryUsedBytes: z.number().min(0),
    memoryUsagePct: z.number().min(0).max(100).nullable(),
    diskTotalBytes: z.number().min(0).nullable(),
    diskUsedBytes: z.number().min(0).nullable(),
    diskUsagePct: z.number().min(0).max(100).nullable(),
    loadAvg: z.tuple([z.number(), z.number(), z.number()]),
    uptimeSec: z.number().min(0),
    os: z.string().max(255),
    kernel: z.string().max(255).nullable(),
    openvpnVersion: z.string().max(63).nullable(),
    interfaces: z.array(z.object({ name: z.string().max(63), addresses: z.array(z.string().max(63)) })),
    trafficCounters: z.record(z.string(), z.object({ rx: z.number(), tx: z.number() })),
    services: z.array(z.object({ name: z.string().max(63), status: z.enum(["running", "stopped", "unknown"]) })),
    greInterfaces: z.array(z.object({ name: z.string().max(63), local: z.string().max(63).nullable(), remote: z.string().max(63).nullable() })),
    openvpnProcesses: z.array(z.object({ name: z.string().max(63), status: z.enum(["running", "stopped"]) })),
    capabilities: z
      .object({
        gre: z.boolean().nullable(),
        fou: z.boolean().nullable(),
        nftables: z.boolean().nullable(),
        ipsec: z.object({ available: z.boolean(), tool: z.string().max(31).nullable(), version: z.string().max(63).nullable() }),
        dco: z.object({ supported: z.boolean(), reason: z.string().max(255) }),
        openvpnVersion: z.string().max(63).nullable(),
        kernel: z.string().max(255).nullable(),
      })
      .nullable()
      .optional(),
  });

  app.post("/api/v1/agent/heartbeat", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request) => {
    const { nodeId } = await agentNode(request);
    const body = request.body as { telemetry: unknown; openvpnStatus?: unknown };
    const telemetry = parse(telemetrySchema, body.telemetry);
    const statusSchema = z.array(z.object({
      inboundName: z.string().max(63),
      connected: z.array(z.object({
        commonName: z.string().max(255),
        realIp: z.string().max(63),
        vpnIp: z.string().max(63).nullable(),
        rxBytes: z.number(),
        txBytes: z.number(),
        connectedSinceSec: z.number(),
      })),
    }));
    const openvpnStatus = body.openvpnStatus ? parse(statusSchema, body.openvpnStatus) : undefined;
    await nodesService.ingestHeartbeat(nodeId, telemetry as never, openvpnStatus as never, request.ip);
    return { heartbeatIntervalSec: config.agent.heartbeatIntervalSec };
  });

  app.get("/api/v1/agent/operations", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request) => {
    const { nodeId } = await agentNode(request);
    const op = await operationsService.claimNextOperation(nodeId);
    return { operation: op };
  });

  app.post("/api/v1/agent/operations/:id/result", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request) => {
    const { nodeId } = await agentNode(request);
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      success: z.boolean(),
      output: z.unknown().optional(),
      error: z.string().max(8000).optional().nullable(),
      progress: z.number().min(0).max(100).optional(),
    }), request.body);
    const op = await q1<{ node_id: string | null; status: string }>(`SELECT node_id, status FROM operations WHERE id = ?`, id);
    if (!op) throw notFound("Operation not found");
    if (op.node_id !== nodeId) throw unauthorized("Operation belongs to another node");
    if (op.status === "success" || op.status === "failed") return { ok: true, duplicate: true };
    await settleOperation(id, body.success, { output: body.output ?? null, error: body.error ?? null });
    return { ok: true };
  });

  app.post("/api/v1/agent/operations/:id/progress", { config: { rateLimit: { max: 900, timeWindow: "1 minute" } } }, async (request) => {
    await agentNode(request);
    const { id } = request.params as { id: string };
    const body = parse(z.object({ progress: z.number().min(0).max(100), step: z.string().max(63), message: z.string().max(500) }), request.body);
    await operationsService.progressOperation(id, body.progress, body.step, body.message);
    return { ok: true };
  });

  app.post("/api/v1/agent/authorize", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    const { nodeId } = await agentNode(request);
    const body = parse(z.object({
      commonName: z.string().min(1).max(255),
      sourceIp: z.string().max(63),
      vpnIp: z.string().max(63).nullable(),
      hwid: z.string().max(255).nullable(),
      inboundName: z.string().max(63),
    }), request.body);
    const inbound = await q1<{ node_id: string }>(`SELECT node_id FROM inbounds WHERE name = ?`, body.inboundName);
    if (!inbound || inbound.node_id !== nodeId) throw unauthorized("Inbound does not belong to this node");
    const decision = await clientsService.authorizeConnection({
      commonName: body.commonName,
      sourceIp: body.sourceIp,
      vpnIp: body.vpnIp,
      hwid: body.hwid,
      inboundName: body.inboundName,
    });
    return { allow: decision.allow, reason: decision.reason, directives: [] };
  });

  app.post("/api/v1/agent/disconnect", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    await agentNode(request);
    const body = parse(z.object({
      inboundName: z.string().max(63),
      vpnIp: z.string().max(63).nullable(),
      sourceIp: z.string().max(63),
    }), request.body);
    await clientsService.closeSessionByVpnIp(body.inboundName, body.vpnIp, body.sourceIp);
    return { ok: true };
  });

  // ---- Inbounds -----------------------------------------------------------
  const structuredConfigSchema = z.object({
    port: z.number().int().min(1).max(65535).optional(),
    listenAddress: z.string().max(63).optional(),
    transport: z.enum(["udp", "tcp"]).optional(),
    serverNetwork: z.string().max(63).optional(),
    dnsServers: z.array(z.string().max(63)).max(4).optional(),
    redirectGateway: z.boolean().optional(),
    clientToClient: z.boolean().optional(),
    tunMtu: z.number().int().optional(),
    mssFix: z.number().int().nullable().optional(),
    fragment: z.number().int().nullable().optional(),
    dataCiphers: z.array(z.string().max(63)).min(1).max(6).optional(),
    fallbackCipher: z.string().max(63).nullable().optional(),
    authDigest: z.string().max(63).optional(),
    tlsMode: z.enum(["tls-crypt", "tls-auth", "none"]).optional(),
    tlsVersionMin: z.enum(["1.2", "1.3"]).optional(),
    keepaliveInterval: z.number().int().min(1).max(600).optional(),
    keepaliveTimeout: z.number().int().min(2).max(3600).optional(),
    maxClients: z.number().int().min(1).max(10000).optional(),
    performanceProfile: z.enum(["balanced", "low-latency", "throughput", "compatibility"]).optional(),
    duplicateCn: z.boolean().optional(),
    pushRoutes: z.array(z.string().max(63)).max(32).optional(),
    logVerbosity: z.number().int().min(0).max(11).optional(),
    deploymentMode: z.enum(["direct", "through-tunnel"]).optional(),
    tunnelId: z.string().uuid().nullable().optional(),
    /** Optional public domain used in generated profiles (spec §40). */
    domain: z
      .string()
      .max(253)
      .nullable()
      .optional()
      .refine((v) => v == null || v === "" || isValidDomain(v), {
        message: "domain must be a DNS name such as vpn.example.com",
      }),
    /** Client authentication mode (spec §39). */
    authMode: z.enum(["certificate", "password", "certificate+password"]).optional(),
  });

  app.get("/api/v1/inbounds", async (request) => {
    requireAuth(request);
    return { inbounds: await inboundsService.listInbounds() };
  });

  app.post("/api/v1/inbounds", async (request) => {
    const a = actor(request, "operator");
    const body = parse(z.object({
      name: z.string().min(3).max(63),
      description: z.string().max(2000).optional().nullable(),
      nodeId: z.string().uuid(),
      config: structuredConfigSchema.optional(),
    }), request.body);
    const inbound = await inboundsService.createInbound({
      name: body.name,
      description: body.description ?? null,
      nodeId: body.nodeId,
      config: body.config ?? {},
    }, a);
    audit({ actorId: a.id, actorName: a.name, action: "inbound.create", entityType: "inbound", entityId: inbound.id, entityName: inbound.name, summary: `Created OpenVPN inbound ${inbound.name} (v1)` });
    return { inbound };
  });

  app.get("/api/v1/inbounds/:id", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const inbound = await inboundsService.getInbound(id);
    const node = await q1(`SELECT id, name, status, enrollment_state FROM nodes WHERE id = ?`, inbound.nodeId);
    const current = await inboundsService.inboundVersionConfig(id, inbound.currentVersion);
    return {
      inbound,
      node,
      currentConfig: current?.generatedConfig ?? null,
      versions: await inboundsService.inboundVersions(id),
      deployments: await inboundsService.inboundDeployments(id),
      clients: await q(
        `SELECT c.id, c.username, c.status, c.used_billed_bytes FROM client_inbounds ci JOIN clients c ON c.id = ci.client_id WHERE ci.inbound_id = ?`,
        id,
      ),
    };
  });

  app.post("/api/v1/inbounds/validate", async (request) => {
    requireAuth(request);
    const body = parse(z.object({
      nodeId: z.string().uuid().optional(),
      config: structuredConfigSchema,
    }), request.body);
    const expanded = await inboundsService.expandForValidation(body.config, body.nodeId);
    return { validation: validateOpenVPNConfig(expanded), expanded };
  });

  app.patch("/api/v1/inbounds/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      description: z.string().max(2000).optional().nullable(),
      config: structuredConfigSchema.optional(),
      allowUnverifiedDomain: z.boolean().optional(),
    }), request.body);
    const domainChanged = body.config?.domain !== undefined;
    const inbound = await inboundsService.updateInbound(id, body, a);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: domainChanged ? "inbound.domain" : "inbound.update",
      entityType: "inbound",
      entityId: id,
      entityName: inbound.name,
      summary: domainChanged
        ? `Set domain for ${inbound.name} to ${inbound.structuredConfig.domain ?? "(none)"} (DNS status: ${inbound.domainStatus})`
        : `Updated inbound ${inbound.name}`,
    });
    return { inbound };
  });

  // ---- Inbound domain verification (spec §40) ------------------------------ 
  app.post("/api/v1/inbounds/:id/domain-check", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const result = await inboundsService.checkInboundDomain(id);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "inbound.domain",
      entityType: "inbound",
      entityId: id,
      summary: `Domain check for ${result.domain ?? "(none)"}: ${result.status}`,
      detail: { resolvedIps: result.resolvedIps, expectedAddress: result.expectedAddress },
    });
    return { check: result };
  });

  app.get("/api/v1/inbounds/:id/domain", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const inbound = await inboundsService.getInbound(id);
    const node = await q1<{ address: string | null; name: string }>(`SELECT address, name FROM nodes WHERE id = ?`, inbound.nodeId);
    return {
      domain: inbound.structuredConfig.domain ?? null,
      status: inbound.domainStatus,
      resolvedIps: inbound.domainResolvedIps,
      checkedAt: inbound.domainCheckedAt,
      nodeAddress: node?.address ?? null,
      nodeName: node?.name ?? null,
    };
  });

  app.delete("/api/v1/inbounds/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await inboundsService.deleteInbound(id, a);
    return { ok: true };
  });

  app.post("/api/v1/inbounds/:id/deploy", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const result = await inboundsService.deployInbound(id, a);
    return result;
  });

  app.post("/api/v1/inbounds/:id/rollback", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({ version: z.number().int().min(1) }), request.body);
    const inbound = await inboundsService.rollbackInbound(id, body.version, a);
    return { inbound };
  });

  app.post("/api/v1/inbounds/:id/restart", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await inboundsService.restartInbound(id, a);
    return { ok: true };
  });

  app.post("/api/v1/inbounds/:id/stop", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await inboundsService.markInboundStopped(id, a);
    return { ok: true };
  });

  /** Load-balancing group fields, shared by create and update (spec §41). */
  const lbHealthSchema = z.object({
    minSuccessRatePct: z.number().min(0).max(100).nullable(),
    maxLatencyMs: z.number().min(0).max(10000).nullable(),
    maxLossPct: z.number().min(0).max(100).nullable(),
    requireNodeOnline: z.boolean(),
  });
  const lbFailoverSchema = z.object({
    redirectNewSessions: z.boolean(),
    keepExistingSessions: z.boolean(),
    autoDrain: z.boolean(),
    autoRestore: z.boolean(),
  });
  const lbGroupSchema = z.object({
    name: z.string().min(2).max(63),
    description: z.string().max(1000).nullable().optional(),
    mode: z.enum(["weighted", "failover", "least-load"]).optional(),
    enabled: z.boolean().optional(),
    healthRequirements: lbHealthSchema.partial().optional(),
    failover: lbFailoverSchema.partial().optional(),
  });

  // ---- Clients ------------------------------------------------------------
  const limitsSchema = z.object({
    trafficQuotaBytes: z.number().min(0).nullable().optional(),
    timeQuotaSec: z.number().min(0).nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    concurrentSessions: z.number().int().min(1).max(1000).nullable().optional(),
    deviceLimit: z.number().int().min(1).max(100).nullable().optional(),
    ipLimit: z.number().int().min(1).max(100).nullable().optional(),
    ipAllowlist: z.array(z.string().max(63)).max(50).optional(),
    ipDenylist: z.array(z.string().max(63)).max(50).optional(),
    downloadSpeedKbps: z.number().min(0).nullable().optional(),
    uploadSpeedKbps: z.number().min(0).nullable().optional(),
  });

  app.get("/api/v1/clients", async (request) => {
    requireAuth(request);
    const query = request.query as { search?: string; status?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const offset = Number(query.offset ?? 0);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.search) {
      where.push(`(username LIKE ? OR display_name LIKE ?)`);
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    if (query.status) {
      where.push(`status = ?`);
      params.push(query.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await q(`SELECT * FROM clients ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = (await q1<{ c: number }>(`SELECT COUNT(*) AS c FROM clients ${whereSql}`, ...params))?.c ?? 0;
    return { clients: rows.map(clientsService.rowToClient), total, limit, offset };
  });

  app.post("/api/v1/clients", async (request) => {
    const a = actor(request, "operator");
    const body = parse(z.object({
      username: z.string().min(3).max(63),
      displayName: z.string().max(120).optional().nullable(),
      description: z.string().max(2000).optional().nullable(),
      groupId: z.string().uuid().nullable().optional(),
      tags: z.array(z.string().max(40)).max(16).optional(),
      notes: z.string().max(4000).optional().nullable(),
      baseMultiplier: z.number().min(0.1).max(100).optional(),
      limits: limitsSchema.optional(),
      inboundIds: z.array(z.string().uuid()).max(50).optional(),
      /** OpenVPN identity (spec §39). Defaults to the client name, no password. */
      ovpnUsername: z.string().min(3).max(63).optional(),
      ovpnPassword: z.string().min(10).max(128).optional(),
      preferredNodeId: z.string().uuid().nullable().optional(),
      preferredRegion: z.string().max(63).nullable().optional(),
      preferredTransport: z.enum(["udp", "tcp"]).nullable().optional(),
      fallbackInboundId: z.string().uuid().nullable().optional(),
      routingPreferences: z
        .object({
          sticky: z.boolean().optional(),
          preferExitNodeIds: z.array(z.string().uuid()).max(10).optional(),
          excludeNodeIds: z.array(z.string().uuid()).max(20).optional(),
          failoverToFallback: z.boolean().optional(),
        })
        .optional(),
    }), request.body);
    const client = await clientsService.createClient({
      username: body.username,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      groupId: body.groupId ?? null,
      tags: body.tags ?? [],
      notes: body.notes ?? null,
      baseMultiplier: body.baseMultiplier,
      limits: body.limits ?? {},
      inboundIds: body.inboundIds ?? [],
      ovpnUsername: body.ovpnUsername ?? null,
      ovpnPassword: body.ovpnPassword ?? null,
      preferredNodeId: body.preferredNodeId ?? null,
      preferredRegion: body.preferredRegion ?? null,
      preferredTransport: body.preferredTransport ?? null,
      fallbackInboundId: body.fallbackInboundId ?? null,
      routingPreferences: body.routingPreferences,
    });
    audit({ actorId: a.id, actorName: a.name, action: "client.create", entityType: "client", entityId: client.id, entityName: client.username, summary: `Created client ${client.username}` });
    return { client };
  });

  app.get("/api/v1/clients/:id", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const client = await clientsService.getClient(id);
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    return {
      client,
      inbounds: await clientsService.clientInbounds(id),
      devices: await clientsService.clientDevices(id),
      sessions: await clientsService.clientSessions(id),
      usageSeries: await clientsService.clientUsageSeries(id, since),
      policies: (await clientsService.listPolicyRules()).filter((r) =>
        r.conditions.some((c) => c.type === "client" && (c.value === id || (Array.isArray(c.value) && c.value.includes(id)))) ||
        (client.groupId && r.conditions.some((c) => c.type === "group" && (c.value === client.groupId || (Array.isArray(c.value) && c.value.includes(client.groupId))))),
      ),
    };
  });

  // Every editable property except the identity ones (rename / credentials),
  // which have their own audited endpoints below (spec §38).
  app.patch("/api/v1/clients/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      displayName: z.string().max(120).optional().nullable(),
      description: z.string().max(2000).optional().nullable(),
      notes: z.string().max(4000).optional().nullable(),
      groupId: z.string().uuid().nullable().optional(),
      tags: z.array(z.string().max(40)).max(16).optional(),
      baseMultiplier: z.number().min(0.1).max(100).optional(),
      limits: limitsSchema.optional(),
      preferredNodeId: z.string().uuid().nullable().optional(),
      preferredRegion: z.string().max(63).nullable().optional(),
      preferredTransport: z.enum(["udp", "tcp"]).nullable().optional(),
      fallbackInboundId: z.string().uuid().nullable().optional(),
      routingPreferences: z
        .object({
          sticky: z.boolean().optional(),
          preferExitNodeIds: z.array(z.string().uuid()).max(10).optional(),
          excludeNodeIds: z.array(z.string().uuid()).max(20).optional(),
          failoverToFallback: z.boolean().optional(),
        })
        .optional(),
      ovpnAuthEnabled: z.boolean().optional(),
    }), request.body);
    const client = await clientsService.updateClient(id, body);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "client.update",
      entityType: "client",
      entityId: id,
      entityName: client.username,
      summary: `Updated client ${client.username} (${Object.keys(body).join(", ") || "no fields"})`,
    });
    return { client };
  });

  // ---- Client identity + OpenVPN credentials (spec §38/§39) ---------------
  app.post("/api/v1/clients/:id/username", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, `rename client ${(request.params as { id: string }).id}`);
    const { id } = request.params as { id: string };
    const body = parse(z.object({ username: z.string().min(3).max(63) }), request.body);
    const before = await clientsService.getClient(id);
    const client = await clientsService.renameClient(id, body.username);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "client.rename",
      entityType: "client",
      entityId: id,
      entityName: client.username,
      summary: `Renamed client ${before.username} to ${client.username}; certificate reissued, sessions disconnected`,
    });
    return { client };
  });

  app.put("/api/v1/clients/:id/credentials", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, `change OpenVPN credentials for ${(request.params as { id: string }).id}`);
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      username: z.string().min(3).max(63).optional(),
      password: z.string().min(10).max(128).optional(),
      enabled: z.boolean().optional(),
    }), request.body);
    if (body.username === undefined && body.password === undefined && body.enabled === undefined) {
      throw badRequest("Provide at least one of username, password or enabled");
    }
    const result = await clientsService.setOvpnCredentials(id, body, a.name);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "client.credentials",
      entityType: "client",
      entityId: id,
      entityName: result.client.username,
      summary:
        `OpenVPN credentials for ${result.client.username}: ` +
        [result.usernameChanged ? "username changed" : null, result.passwordChanged ? "password changed" : null]
          .filter(Boolean)
          .join(", ") || `credential settings updated`,
      // Only metadata: the password itself is never logged or returned.
      detail: { inboundsSynced: result.inboundsSynced, passwordSetAt: result.client.ovpnPasswordSetAt },
    });
    return { client: result.client, inboundsSynced: result.inboundsSynced };
  });

  app.get("/api/v1/clients/:id/credential-impact", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const inbounds = await clientsService.credentialInbounds(id);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "client.credentials",
      entityType: "client",
      entityId: id,
      summary: `Credential impact check: ${inbounds.length} password-authenticating inbound(s) verify this client against the control plane`,
      detail: { inbounds: inbounds.map((i) => i.name) },
    });
    return { inbounds, note: "Passwords are verified by the control plane on every connection; nothing is stored on the nodes." };
  });

  app.post("/api/v1/clients/:id/placement", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      preferredNodeId: z.string().uuid().nullable().optional(),
      preferredRegion: z.string().max(63).nullable().optional(),
      preferredTransport: z.enum(["udp", "tcp"]).nullable().optional(),
      fallbackInboundId: z.string().uuid().nullable().optional(),
      sticky: z.boolean().optional(),
      preferExitNodeIds: z.array(z.string().uuid()).max(10).optional(),
      excludeNodeIds: z.array(z.string().uuid()).max(20).optional(),
      failoverToFallback: z.boolean().optional(),
    }), request.body);
    const client = await clientsService.updateClientPlacement(id, body);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "client.placement",
      entityType: "client",
      entityId: id,
      entityName: client.username,
      summary: `Updated placement for ${client.username}: node=${client.preferredNodeId ?? "any"}, region=${client.preferredRegion ?? "any"}, transport=${client.preferredTransport ?? "any"}`,
    });
    return { client };
  });

  app.put("/api/v1/clients/:id/inbounds", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({ inboundIds: z.array(z.string().uuid()).max(50) }), request.body);
    const assigned = await clientsService.setInboundAssignments(id, body.inboundIds, a.name);
    const client = await clientsService.getClient(id);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "client.inbounds",
      entityType: "client",
      entityId: id,
      entityName: client.username,
      summary: `Set ${assigned.length} inbound assignment(s) for ${client.username}`,
    });
    return { client, inboundIds: assigned };
  });

  app.post("/api/v1/clients/:id/suspend", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const client = await clientsService.suspendClient(id);
    audit({ actorId: a.id, actorName: a.name, action: "client.suspend", entityType: "client", entityId: id, entityName: client.username, summary: `Suspended client ${client.username}` });
    return { client };
  });

  app.post("/api/v1/clients/:id/resume", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const client = await clientsService.resumeClient(id);
    audit({ actorId: a.id, actorName: a.name, action: "client.resume", entityType: "client", entityId: id, entityName: client.username, summary: `Resumed client ${client.username}` });
    return { client };
  });

  app.post("/api/v1/clients/:id/revoke", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const client = await clientsService.revokeClient(id);
    audit({ actorId: a.id, actorName: a.name, action: "client.revoke", entityType: "client", entityId: id, entityName: client.username, summary: `Revoked client ${client.username} (certificate revoked)` });
    return { client };
  });

  app.post("/api/v1/clients/:id/rotate", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await clientsService.rotateClientCertificate(id);
    const client = await clientsService.getClient(id);
    audit({ actorId: a.id, actorName: a.name, action: "client.rotate", entityType: "client", entityId: id, entityName: client.username, summary: `Rotated certificate for ${client.username}` });
    return { ok: true };
  });

  app.post("/api/v1/clients/:id/config", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({ inboundId: z.string().uuid() }), request.body);
    const profile = await clientsService.buildClientProfile(id, body.inboundId);
    audit({ actorId: a.id, actorName: a.name, action: "client.config_generate", entityType: "client", entityId: id, summary: `Generated client configuration` });
    return { ovpn: profile.ovpn, filename: profile.filename };
  });

  app.post("/api/v1/clients/:id/inbounds/:inboundId/assign", async (request) => {
    const a = actor(request, "operator");
    const { id, inboundId } = request.params as { id: string; inboundId: string };
    await clientsService.assignClientToInbound(id, inboundId);
    return { ok: true };
  });

  app.post("/api/v1/clients/:id/inbounds/:inboundId/unassign", async (request) => {
    const a = actor(request, "operator");
    const { id, inboundId } = request.params as { id: string; inboundId: string };
    await clientsService.unassignClientFromInbound(id, inboundId);
    return { ok: true };
  });

  app.post("/api/v1/clients/:id/devices/:deviceId/revoke", async (request) => {
    const a = actor(request, "operator");
    const { id, deviceId } = request.params as { id: string; deviceId: string };
    await clientsService.revokeDevice(id, deviceId);
    audit({ actorId: a.id, actorName: a.name, action: "client.update", entityType: "client", entityId: id, summary: `Revoked device` });
    return { ok: true };
  });

  // ---- Policies -----------------------------------------------------------
  app.get("/api/v1/policies", async (request) => {
    requireAuth(request);
    return { policies: await clientsService.listPolicyRules() };
  });

  app.post("/api/v1/policies", async (request) => {
    const a = actor(request, "operator");
    const body = parse(z.object({
      name: z.string().min(2).max(120),
      description: z.string().max(2000).optional().nullable(),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(1).max(10000).optional(),
      effectiveFrom: z.string().datetime().nullable().optional(),
      effectiveUntil: z.string().datetime().nullable().optional(),
      conditions: z.array(z.object({
        type: z.enum(["client", "group", "inbound", "node", "sourceIp", "timeOfDay", "dayOfWeek", "trafficUsedBytes", "activeSessions", "deviceCount"]),
        op: z.enum(["eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte"]),
        value: z.unknown(),
      })).max(12),
      actions: z.array(z.object({
        type: z.enum(["deny", "suspend", "limit_bandwidth", "limit_sessions", "limit_devices", "apply_multiplier", "alert"]),
        params: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(6),
    }), request.body);
    const id = uuid();
    const now = nowIso();
    await run(
      `INSERT INTO policy_rules (id, name, description, enabled, priority, effective_from, effective_until, conditions, actions, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      body.name,
      body.description ?? null,
      body.enabled === false ? 0 : 1,
      body.priority ?? 100,
      body.effectiveFrom ?? null,
      body.effectiveUntil ?? null,
      JSON.stringify(body.conditions),
      JSON.stringify(body.actions),
      now,
      now,
    );
    audit({ actorId: a.id, actorName: a.name, action: "policy.create", entityType: "policy", entityId: id, entityName: body.name, summary: `Created policy ${body.name}` });
    return { id };
  });

  app.patch("/api/v1/policies/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      name: z.string().min(2).max(120).optional(),
      description: z.string().max(2000).optional().nullable(),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(1).max(10000).optional(),
      effectiveFrom: z.string().datetime().nullable().optional(),
      effectiveUntil: z.string().datetime().nullable().optional(),
      conditions: z.array(z.unknown()).max(12).optional(),
      actions: z.array(z.unknown()).min(1).max(6).optional(),
    }), request.body);
    const existing = await q1(`SELECT * FROM policy_rules WHERE id = ?`, id);
    if (!existing) throw notFound("Policy not found");
    await run(
      `UPDATE policy_rules SET name = ?, description = ?, enabled = ?, priority = ?, effective_from = ?, effective_until = ?, conditions = ?, actions = ?, updated_at = ? WHERE id = ?`,
      body.name ?? (existing.name as string),
      body.description ?? (existing.description as string | null),
      body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0,
      body.priority ?? (existing.priority as number),
      body.effectiveFrom ?? (existing.effective_from as string | null),
      body.effectiveUntil ?? (existing.effective_until as string | null),
      body.conditions ? JSON.stringify(body.conditions) : existing.conditions,
      body.actions ? JSON.stringify(body.actions) : existing.actions,
      nowIso(),
      id,
    );
    audit({ actorId: a.id, actorName: a.name, action: "policy.update", entityType: "policy", entityId: id, entityName: body.name ?? (existing.name as string), summary: `Updated policy` });
    return { ok: true };
  });

  app.delete("/api/v1/policies/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const existing = await q1<{ name: string }>(`SELECT name FROM policy_rules WHERE id = ?`, id);
    if (!existing) throw notFound("Policy not found");
    await run(`DELETE FROM policy_rules WHERE id = ?`, id);
    audit({ actorId: a.id, actorName: a.name, action: "policy.delete", entityType: "policy", entityId: id, entityName: existing.name, summary: `Deleted policy ${existing.name}` });
    return { ok: true };
  });

  // ---- Tunnels ------------------------------------------------------------
  app.get("/api/v1/tunnels", async (request) => {
    requireAuth(request);
    const tunnels = await tunnelsService.listTunnels();
    return {
      tunnels: await Promise.all(tunnels.map(async (t) => ({
        ...t,
        sourceName: (await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, t.sourceNodeId))?.name ?? "?",
        destName: (await q1<{ name: string }>(`SELECT name FROM nodes WHERE id = ?`, t.destNodeId))?.name ?? "?",
      }))),
    };
  });

  app.post("/api/v1/tunnels", async (request) => {
    const a = actor(request, "operator");
    const body = parse(z.object({
      // The tunnel name becomes the GRE interface name on both nodes, and Linux
      // interface names are limited to 15 characters (IFNAMSIZ - 1).
      name: z
        .string()
        .min(3)
        .max(15, "Tunnel name must be 3-15 characters: it becomes the Linux interface name on each node."),
      sourceNodeId: z.string().uuid(),
      destNodeId: z.string().uuid(),
      // true/omitted: generate a key. false: keyless GRE. A string is used as the
      // key itself and canonicalised (1-8 hexadecimal characters); anything else
      // is refused by the service before it can be queued.
      key: z
        // The length bound is deliberately loose: the service owns the rule and
        // answers with the exact hexadecimal requirement for any bad value.
        .union([z.boolean(), z.string().min(1).max(32)])
        .nullable()
        .optional(),
      ttl: z.number().int().min(1).max(255).optional(),
      mtuOverride: z.number().int().min(576).max(1500).nullable().optional(),
      pathMtu: z.number().int().min(576).max(1500).optional(),
      fouPort: z.number().int().min(1024).max(65535).nullable().optional(),
      ipsec: z.boolean().optional(),
    }), request.body);
    const tunnel = await tunnelsService.createTunnel(body, a);
    const mode = [tunnel.fouPort ? "FOU" : null, tunnel.ipsecEnabled ? "IPsec" : null].filter(Boolean).join("+") || "raw";
    audit({ actorId: a.id, actorName: a.name, action: "tunnel.create", entityType: "tunnel", entityId: tunnel.id, entityName: tunnel.name, summary: `Created GRE tunnel ${tunnel.name} (${mode})` });
    return { tunnel };
  });

  app.post("/api/v1/tunnels/mesh", async (request) => {
    const a = actor(request, "operator");
    const body = parse(z.object({
      name: z.string().min(3).max(15),
      sourceNodeIds: z.array(z.string().uuid()).min(1).max(50),
      destNodeIds: z.array(z.string().uuid()).min(1).max(50),
      key: z.boolean().nullable().optional(),
      pathMtu: z.number().int().min(576).max(1500).optional(),
      fouPort: z.number().int().min(1024).max(65535).nullable().optional(),
      ipsec: z.boolean().optional(),
    }), request.body);
    return tunnelsService.createMesh(body, a);
  });

  app.get("/api/v1/nodes/:id/capabilities", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    return nodesService.nodeCapabilities(id);
  });

  app.get("/api/v1/tunnels/mtu-advice", async (request) => {
    requireAuth(request);
    const { pathMtu, keyed } = request.query as { pathMtu?: string; keyed?: string };
    return tunnelsService.mtuAdvice(Number(pathMtu ?? 1500), keyed !== "false");
  });

  app.get("/api/v1/tunnels/:id", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const tunnel = await tunnelsService.getTunnel(id);
    return {
      tunnel,
      routes: await tunnelsService.tunnelRoutes(id),
      sourceNode: await q1(`SELECT id, name, status, address FROM nodes WHERE id = ?`, tunnel.sourceNodeId),
      destNode: await q1(`SELECT id, name, status, address FROM nodes WHERE id = ?`, tunnel.destNodeId),
      operations: await q(`SELECT * FROM operations WHERE ref_type = 'tunnel' AND ref_id = ? ORDER BY created_at DESC LIMIT 20`, id),
      pathHealth: await routingService.pathHealthHistory(id, 50),
    };
  });

  app.post("/api/v1/tunnels/:id/deploy", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await tunnelsService.deployTunnel(id, a);
    return { ok: true };
  });

  app.post("/api/v1/tunnels/:id/test", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    return tunnelsService.testTunnel(id, a);
  });

  app.post("/api/v1/tunnels/:id/benchmark", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(
      z.object({
        pingCount: z.number().int().min(1).max(200).optional(),
        iperfSeconds: z.number().int().min(1).max(60).nullable().optional(),
      }),
      request.body ?? {},
    );
    return routingService.queueBenchmark(id, body, a);
  });

  // ---- Routing intelligence ------------------------------------------------
  // Real node/path/transport state, sticky assignments, explainable events and
  // the policy that tiers candidates. All decisions come from the shared engine.

  app.get("/api/v1/routing/matrix", async (request) => {
    requireAuth(request);
    return routingService.routingMatrix();
  });

  // Path probing is explainable: an operator can see which paths are due for a
  // probe and, for every path that is not, the reason it is waiting.
  app.get("/api/v1/routing/probes", async (request) => {
    requireAuth(request);
    const plan = await healthEngine.planHealthProbes();
    return {
      intervalSec: healthEngine.PROBE_INTERVAL_SEC,
      maxPerSweep: healthEngine.PROBE_MAX_PER_SWEEP,
      pingCount: healthEngine.PROBE_PING_COUNT,
      due: plan.filter((p) => p.due).length,
      probes: plan,
    };
  });

  app.post("/api/v1/routing/probes/run", async (request) => {
    const a = actor(request, "operator");
    const result = await healthEngine.runHealthProbes();
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "routing.probe",
      entityType: "path_health",
      entityId: null,
      summary: `Ran a path health sweep: ${result.queued} probe(s) queued, ${result.skipped} skipped`,
      detail: result,
      ip: request.ip,
    });
    return result;
  });

  app.get("/api/v1/routing/assignments", async (request) => {
    requireAuth(request);
    return { assignments: await routingService.listAssignments() };
  });

  app.get("/api/v1/routing/events", async (request) => {
    requireAuth(request);
    const { limit } = request.query as { limit?: string };
    return { events: await routingService.listRoutingEvents(limit ? Number(limit) : 50) };
  });

  app.post("/api/v1/routing/place", async (request) => {
    const a = actor(request, "operator");
    const body = parse(
      z.object({
        clientId: z.string().min(1),
        preferIngressNodeId: z.string().min(1).nullable().optional(),
        allowDegraded: z.boolean().optional(),
      }),
      request.body,
    );
    return routingService.decidePlacement(body, a);
  });

  app.get("/api/v1/routing/policies", async (request) => {
    requireAuth(request);
    const { scope, refId } = request.query as { scope?: string; refId?: string };
    const resolvedScope = scope === "client" || scope === "group" ? scope : "global";
    // Always the effective policy: no stored row means AUTO without
    // preferences, never a null the panel would have to guess about.
    const stored = await routingService.getRoutingPolicy(resolvedScope, refId ?? "");
    return { policy: routingService.effectiveRoutingPolicy(stored) };
  });

  app.put("/api/v1/routing/policies", async (request) => {
    const a = actor(request, "admin");
    const body = parse(
      z.object({
        scope: z.enum(["global", "client", "group"]).optional(),
        refId: z.string().max(64).optional(),
        mode: z.enum(["auto", "preferred-node", "preferred-region", "preferred-transport", "strict"]),
        preferredNodeIds: z.array(z.string().max(64)).max(32).optional(),
        preferredCountries: z.array(z.string().max(120)).max(32).optional(),
        preferredRegionClasses: z.array(z.enum(["iran", "international"])).max(2).optional(),
        preferredTransports: z.array(z.enum(["openvpn-udp", "openvpn-tcp", "gre", "gre-fou", "gre-ipsec"])).max(8).optional(),
        minSwitchDelta: z.number().min(0).max(100).optional(),
        holdDownSec: z.number().int().min(0).max(86_400).optional(),
        enabled: z.boolean().optional(),
      }),
      request.body,
    );
    return { policy: await routingService.saveRoutingPolicy(body, a) };
  });

  app.patch("/api/v1/routing/admin", async (request) => {
    const a = actor(request, "operator");
    const body = parse(
      z.object({
        entity: z.enum(["node", "tunnel"]),
        id: z.string().min(1),
        state: z.enum(["enabled", "disabled", "drained"]),
      }),
      request.body,
    );
    return routingService.setAdminState(body.entity, body.id, body.state, a);
  });

  app.delete("/api/v1/tunnels/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await tunnelsService.deleteTunnel(id, a);
    return { ok: true };
  });

  // ---- Operations / audit / alerts / settings ------------------------------
  app.get("/api/v1/operations", async (request) => {
    requireAuth(request);
    const query = request.query as { limit?: string; status?: string };
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const rows = query.status
      ? await q(`SELECT * FROM operations WHERE status = ? ORDER BY created_at DESC LIMIT ?`, query.status, limit)
      : await q(`SELECT * FROM operations ORDER BY created_at DESC LIMIT ?`, limit);
    return { operations: rows };
  });

  app.get("/api/v1/operations/:id", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    return operationsService.operationWithLogs(id);
  });

  app.get("/api/v1/audit", async (request) => {
    requireAuth(request);
    const query = request.query as { limit?: string; action?: string };
    const limit = Math.min(Number(query.limit ?? 100), 500);
    const rows = query.action
      ? await q(`SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY at DESC LIMIT ?`, `%${query.action}%`, limit)
      : await q(`SELECT * FROM audit_logs ORDER BY at DESC LIMIT ?`, limit);
    return { entries: rows };
  });

  app.get("/api/v1/alerts", async (request) => {
    requireAuth(request);
    return { alerts: await q(`SELECT * FROM alerts ORDER BY (status = 'open') DESC, created_at DESC LIMIT 200`) };
  });

  app.post("/api/v1/alerts/:id/resolve", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    await run(`UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`, nowIso(), id);
    audit({ actorId: a.id, actorName: a.name, action: "alert.resolve", entityType: "alert", entityId: id, summary: `Resolved alert` });
    return { ok: true };
  });

  app.get("/api/v1/settings", async (request) => {
    requireAuth(request);
    return { settings: await settingsService.publicSettings() };
  });

  app.patch("/api/v1/settings", async (request) => {
    const a = actor(request, "admin");
    const body = parse(z.object({
      "ui.siteName": z.string().max(60).optional(),
      "retention.healthDays": z.string().regex(/^\d+$/).optional(),
      "retention.usageDays": z.string().regex(/^\d+$/).optional(),
      "retention.auditDays": z.string().regex(/^\d+$/).optional(),
      "security.sessionTtlSec": z.string().regex(/^\d+$/).optional(),
    }), request.body);
    for (const [k, v] of Object.entries(body)) {
      await settingsService.setSetting(k, String(v));
    }
    audit({ actorId: a.id, actorName: a.name, action: "settings.update", summary: "Updated platform settings", detail: body });
    return { settings: await settingsService.publicSettings() };
  });

  /**
   * Session-secret rotation (spec §14/§24).
   *
   * One implementation, used by the panel and by `arvoo secret rotate`. The new
   * secret is generated server-side, stored where bootstrap reads it, and
   * applied to the running process in the same step — so there is exactly one
   * source of truth and no second rotation path.
   *
   * Every existing session is invalidated by design (tokens were signed with
   * the old secret). That is the safe direction: quiet invalidation beats a
   * window where two secrets are both accepted.
   */
  app.post("/api/v1/system/rotate-session-secret", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "rotating the session signing secret");
    const body = parse(z.object({ confirm: z.literal("rotate") }), request.body);
    void body;
    const previous = await q1<{ updated_at: string }>(`SELECT updated_at FROM settings WHERE key = 'security.jwtSecret'`);
    const rotatedAt = nowIso();
    await settingsService.setSetting("security.jwtSecret", randomBytes(32).toString("hex"));
    const { loadSessionSecretFromStore } = await import("../bootstrap.js");
    await loadSessionSecretFromStore();
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "system.secret_rotate",
      entityType: "settings",
      entityId: "security.jwtSecret",
      summary: "Rotated the session signing secret; all existing sessions were invalidated",
      detail: { previousRotatedAt: previous?.updated_at ?? null },
      ip: request.ip,
    });
    return {
      rotatedAt,
      previousRotatedAt: previous?.updated_at ?? null,
      sessionsInvalidated: true,
      note: "Sign in again. The secret itself is never returned by this endpoint.",
    };
  });

  /**
   * Management access secret (spec §14): the additional layer on top of
   * authentication. Metadata only - the value is returned once, to the caller
   * that created it, and never again.
   */
  app.get("/api/v1/system/management", async (request) => {
    requireRole("admin")(request);
    return { management: await managementSecret.status(), recoveryFile: MANAGEMENT_SECRET_FILE };
  });

  app.post("/api/v1/system/management", async (request) => {
    const a = actor(request, "admin");
    const body = parse(
      z.object({
        action: z.enum(["enable", "rotate", "disable", "policy", "set"]),
        /** Operator-chosen value for action=set (never logged, never stored raw). */
        value: z.string().min(16).max(200).optional(),
        autoRotateHours: z.number().min(0).max(168).optional(),
        graceMinutes: z.number().min(0).max(1440).optional(),
        confirm: z.literal("apply"),
      }),
      request.body,
    );

    // Changing the gate itself always needs the current secret - except for the
    // first enable, when no secret exists yet. That is what stops a stolen
    // admin session from quietly rotating the second factor away.
    const current = await managementSecret.status();
    if (current.enabled) await requireManagement(request, `management secret: ${body.action}`);

    if (body.action === "disable") {
      const status = await managementSecret.disable();
      audit({
        actorId: a.id,
        actorName: a.name,
        action: "security.management_secret_disable",
        entityType: "settings",
        summary: "Disabled the management access secret",
        ip: request.ip,
      });
      return { management: status, secret: null };
    }

    if (body.action === "policy") {
      const status = await managementSecret.setPolicy({
        autoRotateHours: body.autoRotateHours,
        graceMinutes: body.graceMinutes,
      });
      audit({
        actorId: a.id,
        actorName: a.name,
        action: "security.management_secret_policy",
        entityType: "settings",
        summary: `Management secret policy: rotate every ${status.autoRotateHours}h, ${status.graceMinutes}m grace`,
        detail: { autoRotateHours: status.autoRotateHours, graceMinutes: status.graceMinutes },
        ip: request.ip,
      });
      return { management: status, secret: null };
    }

    if (body.action === "set" && !body.value) {
      throw unprocessable("Validation failed: value is required when action is set");
    }

    const result = await managementSecret.rotate({
      reason: body.action,
      value: body.action === "set" ? body.value : undefined,
      autoRotateHours: body.autoRotateHours,
      graceMinutes: body.graceMinutes,
    });
    // On Linux the value is also written where a terminal operator can recover
    // it (root only). It is never written to the audit log, the journal or a
    // response body other than this one.
    const persisted = await managementSecret.persistToFile(result.secret);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: "security.management_secret_rotate",
      entityType: "settings",
      summary: `Rotated the management access secret (${body.action}); previous value valid for ${result.status.graceMinutes} minutes`,
      detail: {
        previousValidUntil: result.status.previousValidUntil,
        nextRotationAt: result.status.nextRotationAt,
        recoveryFileWritten: persisted,
      },
      ip: request.ip,
    });
    return {
      management: result.status,
      secret: result.secret,
      recoveryFile: MANAGEMENT_SECRET_FILE,
      recoveryFileWritten: persisted,
      note: "This value is shown once. Store it in your password manager now.",
    };
  });

  /** Real security posture for `arvoo security-audit` (spec §35). */
  app.get("/api/v1/system/security", async (request) => {
    requireRole("admin")(request);
    const [failed24h] = await q<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'auth.failed' AND at > ?`,
      new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    );
    const [secretRow] = await q<{ updated_at: string }>(`SELECT updated_at FROM settings WHERE key = 'security.jwtSecret'`);
    const [rotations] = await q<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'system.secret_rotate'`,
    );
    return {
      session: {
        absoluteLifetimeSec: config.jwtTtlSec,
        idleLifetimeSec: config.sessionIdleSec,
        csrfProtection: true,
        cookieFlags: ["HttpOnly", "SameSite=Strict", config.isProduction ? "Secure" : "Secure(when HTTPS)"],
      },
      secret: {
        kind: "security.jwtSecret",
        rotatedAt: secretRow?.updated_at ?? null,
        rotationCount: Number(rotations?.count ?? 0),
        storedHashedOrEncrypted: false,
        note: "Session signing secret: random, stored server-side only, never returned by the API.",
      },
      login: {
        failedLast24h: Number(failed24h?.count ?? 0),
        rateLimit: "10 attempts/minute per source",
        genericErrors: true,
        usernameEnumerationResistant: true,
      },
      exposure: {
        robotsNoindex: true,
        securityHeaders: Object.keys(SECURITY_HEADERS),
        sourceMapsInProduction: false,
        directoryListings: false,
      },
      managementSecret: await managementSecret.status(),
    };
  });

  /**
   * Live route inventory, generated from the running Fastify instance rather
   * than from a hand-written list, so it can never list an endpoint that does
   * not exist. Paired with docs/API.md (request/response shapes, auth, RBAC and
   * rate limits) this is the API reference: it is *not* a full OpenAPI schema,
   * and the docs say so explicitly.
   */
  app.get("/api/v1/system/routes", async (request) => {
    requireRole("admin")(request);
    const tree = app.printRoutes({ commonPrefix: false });
    const routes = tree
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "└── /" && line !== "├── /")
      .map((line) => line.replace(/^[│├└─\s]+/, ""));
    return {
      service: "arvoo-control-plane",
      generatedFrom: "fastify.printRoutes()",
      documentation: "docs/API.md",
      concurrency: { model: "request/response", websockets: false, polling: "clients poll /api/v1/... at their own interval" },
      routes,
    };
  });

  app.post("/api/v1/maintenance/retention-sweep", async (request) => {
    actor(request, "admin");
    const healthDays = Number((await settingsService.getSetting("retention.healthDays")) ?? "14");
    const usageDays = Number((await settingsService.getSetting("retention.usageDays")) ?? "90");
    const healthCutoff = new Date(Date.now() - healthDays * 86400_000).toISOString();
    const usageCutoff = new Date(Date.now() - usageDays * 86400_000).toISOString();
    await run(`DELETE FROM node_health_samples WHERE at < ?`, healthCutoff);
    await run(`DELETE FROM client_usage_samples WHERE at < ?`, usageCutoff);
    // The same pass reconciles load-balancing groups against measured health and
    // collects results produced by the master's privileged firewall helper.
    const groups = await loadBalancer.reconcileGroups();
    const firewallResults = await firewallService.ingestSelfResults();
    return { ok: true, healthCutoff, usageCutoff, groups, firewallResults };
  });

  // ---- OpenVPN credential verification (spec §39) --------------------------
  // Called by the node's `auth-user-pass-verify` hook. The node authenticates
  // as itself; the *user's* password is verified here, so no credential is ever
  // stored on the node.
  app.post("/api/v1/agent/openvpn-auth", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request) => {
    const { nodeId } = await agentNode(request);
    const body = parse(z.object({
      username: z.string().min(1).max(128),
      password: z.string().min(1).max(256),
      commonName: z.string().max(255).nullable().optional(),
      inboundName: z.string().min(1).max(63),
    }), request.body);
    const inbound = await q1<{ node_id: string; structured_config: string }>(
      `SELECT node_id, structured_config FROM inbounds WHERE name = ?`,
      body.inboundName,
    );
    if (!inbound || inbound.node_id !== nodeId) throw unauthorized("Inbound does not belong to this node");
    let authMode = "certificate";
    try {
      authMode = normalizeAuthMode((JSON.parse(inbound.structured_config) as { authMode?: "certificate" | "password" | "certificate+password" }).authMode);
    } catch {
      authMode = "certificate";
    }
    if (authMode === "certificate") {
      // Password authentication is not enabled on this inbound: refuse instead
      // of silently accepting a credential the platform does not manage.
      return { allow: false, reason: "This inbound authenticates by certificate only" };
    }
    const decision = await clientsService.authenticateOvpnCredentials({
      username: body.username,
      password: body.password,
      commonName: body.commonName ?? null,
      inboundName: body.inboundName,
    });
    if (!decision.allow) {
      audit({
        actorId: "system",
        actorName: "openvpn-auth",
        action: "auth.failed",
        entityType: "client",
        entityId: decision.clientId,
        entityName: body.username,
        summary: `OpenVPN login refused on ${body.inboundName}: ${decision.reason ?? "no reason"}`,
        ip: request.ip,
      });
    }
    // The reason is returned to the hook (which logs it for the operator) but
    // never includes the password or the hash.
    return { allow: decision.allow, reason: decision.reason };
  });

  // ---- Load balancing (spec §41) ------------------------------------------
  app.get("/api/v1/lb/groups", async (request) => {
    requireAuth(request);
    return { groups: await loadBalancer.listGroupViews() };
  });

  app.post("/api/v1/lb/groups", async (request) => {
    const a = actor(request, "operator");
    const body = parse(lbGroupSchema, request.body);
    const group = await loadBalancer.createGroup(body, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.group_create", entityType: "settings", entityId: group.id, entityName: group.name, summary: `Created load-balancing group ${group.name} (${group.mode})` });
    return { group: await loadBalancer.getGroupView(group.id) };
  });

  app.get("/api/v1/lb/groups/:id", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    return { group: await loadBalancer.getGroupView(id) };
  });

  app.patch("/api/v1/lb/groups/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(lbGroupSchema.partial(), request.body);
    const group = await loadBalancer.updateGroup(id, body, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.group_update", entityType: "settings", entityId: id, entityName: group.name, summary: `Updated load-balancing group ${group.name}` });
    return { group: await loadBalancer.getGroupView(id) };
  });

  app.delete("/api/v1/lb/groups/:id", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const group = await loadBalancer.getGroup(id);
    await loadBalancer.deleteGroup(id);
    audit({ actorId: a.id, actorName: a.name, action: "lb.group_delete", entityType: "settings", entityId: id, entityName: group.name, summary: `Deleted load-balancing group ${group.name}` });
    return { ok: true };
  });

  app.post("/api/v1/lb/groups/:id/members", async (request) => {
    const a = actor(request, "operator");
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      kind: z.enum(["inbound", "node"]),
      refId: z.string().uuid(),
      weight: z.number().int().min(0).max(1000).optional(),
      priority: z.number().int().min(0).max(1000).optional(),
      enabled: z.boolean().optional(),
    }), request.body);
    const member = await loadBalancer.addMember(id, body, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.member_update", entityType: "settings", entityId: id, summary: `Added ${body.kind} member (weight ${member.weight}) to the group` });
    return { group: await loadBalancer.getGroupView(id) };
  });

  app.patch("/api/v1/lb/members/:memberId", async (request) => {
    const a = actor(request, "operator");
    const { memberId } = request.params as { memberId: string };
    const body = parse(z.object({
      weight: z.number().int().min(0).max(1000).optional(),
      priority: z.number().int().min(0).max(1000).optional(),
      enabled: z.boolean().optional(),
    }), request.body);
    const member = await loadBalancer.updateMember(memberId, body, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.member_update", entityType: "settings", entityId: member.groupId, summary: `Updated member: ${JSON.stringify(body)}` });
    return { group: await loadBalancer.getGroupView(member.groupId) };
  });

  app.delete("/api/v1/lb/members/:memberId", async (request) => {
    const a = actor(request, "operator");
    const { memberId } = request.params as { memberId: string };
    const member = await loadBalancer.getMember(memberId);
    await loadBalancer.removeMember(memberId, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.member_update", entityType: "settings", entityId: member.groupId, summary: `Removed a member from the group` });
    return { group: await loadBalancer.getGroupView(member.groupId) };
  });

  app.post("/api/v1/lb/members/:memberId/drain", async (request) => {
    const a = actor(request, "operator");
    const { memberId } = request.params as { memberId: string };
    const body = parse(z.object({ reason: z.string().max(500).nullable().optional() }), request.body ?? {});
    const member = await loadBalancer.getMember(memberId);
    await loadBalancer.drainMember(memberId, body.reason ?? null, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.drain", entityType: "settings", entityId: member.groupId, summary: `Drained a member: ${body.reason ?? "no reason given"}` });
    return { group: await loadBalancer.getGroupView(member.groupId) };
  });

  app.post("/api/v1/lb/members/:memberId/restore", async (request) => {
    const a = actor(request, "operator");
    const { memberId } = request.params as { memberId: string };
    const member = await loadBalancer.getMember(memberId);
    await loadBalancer.restoreMember(memberId, a.name);
    audit({ actorId: a.id, actorName: a.name, action: "lb.restore", entityType: "settings", entityId: member.groupId, summary: "Restored a drained member" });
    return { group: await loadBalancer.getGroupView(member.groupId) };
  });

  // Where the next session would go, computed from measured health. Never a
  // simulated percentage: it either names a member or says why none is usable.
  app.post("/api/v1/lb/groups/:id/choose", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    const result = await loadBalancer.chooseForGroup(id);
    return { memberId: result.member?.id ?? null, memberName: result.member?.name ?? null, degraded: result.degraded, reason: result.reason };
  });

  app.get("/api/v1/lb/groups/:id/events", async (request) => {
    requireAuth(request);
    const { id } = request.params as { id: string };
    return { events: await loadBalancer.groupEvents(id) };
  });

  app.post("/api/v1/lb/reconcile", async (request) => {
    const a = actor(request, "operator");
    const result = await loadBalancer.reconcileGroups();
    audit({ actorId: a.id, actorName: a.name, action: "lb.group_update", entityType: "settings", summary: `Load-balancing reconciliation: ${result.drained} drained, ${result.restored} restored` });
    return result;
  });

  // ---- Managed firewall / UFW (spec §UFW) ---------------------------------
  app.get("/api/v1/firewall", async (request) => {
    requireAuth(request);
    return firewallService.firewallOverview();
  });

  app.patch("/api/v1/firewall/policy", async (request) => {
    const a = actor(request, "admin");
    const body = parse(z.object({
      sshPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(4).optional(),
      adminSources: z.array(z.string().max(63)).max(20).optional(),
      panelPorts: z.array(z.number().int().min(1).max(65535)).max(4).optional(),
      restrictPanel: z.boolean().optional(),
      exposeApiPort: z.boolean().optional(),
      allowIcmp: z.boolean().optional(),
      includeInactiveInbounds: z.boolean().optional(),
      extraRules: z
        .array(
          z.object({
            port: z.number().int().min(1).max(65535).nullable(),
            proto: z.enum(["tcp", "udp", "gre", "esp", "icmp"]),
            from: z.string().max(63).nullable(),
            comment: z.string().max(120),
          }),
        )
        .max(50)
        .optional(),
    }), request.body);
    const policy = await firewallService.saveFirewallPolicy(body);
    audit({ actorId: a.id, actorName: a.name, action: "firewall.plan", entityType: "settings", summary: `Updated firewall policy: SSH ${policy.sshPorts.join(", ")}, panel ${policy.panelPorts.join(", ")}` });
    return { policy };
  });

  // Preview of exactly what would be applied, with the ufw command lines.
  app.get("/api/v1/firewall/plan", async (request) => {
    requireAuth(request);
    const query = request.query as { host?: string };
    const plan = await firewallService.buildPlanForHost(query.host ?? firewallService.SELF_HOST);
    const previous = await firewallService.appliedRules(query.host ?? firewallService.SELF_HOST);
    const diff = diffFirewallPlans(previous, plan.rules);
    return {
      plan,
      commands: plan.rules.map((rule) => ({ id: rule.id, argv: ruleToUfwArgs(rule), remove: ufwDeleteArgs(rule) })),
      diff: { added: diff.added, removed: diff.removed, unchanged: diff.unchanged.length },
    };
  });

  // "Config & Enable UFW": build the plan from real state and apply it.
  app.post("/api/v1/firewall/apply", async (request) => {
    const a = actor(request, "admin");
    await requireManagement(request, "enable the managed firewall");
    const body = parse(z.object({
      host: z.string().min(1).max(64),
      action: z.enum(["enable", "update", "disable"]).optional(),
    }), request.body);
    const action = body.action ?? "enable";
    const result = await firewallService.requestApply(body.host, action, a.name);
    audit({
      actorId: a.id,
      actorName: a.name,
      action: action === "enable" ? "firewall.enable" : action === "update" ? "firewall.update" : "firewall.disable",
      entityType: "settings",
      entityId: result.hostKey,
      summary:
        `${action === "enable" ? "Config & Enable UFW" : action === "update" ? "Update UFW" : "Disable UFW"} on ${result.hostKey}: ` +
        `${result.added.length} rule(s) added, ${result.removed.length} removed - ${result.status}`,
      detail: { planHash: result.planHash, detail: result.detail, operationId: result.operationId },
      ip: request.ip,
    });
    return result;
  });

  app.get("/api/v1/firewall/history", async (request) => {
    requireAuth(request);
    const query = request.query as { host?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 25), 100);
    const rows = query.host
      ? await q(`SELECT * FROM firewall_applies WHERE node_id = ? ORDER BY at DESC LIMIT ?`, query.host, limit)
      : await q(`SELECT * FROM firewall_applies ORDER BY at DESC LIMIT ?`, limit);
    return { applies: rows.map(firewallService.rowToApplyRecord) };
  });
}
