import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellRing, Check, CheckCircle2, Clock, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Button, Card, EmptyState, LoadingState, PageHeader, Select, cx } from "../components/ui/primitives";
import { StatCard } from "../components/ui/data";
import { ConfirmDialog } from "../components/ui/overlay";
import { formatDateTime, timeAgo } from "../lib/format";

interface Alert {
  id: string;
  severity: string;
  type: string;
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

const severityMeta = {
  critical: { tone: "danger" as const, rail: "bg-danger", label: "Critical" },
  warning: { tone: "warning" as const, rail: "bg-warning", label: "Warning" },
  info: { tone: "info" as const, rail: "bg-info", label: "Info" },
};

export function AlertsPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("open");
  const [resolveTarget, setResolveTarget] = useState<Alert | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.get<{ alerts: Alert[] }>("/alerts"),
    refetchInterval: 12_000,
  });

  const alerts = data?.alerts ?? [];
  const open = alerts.filter((a) => a.status !== "resolved");
  const critical = open.filter((a) => a.severity === "critical").length;
  const resolved = alerts.length - open.length;

  const filtered = useMemo(
    () =>
      alerts.filter((a) => {
        if (statusFilter === "open") return a.status !== "resolved";
        if (statusFilter === "critical") return a.status !== "resolved" && a.severity === "critical";
        if (statusFilter === "resolved") return a.status === "resolved";
        return true;
      }),
    [alerts, statusFilter],
  );

  const resolve = async () => {
    if (!resolveTarget) return;
    setBusy(true);
    try {
      await api.post(`/alerts/${resolveTarget.id}/resolve`);
      toast.success("Alert resolved");
      void queryClient.invalidateQueries({ queryKey: ["alerts"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setResolveTarget(null);
    }
  };

  if (isLoading) return <LoadingState label="Loading alerts…" />;

  return (
    <div>
      <PageHeader
        icon={<BellRing size={15} />}
        title="Alerts"
        badge={open.length > 0 ? <Badge tone={critical > 0 ? "danger" : "warning"}>{open.length} open</Badge> : undefined}
        desc="Raised by real conditions: missed heartbeats, stopped services, failed deployments and unhealthy tunnels."
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh alerts">
            <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />

      {alerts.length > 0 && (
        <div className="grid-cards mb-4">
          <StatCard label="Open" value={open.length} tone={open.length > 0 ? "warning" : "success"} icon={<BellRing size={14} />} sub="awaiting operator action" />
          <StatCard label="Critical" value={critical} tone={critical > 0 ? "danger" : "success"} icon={<TriangleAlert size={14} />} sub="service-affecting" />
          <StatCard label="Resolved" value={resolved} tone="success" icon={<CheckCircle2 size={14} />} sub="kept for history" />
        </div>
      )}

      {alerts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldCheck size={18} />}
            title="No alerts — ever"
            message="This list is not a promise of good health: it fills only when a real condition occurs. With no infrastructure yet, nothing can fail."
          />
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter alerts" className="max-w-[11rem]">
              <option value="open">Open alerts</option>
              <option value="critical">Critical only</option>
              <option value="resolved">Resolved</option>
              <option value="all">Everything</option>
            </Select>
            <span className="text-2xs text-faint tnum">{filtered.length} shown</span>
          </div>

          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={<CheckCircle2 size={18} />}
                title={statusFilter === "resolved" ? "Nothing resolved yet" : "No open alerts"}
                message={
                  statusFilter === "resolved"
                    ? "Resolved alerts stay listed here so you can trace how an incident ended."
                    : "All alerts have been resolved. Switch to “Everything” to review the history."
                }
                action={
                  <Button variant="secondary" size="sm" onClick={() => setStatusFilter("all")}>
                    Show everything
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="space-y-2">
              {filtered.map((a) => {
                const meta = severityMeta[a.severity as keyof typeof severityMeta] ?? severityMeta.info;
                const isOpen = a.status !== "resolved";
                return (
                  <div
                    key={a.id}
                    className={cx(
                      "panel relative overflow-hidden transition-colors",
                      isOpen && a.severity === "critical" ? "border-danger/35" : "hover:border-line-strong",
                    )}
                  >
                    <span className={cx("absolute inset-y-0 left-0 w-[2px]", isOpen ? meta.rail : "bg-line-strong")} aria-hidden />
                    <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 pl-5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                          <span className="text-[13px] font-medium text-text">{a.title}</span>
                          <Badge tone={isOpen ? (a.status === "acknowledged" ? "warning" : "danger") : "success"}>{a.status.replace(/_/g, " ")}</Badge>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted">{a.message}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-3xs text-faint">
                          <span className="mono">{a.type}</span>
                          {a.entity_id && (
                            <>
                              <span>·</span>
                              <span className="mono">{a.entity_id}</span>
                            </>
                          )}
                          <span>·</span>
                          <Clock size={10} />
                          <span>{formatDateTime(a.created_at)}</span>
                          <span>({timeAgo(a.created_at)})</span>
                          {a.resolved_at && <span>· resolved {timeAgo(a.resolved_at)}</span>}
                        </p>
                      </div>
                      {isOpen && (
                        <Button size="sm" variant="secondary" onClick={() => setResolveTarget(a)}>
                          <Check size={13} /> Resolve
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={resolveTarget != null}
        onOpenChange={() => setResolveTarget(null)}
        title="Resolve this alert?"
        message={
          resolveTarget ? `“${resolveTarget.title}” is marked resolved. It reopens automatically if the underlying condition returns.` : ""
        }
        confirmLabel="Resolve alert"
        loading={busy}
        onConfirm={resolve}
      />
    </div>
  );
}
