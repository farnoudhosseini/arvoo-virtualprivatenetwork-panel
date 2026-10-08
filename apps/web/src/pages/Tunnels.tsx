import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { LayoutGrid, List, Network, Plus, RefreshCw, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import { GRE_KEY_RULE, canonicalGreKey, type TunnelRecord } from "@arvoo/shared";
import {
  Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { DataTable } from "../components/ui/data";
import { Drawer, ConfirmDialog } from "../components/ui/overlay";
import { LinkDiagram } from "../components/network/LinkDiagram";
import { timeAgo } from "../lib/format";

type TunnelRow = TunnelRecord & { sourceName: string; destName: string };

export function TunnelsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<TunnelRow | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<"table" | "grid">("grid");
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["tunnels"],
    queryFn: () => api.get<{ tunnels: TunnelRow[] }>("/tunnels"),
    refetchInterval: 15_000,
  });

  const tunnels = data?.tunnels ?? [];
  const rows = useMemo(
    () =>
      tunnels.filter((t) => {
        const q = search.trim().toLowerCase();
        const text = !q || t.name.toLowerCase().includes(q) || t.sourceName.toLowerCase().includes(q) || t.destName.toLowerCase().includes(q);
        return text && (status === "all" || t.status === status);
      }),
    [tunnels, search, status],
  );

  const filtersActive = search.trim() !== "" || status !== "all";
  const doDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.delete(`/tunnels/${deleteTarget.id}`);
      toast.success(`Tunnel ${deleteTarget.name} deleted`);
      void queryClient.invalidateQueries({ queryKey: ["tunnels"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  };

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tunnel or node…" className="pl-8" aria-label="Search tunnels" />
      </div>
      <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className="max-w-[9.5rem]">
        <option value="all">Any status</option>
        <option value="up">Up</option>
        <option value="degraded">Degraded</option>
        <option value="down">Down</option>
        <option value="planned">Planned</option>
      </Select>
      {filtersActive && (
        <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setStatus("all"); }}>
          <X size={13} /> Clear
        </Button>
      )}
      <span className="hidden text-2xs text-faint sm:inline tnum">{rows.length} shown</span>
      <div className="ml-auto flex items-center gap-0.5 rounded-default border border-line bg-surface-2 p-0.5">
        {([["grid", LayoutGrid, "Link view"], ["table", List, "Table view"]] as const).map(([v, Icon, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            aria-label={label}
            aria-pressed={view === v}
            className={cx(
              "flex size-7 items-center justify-center rounded-[6px] transition-colors duration-fast",
              view === v ? "bg-surface-3 text-text" : "text-faint hover:text-muted",
            )}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
    </div>
  );

  const empty = (
    <EmptyState
      icon={<Network size={18} />}
      title={filtersActive ? "No tunnels match these filters" : "No tunnels yet"}
      message={
        filtersActive
          ? "Adjust the search or clear the filters to see every link."
          : "Link two approved nodes with a GRE tunnel. Both sides are deployed together and verified with a real ping across the tunnel IP."
      }
      action={
        filtersActive ? (
          <Button variant="secondary" onClick={() => { setSearch(""); setStatus("all"); }}>
            Clear filters
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setParams({ new: "1" })}>
            <Plus size={14} /> Create tunnel
          </Button>
        )
      }
    />
  );

  return (
    <div>
      <PageHeader
        icon={<Network size={15} />}
        title="Tunnels"
        badge={tunnels.length > 0 ? <Badge tone="neutral" mono>{tunnels.length}</Badge> : undefined}
        desc="GRE links between nodes over the kernel's native GRE. MTU is derived by the engine from path MTU and encapsulation overhead."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh tunnels">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setParams({ new: "1" })}>
              <Plus size={14} /> Create tunnel
            </Button>
          </>
        }
      />

      <div className="mb-4 flex items-start gap-2.5 rounded-default border border-warning/25 bg-warning-soft px-3.5 py-2.5 text-2xs leading-relaxed">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
        <span className="text-muted">
          <span className="font-medium text-warning">GRE is encapsulation, not encryption.</span> Use GRE only over paths you control; sensitive
          traffic needs a crypto layer on top. Arvoo never presents GRE as a secure tunnel.
        </span>
      </div>

      {view === "grid" ? (
        <Card>
          <div className="border-b border-line px-3 py-2.5">{toolbar}</div>
          {isLoading ? (
            <div className="space-y-3 p-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="shimmer h-16 rounded-default" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            empty
          ) : (
            <div className="divide-y divide-line/70">
              {rows.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigate(`/tunnels/${t.id}`)}
                  className="group block w-full px-4 py-3.5 text-left transition-colors hover:bg-surface-2"
                >
                  <div className="mb-2.5 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="mono truncate text-xs font-medium text-text">{t.name}</span>
                      <span className="mono hidden text-3xs text-faint sm:inline">{t.tunnelNetwork}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-3xs text-faint">
                      <span className="hidden tnum sm:inline">{t.mtu} MTU</span>
                      <span className="hidden tnum md:inline">{timeAgo(t.lastVerifiedAt)}</span>
                      <UnifiedStatus status={t.status} />
                    </div>
                  </div>
                  <LinkDiagram
                    compact
                    status={t.status}
                    label={t.key ? "GRE · keyed" : "GRE"}
                    source={{ name: t.sourceName }}
                    dest={{ name: t.destName }}
                    metrics={
                      <>
                        {t.latencyMs != null && <span className="tnum">{t.latencyMs} ms</span>}
                        {t.lossPct != null && <span className="tnum"> · {t.lossPct}% loss</span>}
                      </>
                    }
                  />
                </button>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <DataTable
          loading={isLoading}
          toolbar={toolbar}
          columns={[
            { key: "name", header: "Tunnel", primary: true, sortValue: (t) => t.name, render: (t) => <span className="mono font-medium">{t.name}</span> },
            {
              key: "path",
              header: "Path",
              render: (t) => (
                <span className="text-xs">
                  {t.sourceName} <span className="text-faint">↔</span> {t.destName}
                </span>
              ),
            },
            { key: "status", header: "Status", sortValue: (t) => t.status, render: (t) => <UnifiedStatus status={t.status} /> },
            {
              key: "latency",
              header: "Latency",
              align: "right",
              sortValue: (t) => t.latencyMs ?? 0,
              render: (t) => <span className="mono text-2xs text-muted tnum">{t.latencyMs != null ? `${t.latencyMs} ms` : "—"}</span>,
            },
            {
              key: "loss",
              header: "Loss",
              align: "right",
              hideBelow: "sm",
              sortValue: (t) => t.lossPct ?? 0,
              render: (t) => (
                <span className={cx("mono text-2xs tnum", (t.lossPct ?? 0) > 2 ? "text-danger" : "text-muted")}>
                  {t.lossPct != null ? `${t.lossPct}%` : "—"}
                </span>
              ),
            },
            { key: "mtu", header: "MTU", align: "right", hideBelow: "md", render: (t) => <span className="mono text-2xs text-muted tnum">{t.mtu}</span> },
            { key: "net", header: "Transport /30", hideBelow: "lg", render: (t) => <span className="mono text-2xs text-muted">{t.tunnelNetwork}</span> },
            {
              key: "seen",
              header: "Verified",
              align: "right",
              hideBelow: "md",
              sortValue: (t) => t.lastVerifiedAt ?? "",
              render: (t) => <span className="text-2xs text-muted">{timeAgo(t.lastVerifiedAt)}</span>,
            },
          ]}
          rows={rows}
          rowKey={(t) => t.id}
          onRowClick={(t) => navigate(`/tunnels/${t.id}`)}
          rowActions={(t) => (
            <Button variant="ghost" size="sm" aria-label={`Delete ${t.name}`} onClick={(e) => { e.stopPropagation(); setDeleteTarget(t); }}>
              <Trash2 size={13} className="text-danger" />
            </Button>
          )}
          empty={empty}
        />
      )}

      <NewTunnelDrawer open={params.get("new") === "1"} onClose={() => setParams({})} onCreated={() => queryClient.invalidateQueries({ queryKey: ["tunnels"] })} />

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={() => setDeleteTarget(null)}
        title={`Delete tunnel “${deleteTarget?.name}”?`}
        message="Removal is queued on both nodes. The interface disappears from both sides; inbounds using it lose their egress path."
        confirmLabel="Delete tunnel"
        danger
        loading={busy}
        onConfirm={doDelete}
      />
    </div>
  );
}

function NewTunnelDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { data: nodesData } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: Array<{ id: string; name: string; enrollmentState: string; status: string; address: string | null }> }>("/nodes"),
    enabled: open,
  });
  const [pathMtu, setPathMtu] = useState("1500");
  const [keyMode, setKeyMode] = useState<"auto" | "custom" | "none">("auto");
  const [customKey, setCustomKey] = useState("");
  const { data: advice } = useQuery({
    queryKey: ["mtu-advice", pathMtu, keyMode],
    queryFn: () => api.get<{ recommendedMtu: number; recommendedMss: number; explanation: string[] }>(`/tunnels/mtu-advice?pathMtu=${pathMtu}&keyed=${keyMode !== "none"}`),
    enabled: open,
  });

  const eligible = (nodesData?.nodes ?? []).filter((n) => n.enrollmentState === "approved");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [mtuOverride, setMtuOverride] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The API canonicalises the key as well; checking here keeps an invalid value
  // from ever being submitted, and shows the operator the exact hex key that
  // will be applied on both nodes.
  const canonicalKey = canonicalGreKey(customKey);
  const customKeyInvalid = keyMode === "custom" && canonicalKey === null;

  const submit = async () => {
    if (customKeyInvalid) {
      toast.error(`GRE key must be ${GRE_KEY_RULE}.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ tunnel: TunnelRecord }>("/tunnels", {
        name: name.trim(),
        sourceNodeId: source,
        destNodeId: dest,
        key: keyMode === "none" ? false : keyMode === "custom" ? canonicalKey : true,
        pathMtu: Number(pathMtu) || 1500,
        mtuOverride: mtuOverride ? Number(mtuOverride) : null,
      });
      toast.success(`Tunnel ${res.tunnel.name} created — deploying to both nodes`);
      onCreated();
      onClose();
      setName("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Create GRE tunnel"
      desc="Both nodes need approved agents. The engine computes MTU from the path; both sides are deployed and ping-verified."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={submitting}
            disabled={!name.trim() || !source || !dest || customKeyInvalid}
          >
            Create & deploy both sides
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <div className="label-micro">Link</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Interface name" required hint="Applied on both nodes (15 chars max)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ir-de-01" maxLength={15} className="mono" autoFocus />
            </Field>
            <Field label="GRE key" hint="Keys the encapsulation — it is not encryption">
              <Select
                value={keyMode}
                onChange={(e) => setKeyMode(e.target.value as "auto" | "custom" | "none")}
              >
                <option value="auto">Auto-generated key</option>
                <option value="custom">Custom key (hexadecimal)</option>
                <option value="none">No key</option>
              </Select>
            </Field>
          </div>

          {keyMode === "custom" && (
            <Field label="Custom GRE key" required hint="1-8 hexadecimal digits, case-insensitive (0 to ffffffff)">
              <Input
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder="ac80001"
                maxLength={10}
                className="mono"
                aria-invalid={customKeyInvalid}
              />
              <p className={cx("mt-1 text-2xs", customKeyInvalid ? "text-danger" : "text-faint")}>
                {canonicalKey !== null
                  ? `Applied as 0x${canonicalKey} (decimal ${parseInt(canonicalKey, 16)}).`
                  : `Must be ${GRE_KEY_RULE}.`}
              </p>
            </Field>
          )}

          {eligible.length < 2 && (
            <p className="rounded-default border border-warning/25 bg-warning-soft px-3 py-2 text-2xs leading-relaxed text-warning">
              Two approved nodes are required. Approve another agent before creating a tunnel.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Source (ingress) node" required hint="Usually the node clients connect to">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Select node…</option>
                {eligible.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                    {n.address ? ` (${n.address})` : " (no address reported)"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Destination (egress) node" required>
              <Select value={dest} onChange={(e) => setDest(e.target.value)}>
                <option value="">Select node…</option>
                {eligible.filter((n) => n.id !== source).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                    {n.address ? ` (${n.address})` : " (no address reported)"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {source && dest && (
            <div className="inset px-3.5 py-3">
              <LinkDiagram
                compact
                status="planned"
                label={keyMode !== "none" ? "GRE · keyed" : "GRE"}
                source={{ name: eligible.find((n) => n.id === source)?.name ?? "source", address: eligible.find((n) => n.id === source)?.address ?? null }}
                dest={{ name: eligible.find((n) => n.id === dest)?.name ?? "destination", address: eligible.find((n) => n.id === dest)?.address ?? null }}
              />
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="label-micro">MTU</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Path MTU" hint="Physical MTU of the underlying path">
              <Input type="number" value={pathMtu} onChange={(e) => setPathMtu(e.target.value)} />
            </Field>
            <Field label="Tunnel MTU override" hint="Empty = use the engine recommendation">
              <Input type="number" value={mtuOverride} onChange={(e) => setMtuOverride(e.target.value)} placeholder={advice ? String(advice.recommendedMtu) : "auto"} />
            </Field>
          </div>
          {advice && (
            <div className="rounded-default border border-info/25 bg-info-soft px-3 py-2 text-2xs leading-relaxed text-muted">
              <span className="text-info">Engine recommends MTU {advice.recommendedMtu} (MSS {advice.recommendedMss}).</span>{" "}
              {advice.explanation.join(" · ")}
            </div>
          )}
        </section>
      </div>
    </Drawer>
  );
}
