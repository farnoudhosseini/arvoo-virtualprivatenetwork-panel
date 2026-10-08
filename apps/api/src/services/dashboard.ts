import { q, q1 } from "../db/index.js";
import type { DashboardStats, TopologyGraph } from "@arvoo/shared";

export async function dashboardStats(): Promise<DashboardStats> {
  const nodes = await q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM nodes GROUP BY status`);
  const byStatus = (s: string) => nodes.find((n) => n.status === s)?.c ?? 0;
  const nodeTotal = nodes.reduce((a, n) => a + n.c, 0);

  const inbounds = await q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM inbounds GROUP BY status`);
  const clients = await q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM clients GROUP BY status`);
  const tunnels = await q<{ status: string; c: number }>(`SELECT status, COUNT(*) AS c FROM tunnels GROUP BY status`);
  const connected = (await q1<{ c: number }>(`SELECT COUNT(*) AS c FROM client_sessions WHERE active = 1`))?.c ?? 0;

  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const traffic24h = (await q1<{ s: number | null }>(
    `SELECT SUM(billed_bytes) AS s FROM client_usage_samples WHERE at >= ?`,
    since24h,
  ))?.s ?? null;

  return {
    nodes: {
      total: nodeTotal,
      online: byStatus("online"),
      offline: byStatus("offline"),
      pending: byStatus("pending"),
      degraded: byStatus("degraded"),
    },
    inbounds: {
      total: inbounds.reduce((a, n) => a + n.c, 0),
      active: inbounds.find((n) => n.status === "active")?.c ?? 0,
    },
    clients: {
      total: clients.reduce((a, n) => a + n.c, 0),
      active: clients.find((n) => n.status === "active")?.c ?? 0,
      connected,
    },
    tunnels: {
      total: tunnels.reduce((a, n) => a + n.c, 0),
      up: tunnels.find((n) => n.status === "up")?.c ?? 0,
      degraded: tunnels.find((n) => n.status === "degraded")?.c ?? 0,
      down: tunnels.find((n) => n.status === "down" || n.status === "error")?.c ?? 0,
    },
    traffic: { last24hBilledBytes: traffic24h },
  };
}

export async function trafficSeriesLast24h(): Promise<Array<{ at: string; billedBytes: number }>> {
  // `at` is ISO-8601 UTC text; truncate to the hour with a plain string slice
  // (equivalent to SQLite strftime, index-friendly, no cast needed).
  return q<{ at: string; billedBytes: number }>(
    `SELECT SUBSTR(at, 1, 13) || ':00:00.000Z' AS at, SUM(billed_bytes) AS "billedBytes"
     FROM client_usage_samples WHERE at >= ? GROUP BY at ORDER BY at ASC`,
    new Date(Date.now() - 24 * 3600_000).toISOString(),
  ) as Promise<Array<{ at: string; billedBytes: number }>>;
}

export async function topology(): Promise<TopologyGraph> {
  const nodes = await q<Record<string, unknown>>(`SELECT * FROM nodes ORDER BY is_self DESC, name ASC`);
  const tunnels = await q<Record<string, unknown>>(`SELECT * FROM tunnels`);
  const inbounds = await q<Record<string, unknown>>(`SELECT * FROM inbounds`);

  const openvpnPerNode = new Map<string, number>();
  for (const row of await q<{ node_id: string; c: number }>(
    `SELECT n.id AS node_id, COUNT(s.id) AS c
     FROM nodes n
     LEFT JOIN client_sessions s ON s.node_id = n.id AND s.active = 1
     GROUP BY n.id`,
  )) {
    openvpnPerNode.set(row.node_id, row.c ?? 0);
  }

  return {
    nodes: nodes.map((n) => ({
      id: n.id as string,
      name: n.name as string,
      role: n.role as TopologyGraph["nodes"][number]["role"],
      regionClass: n.region_class as TopologyGraph["nodes"][number]["regionClass"],
      status: n.status as TopologyGraph["nodes"][number]["status"],
      isSelf: Boolean(n.is_self),
      openvpnClients: openvpnPerNode.get(n.id as string) ?? 0,
    })),
    links: tunnels.map((t) => ({
      id: t.id as string,
      kind: "tunnel" as const,
      sourceNodeId: t.source_node_id as string,
      destNodeId: t.dest_node_id as string,
      status: t.status as TopologyGraph["links"][number]["status"],
      latencyMs: t.latency_ms as number | null,
      name: t.name as string,
    })),
    inbounds: await Promise.all(
      inbounds.map(async (i) => ({
        id: i.id as string,
        name: i.name as string,
        nodeId: i.node_id as string,
        status: i.status as TopologyGraph["inbounds"][number]["status"],
        clientCount:
          (await q1<{ c: number }>(`SELECT COUNT(*) AS c FROM client_inbounds WHERE inbound_id = ?`, i.id as string))?.c ?? 0,
      })),
    ),
  };
}
