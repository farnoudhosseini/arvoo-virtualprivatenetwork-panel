import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Globe, History, Play, RefreshCw, Rocket, RotateCcw, Server, StopCircle, Users } from "lucide-react";
import { api } from "../lib/api";
import type { InboundRecord } from "@arvoo/shared";
import {
  BackLink, Badge, Button, Card, CardHeader, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { CodeBlock, DataTable, StatCard } from "../components/ui/data";
import { ConfirmDialog, Tabs } from "../components/ui/overlay";
import { formatDateTime, timeAgo } from "../lib/format";
import { downloadText } from "../lib/api";

interface InboundDetailResponse {
  inbound: InboundRecord;
  node: { id: string; name: string; status: string; enrollment_state: string };
  currentConfig: string | null;
  versions: Array<{ id: string; version: number; checksum: string; openvpn_version: string | null; created_by: string | null; created_at: string; structured_config: string }>;
  deployments: Array<{ id: string; version: number; status: string; error: string | null; operation_id: string; created_at: string; finished_at: string | null }>;
  clients: Array<{ id: string; username: string; status: string; used_billed_bytes: number }>;
}

export function InboundDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [rollbackTo, setRollbackTo] = useState<number | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["inbound", id],
    queryFn: () => api.get<InboundDetailResponse>(`/inbounds/${id}`),
    refetchInterval: 8_000,
    enabled: !!id,
  });

  if (isLoading) return <LoadingState label="Loading inbound…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;
  const { inbound, node } = data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbound", id] });
    void queryClient.invalidateQueries({ queryKey: ["inbounds"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const deploy = async () => {
    setBusy("deploy");
    try {
      const res = await api.post<{ operationId: string; egressOperationId: string | null }>(`/inbounds/${id}/deploy`);
      toast.success(`Deployment queued (operation ${res.operationId.slice(0, 8)}…) — watch the timeline below`);
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (version: number) => {
    setBusy(`rollback-${version}`);
    try {
      await api.post(`/inbounds/${id}/rollback`, { version });
      toast.success(`Rolled back to v${version} — a new version was created. Deploy to apply it on the node.`);
      setRollbackTo(null);
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const lifecycle = async (kind: "restart" | "stop") => {
    setBusy(kind);
    try {
      await api.post(`/inbounds/${id}/${kind}`);
      toast.success(kind === "restart" ? "Restart queued" : "Stop queued");
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cfg = inbound.structuredConfig;
  const checksum = data.versions.find((v) => v.version === inbound.currentVersion)?.checksum ?? null;
  const lastDeploy = data.deployments[0];

  return (
    <div>
      <div className="mb-3">
        <BackLink label="Inbounds" onClick={() => navigate("/inbounds")} />
      </div>

      <PageHeader
        icon={<Globe size={15} />}
        title={<span className="mono">{inbound.name}</span>}
        badge={<UnifiedStatus status={inbound.status} />}
        desc={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>OpenVPN</span>
            <span className="text-faint">·</span>
            <span className="mono">
              {cfg.transport.toUpperCase()} {cfg.port}
            </span>
            <span className="text-faint">·</span>
            <span className="mono">{cfg.serverNetwork}</span>
            <Badge tone="neutral">{cfg.performanceProfile}</Badge>
            {cfg.deploymentMode === "through-tunnel" && <Badge tone="info">egress via tunnel</Badge>}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh inbound">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => lifecycle("restart")} loading={busy === "restart"} disabled={busy === "stop" || busy === "deploy"}>
              <Play size={13} /> Restart
            </Button>
            <Button size="sm" variant="secondary" onClick={() => lifecycle("stop")} loading={busy === "stop"} disabled={busy === "restart" || busy === "deploy"}>
              <StopCircle size={13} /> Stop
            </Button>
            <Button size="sm" variant="primary" onClick={deploy} loading={busy === "deploy"} disabled={busy === "restart" || busy === "stop"}>
              <Rocket size={13} /> Deploy v{inbound.currentVersion}
            </Button>
          </>
        }
      />

      <div className="grid-cards mb-4">
        <StatCard
          label="Node"
          value={node?.name ?? "—"}
          icon={<Server size={14} />}
          tone={node?.status === "online" ? "success" : "warning"}
          sub={node ? `agent ${node.enrollment_state.replace(/_/g, " ")}` : undefined}
          onClick={node ? () => navigate(`/nodes/${node.id}`) : undefined}
        />
        <StatCard label="Clients" value={inbound.clientCount} icon={<Users size={14} />} sub="assigned to this endpoint" onClick={() => navigate("/clients")} />
        <StatCard label="Config version" value={`v${inbound.currentVersion}`} sub={checksum ? `sha256 ${checksum.slice(0, 12)}…` : "no checksum"} />
        <StatCard
          label="Last deployment"
          value={lastDeploy ? lastDeploy.status : "never"}
          tone={lastDeploy?.status === "success" ? "success" : lastDeploy ? "warning" : "default"}
          icon={<History size={14} />}
          sub={lastDeploy ? `${timeAgo(lastDeploy.created_at)} · v${lastDeploy.version}` : "deploy to push config"}
        />
      </div>

      {node?.status !== "online" && (
        <div className="mb-4 rounded-default border border-warning/25 bg-warning-soft px-3.5 py-2.5 text-2xs leading-relaxed text-warning">
          The node agent is not online. Deployments will be rejected until it sends heartbeats again.
        </div>
      )}

      <Tabs
        variant="segmented"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Network" desc="Addressing and transport for this endpoint" icon={<Globe size={14} />} />
                  <div className="px-4 py-2">
                    <KeyValue label="Transport" value={`${cfg.transport.toUpperCase()} ${cfg.port}`} mono />
                    <KeyValue label="Listen address" value={cfg.listenAddress} mono />
                    <KeyValue label="Server network" value={`${cfg.serverNetwork} · ${cfg.topology}`} mono />
                    <KeyValue label="Device" value={cfg.device} mono />
                    <KeyValue label="Redirect gateway" value={cfg.redirectGateway ? "yes — all client traffic" : "no — split tunnel"} />
                    <KeyValue label="Client-to-client" value={cfg.clientToClient ? "allowed" : "blocked"} />
                    <KeyValue label="Push routes" value={cfg.pushRoutes.length > 0 ? cfg.pushRoutes.join(", ") : "none"} mono />
                    <KeyValue label="DNS servers" value={cfg.dnsServers.length > 0 ? cfg.dnsServers.join(", ") : "not pushed"} mono />
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Security & performance" desc="Validation happens before the node is touched" icon={<Rocket size={14} />} />
                  <div className="px-4 py-2">
                    <KeyValue label="TLS mode" value={cfg.tlsMode} />
                    <KeyValue label="TLS minimum" value={cfg.tlsVersionMin} />
                    <KeyValue label="Auth digest" value={cfg.authDigest} mono />
                    <KeyValue label="Data ciphers" value={cfg.dataCiphers.join(":")} mono />
                    {cfg.fallbackCipher && <KeyValue label="Legacy fallback cipher" value={cfg.fallbackCipher} mono />}
                    <KeyValue label="Performance profile" value={<span className="capitalize">{cfg.performanceProfile}</span>} />
                    <KeyValue label="TUN MTU / MSS fix" value={`${cfg.tunMtu} / ${cfg.mssFix ?? "auto"}`} mono />
                    {cfg.fragment != null && <KeyValue label="Fragment" value={cfg.fragment} mono />}
                    <KeyValue label="Keepalive" value={`${cfg.keepaliveInterval}s / ${cfg.keepaliveTimeout}s`} mono />
                    <KeyValue label="Max clients" value={cfg.maxClients} />
                    <KeyValue label="Compression" value={cfg.compression} />
                    <KeyValue label="Duplicate CN" value={cfg.duplicateCn ? "allowed" : "rejected"} />
                    <KeyValue label="Log verbosity" value={cfg.logVerbosity} />
                  </div>
                </Card>
              </div>
            ),
          },
          {
            value: "config",
            label: "Configuration",
            content: data.currentConfig ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-2xs text-faint">
                    Generated server configuration · checksum {checksum ? checksum.slice(0, 16) : "—"}…
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => downloadText(`${inbound.name}.conf`, data.currentConfig ?? "", "text/plain")}
                  >
                    <Download size={13} /> Download
                  </Button>
                </div>
                <CodeBlock code={data.currentConfig} filename={`server.conf · v${inbound.currentVersion}`} language="openvpn" maxHeight="560px" />
              </div>
            ) : (
              <Card>
                <EmptyState
                  icon={<Globe size={18} />}
                  title="No configuration generated"
                  message="Create a version by deploying this inbound; the generated config appears here afterwards."
                />
              </Card>
            ),
          },
          {
            value: "versions",
            label: "Versions",
            count: data.versions.length,
            content: (
              <DataTable
                columns={[
                  {
                    key: "version",
                    header: "Version",
                    primary: true,
                    sortValue: (v) => v.version,
                    render: (v) => (
                      <span className="mono flex items-center gap-2 text-xs">
                        v{v.version}
                        {v.version === inbound.currentVersion && <Badge tone="success">current</Badge>}
                      </span>
                    ),
                  },
                  { key: "checksum", header: "Checksum", hideBelow: "sm", render: (v) => <span className="mono text-2xs text-muted">{v.checksum.slice(0, 16)}…</span> },
                  { key: "openvpn", header: "OpenVPN", hideBelow: "lg", render: (v) => <span className="mono text-2xs text-muted">{v.openvpn_version ?? "runtime"}</span> },
                  { key: "by", header: "Author", hideBelow: "md", render: (v) => <span className="text-2xs text-muted">{v.created_by ?? "system"}</span> },
                  { key: "at", header: "Created", align: "right", sortValue: (v) => v.created_at, render: (v) => <span className="text-2xs text-muted">{formatDateTime(v.created_at)}</span> },
                ]}
                rows={data.versions}
                rowKey={(v) => v.id}
                initialSort={{ key: "version", dir: "desc" }}
                rowActions={(v) =>
                  v.version !== inbound.currentVersion ? (
                    <Button size="sm" variant="ghost" onClick={() => setRollbackTo(v.version)}>
                      <RotateCcw size={12} /> Roll back
                    </Button>
                  ) : null
                }
                empty={<EmptyState compact icon={<History size={18} />} title="No versions yet" message="Deploying this inbound creates its first version." />}
              />
            ),
          },
          {
            value: "deployments",
            label: "Deployments",
            count: data.deployments.length,
            content: (
              <DataTable
                columns={[
                  { key: "version", header: "Version", primary: true, render: (d) => <span className="mono text-xs">v{d.version}</span> },
                  { key: "status", header: "Status", sortValue: (d) => d.status, render: (d) => <UnifiedStatus status={d.status} /> },
                  {
                    key: "op",
                    header: "Operation",
                    hideBelow: "sm",
                    render: (d) => (
                      <button
                        type="button"
                        className="mono text-2xs text-info transition-colors hover:text-text"
                        onClick={() => navigate(`/operations?op=${d.operation_id}`)}
                      >
                        {d.operation_id.slice(0, 12)}…
                      </button>
                    ),
                  },
                  { key: "at", header: "When", align: "right", sortValue: (d) => d.created_at, render: (d) => <span className="text-2xs text-muted">{timeAgo(d.created_at)}</span> },
                  { key: "error", header: "Error", hideBelow: "md", render: (d) => <span className="text-2xs leading-snug text-danger">{d.error ?? ""}</span> },
                ]}
                rows={data.deployments}
                rowKey={(d) => d.id}
                initialSort={{ key: "at", dir: "desc" }}
                empty={
                  <EmptyState
                    compact
                    icon={<History size={18} />}
                    title="Never deployed"
                    message="Deploy this inbound to push configuration to the node. Every step the agent executes appears on the operation timeline."
                  />
                }
              />
            ),
          },
          {
            value: "clients",
            label: "Clients",
            count: data.clients.length,
            content: (
              <DataTable
                columns={[
                  { key: "username", header: "Client", primary: true, render: (c) => <span className="mono text-xs">{c.username}</span> },
                  { key: "status", header: "Status", render: (c) => <UnifiedStatus status={c.status} /> },
                ]}
                rows={data.clients}
                rowKey={(c) => c.id}
                onRowClick={(c) => navigate(`/clients/${c.id}`)}
                empty={<EmptyState compact icon={<Users size={18} />} title="No clients assigned" message="Assign clients to this inbound from the Clients page." />}
              />
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={rollbackTo != null}
        onOpenChange={() => setRollbackTo(null)}
        title={`Roll back to v${rollbackTo}?`}
        message={`The configuration from v${rollbackTo} becomes the new current version (v${inbound.currentVersion + 1}). You still need to deploy it to the node.`}
        confirmLabel={`Roll back to v${rollbackTo}`}
        onConfirm={() => rollbackTo != null && rollback(rollbackTo)}
        loading={busy?.startsWith("rollback") ?? false}
      />
    </div>
  );
}
