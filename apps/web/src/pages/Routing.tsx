import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Activity, Gauge, Network, Radar, RefreshCw, Route, Server, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Meter,
  PageHeader,
  Select,
  StatusDot,
  cx,
  type StatusTone,
} from "../components/ui/primitives";
import { DataTable, StatCard, type Column } from "../components/ui/data";

// ---------------------------------------------------------------------------
// Shapes returned by the routing API (see apps/api/src/services/routing.ts)
// ---------------------------------------------------------------------------

type HealthState = "healthy" | "degraded" | "recovering" | "failing" | "down" | "unknown" | null;
type AdminState = "enabled" | "drained" | "disabled";

interface MatrixNode {
  nodeId: string;
  label: string;
  status: string;
  adminState: AdminState;
  sessions: number;
  capacitySessions: number | null;
  health: HealthState;
  score: number;
  reasons: string[];
}

interface MatrixPath {
  tunnelId: string;
  label: string;
  transport: string | null;
  transportLabel: string | null;
  security: "none" | "encrypted" | null;
  adminState: AdminState;
  weight: number;
  healthState: HealthState;
  stale: boolean;
  metrics: { latencyMs: number | null; lossPct: number | null; jitterMs: number | null; throughputMbps: number | null; samples: number } | null;
  bitrate: number | null;
  eligible: boolean;
  score: number | null;
  reason: string | null;
}

interface MatrixPolicy {
  mode: string;
  preferredNodeIds?: string[];
  preferredCountries?: string[];
  preferredRegionClasses?: string[];
  preferredTransports?: string[];
}

interface RoutingMatrix {
  generatedAt: string;
  policy: MatrixPolicy;
  nodes: MatrixNode[];
  paths: MatrixPath[];
}

interface AssignmentRow {
  id: string;
  client_id: string;
  username: string;
  ingress_name: string;
  egress_name: string;
  tunnel_name: string | null;
  transport: string | null;
  state: string;
  reason: string | null;
  score: number | null;
  updated_at: string;
}

interface RoutingEventRow {
  id: string;
  at: string;
  kind: string;
  username: string | null;
  tunnel_id: string | null;
  transport: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Path probing plan (GET /routing/probes): why each path is or is not probed.
// ---------------------------------------------------------------------------

interface ProbeRow {
  tunnelId: string;
  name: string;
  state: HealthState;
  intervalSec: number;
  ageSec: number | null;
  due: boolean;
  reason: string;
}

interface ProbePlan {
  intervalSec: Record<string, number>;
  maxPerSweep: number;
  pingCount: number;
  due: number;
  probes: ProbeRow[];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

const HEALTH_TONE: Record<string, StatusTone> = {
  healthy: "success",
  degraded: "warning",
  recovering: "info",
  failing: "danger",
  down: "danger",
};

const TRANSPORT_OPTIONS = [
  { value: "openvpn-udp", label: "OpenVPN UDP" },
  { value: "openvpn-tcp", label: "OpenVPN TCP" },
  { value: "gre", label: "GRE" },
  { value: "gre-fou", label: "GRE over FOU" },
  { value: "gre-ipsec", label: "GRE over IPsec" },
];

const MODES: Array<{ value: string; label: string; description: string }> = [
  { value: "auto", label: "Automatic", description: "Score every healthy path and take the best one. No preference is applied." },
  { value: "preferred-region", label: "Prefer a region", description: "Paths in the preferred region are tried first. Healthy paths elsewhere stay as fallback." },
  { value: "preferred-transport", label: "Prefer a transport", description: "Paths already using the preferred encapsulation are tried first; the rest stay as fallback." },
  { value: "preferred-node", label: "Prefer a node", description: "Paths touching the chosen nodes are tried first; the rest stay as fallback." },
  { value: "strict", label: "Strict", description: "Nothing outside the preference is used, even when every preferred path is down." },
];

function HealthBadge({ state, stale }: { state: HealthState; stale?: boolean }) {
  if (!state) {
    return <span className="text-2xs text-faint">not measured</span>;
  }
  const tone = HEALTH_TONE[state] ?? "neutral";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone}>
        <StatusDot tone={tone} live={state === "healthy"} />
        {state}
      </Badge>
      {stale && <span className="text-3xs text-warning">stale</span>}
    </span>
  );
}

