import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, ScrollText, Search, TriangleAlert, UserCog, X } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Button, EmptyState, Input, LoadingState, PageHeader, Select, UnifiedStatus, cx } from "../components/ui/primitives";
import { DataTable, StatCard } from "../components/ui/data";
import { formatDateTime, timeAgo } from "../lib/format";

interface AuditEntry {
  id: string;
  at: string;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_name: string | null;
  summary: string;
  ip: string | null;
}

const actionTone = (action: string): "success" | "danger" | "warning" | "info" | "neutral" => {
  if (action.includes("failed") || action.includes("revoke") || action.includes("delete")) return "danger";
  if (action.includes("create")) return "success";
  if (action.includes("suspend")) return "warning";
  if (action.startsWith("auth")) return "info";
  return "neutral";
};

/**
 * Audit = immutable privileged-action record.
 * Activity = the same feed surfaced as the platform's live event stream, so both
 * routes share one query, one table and one filter language.
 */
export function AuditPage({ variant = "audit" }: { variant?: "audit" | "activity" }) {
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [actor, setActor] = useState("all");

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["audit", search],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/audit?limit=300${search ? `&action=${encodeURIComponent(search)}` : ""}`),
    refetchInterval: variant === "activity" ? 10_000 : 20_000,
  });

  const entries = data?.entries ?? [];
  const actors = useMemo(() => Array.from(new Set(entries.map((e) => e.actor_name ?? "system"))).sort(), [entries]);

  const rows = useMemo(
    () =>
      entries.filter((e) => {
        const failed = e.action.includes("failed") || e.action.includes("error");
        if (outcome === "failures" && !failed) return false;
        if (outcome === "success" && failed) return false;
        if (actor !== "all" && (e.actor_name ?? "system") !== actor) return false;
        return true;
      }),
    [entries, outcome, actor],
  );

  const failures = entries.filter((e) => e.action.includes("failed") || e.action.includes("error")).length;
  const filtersActive = search.trim() !== "" || outcome !== "all" || actor !== "all";
  const clear = () => {
    setSearch("");
    setOutcome("all");
    setActor("all");
  };

  return (
    <div>
      <PageHeader
        icon={variant === "activity" ? <Activity size={15} /> : <ScrollText size={15} />}
        title={variant === "activity" ? "Activity" : "Audit log"}
        badge={entries.length > 0 ? <Badge tone="neutral" mono>{entries.length}</Badge> : undefined}
        desc={
          variant === "activity"
            ? "Live event stream of the platform — the same immutable, actor-attributed record the audit log keeps."
            : "Immutable record of every privileged action: logins, configuration changes, deployments, suspensions and revocations."
        }
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {entries.length > 0 && (
        <div className="grid-cards mb-4">
          <StatCard label="Entries (latest 300)" value={entries.length} icon={<ScrollText size={14} />} sub="newest first" />
          <StatCard
            label="Failures"
            value={failures}
            tone={failures > 0 ? "warning" : "success"}
            icon={<TriangleAlert size={14} />}
            sub="failed logins and errors"
          />
          <StatCard label="Distinct actors" value={actors.length} icon={<UserCog size={14} />} sub={actors.slice(0, 2).join(", ")} />
        </div>
      )}

      <DataTable
        loading={isLoading}
        dense
        columns={[
          {
            key: "at",
            header: "When",
            sortValue: (e) => e.at,
            render: (e) => (
              <span className="whitespace-nowrap text-2xs text-muted">
                {variant === "activity" ? timeAgo(e.at) : formatDateTime(e.at)}
              </span>
            ),
          },
          { key: "actor", header: "Actor", sortValue: (e) => e.actor_name ?? "", render: (e) => <span className="text-xs font-medium text-text">{e.actor_name ?? "system"}</span> },
          {
            key: "action",
            header: "Action",
            sortValue: (e) => e.action,
            render: (e) => (
              <Badge tone={actionTone(e.action)} mono>
                {e.action}
              </Badge>
            ),
          },
          {
            key: "summary",
            header: "Summary",
            primary: true,
            render: (e) => (
              <div className="min-w-0">
                <div className="truncate text-xs text-text">{e.summary}</div>
                {(e.entity_type || e.entity_name) && (
                  <div className="mt-0.5 truncate text-2xs text-faint">
                    {[e.entity_type, e.entity_name].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            ),
          },
          { key: "ip", header: "IP", align: "right", hideBelow: "md", render: (e) => <span className="mono text-2xs text-faint">{e.ip ?? "—"}</span> },
        ]}
        rows={rows}
        rowKey={(e) => e.id}
        initialSort={{ key: "at", dir: "desc" }}
        pageSize={50}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by action (inbound, client, auth…)…" className="pl-8" aria-label="Filter audit entries" />
            </div>
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filter by outcome" className="max-w-[10rem]">
              <option value="all">Any outcome</option>
              <option value="success">Successful only</option>
              <option value="failures">Failures only</option>
            </Select>
            <Select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Filter by actor" className="max-w-[10rem]">
              <option value="all">Any actor</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}
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
          filtersActive ? (
            <EmptyState
              icon={<ScrollText size={18} />}
              title="No entries match these filters"
              message="Adjust the action filter, outcome or actor to widen the search."
              action={
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<ScrollText size={18} />}
              title="No audit entries yet"
              message="Every privileged action is recorded here automatically — starting with your first login."
            />
          )
        }
      />

      <p className="mt-2 text-2xs text-faint">
        Entries are append-only and attributed to the acting identity (or <span className="mono">system</span> for automated work).
      </p>
    </div>
  );
}

export function ActivityPage() {
  return <AuditPage variant="activity" />;
}

export { UnifiedStatus };
