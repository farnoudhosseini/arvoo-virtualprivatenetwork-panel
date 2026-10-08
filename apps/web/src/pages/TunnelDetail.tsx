import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Gauge, Network, RefreshCw, Rocket, Route as RouteIcon, ShieldAlert } from "lucide-react";
import { api } from "../lib/api";
import type { TunnelRecord } from "@arvoo/shared";
import {
  BackLink, Badge, Button, Card, CardHeader, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { DataTable, StatCard } from "../components/ui/data";
import { LinkDiagram } from "../components/network/LinkDiagram";
import { timeAgo, formatDateTime } from "../lib/format";

interface TunnelDetailResponse {
  tunnel: TunnelRecord;
  routes: Array<{ id: string; destination: string; gateway: string | null; device: string | null }>;
  sourceNode: { id: string; name: string; status: string; address: string | null } | null;
  destNode: { id: string; name: string; status: string; address: string | null } | null;
  operations: Array<{ id: string; type: string; status: string; created_at: string; error: string | null }>;
}

export function TunnelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"test" | "deploy" | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["tunnel", id],
    queryFn: () => api.get<TunnelDetailResponse>(`/tunnels/${id}`),
    refetchInterval: 10_000,
    enabled: !!id,
  });

  if (isLoading) return <LoadingState label="Loading tunnel…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;
  const { tunnel } = data;

  const runTest = async () => {
    setBusy("test");
    try {
      const res = await api.post<{ operationId: string }>(`/tunnels/${id}/test`);
      toast.success(`Tunnel test queued (${res.operationId.slice(0, 8)}…) — real ping RTT/loss reported by the node`);
      void queryClient.invalidateQueries({ queryKey: ["tunnel", id] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const redeploy = async () => {
    setBusy("deploy");
    try {
      await api.post(`/tunnels/${id}/deploy`);
      toast.success("Both sides queued for deployment");
      void queryClient.invalidateQueries({ queryKey: ["tunnel", id] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="mb-3">
        <BackLink label="Tunnels" onClick={() => navigate("/tunnels")} />
      </div>

      <PageHeader
        icon={<Network size={15} />}
        title={<span className="mono">{tunnel.name}</span>}
        badge={<UnifiedStatus status={tunnel.status} />}
        desc={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>GRE link</span>
            <span className="text-faint">·</span>
            <span className="mono">{tunnel.sourceEndpoint}</span>
            <span className="text-faint">→</span>
            <span className="mono">{tunnel.destEndpoint}</span>
            <span className="text-faint">·</span>
            <span className="mono">{tunnel.tunnelNetwork}</span>
            <Badge tone={tunnel.key ? "neutral" : "warning"}>{tunnel.key ? "keyed" : "unkeyed"}</Badge>
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh tunnel">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} />
            </Button>
            <Button size="sm" variant="secondary" onClick={runTest} loading={busy === "test"} disabled={busy === "deploy"}>
              <Gauge size={13} /> Run test
            </Button>
            <Button size="sm" variant="primary" onClick={redeploy} loading={busy === "deploy"} disabled={busy === "test"}>
              <Rocket size={13} /> Redeploy
            </Button>
          </>
        }
      />

      {/* Fabric view */}
      <Card className="mb-4">
        <CardHeader title="Link path" desc="Public endpoints carry the tunnel; /30 addresses are internal to the link" icon={<RouteIcon size={14} />} />
        <div className="px-4 py-5">
          <LinkDiagram
            status={tunnel.status}
            label={tunnel.key ? "GRE · keyed" : "GRE"}
            source={{ name: data.sourceNode?.name ?? "source", address: tunnel.sourceEndpoint, status: data.sourceNode?.status }}
            dest={{ name: data.destNode?.name ?? "destination", address: tunnel.destEndpoint, status: data.destNode?.status }}
            metrics={
              <>
                {tunnel.latencyMs != null && <span className="tnum">{tunnel.latencyMs} ms</span>}
                {tunnel.lossPct != null && <span className="tnum"> · {tunnel.lossPct}% loss</span>}
                {tunnel.latencyMs == null && tunnel.lossPct == null && <span>no measurement yet</span>}
              </>
            }
            onSourceClick={data.sourceNode ? () => navigate(`/nodes/${data.sourceNode!.id}`) : undefined}
            onDestClick={data.destNode ? () => navigate(`/nodes/${data.destNode!.id}`) : undefined}
          />
          <div className="mt-6 flex items-start gap-2.5 rounded-default border border-warning/25 bg-warning-soft px-3.5 py-2.5 text-2xs leading-relaxed">
            <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
            <span className="text-muted">
              <span className="font-medium text-warning">GRE encapsulates and routes — it does not encrypt.</span> It is safe on private or
              backbone paths you control.
            </span>
          </div>
        </div>
      </Card>

      <div className="grid-cards mb-4">
        <StatCard
          label="Latency"
          value={tunnel.latencyMs != null ? `${tunnel.latencyMs} ms` : "—"}
          tone={tunnel.latencyMs != null && tunnel.latencyMs > 150 ? "warning" : "default"}
          icon={<Activity size={14} />}
          sub="measured by agent ping"
        />
        <StatCard
          label="Packet loss"
          value={tunnel.lossPct != null ? `${tunnel.lossPct}%` : "—"}
          tone={tunnel.lossPct == null ? "default" : tunnel.lossPct > 2 ? "danger" : tunnel.lossPct > 0 ? "warning" : "success"}
          icon={<Gauge size={14} />}
          sub="from the last verification"
        />
        <StatCard label="MTU" value={tunnel.mtu} sub={tunnel.mtuOverride != null ? "manual override" : "engine computed"} />
        <StatCard label="TTL" value={tunnel.ttl} sub={tunnel.key ? "keyed encapsulation" : "no GRE key"} />
        <StatCard label="Last verified" value={timeAgo(tunnel.lastVerifiedAt)} sub={formatDateTime(tunnel.lastVerifiedAt)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Link attributes" desc="Stored configuration for both sides" icon={<Network size={14} />} />
          <div className="px-4 py-2">
            <KeyValue label="Interface name" value={tunnel.name} mono />
            <KeyValue label="Tunnel network" value={tunnel.tunnelNetwork} mono />
            <KeyValue label="Source endpoint" value={tunnel.sourceEndpoint} mono />
            <KeyValue label="Local tunnel IP" value={tunnel.localTunnelIp} mono />
            <KeyValue label="Destination endpoint" value={tunnel.destEndpoint} mono />
            <KeyValue label="Remote tunnel IP" value={tunnel.remoteTunnelIp} mono />
            <KeyValue
              label="GRE key"
              value={
                tunnel.key ? (
                  <>
                    0x{tunnel.key}
                    <span className="ml-1 text-2xs text-faint">(decimal {parseInt(tunnel.key, 16)})</span>
                  </>
                ) : (
                  "none (unkeyed)"
                )
              }
              mono
            />
            <KeyValue label="MTU" value={`${tunnel.mtu}${tunnel.mtuOverride != null ? ` (override, engine: ${tunnel.mtuOverride})` : " (computed)"}`} />
            <KeyValue label="TTL" value={tunnel.ttl} />
            <KeyValue label="Created" value={formatDateTime(tunnel.createdAt)} />
            <KeyValue label="Last verified" value={formatDateTime(tunnel.lastVerifiedAt)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Deployed routes" desc="Destination prefixes routed across this link" icon={<RouteIcon size={14} />} />
          {data.routes.length === 0 ? (
            <EmptyState
              compact
              icon={<RouteIcon size={18} />}
              title="No routes yet"
              message="Routes appear after the tunnel is deployed on both nodes."
            />
          ) : (
            <div className="divide-y divide-line/70">
              {data.routes.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="mono min-w-0 truncate text-xs text-text">{r.destination}</span>
                  <span className="mono shrink-0 text-2xs text-faint">
                    {r.gateway ? `via ${r.gateway}` : "direct"} {r.device ? `· ${r.device}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader title="Operations" desc="Deployment and verification history for both sides" icon={<Rocket size={14} />} />
          <DataTable
            columns={[
              { key: "type", header: "Operation", primary: true, render: (o) => <span className="mono text-xs">{o.type}</span> },
              { key: "status", header: "Status", sortValue: (o) => o.status, render: (o) => <UnifiedStatus status={o.status} /> },
              { key: "at", header: "Created", align: "right", sortValue: (o) => o.created_at, render: (o) => <span className="text-2xs text-muted tnum">{timeAgo(o.created_at)}</span> },
              { key: "error", header: "Error", hideBelow: "md", render: (o) => <span className="text-2xs text-danger">{o.error ?? ""}</span> },
            ]}
            rows={data.operations}
            rowKey={(o) => o.id}
            initialSort={{ key: "at", dir: "desc" }}
            empty={
              <EmptyState
                compact
                icon={<Rocket size={18} />}
                title="No operations yet"
                message="Create or redeploy the tunnel to see deployment history here."
              />
            }
          />
        </Card>
      </div>
    </div>
  );
}
