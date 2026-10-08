import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid } from "recharts";
import {
  Activity, ArrowUpRight, BellRing, Boxes, Gauge, Globe, Network, Plus, RefreshCw, Server, ShieldCheck, Users, Zap,
} from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, timeAgo, formatDateTime } from "../lib/format";
import {
  Badge, Button, Card, CardHeader, ErrorState, EmptyState, LoadingState, SectionLabel, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { StatCard } from "../components/ui/data";
import { chart } from "../lib/charts";
import type { DashboardStats, NodeRecord } from "@arvoo/shared";

interface DashboardResponse {
  stats: DashboardStats;
  trafficSeries: Array<{ at: string; billedBytes: number }>;
  recentActivity: Array<{ id: string; at: string; actor_name: string | null; action: string; summary: string }>;
  alerts: Array<{ id: string; severity: string; title: string; message: string; created_at: string }>;
}

const severityTone = (s: string): "danger" | "warning" | "info" =>
  s === "critical" ? "danger" : s === "warning" ? "warning" : "info";

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardResponse>("/dashboard"),
    refetchInterval: 15_000,
  });

  const { data: nodesData } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: NodeRecord[] }>("/nodes"),
  });

  if (isLoading) return <DashboardSkeleton />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  const s = data!.stats;
  const hasNodes = s.nodes.total > 0;
  const allOnline = hasNodes && s.nodes.online === s.nodes.total;
  const tunnelsHealthy = s.tunnels.total === 0 || s.tunnels.down === 0;
  const criticalAlerts = data!.alerts.filter((a) => a.severity === "critical").length;
  const nodes = nodesData?.nodes ?? [];

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ header */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[19px] font-semibold leading-tight tracking-tight text-text">Control plane</h1>
            <Badge tone={criticalAlerts > 0 ? "danger" : allOnline ? "success" : hasNodes ? "warning" : "neutral"}>
              {criticalAlerts > 0
                ? `${criticalAlerts} critical`
                : allOnline
                  ? "all systems nominal"
                  : hasNodes
                    ? "degraded"
                    : "no infrastructure yet"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted">
            Live state of the Arvoo VPN fabric — every number below comes from real agent telemetry and audited operations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-3xs text-faint sm:block">
            updated {data ? timeAgo(new Date().toISOString()) : "—"}
          </span>
          <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh dashboard">
            <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate("/nodes?new=1")}>
            <Plus size={14} /> Add node
          </Button>
        </div>
      </header>

      {/* ------------------------------------------------------- metric rail */}
      <section>
        <SectionLabel
          actions={
            <Link to="/topology" className="inline-flex items-center gap-1 text-2xs text-muted transition-colors hover:text-text">
              Network topology <ArrowUpRight size={11} />
            </Link>
          }
        >
          Infrastructure
        </SectionLabel>
        <div className="grid-cards">
          <StatCard
            label="Nodes"
            value={s.nodes.total}
            tone={allOnline ? "success" : hasNodes ? "warning" : "default"}
            icon={<Server size={14} />}
            sub={
              <span className="flex items-center gap-1.5">
                <span className="text-success">{s.nodes.online} online</span>
                <span className="text-faint">·</span>
                <span className={s.nodes.offline > 0 ? "text-danger" : undefined}>{s.nodes.offline} offline</span>
                {s.nodes.pending > 0 && (
                  <>
                    <span className="text-faint">·</span>
                    <span className="text-warning">{s.nodes.pending} pending</span>
                  </>
                )}
              </span>
            }
            onClick={() => navigate("/nodes")}
          />
          <StatCard
            label="GRE tunnels"
            value={s.tunnels.total}
            tone={tunnelsHealthy ? "default" : "danger"}
            icon={<Network size={14} />}
            sub={`${s.tunnels.up} up · ${s.tunnels.degraded} degraded · ${s.tunnels.down} down`}
            onClick={() => navigate("/tunnels")}
          />
          <StatCard
            label="Inbounds"
            value={s.inbounds.total}
            tone={s.inbounds.active > 0 ? "success" : "default"}
            icon={<Globe size={14} />}
            sub={`${s.inbounds.active} active listeners`}
            onClick={() => navigate("/inbounds")}
          />
        </div>
      </section>

      <section>
        <SectionLabel>VPN service</SectionLabel>
        <div className="grid-cards">
          <StatCard
            label="Clients"
            value={s.clients.total}
            icon={<Users size={14} />}
            sub={`${s.clients.active} active · ${s.clients.total - s.clients.active} inactive`}
            onClick={() => navigate("/clients")}
          />
          <StatCard
            label="Connected now"
            value={s.clients.connected}
            tone={s.clients.connected > 0 ? "success" : "default"}
            icon={<Zap size={14} />}
            sub="live sessions reported by nodes"
          />
          <StatCard
            label="Traffic · 24h"
            value={s.traffic.last24hBilledBytes == null ? "—" : formatBytes(s.traffic.last24hBilledBytes)}
            icon={<Gauge size={14} />}
            sub="billed (quota multipliers applied)"
          />
          <StatCard
            label="Open alerts"
            value={data!.alerts.length}
            tone={criticalAlerts > 0 ? "danger" : data!.alerts.length > 0 ? "warning" : "success"}
            icon={<BellRing size={14} />}
            sub={criticalAlerts > 0 ? `${criticalAlerts} critical` : "no critical conditions"}
            onClick={() => navigate("/alerts")}
          />
        </div>
      </section>

      {/* -------------------------------------------------- chart + alerts */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Client traffic"
            desc="Hourly billed traffic from real usage accounting · last 24 hours"
            icon={<Activity size={14} />}
            actions={
              data!.trafficSeries.some((d) => d.billedBytes > 0) ? (
                <Badge tone="neutral" mono>
                  {formatBytes(data!.trafficSeries.reduce((a, d) => a + d.billedBytes, 0))} total
                </Badge>
              ) : undefined
            }
          />
          {data!.trafficSeries.length === 0 || data!.trafficSeries.every((d) => d.billedBytes === 0) ? (
            <EmptyState
              compact
              icon={<Activity size={18} />}
              title="No traffic recorded yet"
              message="Traffic appears here as soon as real client sessions report usage through deployed nodes."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate("/inbounds")}>
                  Configure an inbound
                </Button>
              }
            />
          ) : (
            <div className="h-64 p-3">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data!.trafficSeries.map((d) => ({ at: formatDateTime(d.at), mb: d.billedBytes / 1024 / 1024 }))}>
                  <defs>
                    <linearGradient id="trafficFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={chart.grid} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="at" tick={chart.tick} tickLine={false} axisLine={{ stroke: chart.grid }} minTickGap={48} />
                  <YAxis tick={chart.tick} tickLine={false} axisLine={false} width={58} tickFormatter={(v: number) => `${v.toFixed(1)} MB`} />
                  <ReTooltip
                    contentStyle={chart.tooltip}
                    labelStyle={chart.tooltipLabel}
                    formatter={(v: number) => [`${v.toFixed(2)} MB`, "Billed"]}
                  />
                  <Area type="monotone" dataKey="mb" stroke={chart.accent} strokeWidth={1.75} fill="url(#trafficFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="flex flex-col">
          <CardHeader
            title="Active alerts"
            desc="Conditions requiring operator attention"
            icon={<BellRing size={14} />}
            actions={
              <Link to="/alerts" className="text-2xs text-muted transition-colors hover:text-text">
                View all
              </Link>
            }
          />
          {data!.alerts.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck size={18} />}
              title="No active alerts"
              message="Infrastructure is quiet. Alerts appear when nodes, tunnels or services misbehave."
              compact
            />
          ) : (
            <div className="max-h-[19rem] divide-y divide-line/70 overflow-y-auto">
              {data!.alerts.slice(0, 8).map((a) => (
                <Link key={a.id} to="/alerts" className="block px-4 py-2.5 transition-colors hover:bg-surface-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{a.title}</span>
                    <span className="shrink-0 text-3xs text-faint">{timeAgo(a.created_at)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-2xs leading-snug text-muted">{a.message}</p>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ------------------------------------------------- nodes + activity */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Node health"
            desc="Latest heartbeat and reachability per server"
            icon={<Server size={14} />}
            actions={
              <Link to="/nodes" className="text-2xs text-muted transition-colors hover:text-text">
                Manage nodes
              </Link>
            }
          />
          {nodes.length === 0 ? (
            <EmptyState
              icon={<Server size={18} />}
              title="No nodes yet"
              message="Connect your first Arvoo node to start building the VPN fabric. The control plane itself can also be registered as a node."
              action={
                <Button variant="primary" size="sm" onClick={() => navigate("/nodes?new=1")}>
                  <Plus size={14} /> Add node
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-line/70">
              {nodes.map((n) => (
                <Link
                  key={n.id}
                  to={`/nodes/${n.id}`}
                  className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
                >
                  <span
                    className={cx(
                      "flex size-7 shrink-0 items-center justify-center rounded-[7px] border text-2xs font-semibold uppercase",
                      n.status === "online"
                        ? "border-success/25 bg-success-soft text-success"
                        : n.status === "offline"
                          ? "border-danger/25 bg-danger-soft text-danger"
                          : "border-line bg-surface-3 text-muted",
                    )}
                    aria-hidden
                  >
                    {n.name.slice(0, 2)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-text">{n.name}</span>
                      <span className="hidden text-3xs uppercase tracking-wider text-faint sm:inline">{n.role}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-3xs text-faint">
                      <span className="mono">{n.address ?? "no address"}</span>
                      <span>·</span>
                      <span>{n.regionClass === "iran" ? "Iran" : "International"}{n.country ? ` · ${n.country}` : ""}</span>
                    </div>
                  </div>
                  <div className="hidden shrink-0 text-right text-3xs text-faint md:block">
                    <div>last seen</div>
                    <div className="tnum text-muted">{timeAgo(n.lastHeartbeatAt)}</div>
                  </div>
                  <UnifiedStatus status={n.status} />
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent activity"
            desc="Audited operator and system actions"
            icon={<Boxes size={14} />}
            actions={
              <Link to="/activity" className="text-2xs text-muted transition-colors hover:text-text">
                All
              </Link>
            }
          />
          {data!.recentActivity.length === 0 ? (
            <EmptyState icon={<Boxes size={18} />} title="No activity yet" compact />
          ) : (
            <ol className="relative max-h-[19rem] overflow-y-auto px-4 py-3">
              <span className="absolute bottom-3 left-[22px] top-4 w-px bg-line" aria-hidden />
              {data!.recentActivity.slice(0, 10).map((e) => (
                <li key={e.id} className="relative flex gap-3 pb-3 last:pb-0">
                  <span className="z-10 mt-1 size-1.5 shrink-0 rounded-full bg-line-strong ring-4 ring-surface" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-2xs leading-snug text-text">{e.summary}</p>
                    <p className="mt-0.5 text-3xs text-faint">
                      {e.actor_name ?? "system"} · {timeAgo(e.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

/** First paint matches the final layout so the dashboard never jumps. */
function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="shimmer h-5 w-44 rounded" />
          <div className="shimmer h-3 w-80 rounded" />
        </div>
        <div className="shimmer h-8 w-40 rounded-default" />
      </div>
      {[3, 4].map((count, row) => (
        <div key={row} className="grid-cards">
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="panel space-y-3 px-3.5 py-3">
              <div className="shimmer h-2.5 w-16 rounded" />
              <div className="shimmer h-5 w-12 rounded" />
              <div className="shimmer h-2.5 w-28 rounded" />
            </div>
          ))}
        </div>
      ))}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="panel xl:col-span-2">
          <div className="border-b border-line px-4 py-3">
            <div className="shimmer h-3 w-32 rounded" />
          </div>
          <div className="shimmer m-3 h-64 rounded" />
        </div>
        <div className="panel">
          <div className="border-b border-line px-4 py-3">
            <div className="shimmer h-3 w-28 rounded" />
          </div>
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="shimmer h-3 w-full rounded" />
                <div className="shimmer h-2.5 w-3/4 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
