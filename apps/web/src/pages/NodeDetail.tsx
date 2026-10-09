import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid } from "recharts";
import { toast } from "sonner";
import {
  Ban, Cpu, HardDrive, MemoryStick, Network, Activity, Boxes, Server, ShieldCheck, Globe, Gauge, RefreshCw, Plug,
  KeyRound, ShieldAlert, Trash2, Eye, TriangleAlert, ArrowUpRight,
} from "lucide-react";
import { api } from "../lib/api";
import type { NodeDependencies, NodeRecord, NodeTelemetry, NodeTokenSecret, NodeTokenStatus } from "@arvoo/shared";
import {
  Badge, BackLink, Button, Card, CardHeader, CopyField, EmptyState, ErrorState, KeyValue, LoadingState, Meter,
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
  const [lifecycle, setLifecycle] = useState<"rotate" | "revoke-token" | "decommission" | "delete" | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [revealed, setRevealed] = useState<NodeTokenSecret | null>(null);
  const [working, setWorking] = useState<"reveal" | "rotate" | "revoke-token" | "decommission" | "delete" | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["node", id],
    queryFn: () => api.get<NodeDetailResponse>(`/nodes/${id}`),
    refetchInterval: 10_000,
    enabled: !!id,
  });

  // Credential metadata and dependencies are separate endpoints: the secret is
  // never part of the node record, so it is only fetched when it is asked for.
  const tokenQuery = useQuery({
    queryKey: ["node-token", id],
    queryFn: () => api.get<{ token: NodeTokenStatus }>(`/nodes/${id}/token`),
    enabled: !!id,
  });
  const depsQuery = useQuery({
    queryKey: ["node-deps", id],
    queryFn: () => api.get<{ dependencies: NodeDependencies }>(`/nodes/${id}/dependencies`),
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

  const token = tokenQuery.data?.token ?? null;
  const deps = depsQuery.data?.dependencies ?? null;

  const refreshLifecycle = () => {
    void queryClient.invalidateQueries({ queryKey: ["node", id] });
    void queryClient.invalidateQueries({ queryKey: ["node-token", id] });
    void queryClient.invalidateQueries({ queryKey: ["node-deps", id] });
    void queryClient.invalidateQueries({ queryKey: ["nodes"] });
  };

  const revealToken = async () => {
    setWorking("reveal");
    try {
      const res = await api.post<{ token: NodeTokenSecret }>(`/nodes/${id}/token/reveal`);
      setRevealed(res.token);
      toast.success("Active credential revealed");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setWorking(null);
    }
  };

  // A rotation returns the new credential in the same response, so it is shown
  // at once - the previous one stops authenticating immediately.
  const rotateToken = async () => {
    setWorking("rotate");
    try {
      const res = await api.post<{ token: NodeTokenSecret }>(`/nodes/${id}/token/rotate`);
      setRevealed(res.token);
      toast.success("Credential rotated - install the new value on the node now");
      refreshLifecycle();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setWorking(null);
      setLifecycle(null);
    }
  };

  const revokeToken = async () => {
    setWorking("revoke-token");
    try {
      await api.post(`/nodes/${id}/token/revoke`);
      setRevealed(null);
      toast.success("Credential revoked - the agent can no longer authenticate");
      refreshLifecycle();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setWorking(null);
      setLifecycle(null);
    }
  };

  const decommission = async () => {
    setWorking("decommission");
    try {
      const res = await api.post<{ decommission: { decommissionState: string; detail: string; operationId: string | null } }>(
        `/nodes/${id}/decommission`,
      );
      const state = res.decommission.decommissionState;
      if (state === "complete") toast.success("Decommissioned: the credential is revoked and nothing was left on the host");
      else if (state === "requested") toast.success("Credential revoked. Host cleanup is queued - wait for it before deleting");
      else toast.warning(`Credential revoked. Host cleanup is still pending: ${res.decommission.detail}`);
      refreshLifecycle();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setWorking(null);
      setLifecycle(null);
    }
  };

  const deleteNode = async () => {
    setWorking("delete");
    try {
      const res = await api.delete<{ deleted: { forced: boolean; pendingCleanup: string | null; cancelledOperations: number } }>(
        `/nodes/${id}${forceDelete ? "?force=true" : ""}`,
      );
      toast.success(
        res.deleted.pendingCleanup ? "Node deleted - pending host cleanup was recorded in the audit log" : "Node deleted",
      );
      void queryClient.invalidateQueries({ queryKey: ["nodes"] });
      navigate("/nodes");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setWorking(null);
      setLifecycle(null);
      setForceDelete(false);
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

      {/* Decommissioning is a stored state, not a guess: the host may still hold
          resources the panel created, and that is what this banner says. */}
      {node.decommissionState === "requested" && (
        <div className="mb-4 flex items-start gap-2.5 rounded-default border border-info/25 bg-info-soft px-3.5 py-3 text-xs leading-relaxed">
          <RefreshCw size={15} className="mt-0.5 shrink-0 text-info" />
          <span className="text-muted">
            <span className="font-medium text-info">Decommissioning in progress.</span> The credential is revoked and host cleanup is queued. The
            node's own report decides when the cleanup is complete.
          </span>
        </div>
      )}
      {(node.decommissionState === "partial" || (node.decommissionState === "complete" && node.decommissionDetail)) && (
        <div
          className={cx(
            "mb-4 flex items-start gap-2.5 rounded-default border px-3.5 py-3 text-xs leading-relaxed",
            node.decommissionState === "partial" ? "border-warning/25 bg-warning-soft" : "border-line/70 bg-surface-2",
          )}
        >
          {node.decommissionState === "partial" ? (
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
          ) : (
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
          )}
          <span className="text-muted">
            <span className={cx("font-medium", node.decommissionState === "partial" ? "text-warning" : "text-success")}>
              {node.decommissionState === "partial" ? "Host cleanup is still pending." : "Host cleanup complete."}
            </span>{" "}
            {node.decommissionDetail}
            {node.decommissionState === "partial" && " Re-run decommission when the node is reachable, or delete the record with force (the pending cleanup stays in the audit log)."}
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
            value: "access",
            label: "Access & lifecycle",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader
                    title="Agent credential"
                    desc="What this node authenticates with - shown on purpose, never logged"
                    icon={<KeyRound size={14} />}
                  />
                  <div className="px-4 py-2">
                    <KeyValue
                      label="Status"
                      value={
                        token ? (
                          <Badge tone={token.status === "active" ? "success" : token.status === "revoked" ? "danger" : "neutral"}>
                            {token.status === "active" ? "active" : token.status === "revoked" ? "revoked" : "no credential yet"}
                          </Badge>
                        ) : (
                          "—"
                        )
                      }
                    />
                    <KeyValue label="Issued" value={token ? timeAgo(token.issuedAt) : "—"} />
                    <KeyValue label="Rotated" value={token?.rotatedAt ? timeAgo(token.rotatedAt) : "never"} />
                    <KeyValue label="Revoked" value={token?.revokedAt ? timeAgo(token.revokedAt) : "—"} />
                    <KeyValue label="Last heartbeat" value={timeAgo(node.lastHeartbeatAt)} />
                  </div>
                  {token && !token.revealable && token.reason && (
                    <p className="mx-4 mb-3 rounded-default border border-warning/25 bg-warning-soft px-3 py-2 text-2xs leading-relaxed text-warning">
                      {token.reason}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 border-t border-line/70 px-4 py-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!token?.revealable}
                      loading={working === "reveal"}
                      onClick={revealToken}
                    >
                      <Eye size={13} /> Reveal active credential
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setLifecycle("rotate")} disabled={node.enrollmentState === "not_enrolled"}>
                      <RefreshCw size={13} /> Rotate
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setLifecycle("revoke-token")} disabled={!token || token.status !== "active"}>
                      <Ban size={13} /> Revoke credential
                    </Button>
                  </div>
                  {revealed && (
                    <div className="border-t border-line/70 p-4">
                      <div className="mb-2 flex items-center gap-1.5 text-2xs text-warning">
                        <ShieldAlert size={13} /> The active credential. It is returned by this request only - not in any list, log or export.
                      </div>
                      <CopyField label="Active credential" value={revealed.secret} />
                      <p className="mt-3 text-2xs text-faint">Install it on the node (rewrites the agent identity and restarts the service):</p>
                      <CodeBlock filename="apply-credential.sh" maxHeight="150px" code={revealed.applyCommand} />
                    </div>
                  )}
                </Card>

                <Card>
                  <CardHeader
                    title="Host cleanup & deletion"
                    desc="Everything Arvoo owns on this machine, and what stops deletion"
                    icon={<Trash2 size={14} />}
                  />
                  <div className="px-4 py-2">
                    <KeyValue
                      label="Cleanup state"
                      value={
                        <Badge
                          tone={
                            node.decommissionState === "complete"
                              ? "success"
                              : node.decommissionState === "partial"
                                ? "warning"
                                : node.decommissionState === "requested"
                                  ? "info"
                                  : "neutral"
                          }
                        >
                          {node.decommissionState}
                        </Badge>
                      }
                    />
                    <KeyValue
                      label="Blocking tunnels"
                      value={
                        deps && deps.blocking.tunnels.length > 0 ? (
                          <span className="flex flex-wrap gap-1.5">
                            {deps.blocking.tunnels.map((t) => (
                              <Link key={t.id} to={`/tunnels/${t.id}`} className="mono text-2xs text-accent hover:underline">
                                {t.name} → {t.otherNodeName}
                              </Link>
                            ))}
                          </span>
                        ) : (
                          "none"
                        )
                      }
                    />
                    <KeyValue
                      label="Blocking inbounds"
                      value={
                        deps && deps.blocking.inbounds.length > 0 ? (
                          <span className="flex flex-wrap gap-1.5">
                            {deps.blocking.inbounds.map((i) => (
                              <Link key={i.id} to={`/inbounds/${i.id}`} className="mono text-2xs text-accent hover:underline">
                                {i.name}
                              </Link>
                            ))}
                          </span>
                        ) : (
                          "none"
                        )
                      }
                    />
                    <KeyValue
                      label="Arvoo-managed here"
                      value={
                        deps
                          ? `${deps.managed.interfaces.length} interface(s), ${deps.managed.inbounds.length} inbound(s), ${deps.managed.routes} route(s)`
                          : "—"
                      }
                      mono
                    />
                    <KeyValue
                      label="Memberships & sessions"
                      value={deps ? `${deps.managed.lbMembers} load-balancer member(s), ${deps.managed.activeSessions} live session(s)` : "—"}
                    />
                    <KeyValue
                      label="In-flight operations"
                      value={
                        deps && deps.inFlightOperations.length > 0 ? (
                          <span className="flex flex-wrap gap-1.5">
                            {deps.inFlightOperations.map((o) => (
                              <Badge key={o.id} tone="info" mono>
                                {o.type} · {o.status}
                              </Badge>
                            ))}
                          </span>
                        ) : (
                          "none"
                        )
                      }
                    />
                  </div>
                  <p className="mx-4 mb-3 rounded-default border border-line/70 bg-surface-2 px-3 py-2 text-2xs leading-relaxed text-muted">
                    {deps?.summary ?? "Loading dependency summary…"}
                  </p>
                  <div className="flex flex-wrap gap-2 border-t border-line/70 px-4 py-3">
                    <Button size="sm" variant="secondary" onClick={() => setLifecycle("decommission")} loading={working === "decommission"}>
                      <ArrowUpRight size={13} /> Decommission node
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setLifecycle("delete")}
                      disabled={deps ? !deps.deletable : false}
                    >
                      <Trash2 size={13} /> Delete node
                    </Button>
                  </div>
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

      <ConfirmDialog
        open={lifecycle === "rotate"}
        onOpenChange={() => setLifecycle(null)}
        title={`Rotate the credential for “${node.name}”?`}
        message="A new credential is generated and returned immediately; the current one stops authenticating at once, so the running agent must be updated with the new value in the same step. The new value is shown here and can be revealed again later."
        confirmLabel="Rotate credential"
        onConfirm={rotateToken}
        loading={working === "rotate"}
      />
      <ConfirmDialog
        open={lifecycle === "revoke-token"}
        onOpenChange={() => setLifecycle(null)}
        title={`Revoke the credential for “${node.name}”?`}
        message="Heartbeats and operations stop immediately and the agent cannot authenticate again until a new credential is issued. The node record and its history are kept."
        confirmLabel="Revoke credential"
        danger
        onConfirm={revokeToken}
        loading={working === "revoke-token"}
      />
      <ConfirmDialog
        open={lifecycle === "decommission"}
        onOpenChange={() => setLifecycle(null)}
        title={`Decommission “${node.name}”?`}
        message={
          deps
            ? `${deps.summary} The credential is revoked and the node is asked to remove exactly what the panel created there (${deps.managed.interfaces.length} interface(s), ${deps.managed.inbounds.length} inbound(s)).`
            : "The credential is revoked and host cleanup is queued."
        }
        confirmLabel="Decommission"
        onConfirm={decommission}
        loading={working === "decommission"}
      />
      <ConfirmDialog
        open={lifecycle === "delete"}
        onOpenChange={(open) => {
          if (!open) {
            setLifecycle(null);
            setForceDelete(false);
          }
        }}
        title={`Delete “${node.name}”?`}
        message={
          <span className="space-y-2">
            <span className="block">
              Deleting removes the node, its credential, telemetry, routes and memberships. Operation history is kept. It is refused while tunnels or inbounds
              still name this node.
              {node.decommissionState === "partial" && " Host cleanup is still pending for this machine."}
            </span>
            {node.decommissionState === "partial" && (
              <label className="flex items-start gap-2 text-2xs text-warning">
                <input type="checkbox" className="mt-0.5" checked={forceDelete} onChange={(e) => setForceDelete(e.target.checked)} />
                <span>Force delete the record anyway. The pending host cleanup is written to the audit log so it is not forgotten.</span>
              </label>
            )}
          </span>
        }
        confirmLabel={forceDelete ? "Force delete" : "Delete node"}
        danger
        onConfirm={deleteNode}
        loading={working === "delete"}
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
