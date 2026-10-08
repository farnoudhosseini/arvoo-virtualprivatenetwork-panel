import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Boxes, RefreshCw, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Button, EmptyState, Input, KeyValue, Meter, PageHeader, Select, UnifiedStatus, cx } from "../components/ui/primitives";
import { CodeBlock, DataTable, StatCard } from "../components/ui/data";
import { Drawer, Tabs } from "../components/ui/overlay";
import { formatDateTime, timeAgo } from "../lib/format";

interface Operation {
  id: string;
  type: string;
  node_id: string | null;
  ref_type: string | null;
  requested_by: string | null;
  status: string;
  progress: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface OperationDetail {
  id: string;
  type: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  logs: Array<{ id: string; at: string; level: string; step: string; message: string }>;
}

export function OperationsPage() {
  const [params, setParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["operations", statusFilter],
    queryFn: () => api.get<{ operations: Operation[] }>(`/operations?limit=100${statusFilter ? `&status=${statusFilter}` : ""}`),
    refetchInterval: 8_000,
  });

  const detailId = params.get("op");

  const { data: detail, isError: detailFailed } = useQuery({
    queryKey: ["operation", detailId],
    queryFn: () => api.get<OperationDetail>(`/operations/${detailId}`),
    enabled: !!detailId,
    refetchInterval: 3_000,
    retry: 1,
  });

  const operations = data?.operations ?? [];
  const rows = operations.filter((o) =>
    search ? o.type.toLowerCase().includes(search.toLowerCase()) || o.id.toLowerCase().includes(search.toLowerCase()) : true,
  );

  const running = operations.filter((o) => o.status === "running" || o.status === "queued").length;
  const failed = operations.filter((o) => o.status === "failed").length;
  const succeeded = operations.filter((o) => o.status === "success").length;
  const filtersActive = search.trim() !== "" || statusFilter !== "";

