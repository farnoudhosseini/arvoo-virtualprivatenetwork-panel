import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowUpRight, Copy, MoreHorizontal, PauseCircle, PlayCircle, Plus, RefreshCw, RefreshCcw, Search, ShieldOff, Users, X,
} from "lucide-react";
import { api } from "../lib/api";
import type { ClientRecord } from "@arvoo/shared";
import {
  Badge, Button, EmptyState, Field, IconButton, Input, Meter, PageHeader, Select, Textarea, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { DataTable, StatCard } from "../components/ui/data";
import { Drawer, DropdownMenu, DropdownTrigger, DropdownContent, DropdownItem, DropdownSeparator, ConfirmDialog } from "../components/ui/overlay";
import { formatBytes, timeAgo } from "../lib/format";

export function ClientsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [quotaFilter, setQuotaFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<"suspend" | "resume" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["clients", search, statusFilter],
    queryFn: () =>
      api.get<{ clients: ClientRecord[]; total: number }>(
        `/clients?limit=200&search=${encodeURIComponent(search)}${statusFilter ? `&status=${statusFilter}` : ""}`,
      ),
    refetchInterval: 15_000,
  });

  const clients = data?.clients ?? [];

  const rows = useMemo(
    () =>
      clients.filter((c) => {
        if (quotaFilter === "unlimited") return c.limits.trafficQuotaBytes == null;
        if (quotaFilter === "near") {
          if (c.limits.trafficQuotaBytes == null) return false;
          return c.usedBilledBytes / c.limits.trafficQuotaBytes > 0.8;
        }
        if (quotaFilter === "expiring") {
          if (!c.limits.expiresAt) return false;
          return new Date(c.limits.expiresAt).getTime() - Date.now() < 7 * 86400_000;
        }
        return true;
      }),
    [clients, quotaFilter],
  );

  const stats = useMemo(() => {
    const active = clients.filter((c) => c.status === "active").length;
    const suspended = clients.filter((c) => c.status === "suspended").length;
    const totalUsed = clients.reduce((a, c) => a + c.usedBilledBytes, 0);
    const nearQuota = clients.filter((c) => c.limits.trafficQuotaBytes != null && c.usedBilledBytes / c.limits.trafficQuotaBytes > 0.8).length;
    return { total: data?.total ?? 0, active, suspended, totalUsed, nearQuota };
  }, [clients, data]);

  const filtersActive = search.trim() !== "" || statusFilter !== "" || quotaFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setStatusFilter("");
    setQuotaFilter("all");
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["clients"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const act = async (client: ClientRecord, kind: "suspend" | "resume" | "revoke" | "rotate") => {
    try {
      await api.post(`/clients/${client.id}/${kind}`);
      toast.success(
        kind === "suspend"
          ? `${client.username} suspended — new connections denied`
          : kind === "resume"
            ? `${client.username} resumed`
            : kind === "revoke"
              ? `${client.username} revoked — certificate invalidated`
              : `${client.username} certificate rotated`,
      );
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const runBulk = async () => {
    if (!bulkAction || selected.length === 0) return;
    setBusy(true);
    const targets = clients.filter((c) => selected.includes(c.id));
    const results = await Promise.allSettled(targets.map((c) => api.post(`/clients/${c.id}/${bulkAction}`)));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === 0) toast.success(`${targets.length} client${targets.length === 1 ? "" : "s"} ${bulkAction === "revoke" ? "revoked" : bulkAction + "d"}`);
    else toast.error(`${failed} of ${targets.length} failed — check the audit log`);
    setBusy(false);
    setBulkAction(null);
    setSelected([]);
    invalidate();
  };

  const copyUsername = (c: ClientRecord) => {
    void navigator.clipboard.writeText(c.username);
    toast.success(`Copied ${c.username}`);
  };

  return (
    <div>
      <PageHeader
        icon={<Users size={15} />}
        title="Clients"
        badge={stats.total > 0 ? <Badge tone="neutral" mono>{stats.total}</Badge> : undefined}
        desc="VPN identities with quotas, device limits and policy-driven multipliers. Usage is billed from real session telemetry."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh clients">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setParams({ new: "1" })}>
              <Plus size={14} /> New client
            </Button>
          </>
        }
      />

      <div className="grid-cards mb-4">
        <StatCard label="Clients" value={stats.total} icon={<Users size={14} />} sub={`${stats.active} active · ${stats.suspended} suspended`} />
        <StatCard
          label="Near quota"
          value={stats.nearQuota}
          tone={stats.nearQuota > 0 ? "warning" : "success"}
          sub="above 80% of their traffic quota"
        />
        <StatCard label="Billed usage" value={formatBytes(stats.totalUsed)} sub="multipliers applied" />
      </div>

      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-default border border-accent/30 bg-accent-soft px-3 py-2">
          <span className="text-2xs font-medium text-text tnum">{selected.length} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setBulkAction("suspend")}>
              <PauseCircle size={12} /> Suspend
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setBulkAction("resume")}>
              <PlayCircle size={12} /> Resume
            </Button>
            <Button size="sm" variant="danger" onClick={() => setBulkAction("revoke")}>
              <ShieldOff size={12} /> Revoke
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              <X size={12} /> Clear
            </Button>
          </div>
        </div>
      )}

      <DataTable
        loading={isLoading}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        columns={[
          {
            key: "username",
            header: "Client",
            primary: true,
            sortValue: (c) => c.username,
            render: (c) => (
              <div className="min-w-0">
                <div className="mono truncate font-medium text-text">{c.username}</div>
                <div className="mt-0.5 truncate text-2xs text-faint">
                  {c.displayName ?? "no display name"}
                  {c.baseMultiplier !== 1 && ` · ${c.baseMultiplier}× billing`}
                </div>
              </div>
            ),
          },
          { key: "status", header: "Status", sortValue: (c) => c.status, render: (c) => <UnifiedStatus status={c.status} /> },
          {
            key: "quota",
            header: "Quota",
            sortValue: (c) => (c.limits.trafficQuotaBytes ? c.usedBilledBytes / c.limits.trafficQuotaBytes : -1),
            render: (c) => {
              const pct = c.limits.trafficQuotaBytes ? (c.usedBilledBytes / c.limits.trafficQuotaBytes) * 100 : null;
              return (
                <div className="w-32">
                  {pct != null ? (
                    <Meter pct={pct} size="sm" label={<span className="text-3xs">{formatBytes(c.usedBilledBytes)} / {formatBytes(c.limits.trafficQuotaBytes)}</span>} />
                  ) : (
                    <span className="text-2xs text-faint">{formatBytes(c.usedBilledBytes)} · unlimited</span>
                  )}
                </div>
              );
            },
          },
          {
            key: "limits",
            header: "Limits",
            hideBelow: "md",
            render: (c) => (
              <span className="text-2xs text-muted tnum">
                {c.limits.deviceLimit != null ? `${c.limits.deviceLimit} dev` : "∞ dev"}
                {" · "}
                {c.limits.ipLimit != null ? `${c.limits.ipLimit} IP` : "∞ IP"}
              </span>
            ),
          },
          {
            key: "multiplier",
            header: "Multiplier",
            align: "right",
            hideBelow: "lg",
            sortValue: (c) => c.baseMultiplier,
            render: (c) => <Badge tone={c.baseMultiplier === 1 ? "neutral" : "info"} mono>{c.baseMultiplier}×</Badge>,
          },
          {
            key: "expires",
            header: "Expires",
            align: "right",
            sortValue: (c) => c.limits.expiresAt ?? "",
            render: (c) => {
              const expires = c.limits.expiresAt;
              const soon = expires ? new Date(expires).getTime() - Date.now() < 7 * 86400_000 : false;
              return <span className={cx("text-2xs", soon ? "text-warning" : "text-muted")}>{expires ? timeAgo(expires) : "never"}</span>;
            },
          },
          {
            key: "created",
            header: "Created",
            align: "right",
            hideBelow: "lg",
            sortValue: (c) => c.createdAt,
            render: (c) => <span className="text-2xs text-faint">{timeAgo(c.createdAt)}</span>,
          },
        ]}
        rows={rows}
        rowKey={(c) => c.id}
        onRowClick={(c) => navigate(`/clients/${c.id}`)}
        initialSort={{ key: "created", dir: "desc" }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search username or name…" className="pl-8" aria-label="Search clients" />
            </div>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status" className="max-w-[9.5rem]">
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="expired">Expired</option>
              <option value="revoked">Revoked</option>
              <option value="suspended_quota">Quota exceeded</option>
            </Select>
            <Select value={quotaFilter} onChange={(e) => setQuotaFilter(e.target.value)} aria-label="Filter by quota state" className="max-w-[11rem]">
              <option value="all">Any quota state</option>
              <option value="near">Near quota (&gt;80%)</option>
              <option value="expiring">Expiring in 7 days</option>
              <option value="unlimited">Unlimited plans</option>
            </Select>
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X size={13} /> Clear
              </Button>
            )}
            <span className="hidden text-2xs text-faint sm:inline tnum">{rows.length} shown</span>
          </div>
        }
        rowActions={(c) => (
          <DropdownMenu>
            <DropdownTrigger asChild>
              <IconButton aria-label={`Actions for ${c.username}`} onClick={(e) => e.stopPropagation()}>
                <MoreHorizontal size={15} />
              </IconButton>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownItem onSelect={() => navigate(`/clients/${c.id}`)}>
                <ArrowUpRight size={13} /> Open client
              </DropdownItem>
              <DropdownItem onSelect={() => copyUsername(c)}>
                <Copy size={13} /> Copy username
              </DropdownItem>
              <DropdownSeparator />
              {c.status === "suspended" ? (
                <DropdownItem onSelect={() => act(c, "resume")}>
                  <PlayCircle size={13} /> Resume access
                </DropdownItem>
              ) : (
                <DropdownItem onSelect={() => act(c, "suspend")}>
                  <PauseCircle size={13} /> Suspend access
                </DropdownItem>
              )}
              <DropdownItem onSelect={() => act(c, "rotate")}>
                <RefreshCcw size={13} /> Rotate certificate
              </DropdownItem>
              <DropdownSeparator />
              <DropdownItem danger onSelect={() => act(c, "revoke")}>
                <ShieldOff size={13} /> Revoke permanently
              </DropdownItem>
            </DropdownContent>
          </DropdownMenu>
        )}
        empty={
          <EmptyState
            icon={<Users size={18} />}
            title={filtersActive ? "No clients match these filters" : "No clients yet"}
            message={
              filtersActive
                ? "Adjust the search or clear the filters to see every identity."
                : "Clients are real VPN identities with certificates, quotas and policies. Create one, assign it to an inbound, then download the .ovpn profile."
            }
            action={
              filtersActive ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setParams({ new: "1" })}>
                  <Plus size={14} /> New client
                </Button>
              )
            }
          />
        }
      />

      <NewClientDrawer
        open={params.get("new") === "1"}
        onClose={() => setParams({})}
        onCreated={(id) => {
          invalidate();
          navigate(`/clients/${id}`);
        }}
      />

      <ConfirmDialog
        open={bulkAction != null}
        onOpenChange={() => setBulkAction(null)}
        danger={bulkAction === "revoke"}
        title={
          bulkAction === "revoke"
            ? `Revoke ${selected.length} client${selected.length === 1 ? "" : "s"}?`
            : `${bulkAction === "suspend" ? "Suspend" : "Resume"} ${selected.length} client${selected.length === 1 ? "" : "s"}?`
        }
        message={
          bulkAction === "revoke"
            ? "Every selected certificate is invalidated permanently. Clients cannot reconnect until their certificates are rotated and new profiles delivered."
            : bulkAction === "suspend"
              ? "New connections are denied immediately; usage and configuration are preserved."
              : "Selected clients can connect again, subject to quotas and policies."
        }
        confirmLabel={bulkAction === "revoke" ? "Revoke permanently" : "Apply"}
        loading={busy}
        onConfirm={runBulk}
      />
    </div>
  );
}

function NewClientDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { data: inboundsData } = useQuery({
    queryKey: ["inbounds"],
    queryFn: () => api.get<{ inbounds: Array<{ id: string; name: string }> }>("/inbounds"),
    enabled: open,
  });

  const [form, setForm] = useState({ username: "", displayName: "", trafficGb: "", days: "30", deviceLimit: "2", ipLimit: "2", multiplier: "1.0" });
  const [selectedInbounds, setSelectedInbounds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const reset = () => {
    setForm({ username: "", displayName: "", trafficGb: "", days: "30", deviceLimit: "2", ipLimit: "2", multiplier: "1.0" });
    setSelectedInbounds([]);
    setNotes("");
  };

  const close = () => {
    onClose();
    reset();
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const expiresAt = form.days && Number(form.days) > 0 ? new Date(Date.now() + Number(form.days) * 86400_000).toISOString() : null;
      const res = await api.post<{ client: ClientRecord }>("/clients", {
        username: form.username.trim(),
        displayName: form.displayName || null,
        notes: notes || null,
        baseMultiplier: Number(form.multiplier) || 1,
        limits: {
          trafficQuotaBytes: form.trafficGb ? Number(form.trafficGb) * 1024 ** 3 : null,
          expiresAt,
          deviceLimit: form.deviceLimit ? Number(form.deviceLimit) : null,
          ipLimit: form.ipLimit ? Number(form.ipLimit) : null,
        },
        inboundIds: selectedInbounds,
      });
      toast.success(`Client ${res.client.username} created with a fresh certificate`);
      onCreated(res.client.id);
      close();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const inbounds = inboundsData?.inbounds ?? [];

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(v) => !v && close()}
        title="New client"
        desc="Creates a real X.509 client certificate under the Arvoo CA. Quotas are enforced at connection time."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setConfirmOpen(true)} disabled={!form.username.trim()}>
              Create client
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <section className="space-y-3">
            <div className="label-micro">Identity</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Username" required hint="Used as the certificate CN">
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="client-A" className="mono" autoFocus />
              </Field>
              <Field label="Display name">
                <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Optional" />
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <div className="label-micro">Quota & access</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Traffic quota (GB)" hint="Empty = unlimited; consumption is multiplied">
                <Input type="number" value={form.trafficGb} onChange={(e) => setForm({ ...form, trafficGb: e.target.value })} placeholder="100" />
              </Field>
              <Field label="Expires in (days)" hint="Empty or 0 = never expires">
                <Input type="number" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
              </Field>
              <Field label="Device (HWID) limit">
                <Input type="number" value={form.deviceLimit} onChange={(e) => setForm({ ...form, deviceLimit: e.target.value })} />
              </Field>
              <Field label="IP limit" hint="Distinct source IPs allowed">
                <Input type="number" value={form.ipLimit} onChange={(e) => setForm({ ...form, ipLimit: e.target.value })} />
              </Field>
              <Field label="Usage multiplier" className="sm:col-span-2" hint="1.0 = normal consumption; 1.5 bills traffic at 150%">
                <Input type="number" step="0.1" value={form.multiplier} onChange={(e) => setForm({ ...form, multiplier: e.target.value })} />
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <div className="label-micro">Inbounds</div>
            <Field label="Assign to inbounds" hint="Clients only appear on the endpoints you assign">
              <div className="flex flex-wrap gap-1.5">
                {inbounds.length === 0 && <span className="text-2xs text-faint">No inbounds exist yet — create an endpoint first.</span>}
                {inbounds.map((i) => {
                  const active = selectedInbounds.includes(i.id);
                  return (
                    <button
                      key={i.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSelectedInbounds((s) => (active ? s.filter((x) => x !== i.id) : [...s, i.id]))}
                      className={cx(
                        "mono rounded-full border px-2.5 py-1 text-2xs transition-colors duration-fast",
                        active ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-muted hover:border-line-strong hover:text-text",
                      )}
                    >
                      {i.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          </section>

          <section className="space-y-3">
            <div className="label-micro">Notes</div>
            <Field label="Admin notes" hint="Internal only — never shown to the client">
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Who is this client, what is it for?" />
            </Field>
          </section>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Create client “${form.username}”?`}
        message="A private key is generated for this client. The .ovpn profile can be downloaded afterwards; credentials can be rotated or revoked at any time."
        confirmLabel="Create client"
        loading={submitting}
        onConfirm={() => {
          setConfirmOpen(false);
          void submit();
        }}
      />
    </>
  );
}
