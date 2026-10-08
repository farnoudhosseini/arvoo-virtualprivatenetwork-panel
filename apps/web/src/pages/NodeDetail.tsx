import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid } from "recharts";
import { toast } from "sonner";
import {
  Ban, Cpu, HardDrive, MemoryStick, Network, Activity, Boxes, Server, ShieldCheck, Globe, Gauge, RefreshCw, Plug,
} from "lucide-react";
import { api } from "../lib/api";
import type { NodeRecord, NodeTelemetry } from "@arvoo/shared";
import {
  Badge, BackLink, Button, Card, CardHeader, EmptyState, ErrorState, KeyValue, LoadingState, Meter,
  PageHeader, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { StatCard, DataTable, CodeBlock } from "../components/ui/data";
import { ConfirmDialog, Tabs } from "../components/ui/overlay";
import { chart } from "../lib/charts";
import { timeAgo, formatBytes, formatDuration } from "../lib/format";

interface NodeDetailResponse {
  node: NodeRecord;
  telemetry: NodeTelemetry | null;
  telemetryAt: string | null;
  healthSamples: Array<{ id: string; at: string; cpu_usage_pct: number | null; memory_usage_pct: number | null; openvpn_clients: number | null }>;
  tunnels: Array<{ id: string; name: string; status: string; latency_ms: number | null; source_name: string; dest_name: string }>;
  inbounds: Array<{ id: string; name: string; status: string; current_version: number }>;
  operations: Array<{ id: string; type: string; status: string; created_at: string; error: string | null }>;
}

export function NodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"approve" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["node", id],
    queryFn: () => api.get<NodeDetailResponse>(`/nodes/${id}`),
    refetchInterval: 10_000,
    enabled: !!id,
  });

  if (isLoading) return <LoadingState label="Loading node…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  const { node, telemetry } = data;

  const act = async (kind: "approve" | "revoke") => {
    setBusy(true);
    try {
      await api.post(`/nodes/${id}/${kind}`);
      toast.success(kind === "approve" ? "Node approved" : "Enrollment revoked");
      void queryClient.invalidateQueries({ queryKey: ["node", id] });
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const rx = Object.values(telemetry?.trafficCounters ?? {}).reduce((a, c) => a + (c?.rx ?? 0), 0);
  const tx = Object.values(telemetry?.trafficCounters ?? {}).reduce((a, c) => a + (c?.tx ?? 0), 0);

  return (
    <div>
      <div className="mb-3">
        <BackLink label="Nodes" onClick={() => navigate("/nodes")} />
      </div>

      <PageHeader
        icon={<Server size={15} />}
        title={node.name}
        badge={<UnifiedStatus status={node.status} />}
        desc={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="capitalize">{node.role}</span>
            <span className="text-faint">·</span>
            <span>{node.regionClass === "iran" ? "Iran" : "International"}{node.country ? ` · ${node.country}` : ""}</span>
            {node.provider && (
              <>
                <span className="text-faint">·</span>
                <span>{node.provider}</span>
              </>
            )}
            {node.isSelf && <Badge tone="accent">control plane host</Badge>}
            {node.tags.map((t) => (
              <Badge key={t} tone="neutral">
                {t}
              </Badge>
            ))}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh node">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} />
            </Button>
            {node.enrollmentState === "enrolled" && (
              <Button variant="primary" size="sm" onClick={() => setConfirm("approve")}>
                <ShieldCheck size={14} /> Approve node
              </Button>
            )}
            {node.enrollmentState === "approved" && (
              <Button variant="secondary" size="sm" onClick={() => setConfirm("revoke")}>
                <Ban size={14} /> Revoke enrollment
              </Button>
            )}
          </>
        }
      />

      {node.enrollmentState === "not_enrolled" && (
        <div className="mb-4 flex items-start gap-2.5 rounded-default border border-warning/25 bg-warning-soft px-3.5 py-3 text-xs leading-relaxed">
          <Plug size={15} className="mt-0.5 shrink-0 text-warning" />
          <span className="text-muted">
            <span className="font-medium text-warning">Agent not enrolled yet.</span> Run the agent on this server with the enrollment token that
            was issued when the node was created, then approve it here. The control plane never executes commands on this machine until the agent
            is approved.
          </span>
        </div>
      )}
      {node.enrollmentState === "enrolled" && (
        <div className="mb-4 flex items-start gap-2.5 rounded-default border border-info/25 bg-info-soft px-3.5 py-3 text-xs leading-relaxed">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-info" />
          <span className="text-muted">
            The agent enrolled successfully and is waiting for approval. Verify the reported platform
            (<span className="mono text-text/90">{node.agentPlatform ?? "unknown"}</span>) before approving.
          </span>
        </div>
      )}

      {/* Resource rail — fixed columns so six metrics never leave a ragged row */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="CPU"
          value={telemetry?.cpuUsagePct != null ? `${telemetry.cpuUsagePct.toFixed(0)}%` : "—"}
          tone={toneFor(telemetry?.cpuUsagePct)}
          icon={<Cpu size={14} />}
          sub={
            telemetry
              ? `${telemetry.cpuCores} cores · load ${telemetry.loadAvg.map((l) => l.toFixed(2)).join(" / ")}`
              : "waiting for heartbeat"
          }
        />
        <StatCard
          label="Memory"
          value={telemetry?.memoryUsagePct != null ? `${telemetry.memoryUsagePct.toFixed(0)}%` : "—"}
          tone={toneFor(telemetry?.memoryUsagePct)}
          icon={<MemoryStick size={14} />}
          sub={telemetry ? `${formatBytes(telemetry.memoryUsedBytes)} of ${formatBytes(telemetry.memoryTotalBytes)}` : undefined}
        />
        <StatCard
          label="Disk"
          value={telemetry?.diskUsagePct != null ? `${telemetry.diskUsagePct.toFixed(0)}%` : "—"}
          tone={toneFor(telemetry?.diskUsagePct)}
          icon={<HardDrive size={14} />}
          sub={telemetry?.diskUsedBytes != null ? `${formatBytes(telemetry.diskUsedBytes)} used of ${formatBytes(telemetry.diskTotalBytes)}` : "not reported"}
        />
        <StatCard
          label="Uptime"
          value={telemetry ? formatDuration(telemetry.uptimeSec) : "—"}
          icon={<Gauge size={14} />}
          sub={telemetry ? `${telemetry.os}${telemetry.kernel ? ` · ${telemetry.kernel}` : ""}` : undefined}
        />
        <StatCard
          label="OpenVPN"
          value={telemetry?.openvpnVersion ?? "not detected"}
          icon={<Globe size={14} />}
          tone={telemetry?.openvpnVersion ? "default" : "warning"}
          sub="version reported by the agent"
        />
        <StatCard
          label="Last heartbeat"
          value={timeAgo(node.lastHeartbeatAt)}
          tone={node.status === "online" ? "success" : "default"}
          icon={<Activity size={14} />}
          sub={node.agentVersion ? `agent v${node.agentVersion}` : "agent version unknown"}
        />
      </div>

      <Tabs
        variant="segmented"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Identity" desc="Registration metadata held by the control plane" icon={<Server size={14} />} />
                  <div className="px-4 py-2">
                    <KeyValue label="Node ID" value={node.id} mono />
                    <KeyValue label="Hostname" value={node.hostname ?? "—"} mono />
                    <KeyValue label="Management address" value={node.address ?? "—"} mono />
                    <KeyValue label="Role" value={<span className="capitalize">{node.role}</span>} />
                    <KeyValue label="Region class" value={node.regionClass === "iran" ? "Iran" : "International"} />
                    <KeyValue label="Country" value={node.country ?? "—"} />
                    <KeyValue label="Provider" value={node.provider ?? "—"} />
                    <KeyValue label="Agent state" value={<UnifiedStatus status={node.enrollmentState} />} />
                    <KeyValue label="Agent version" value={node.agentVersion ?? "—"} mono />
                    <KeyValue label="Agent platform" value={node.agentPlatform ?? "—"} mono />
                    <KeyValue label="Registered" value={timeAgo(node.createdAt)} />
                    <KeyValue label="Last heartbeat" value={timeAgo(node.lastHeartbeatAt)} />
                    {node.description && <KeyValue label="Description" value={node.description} />}
                  </div>
                </Card>

                <div className="space-y-4">
                  <Card>
                    <CardHeader title="Resources" desc="Live utilisation reported by the agent" icon={<Gauge size={14} />} />
                    <div className="space-y-3.5 px-4 py-3.5">
                      <Meter pct={telemetry?.cpuUsagePct ?? null} label="CPU" />
                      <Meter pct={telemetry?.memoryUsagePct ?? null} label="Memory" />
                      <Meter pct={telemetry?.diskUsagePct ?? null} label="Disk" />
                      {!telemetry && <p className="text-2xs text-faint">Utilisation appears after the first successful heartbeat.</p>}
                    </div>
                  </Card>
                  <Card>
                    <CardHeader title="Traffic counters" desc="Cumulative bytes per interface, as read from the OS" icon={<Network size={14} />} />
                    <div className="px-4 py-2">
                      <KeyValue label="Received (all interfaces)" value={rx > 0 ? formatBytes(rx) : "—"} mono />
                      <KeyValue label="Transmitted (all interfaces)" value={tx > 0 ? formatBytes(tx) : "—"} mono />
                    </div>
                  </Card>
                </div>
              </div>
            ),
          },
          {
            value: "health",
            label: "Health",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="CPU / memory" desc="Real samples from agent heartbeats · last 24h, one per minute" icon={<Activity size={14} />} />
                  {data.healthSamples.length < 2 ? (
                    <EmptyState
                      compact
                      icon={<Activity size={18} />}
                      title="Not enough samples yet"
                      message="Charts populate once the approved agent has reported at least two heartbeats."
                    />
                  ) : (
                    <div className="h-56 p-3">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={data.healthSamples.map((s) => ({
                            at: new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                            cpu: s.cpu_usage_pct ?? 0,
                            mem: s.memory_usage_pct ?? 0,
                          }))}
                        >
                          <CartesianGrid stroke={chart.grid} strokeDasharray="2 4" vertical={false} />
                          <XAxis dataKey="at" tick={chart.tick} tickLine={false} axisLine={{ stroke: chart.grid }} minTickGap={40} />
                          <YAxis tick={chart.tick} tickLine={false} axisLine={false} unit="%" width={40} domain={[0, 100]} />
                          <ReTooltip contentStyle={chart.tooltip} labelStyle={chart.tooltipLabel} />
                          <Line type="monotone" dataKey="cpu" stroke={chart.accent} dot={false} strokeWidth={1.75} name="CPU" />
                          <Line type="monotone" dataKey="mem" stroke={chart.info} dot={false} strokeWidth={1.75} name="Memory" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </Card>
                <Card>
                  <CardHeader title="Interfaces" desc="Reported by the agent" icon={<Network size={14} />} />
                  {!telemetry || telemetry.interfaces.length === 0 ? (
                    <EmptyState compact icon={<Network size={18} />} title="No interface data" message="Available once the agent reports a heartbeat." />
                  ) : (
                    <div className="max-h-56 divide-y divide-line/70 overflow-y-auto">
                      {telemetry.interfaces.map((i) => (
                        <div key={i.name} className="flex items-center justify-between gap-3 px-4 py-2">
                          <span className="mono text-xs text-text">{i.name}</span>
                          <span className="mono truncate text-2xs text-faint">{i.addresses.join(", ") || "no address"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            ),
          },
          {
            value: "services",
            label: "Services",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="systemd services" desc="Observed on the node" icon={<Boxes size={14} />} />
                  {!telemetry || telemetry.services.length === 0 ? (
                    <EmptyState compact icon={<Boxes size={18} />} title="No service data" message="Reported by the Linux agent via systemd." />
                  ) : (
                    <div className="divide-y divide-line/70">
                      {telemetry.services.map((s) => (
                        <div key={s.name} className="flex items-center justify-between gap-3 px-4 py-2">
                          <span className="mono text-xs text-text">{s.name}</span>
                          <UnifiedStatus status={s.status === "running" ? "online" : s.status === "stopped" ? "offline" : "unknown"} />
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
                <Card>
                  <CardHeader title="OpenVPN processes" desc="Server processes the agent can see" icon={<Globe size={14} />} />
                  {!telemetry || telemetry.openvpnProcesses.length === 0 ? (
                    <EmptyState compact icon={<Globe size={18} />} title="No OpenVPN processes" message="Deploy an inbound to this node to see processes here." />
                  ) : (
                    <div className="divide-y divide-line/70">
                      {telemetry.openvpnProcesses.map((p) => (
                        <div key={p.name} className="flex items-center justify-between gap-3 px-4 py-2">
                          <span className="mono text-xs text-text">{p.name}</span>
                          <UnifiedStatus status={p.status === "running" ? "active" : "stopped"} />
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            ),
          },
          {
            value: "links",
            label: "Tunnels & inbounds",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="GRE tunnels" desc="Point-to-point links attached to this node" icon={<Network size={14} />} />
                  {data.tunnels.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<Network size={18} />}
                      title="No tunnels attached"
                      message="Create a GRE tunnel to link this node with another."
                     
                    />
                  ) : (
                    <div className="divide-y divide-line/70">
                      {data.tunnels.map((t) => (
                        <Link key={t.id} to={`/tunnels/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-surface-2">
                          <span className="min-w-0">
                            <span className="block truncate text-xs text-text">{t.name}</span>
                            <span className="mono block text-2xs text-faint">
                              {t.source_name} ↔ {t.dest_name}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {t.latency_ms != null && <span className="mono text-2xs text-muted tnum">{t.latency_ms} ms</span>}
                            <UnifiedStatus status={t.status} />
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </Card>
                <Card>
                  <CardHeader title="Inbounds" desc="OpenVPN listeners deployed on this node" icon={<Globe size={14} />} />
                  {data.inbounds.length === 0 ? (
                    <EmptyState compact icon={<Globe size={18} />} title="No inbounds on this node" message="Create an inbound and deploy it here." />
                  ) : (
                    <div className="divide-y divide-line/70">
                      {data.inbounds.map((i) => (
                        <Link key={i.id} to={`/inbounds/${i.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-surface-2">
                          <span className="min-w-0">
                            <span className="mono block truncate text-xs text-text">{i.name}</span>
                            <span className="text-2xs text-faint tnum">version {i.current_version}</span>
                          </span>
                          <UnifiedStatus status={i.status} />
                        </Link>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            ),
          },
          {
            value: "operations",
            label: "Operations",
            count: data.operations.length,
            content: (
              <DataTable
                columns={[
                  { key: "type", header: "Operation", primary: true, render: (o) => <span className="mono text-xs">{o.type}</span> },
                  { key: "status", header: "Status", render: (o) => <UnifiedStatus status={o.status} /> },
                  { key: "created", header: "Created", align: "right", sortValue: (o) => o.created_at, render: (o) => <span className="text-2xs text-muted tnum">{timeAgo(o.created_at)}</span> },
                  { key: "error", header: "Error", hideBelow: "md", render: (o) => <span className="text-2xs text-danger">{o.error ?? ""}</span> },
                ]}
                rows={data.operations}
                rowKey={(o) => o.id}
                initialSort={{ key: "created", dir: "desc" }}
                empty={
                  <EmptyState
                    compact
                    icon={<Boxes size={18} />}
                    title="No operations yet"
                    message="Deployments, restarts and diagnostics on this node appear here."
                  />
                }
              />
            ),
          },
        ]}
      />

      <Card className="mt-4">
        <CardHeader title="Enrollment command" desc="Run this on the node to (re-)enroll the agent after revoking" icon={<ShieldCheck size={14} />} />
        <div className="p-4">
          <CodeBlock
            filename="enroll.sh"
            maxHeight="120px"
            code={`ARVOO_CONTROL_PLANE_URL=${window.location.origin.replace(/:\d+$/, ":4001")} npx tsx src/index.ts enroll <TOKEN>`}
          />
          <p className="mt-2 text-2xs text-faint">
            Tokens are issued when a node is created and are single-use. Revoking enrollment invalidates the node secret immediately.
          </p>
        </div>
      </Card>

      <ConfirmDialog
        open={confirm === "approve"}
        onOpenChange={() => setConfirm(null)}
        title={`Approve node “${node.name}”?`}
        message="The agent will start receiving operations: OpenVPN deployments, GRE tunnels and firewall changes. Approve only if you trust the machine reporting this identity."
        confirmLabel="Approve node"
        onConfirm={() => act("approve")}
        loading={busy}
      />
      <ConfirmDialog
        open={confirm === "revoke"}
        onOpenChange={() => setConfirm(null)}
        title={`Revoke enrollment for “${node.name}”?`}
        message="The node secret becomes invalid immediately: heartbeats and operations stop. The agent must re-enroll with a fresh token and be approved again."
        confirmLabel="Revoke"
        danger
        onConfirm={() => act("revoke")}
        loading={busy}
      />
    </div>
  );
}

function toneFor(pct: number | null | undefined): "default" | "success" | "warning" | "danger" {
  if (pct == null) return "default";
  if (pct > 90) return "danger";
  if (pct > 75) return "warning";
  return "default";
}