  return (
    <div>
      <PageHeader
        icon={<Boxes size={15} />}
        title="Operations"
        badge={operations.length > 0 ? <Badge tone="neutral" mono>{operations.length}</Badge> : undefined}
        desc="Typed infrastructure operations queued to node agents — deployments, restarts, tunnel changes and diagnostics. Nothing runs outside this system."
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh operations">
            <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {operations.length > 0 && (
        <div className="grid-cards mb-4">
          <StatCard label="In flight" value={running} tone={running > 0 ? "accent" : "default"} sub="queued or running" />
          <StatCard label="Succeeded" value={succeeded} tone="success" sub="last 100 operations" />
          <StatCard label="Failed" value={failed} tone={failed > 0 ? "danger" : "success"} sub="inspect the timeline for the cause" />
        </div>
      )}

      <DataTable
        loading={isLoading}
        dense
        columns={[
          {
            key: "type",
            header: "Operation",
            primary: true,
            sortValue: (o) => o.type,
            render: (o) => (
              <div className="min-w-0">
                <div className="mono truncate text-xs text-text">{o.type}</div>
                <div className="mono mt-0.5 truncate text-3xs text-faint">{o.id.slice(0, 16)}…</div>
              </div>
            ),
          },
          { key: "status", header: "Status", sortValue: (o) => o.status, render: (o) => <UnifiedStatus status={o.status} /> },
          {
            key: "progress",
            header: "Progress",
            render: (o) => (
              <div className="w-24">
                <Meter pct={o.status === "success" ? 100 : o.progress} size="sm" tone={o.status === "failed" ? "danger" : "info"} />
                <span className="mt-0.5 block text-3xs text-faint tnum">{o.status === "success" ? 100 : o.progress}%</span>
              </div>
            ),
          },
          { key: "by", header: "Requested by", hideBelow: "sm", render: (o) => <span className="text-2xs text-muted">{o.requested_by ?? "system"}</span> },
          {
            key: "at",
            header: "Created",
            align: "right",
            sortValue: (o) => o.created_at,
            render: (o) => <span className="whitespace-nowrap text-2xs text-muted">{timeAgo(o.created_at)}</span>,
          },
          { key: "error", header: "Error", hideBelow: "lg", render: (o) => <span className="line-clamp-1 max-w-72 text-2xs text-danger">{o.error ?? ""}</span> },
        ]}
        rows={rows}
        rowKey={(o) => o.id}
        onRowClick={(o) => setParams({ op: o.id })}
        initialSort={{ key: "at", dir: "desc" }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search type or ID…" className="pl-8" aria-label="Search operations" />
            </div>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status" className="max-w-[10rem]">
              <option value="">Any status</option>
              {["queued", "running", "success", "failed", "rolled_back", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setStatusFilter(""); }}>
                <X size={13} /> Clear
              </Button>
            )}
            <span className="hidden text-2xs text-faint sm:inline tnum">{rows.length} shown</span>
          </div>
        }
        empty={
          <EmptyState
            icon={<Boxes size={18} />}
            title={filtersActive ? "No operations match these filters" : "No operations yet"}
            message={
              filtersActive
                ? "Adjust the search or clear the status filter."
                : "Deploy an inbound or create a tunnel — every infrastructure change is tracked here with its full timeline."
            }
            action={
              filtersActive ? (
                <Button variant="secondary" onClick={() => { setSearch(""); setStatusFilter(""); }}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
      />

      <Drawer
        open={!!detailId}
        onOpenChange={(v) => !v && setParams({})}
        width="max-w-2xl"
        title={detail ? `Operation · ${detail.type}` : "Operation"}
        desc={detail?.requested_by ? `requested by ${detail.requested_by}` : "queued by the control plane"}
      >
        {detailFailed && !detail ? (
          <EmptyState
            compact
            icon={<Boxes size={18} />}
            title="Operation not found"
            message="This operation id is unknown to the control plane — it may have been pruned by a retention sweep."
            action={
              <Button variant="secondary" size="sm" onClick={() => setParams({})}>
                Close
              </Button>
            }
          />
        ) : !detail ? (
          <div className="space-y-3" aria-busy>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="shimmer h-10 rounded-default" />
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <UnifiedStatus status={detail.status} />
              <Badge tone="neutral" mono>
                {detail.id.slice(0, 18)}…
              </Badge>

            </div>

            <div className="px-1">
              <KeyValue label="Created" value={formatDateTime(detail.created_at)} />
              <KeyValue label="Started" value={detail.started_at ? formatDateTime(detail.started_at) : "not yet"} />
              <KeyValue label="Finished" value={detail.finished_at ? formatDateTime(detail.finished_at) : "in progress"} />
              <KeyValue label="Steps recorded" value={detail.logs.length} />
            </div>

            {detail.error && (
              <div className="rounded-default border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-danger">
                {detail.error}
              </div>
            )}

            <section>
              <div className="label-micro mb-2">Timeline</div>
              {detail.logs.length === 0 ? (
                <p className="text-2xs text-faint">No steps recorded yet — the agent reports each step as it executes.</p>
              ) : (
                <ol className="relative pl-5">
                  <span className="absolute bottom-2 left-[5px] top-2 w-px bg-line" aria-hidden />
                  {detail.logs.map((l) => (
                    <li key={l.id} className="relative pb-3 last:pb-0">
                      <span
                        className={cx(
                          "absolute -left-5 top-1 size-2 rounded-full ring-4 ring-surface",
                          l.level === "error" ? "bg-danger" : l.level === "warn" ? "bg-warning" : "bg-success",
                        )}
                        aria-hidden
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-text">{l.step}</span>
                        <span className="text-3xs text-faint">{formatDateTime(l.at)}</span>
                        {l.level !== "info" && <Badge tone={l.level === "error" ? "danger" : "warning"}>{l.level}</Badge>}
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-snug text-muted">{l.message}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <Tabs
              variant="segmented"
              items={[
                {
                  value: "output",
                  label: "Result",
                  content: detail.output ? (
                    <CodeBlock code={JSON.stringify(detail.output, null, 2)} filename="result.json" maxHeight="260px" />
                  ) : (
                    <p className="text-2xs text-faint">No result payload recorded.</p>
                  ),
                },
                {
                  value: "input",
                  label: "Input",
                  content: (
                    <CodeBlock
                      filename="input.json"
                      maxHeight="260px"
                      code={JSON.stringify(
                        typeof detail.input === "object" && detail.input !== null && "pki" in (detail.input as object)
                          ? { ...(detail.input as object), pki: "[redacted]" }
                          : detail.input,
                        null,
                        2,
                      )}
                    />
                  ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}
