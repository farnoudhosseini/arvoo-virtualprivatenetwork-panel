import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Globe, Network, RefreshCw, Route, Server, X } from "lucide-react";
import { api } from "../lib/api";
import type { TopologyGraph } from "@arvoo/shared";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, StatusDot, UnifiedStatus, cx } from "../components/ui/primitives";
import { StatCard } from "../components/ui/data";

/** Node colours come from the design tokens so the graph matches the panel. */
const STATUS_COLORS: Record<string, string> = {
  online: "var(--success)",
  offline: "var(--danger)",
  pending: "var(--warning)",
  degraded: "var(--warning)",
  error: "var(--danger)",
  maintenance: "var(--info)",
  unknown: "var(--faint)",
};

const LINK_COLORS: Record<string, string> = {
  up: "var(--success)",
  degraded: "var(--warning)",
  down: "var(--danger)",
  planned: "var(--faint)",
};

export function TopologyPage() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["topology"],
    queryFn: () => api.get<TopologyGraph>("/topology"),
    refetchInterval: 15_000,
  });

  const layout = useMemo(() => {
    if (!data) return null;
    const nodes = data.nodes;
    const pos = new Map<string, { x: number; y: number }>();

    // Small fabrics read best as a straight line: A —— GRE —— B. Only once the
    // topology is genuinely radial (4+ nodes) does a hub-and-spoke layout add
    // information instead of empty space.
    if (nodes.length <= 3) {
      const width = nodes.length === 2 ? 640 : 820;
      const height = 220;
      const gap = width / (nodes.length + 1);
      nodes.forEach((n, i) => pos.set(n.id, { x: gap * (i + 1), y: height / 2 }));
      return { width, height, pos };
    }

    // The control-plane host sits in the centre; everything else orbits it.
    const center = nodes.find((n) => n.isSelf) ?? nodes[0];
    const others = nodes.filter((n) => n !== center);
    const width = 880;
    const height = 520;
    if (center) pos.set(center.id, { x: width / 2, y: height / 2 });
    others.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, others.length) - Math.PI / 2;
      const rx = center ? width / 2 - 140 : width / 2;
      const ry = height / 2 - 110;
      pos.set(n.id, { x: width / 2 + rx * Math.cos(angle), y: height / 2 + ry * Math.sin(angle) });
    });
    return { width, height, pos };
  }, [data]);

  if (isLoading) return <LoadingState label="Mapping infrastructure…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  if (!data || !layout || data.nodes.length === 0) {
    return (
      <div>
        <PageHeader icon={<Route size={15} />} title="Network topology" desc="Generated from actual infrastructure state — nodes, GRE links and inbound placement." />
        <Card>
          <EmptyState
            icon={<Route size={18} />}
            title="Nothing to draw yet"
            message="The graph is built from registered nodes and their links. Register a node to start mapping the fabric."
            action={
              <Button variant="primary" size="sm" onClick={() => navigate("/nodes?new=1")}>
                <Server size={14} /> Add node
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const selectedNode = data.nodes.find((n) => n.id === selected);
  const selectedInbounds = data.inbounds.filter((i) => i.nodeId === selected);
  const selectedLinks = data.links.filter((l) => l.sourceNodeId === selected || l.destNodeId === selected);
  const upLinks = data.links.filter((l) => l.status === "up").length;

  return (
    <div>
      <PageHeader
        icon={<Route size={15} />}
        title="Network topology"
        desc="Live graph generated from database state: node health, GRE links and inbound placement. Click a node to inspect it."
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh topology">
            <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      <div className="grid-cards mb-4">
        <StatCard label="Nodes" value={data.nodes.length} icon={<Server size={14} />} sub={`${data.nodes.filter((n) => n.status === "online").length} online`} />
        <StatCard label="Links" value={data.links.length} tone={upLinks === data.links.length ? "success" : "warning"} icon={<Network size={14} />} sub={`${upLinks} verified up`} />
        <StatCard label="Inbounds" value={data.inbounds.length} icon={<Globe size={14} />} sub="placed across the fabric" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="overflow-hidden">
          <CardHeader title="Fabric" desc="Solid links are verified tunnels; dashed links are unverified or failing" icon={<Network size={14} />} />
          <div className="p-2">
            <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full" role="img" aria-label="Network topology graph">
              {/* links */}
              {data.links.map((l) => {
                const a = layout.pos.get(l.sourceNodeId);
                const b = layout.pos.get(l.destNodeId);
                if (!a || !b) return null;
                const color = LINK_COLORS[l.status] ?? "var(--faint)";
                return (
                  <g key={l.id} className="cursor-pointer" onClick={() => navigate(`/tunnels/${l.id}`)}>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={color}
                      strokeWidth={1.75}
                      strokeDasharray={l.status === "up" ? undefined : "6 4"}
                      opacity={0.85}
                    />
                    <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 7} textAnchor="middle" fill="var(--faint)" fontSize={9} className="mono">
                      {l.name}
                      {l.latencyMs != null ? ` · ${l.latencyMs}ms` : ""}
                    </text>
                  </g>
                );
              })}
              {/* nodes */}
              {data.nodes.map((n) => {
                const p = layout.pos.get(n.id)!;
                const color = STATUS_COLORS[n.status] ?? "var(--faint)";
                const r = n.isSelf ? 30 : 22;
                const active = n.id === selected;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    className="cursor-pointer"
                    onClick={() => setSelected(n.id === selected ? null : n.id)}
                  >
                    <circle r={r + (active ? 12 : 6)} fill={color} opacity={active ? 0.2 : 0.1} />
                    <circle r={r} fill="var(--surface-2)" stroke={color} strokeWidth={active ? 2.5 : 1.75} />
                    <text y={4} textAnchor="middle" fill={color} fontSize={11} fontWeight={700}>
                      {n.name.slice(0, 7)}
                    </text>
                    <text y={r + 16} textAnchor="middle" fill="var(--muted)" fontSize={9.5}>
                      {n.regionClass === "iran" ? "IR" : "INTL"} · {n.status}
                      {n.openvpnClients > 0 ? ` · ${n.openvpnClients} clients` : ""}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </Card>

        <div className="space-y-4">
          {selectedNode ? (
            <Card>
              <CardHeader
                title={selectedNode.name}
                desc={`${selectedNode.role} · ${selectedNode.regionClass === "iran" ? "Iran" : "International"}`}
                actions={
                  <button
                    type="button"
                    aria-label="Clear selection"
                    className="text-faint transition-colors hover:text-text"
                    onClick={() => setSelected(null)}
                  >
                    <X size={14} />
                  </button>
                }
              />
              <div className="px-4 py-2">
                <KeyValue label="Status" value={<UnifiedStatus status={selectedNode.status} />} />
                <KeyValue label="Connected clients" value={selectedNode.openvpnClients} />
                <KeyValue label="Inbounds" value={selectedInbounds.length} />
                <KeyValue label="Links" value={selectedLinks.length} />
              </div>
              <div className="border-t border-line p-3">
                <Button variant="secondary" size="sm" className="w-full" onClick={() => navigate(`/nodes/${selectedNode.id}`)}>
                  Open node detail
                </Button>
              </div>
              {selectedInbounds.length > 0 && (
                <div className="border-t border-line">
                  <div className="label-micro px-4 pb-1 pt-3">Inbounds</div>
                  {selectedInbounds.map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => navigate(`/inbounds/${i.id}`)}
                      className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="mono truncate text-2xs text-text">{i.name}</span>
                      <span className="shrink-0 text-3xs text-faint tnum">{i.clientCount} clients</span>
                    </button>
                  ))}
                </div>
              )}
              {selectedLinks.length > 0 && (
                <div className="border-t border-line">
                  <div className="label-micro px-4 pb-1 pt-3">Links</div>
                  {selectedLinks.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => navigate(`/tunnels/${l.id}`)}
                      className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="mono truncate text-2xs text-text">{l.name}</span>
                      <span className="shrink-0 text-3xs text-faint">{l.status}</span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          ) : (
            <Card>
              <CardHeader title="Legend" desc="Click a node in the graph to inspect it" />
              <div className="space-y-2.5 px-4 py-3.5 text-2xs text-muted">
                {[
                  ["success", "online node / verified link"],
                  ["warning", "pending, degraded or failing link"],
                  ["danger", "offline node / link down"],
                  ["info", "maintenance window"],
                ].map(([tone, label]) => (
                  <div key={tone} className="flex items-center gap-2.5">
                    <StatusDot tone={tone as "success" | "warning" | "danger" | "info"} />
                    {label}
                  </div>
                ))}
                <p className="pt-1 leading-relaxed text-faint">
                  The diagram is always derived from database state — it is never hand-drawn, and a link only turns solid when the agent verified it
                  with a real ping.
                </p>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="All nodes" desc="Ordered as reported by the control plane" />
            <div className="divide-y divide-line/70">
              {data.nodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelected(n.id === selected ? null : n.id)}
                  className={cx(
                    "flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-2",
                    n.id === selected && "bg-accent-soft",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLORS[n.status] ?? "var(--faint)" }} aria-hidden />
                    <span className="truncate text-xs text-text">{n.name}</span>
                    {n.isSelf && <Badge tone="accent">master</Badge>}
                  </span>
                  <span className="shrink-0 text-3xs text-faint">{n.status}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