function truncate(value: string | null | undefined, max = 60): string {
  if (!value) return "—";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function AdminTag({ state }: { state: AdminState }) {
  if (state === "enabled") return null;
  return <Badge tone={state === "drained" ? "info" : "danger"}>{state}</Badge>;
}

export function RoutingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["routing-matrix"],
    queryFn: () => api.get<RoutingMatrix>("/routing/matrix"),
    refetchInterval: 15_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ["routing-assignments"],
    queryFn: () => api.get<{ assignments: AssignmentRow[] }>("/routing/assignments"),
    refetchInterval: 15_000,
  });
  const eventsQuery = useQuery({
    queryKey: ["routing-events"],
    queryFn: () => api.get<{ events: RoutingEventRow[] }>("/routing/events?limit=40"),
    refetchInterval: 15_000,
  });
  const probesQuery = useQuery({
    queryKey: ["routing-probes"],
    queryFn: () => api.get<ProbePlan>("/routing/probes"),
    refetchInterval: 30_000,
  });

  const sweepMutation = useMutation({
    mutationFn: () => api.post<{ queued: number; skipped: number; due: number }>("/routing/probes/run", {}),
    onSuccess: (result) => {
      toast.success(
        result.queued === 0
          ? "Nothing was due: every path has a recent measurement."
          : `Queued ${result.queued} probe${result.queued === 1 ? "" : "s"}${result.skipped > 0 ? `, ${result.skipped} already in flight` : ""}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["routing-probes"] });
      void queryClient.invalidateQueries({ queryKey: ["routing-matrix"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const probeMutation = useMutation({
    mutationFn: (tunnelId: string) => api.post(`/tunnels/${tunnelId}/benchmark`, { pingCount: 10, iperfSeconds: null }),
    onSuccess: () => {
      toast.success("Probe queued on the owning node.");
      void queryClient.invalidateQueries({ queryKey: ["routing-probes"] });
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const adminMutation = useMutation({
    mutationFn: (input: { entity: "node" | "tunnel"; id: string; state: AdminState }) => api.patch("/routing/admin", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["routing-matrix"] }),
  });

  if (isLoading) return <LoadingState label="Reading routing state…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  const paths = data.paths;
  const healthy = paths.filter((p) => p.healthState === "healthy").length;
  const degraded = paths.filter((p) => p.healthState === "degraded" || p.healthState === "failing").length;
  const unmeasured = paths.filter((p) => p.metrics == null).length;
  const assignments = assignmentsQuery.data?.assignments ?? [];
  const events = eventsQuery.data?.events ?? [];
  const probes = probesQuery.data;

  const pathColumns: Array<Column<MatrixPath>> = [
    {
      key: "label",
      header: "Path",
      primary: true,
      sortValue: (p) => p.label,
      render: (p) => (
        <button
          type="button"
          onClick={() => navigate(`/tunnels/${p.tunnelId}`)}
          className="mono block max-w-[280px] truncate text-left text-xs text-text transition-colors hover:text-accent"
          title={p.label}
        >
          {p.label}
        </button>
      ),
    },
    {
      key: "transport",
      header: "Encapsulation",
      hideBelow: "md",
      render: (p) => (
        <span className="inline-flex items-center gap-1.5 text-2xs text-muted">
          {p.transportLabel ?? "—"}
          {p.security === "none" ? (
            <Badge tone="warning">unencrypted</Badge>
          ) : p.security === "encrypted" ? (
            <Badge tone="success">encrypted</Badge>
          ) : null}
        </span>
      ),
    },
    { key: "health", header: "Health", render: (p) => <HealthBadge state={p.healthState} stale={p.stale} /> },
    {
      key: "score",
      header: "Score",
      align: "right",
      sortValue: (p) => p.score ?? -1,
      render: (p) => <span className="mono text-xs tnum">{p.score != null ? p.score.toFixed(1) : "—"}</span>,
    },
    {
      key: "weight",
      header: "Weight",
      align: "right",
      hideBelow: "lg",
      sortValue: (p) => p.weight,
      render: (p) => <span className="mono text-2xs text-muted tnum">{p.weight.toFixed(0)}</span>,
    },
    {
      key: "latency",
      header: "Latency / loss",
      align: "right",
      hideBelow: "lg",
      render: (p) => (
        <span className="mono text-2xs text-muted tnum">
          {p.metrics?.latencyMs != null ? `${p.metrics.latencyMs.toFixed(0)} ms` : "—"}
          {" / "}
          {p.metrics?.lossPct != null ? `${p.metrics.lossPct.toFixed(1)}%` : "—"}
        </span>
      ),
    },
    {
      key: "bitrate",
      header: "Throughput",
      align: "right",
      hideBelow: "lg",
      render: (p) => (
        <span className="mono text-2xs text-muted tnum">{p.bitrate != null ? `${p.bitrate.toFixed(0)} Mbps` : "—"}</span>
      ),
    },
    {
      key: "eligible",
      header: "New sessions",
      render: (p) =>
        p.eligible ? (
          <Badge tone="success">eligible</Badge>
        ) : (
          <span className="text-2xs text-faint" title={p.reason ?? undefined}>
            {truncate(p.reason, 48)}
          </span>
        ),
    },
  ];

  const nodeColumns: Array<Column<MatrixNode>> = [
    {
      key: "label",
      header: "Node",
      primary: true,
      sortValue: (n) => n.label,
      render: (n) => (
        <span className="inline-flex items-center gap-2">
          <span className="mono text-xs text-text">{n.label}</span>
          <AdminTag state={n.adminState} />
        </span>
      ),
    },
    {
      key: "health",
      header: "Health",
      render: (n) => <HealthBadge state={n.health} />,
    },
    {
      key: "score",
      header: "Score",
      sortValue: (n) => n.score,
      render: (n) => (
        <span className="flex min-w-[110px] items-center gap-2">
          <span className="mono w-9 text-right text-xs tnum">{n.score.toFixed(1)}</span>
          <Meter pct={n.score} size="sm" />
        </span>
      ),
    },
    {
      key: "sessions",
      header: "Sessions",
      align: "right",
      sortValue: (n) => n.sessions,
      render: (n) => (
        <span className="mono text-2xs text-muted tnum">
          {n.sessions}
          {n.capacitySessions != null ? ` / ${n.capacitySessions}` : ""}
        </span>
      ),
    },
  ];

  const assignmentColumns: Array<Column<AssignmentRow>> = [
    { key: "client", header: "Client", primary: true, sortValue: (a) => a.username, render: (a) => <span className="text-xs text-text">{a.username}</span> },
    {
      key: "route",
      header: "Ingress → egress",
      render: (a) => (
        <span className="mono text-2xs text-muted">
          {a.ingress_name} → {a.egress_name}
        </span>
      ),
    },
    {
      key: "transport",
      header: "Path",
      hideBelow: "md",
      render: (a) => <span className="mono text-2xs text-muted">{a.tunnel_name ?? "—"}</span>,
    },
    {
      key: "state",
      header: "State",
      render: (a) => <Badge tone={a.state === "active" ? "success" : "warning"}>{a.state}</Badge>,
    },
    {
      key: "updated",
      header: "Updated",
      align: "right",
      sortValue: (a) => a.updated_at,
      render: (a) => (
        <span className="text-2xs text-faint" title={a.updated_at}>
          {timeAgo(a.updated_at)}
        </span>
      ),
    },
  ];

  const probeColumns: Array<Column<ProbeRow>> = [
    {
      key: "name",
      header: "Path",
      primary: true,
      sortValue: (p) => p.name,
      render: (p) => <span className="mono text-xs text-text">{p.name}</span>,
    },
    { key: "state", header: "State", render: (p) => <HealthBadge state={p.state} /> },
    {
      key: "interval",
      header: "Interval",
      align: "right",
      hideBelow: "md",
      sortValue: (p) => p.intervalSec,
      render: (p) => <span className="mono text-2xs text-muted tnum">{formatDuration(p.intervalSec)}</span>,
    },
    {
      key: "age",
      header: "Last measurement",
      align: "right",
      hideBelow: "md",
      sortValue: (p) => p.ageSec ?? -1,
      render: (p) => (
        <span className="text-2xs text-muted">{p.ageSec == null ? "never" : `${formatDuration(p.ageSec)} ago`}</span>
      ),
    },
    {
      key: "next",
      header: "Next probe",
      render: (p) =>
        p.due ? (
          <Badge tone="info">due now</Badge>
        ) : (
          <span className="text-2xs text-faint" title={p.reason}>
            {truncate(p.reason, 56)}
          </span>
        ),
    },
  ];

  const eventColumns: Array<Column<RoutingEventRow>> = [
    {
      key: "at",
      header: "When",
      primary: true,
      sortValue: (e) => e.at,
      render: (e) => (
        <span className="text-2xs text-muted" title={e.at}>
          {timeAgo(e.at)}
        </span>
      ),
    },
    {
      key: "kind",
      header: "Decision",
      render: (e) => <Badge tone={e.kind === "reject" ? "danger" : e.kind === "health" ? "info" : "neutral"}>{e.kind}</Badge>,
    },
    {
      key: "client",
      header: "Client",
      hideBelow: "md",
      render: (e) => <span className="text-2xs text-muted">{e.username ?? "—"}</span>,
    },
    {
      key: "reason",
      header: "Reason",
      render: (e) => (
        <span className="text-2xs text-faint" title={e.reason}>
          {truncate(e.reason, 90)}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={<Gauge size={15} />}
        title="Traffic intelligence"
        desc="The routing engine's live state: node scores, real path health, weights, sticky assignments and every recorded decision."
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh routing state">
            <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div className="grid-cards mb-4">
        <StatCard
          label="Healthy paths"
          value={`${healthy}/${paths.length}`}
          tone={healthy === paths.length && paths.length > 0 ? "success" : "warning"}
          icon={<Network size={14} />}
          sub={paths.length === 0 ? "No tunnels yet" : `${degraded} degraded · ${unmeasured} without a measurement`}
        />
        <StatCard
          label="Sticky sessions"
          value={assignments.length}
          icon={<Route size={14} />}
          sub="Clients with an ingress → egress assignment"
        />
        <StatCard
          label="Decisions recorded"
          value={events.length}
          icon={<TriangleAlert size={14} />}
          sub="Placements, holds, failovers and health transitions"
        />
        <StatCard
          label="Nodes in service"
          value={data.nodes.filter((n) => n.adminState === "enabled").length}
          icon={<Server size={14} />}
          sub={`${data.nodes.filter((n) => n.status === "online").length} online`}
        />
      </div>

      {paths.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Network size={18} />}
            title="No paths to route over"
            message="The engine can only place sessions on real tunnels. Create a tunnel between two approved nodes and benchmark it to give the engine something to measure."
            action={
              <Button variant="primary" size="sm" onClick={() => navigate("/tunnels")}>
                <Network size={14} /> Open tunnels
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <CardHeader
              title="Paths"
              desc="Health comes from real measurements. A path that was never probed is down, never “probably fine”."
              icon={<Network size={14} />}
            />
            <DataTable
              columns={pathColumns}
              rows={paths}
              rowKey={(p) => p.tunnelId}
              initialSort={{ key: "score", dir: "desc" }}
              pageSize={12}
              rowActions={(p) =>
                p.adminState === "enabled" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => adminMutation.mutate({ entity: "tunnel", id: p.tunnelId, state: "drained" })}
                  >
                    Drain
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => adminMutation.mutate({ entity: "tunnel", id: p.tunnelId, state: "enabled" })}
                  >
                    Enable
                  </Button>
                )
              }
              footerNote="Draining stops new sessions on a path; sessions already on it keep running until they end."
            />
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Path probing"
              desc={`Health can only come from real measurements. Every path is probed automatically — a healthy one every ${formatDuration(
                probes?.intervalSec.healthy ?? 300,
              )}, a failing one every ${formatDuration(probes?.intervalSec.down ?? 45)}, and a path that was never measured straight away.`}
              icon={<Activity size={14} />}
              actions={
                <Button variant="ghost" size="sm" onClick={() => sweepMutation.mutate()} loading={sweepMutation.isPending}>
                  <Radar size={13} /> Probe due paths
                </Button>
              }
            />
            <DataTable
              columns={probeColumns}
              rows={probes?.probes ?? []}
              rowKey={(p) => p.tunnelId}
              initialSort={{ key: "age", dir: "desc" }}
              pageSize={6}
              rowActions={(p) => (
                <Button variant="ghost" size="sm" onClick={() => probeMutation.mutate(p.tunnelId)}>
                  Probe
                </Button>
              )}
              footerNote={`${probes?.due ?? 0} path(s) due now · probes are light ICMP measurements (${probes?.pingCount ?? 10} packets); throughput is only measured by an explicit benchmark.`}
            />
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="overflow-hidden">
              <CardHeader title="Nodes" desc="Score combines health, resources and how full the node already is." icon={<Server size={14} />} />
              <DataTable
                columns={nodeColumns}
                rows={data.nodes}
                rowKey={(n) => n.nodeId}
                initialSort={{ key: "score", dir: "desc" }}
                pageSize={8}
                rowActions={(n) =>
                  n.adminState === "enabled" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => adminMutation.mutate({ entity: "node", id: n.nodeId, state: "drained" })}
                    >
                      Drain
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => adminMutation.mutate({ entity: "node", id: n.nodeId, state: "enabled" })}
                    >
                      Enable
                    </Button>
                  )
                }
                footerNote="Only nodes whose sessions the panel can actually see are scored; missing telemetry is excluded, not guessed."
              />
            </Card>

            <PolicyEditor
              key={JSON.stringify(data.policy)}
              policy={data.policy}
              nodes={data.nodes.map((n) => ({ nodeId: n.nodeId, label: n.label }))}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader title="Assignments" desc="One ingress and one active egress per client, kept sticky while healthy." icon={<Route size={14} />} />
              <DataTable
                columns={assignmentColumns}
                rows={assignments}
                rowKey={(a) => a.id}
                pageSize={8}
                empty={
                  <EmptyState
                    icon={<Route size={18} />}
                    title="No assignments yet"
                    message="Place a client through the API (POST /routing/place) and it will appear here with the reason it was chosen."
                  />
                }
              />
            </Card>

            <Card className="overflow-hidden">
              <CardHeader title="Recent decisions" desc="Placements, holds and health transitions, with the reason each one happened." />
              <DataTable
                columns={eventColumns}
                rows={events}
                rowKey={(e) => e.id}
                pageSize={8}
                empty={<EmptyState icon={<TriangleAlert size={18} />} title="No decisions recorded" message="Routing events appear here as soon as a client is placed or a path changes health." />}
              />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy editor: the simple intent control over the engine's real policy model
// ---------------------------------------------------------------------------

function PolicyEditor({ policy, nodes }: { policy: MatrixPolicy; nodes: Array<{ nodeId: string; label: string }> }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState(policy.mode);
  const [countries, setCountries] = useState((policy.preferredCountries ?? []).join(", "));
  const [regions, setRegions] = useState<string[]>(policy.preferredRegionClasses ?? []);
  const [transports, setTransports] = useState<string[]>(policy.preferredTransports ?? []);
  const [nodeIds, setNodeIds] = useState<string[]>(policy.preferredNodeIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      api.put("/routing/policies", {
        mode,
        preferredCountries: countries
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        preferredRegionClasses: regions,
        preferredTransports: transports,
        preferredNodeIds: nodeIds,
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["routing-matrix"] });
    },
    onError: (err) => {
      setSaved(false);
      setError((err as Error).message);
    },
  });

  const toggle = (list: string[], value: string, set: (next: string[]) => void) => {
    setSaved(false);
    set(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  };

  const selected = MODES.find((m) => m.value === mode) ?? MODES[0]!;

  return (
    <Card>
      <CardHeader
        title="Connection policy"
        desc="Applies to new sessions only. A healthy existing session is never moved to follow a score."
      />
      <div className="space-y-3.5 px-4 py-3.5">
        <Field label="Intent" hint={selected.description}>
          <Select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setSaved(false);
            }}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>

        {mode === "preferred-region" && (
          <>
            <Field label="Region class">
              <div className="flex flex-wrap gap-3 pt-0.5">
                {["iran", "international"].map((value) => (
                  <label key={value} className="flex items-center gap-2 text-xs text-muted">
                    <Checkbox
                      checked={regions.includes(value)}
                      onCheckedChange={() => toggle(regions, value, setRegions)}
                      label={value === "iran" ? "Iran" : "International"}
                    />
                    {value === "iran" ? "Iran" : "International"}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Countries" hint="Comma separated, matched case-insensitively (e.g. Germany, Netherlands).">
              <Input
                value={countries}
                onChange={(e) => {
                  setCountries(e.target.value);
                  setSaved(false);
                }}
                placeholder="Germany, Netherlands"
              />
            </Field>
          </>
        )}

        {mode === "preferred-transport" && (
          <Field label="Encapsulation">
            <div className="flex flex-wrap gap-3 pt-0.5">
              {TRANSPORT_OPTIONS.map((option) => (
                <label key={option.value} className="flex items-center gap-2 text-xs text-muted">
                  <Checkbox
                    checked={transports.includes(option.value)}
                    onCheckedChange={() => toggle(transports, option.value, setTransports)}
                    label={option.label}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </Field>
        )}

        {mode === "preferred-node" && (
          <Field label="Nodes" hint="Pick the nodes that should be tried first.">
            <div className="flex flex-wrap gap-3 pt-0.5">
              {nodes.map((node) => (
                <label key={node.nodeId} className="flex items-center gap-2 text-xs text-muted">
                  <Checkbox
                    checked={nodeIds.includes(node.nodeId)}
                    onCheckedChange={() => toggle(nodeIds, node.nodeId, setNodeIds)}
                    label={node.label}
                  />
                  {node.label}
                </label>
              ))}
            </div>
          </Field>
        )}

        {error && <p className="text-2xs text-danger">{error}</p>}
        {saved && !error && <p className="text-2xs text-success">Policy saved. It applies to the next placement decision.</p>}

        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          <span className="text-2xs text-faint">
            {selected.label} · engine decides by score, health and capacity
          </span>
          <Button variant="primary" size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
