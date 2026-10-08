import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Globe, Plus, RefreshCw, Search, Users, X } from "lucide-react";
import { api } from "../lib/api";
import type { InboundRecord } from "@arvoo/shared";
import { Badge, Button, EmptyState, Input, PageHeader, Select, UnifiedStatus, cx } from "../components/ui/primitives";
import { DataTable, StatCard } from "../components/ui/data";
import { timeAgo } from "../lib/format";

export function InboundsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [nodeFilter, setNodeFilter] = useState("all");

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["inbounds"],
    queryFn: () => api.get<{ inbounds: InboundRecord[] }>("/inbounds"),
    refetchInterval: 15_000,
  });

  const { data: nodesData } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: Array<{ id: string; name: string; status: string }> }>("/nodes"),
  });

  const nodeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodesData?.nodes ?? []) m.set(n.id, n.name);
    return m;
  }, [nodesData]);

  const inbounds = data?.inbounds ?? [];
  const rows = useMemo(
    () =>
      inbounds.filter((i) => {
        const q = search.trim().toLowerCase();
        const name = nodeName.get(i.nodeId) ?? "";
        const text = !q || i.name.toLowerCase().includes(q) || name.toLowerCase().includes(q);
        return text && (status === "all" || i.status === status) && (nodeFilter === "all" || i.nodeId === nodeFilter);
      }),
    [inbounds, search, status, nodeFilter, nodeName],
  );

  const filtersActive = search.trim() !== "" || status !== "all" || nodeFilter !== "all";
  const clear = () => {
    setSearch("");
    setStatus("all");
    setNodeFilter("all");
  };

  const active = inbounds.filter((i) => i.status === "active").length;
  const clients = inbounds.reduce((a, i) => a + i.clientCount, 0);
  const servingNodes = new Set(inbounds.map((i) => i.nodeId)).size;

  return (
    <div>
      <PageHeader
        icon={<Globe size={15} />}
        title="Inbounds"
        badge={inbounds.length > 0 ? <Badge tone="neutral" mono>{inbounds.length}</Badge> : undefined}
        desc="VPN service endpoints. Each inbound is versioned configuration deployed to a node agent with validation, atomic apply and rollback."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh inbounds">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => navigate("/inbounds/new")}>
              <Plus size={14} /> New inbound
            </Button>
          </>
        }
      />

      {inbounds.length > 0 && (
        <div className="grid-cards mb-4">
          <StatCard label="Inbounds" value={inbounds.length} icon={<Globe size={14} />} sub={`${active} active · ${inbounds.length - active} not active`} />
          <StatCard label="Assigned clients" value={clients} icon={<Users size={14} />} sub="across every endpoint" />
          <StatCard label="Nodes serving" value={servingNodes} sub="distinct nodes carrying an endpoint" onClick={() => navigate("/nodes")} />
        </div>
      )}

      <DataTable
        loading={isLoading}
        dense
        columns={[
          {
            key: "name",
            header: "Inbound",
            primary: true,
            sortValue: (i) => i.name,
            render: (i) => (
              <div className="min-w-0">
                <div className="mono truncate font-medium text-text">{i.name}</div>
                <div className="mt-0.5 text-2xs text-faint">
                  {i.structuredConfig.transport.toUpperCase()} {i.structuredConfig.port} · {i.structuredConfig.serverNetwork}
                </div>
              </div>
            ),
          },
          {
            key: "node",
            header: "Node",
            sortValue: (i) => nodeName.get(i.nodeId) ?? "",
            render: (i) => <span className="text-xs text-muted">{nodeName.get(i.nodeId) ?? "—"}</span>,
          },
          { key: "status", header: "Status", sortValue: (i) => i.status, render: (i) => <UnifiedStatus status={i.status} /> },
          {
            key: "mode",
            header: "Egress",
            hideBelow: "md",
            render: (i) =>
              i.structuredConfig.deploymentMode === "through-tunnel" ? <Badge tone="info">via tunnel</Badge> : <Badge tone="neutral">direct</Badge>,
          },
          {
            key: "profile",
            header: "Profile",
            hideBelow: "lg",
            render: (i) => <span className="text-2xs capitalize text-muted">{i.structuredConfig.performanceProfile}</span>,
          },
          {
            key: "clients",
            header: "Clients",
            align: "right",
            hideBelow: "sm",
            sortValue: (i) => i.clientCount,
            render: (i) => <span className="text-2xs text-muted tnum">{i.clientCount}</span>,
          },
          {
            key: "version",
            header: "Version",
            align: "right",
            hideBelow: "sm",
            sortValue: (i) => i.currentVersion,
            render: (i) => <span className="mono text-2xs text-muted tnum">v{i.currentVersion}</span>,
          },
          {
            key: "updated",
            header: "Updated",
            align: "right",
            sortValue: (i) => i.updatedAt,
            render: (i) => <span className="text-2xs text-muted">{timeAgo(i.updatedAt)}</span>,
          },
        ]}
        rows={rows}
        rowKey={(i) => i.id}
        onRowClick={(i) => navigate(`/inbounds/${i.id}`)}
        initialSort={{ key: "name", dir: "asc" }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search inbound or node…" className="pl-8" aria-label="Search inbounds" />
            </div>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className="max-w-[9.5rem]">
              <option value="all">Any status</option>
              <option value="active">Active</option>
              <option value="stopped">Stopped</option>
              <option value="deploying">Deploying</option>
              <option value="draft">Draft</option>
              <option value="error">Error</option>
            </Select>
            <Select value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)} aria-label="Filter by node" className="max-w-[11rem]">
              <option value="all">Any node</option>
              {(nodesData?.nodes ?? []).map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </Select>
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clear}>
                <X size={13} /> Clear
              </Button>
            )}
            <span className="hidden text-2xs text-faint sm:inline tnum">{rows.length} shown</span>
          </div>
        }
        empty={
          <EmptyState
            icon={<Globe size={18} />}
            title={filtersActive ? "No inbounds match these filters" : "No inbounds yet"}
            message={
              filtersActive
                ? "Adjust the search or clear the filters to see every endpoint."
                : "Create your first OpenVPN endpoint with the structured builder: network, security and performance are validated before anything touches a node."
            }
            action={
              filtersActive ? (
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              ) : (
                <Button variant="primary" onClick={() => navigate("/inbounds/new")}>
                  <Plus size={14} /> New inbound
                </Button>
              )
            }
          />
        }
      />
    </div>
  );
}
