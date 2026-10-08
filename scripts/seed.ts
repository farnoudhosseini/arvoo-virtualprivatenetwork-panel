/**
 * Seeds REAL entities through the real control plane API — no fabricated
 * telemetry or metrics. Creates:
 *   - 3 nodes (master-local, DE-01, IR-01) — DE/IR stay pending until a real
 *     agent enrolls on those machines (honest state).
 *   - 1 OpenVPN inbound (draft, v1 config generated, PKI issued).
 *   - 1 client with quotas + certificate.
 *   - 1 policy rule (scheduled multiplier example).
 * Usage: node --import tsx scripts/seed.ts  (or npx tsx scripts/seed.ts)
 */

const BASE = process.env.ARVOO_URL ?? "http://127.0.0.1:4001";

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const { token } = await api("POST", "/auth/login", {
    username: process.env.ARVOO_ADMIN_USER ?? "admin",
    password: process.env.ARVOO_ADMIN_PASSWORD ?? "arvoo-admin",
  });
  console.log("✓ logged in");

  const existing = await api("GET", "/nodes", undefined, token);
  if (existing.nodes.length > 0) {
    console.log("• nodes already exist, skipping seed");
    return;
  }

  const master = await api("POST", "/nodes", {
    name: "MASTER-LOCAL",
    role: "master",
    regionClass: "international",
    country: "Local",
    description: "The control plane host itself, registered as a managed node.",
  }, token);
  console.log("✓ node MASTER-LOCAL", master.node.id);
  console.log("  enrollment token (10 min, single use):", master.enrollment.token);

  const de = await api("POST", "/nodes", {
    name: "DE-01",
    role: "vpn",
    regionClass: "international",
    country: "Germany",
    provider: "Hetzner",
    description: "International egress node — awaiting agent enrollment on the real server.",
  }, token);
  console.log("✓ node DE-01 (pending agent)", de.node.id);

  const ir = await api("POST", "/nodes", {
    name: "IR-01",
    role: "vpn",
    regionClass: "iran",
    country: "Iran",
    description: "Iran ingress node — awaiting agent enrollment on the real server.",
  }, token);
  console.log("✓ node IR-01 (pending agent)", ir.node.id);

  const inbound = await api("POST", "/inbounds", {
    name: "ovpn-master-01",
    description: "OpenVPN endpoint on the control plane host (direct egress).",
    nodeId: master.node.id,
    config: { performanceProfile: "balanced" },
  }, token);
  console.log("✓ inbound ovpn-master-01 v1 (draft, PKI issued)", inbound.inbound.id);

  const client = await api("POST", "/clients", {
    username: "client-A",
    displayName: "First Client",
    baseMultiplier: 1.0,
    limits: {
      trafficQuotaBytes: 100 * 1024 ** 3,
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      deviceLimit: 2,
      ipLimit: 2,
    },
    inboundIds: [inbound.inbound.id],
  }, token);
  console.log("✓ client client-A (100 GB / 30 days / 2 devices / 2 IPs)", client.client.id);

  const policy = await api("POST", "/policies", {
    name: "off-hours-1x",
    description: "Example scheduled multiplier: normal consumption outside peak hours.",
    priority: 50,
    conditions: [{ type: "timeOfDay", op: "gte", value: 0 }],
    actions: [{ type: "apply_multiplier", params: { multiplier: 1.0 } }],
  }, token);
  console.log("✓ policy off-hours-1x", policy.id);

  console.log("\nNext steps:");
  console.log("  1. Run the agent on this machine to bring MASTER-LOCAL online:");
  console.log(`     ARVOO_CONTROL_PLANE_URL=${BASE} npx tsx src/index.ts enroll ${master.enrollment.token}`);
  console.log("  2. Approve it from Nodes → MASTER-LOCAL.");
  console.log("  3. On real servers, create DE-01/IR-01 agents the same way.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
