import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  CheckCircle2, Copy, LayoutGrid, List, MoreHorizontal, Plus, RefreshCw, Search, Server, ShieldCheck, Ban, X,
} from "lucide-react";
import { api } from "../lib/api";
import type { NodeRecord } from "@arvoo/shared";
import {
  Badge, Button, Card, EmptyState, Field, IconButton, Input, PageHeader, Select, Textarea, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { DataTable } from "../components/ui/data";
import { Drawer, DropdownMenu, DropdownTrigger, DropdownContent, DropdownItem, DropdownSeparator, ConfirmDialog } from "../components/ui/overlay";
import { timeAgo } from "../lib/format";

type View = "table" | "grid";

export function NodesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const showNew = params.get("new") === "1";

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: NodeRecord[] }>("/nodes"),
    refetchInterval: 15_000,
  });

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [region, setRegion] = useState("all");
  const [view, setView] = useState<View>("table");
  const [revoke, setRevoke] = useState<NodeRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const nodes = data?.nodes ?? [];
  const rows = useMemo(
    () =>
      nodes.filter((n) => {
        const q = search.trim().toLowerCase();
        const matchesText =
          !q || n.name.toLowerCase().includes(q) || (n.address ?? "").toLowerCase().includes(q) || (n.provider ?? "").toLowerCase().includes(q);
        const matchesStatus = status === "all" || n.status === status;
        const matchesRegion = region === "all" || n.regionClass === region;
        return matchesText && matchesStatus && matchesRegion;
      }),
    [nodes, search, status, region],
  );

  const filtersActive = search.trim() !== "" || status !== "all" || region !== "all";
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["nodes"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const approve = async (node: NodeRecord) => {
    try {
      await api.post(`/nodes/${node.id}/approve`);
      toast.success(`${node.name} approved`);
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const doRevoke = async () => {
    if (!revoke) return;
    setBusy(true);
    try {
      await api.post(`/nodes/${revoke.id}/revoke`);
      toast.success(`${revoke.name} enrollment revoked`);
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setRevoke(null);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success("Address copied");
  };

  return (
    <div>
      <PageHeader
        title="Nodes"
        icon={<Server size={15} />}
        badge={nodes.length > 0 ? <Badge tone="neutral" mono>{nodes.length}</Badge> : undefined}
        desc="Real servers managed by Arvoo. Each node runs the Arvoo agent, reports live health and executes infrastructure operations."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => refetch()} aria-label="Refresh nodes">
              <RefreshCw size={13} className={cx(isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setParams({ new: "1" })}>
              <Plus size={14} /> Add node
            </Button>
          </>
        }
      />

      {view === "table" ? (
        <DataTable
          loading={isLoading}
          columns={[
            {
              key: "name",
              header: "Node",
              primary: true,
              sortValue: (n) => n.name,
              render: (n) => (
                <div className="min-w-0">
                  <div className="truncate font-medium text-text">{n.name}</div>
                  <div className="mono mt-0.5 truncate text-2xs text-faint">{n.address ?? "no address reported"}</div>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              sortValue: (n) => n.status,
              render: (n) => <UnifiedStatus status={n.status} />,
            },
            {
              key: "agent",
              header: "Agent",
              render: (n) => <UnifiedStatus status={n.enrollmentState} />,
            },
            {
              key: "role",
              header: "Role",
              hideBelow: "md",
              render: (n) => <span className="text-xs capitalize text-muted">{n.role}</span>,
            },
            {
              key: "region",
              header: "Region",
              hideBelow: "sm",
              sortValue: (n) => `${n.regionClass}${n.country ?? ""}`,
              render: (n) => (
                <span className="text-xs text-muted">
                  {n.regionClass === "iran" ? "Iran" : "International"}
                  {n.country ? ` · ${n.country}` : ""}
                </span>
              ),
            },
            {
              key: "platform",
              header: "Platform",
              hideBelow: "lg",
              render: (n) => <span className="truncate text-2xs text-muted">{n.agentPlatform ?? "—"}</span>,
            },
            {
              key: "heartbeat",
              header: "Last seen",
              align: "right",
              sortValue: (n) => n.lastHeartbeatAt ?? "",
              render: (n) => <span className="text-2xs text-muted tnum">{timeAgo(n.lastHeartbeatAt)}</span>,
            },
          ]}
          rows={rows}
          rowKey={(n) => n.id}
          onRowClick={(n) => navigate(`/nodes/${n.id}`)}
          initialSort={{ key: "status", dir: "asc" }}
          toolbar={
            <NodesToolbar
              search={search}
              setSearch={setSearch}
              status={status}
              setStatus={setStatus}
              region={region}
              setRegion={setRegion}
              view={view}
              setView={setView}
              count={rows.length}
              filtersActive={filtersActive}
              onClear={() => {
                setSearch("");
                setStatus("all");
                setRegion("all");
              }}
            />
          }
          rowActions={(n) => <NodeActions node={n} onOpen={() => navigate(`/nodes/${n.id}`)} onApprove={() => approve(n)} onRevoke={() => setRevoke(n)} onCopy={() => copy(n.address ?? n.name)} />}
          empty={
            <EmptyState
              icon={<Server size={18} />}
              title={filtersActive ? "No nodes match these filters" : "No nodes yet"}
              message={
                filtersActive
                  ? "Adjust the search or clear the filters to see all servers."
                  : "Register your first server, then install the Arvoo agent on it and approve the enrollment. The control plane itself can also be registered as a node."
              }
              action={
                filtersActive ? (
                  <Button variant="secondary" onClick={() => { setSearch(""); setStatus("all"); setRegion("all"); }}>
                    Clear filters
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => setParams({ new: "1" })}>
                    <Plus size={14} /> Add node
                  </Button>
                )
              }
            />
          }
        />
      ) : (
        <NodeGrid
          nodes={rows}
          loading={isLoading}
          onOpen={(n) => navigate(`/nodes/${n.id}`)}
          toolbar={
            <NodesToolbar
              search={search}
              setSearch={setSearch}
              status={status}
              setStatus={setStatus}
              region={region}
              setRegion={setRegion}
              view={view}
              setView={setView}
              count={rows.length}
              filtersActive={filtersActive}
              onClear={() => { setSearch(""); setStatus("all"); setRegion("all"); }}
            />
          }
          empty={
            <EmptyState
              icon={<Server size={18} />}
              title={filtersActive ? "No nodes match these filters" : "No nodes yet"}
              message={filtersActive ? "Adjust the search or clear the filters." : "Register your first server and enroll its agent."}
              action={
                <Button variant="primary" size="sm" onClick={() => setParams({ new: "1" })}>
                  <Plus size={14} /> Add node
                </Button>
              }
            />
          }
        />
      )}

      <AddNodeDrawer
        open={showNew}
        onClose={() => setParams({})}
        onCreated={() => {
          invalidate();
        }}
      />

      <ConfirmDialog
        open={!!revoke}
        onOpenChange={() => setRevoke(null)}
        title={`Revoke enrollment for “${revoke?.name ?? ""}”?`}
        message="The node secret becomes invalid immediately: heartbeats and operations stop. The agent must re-enroll with a fresh token and be approved again."
        confirmLabel="Revoke"
        danger
        loading={busy}
        onConfirm={doRevoke}
      />
    </div>
  );
}

function NodesToolbar({
  search, setSearch, status, setStatus, region, setRegion, view, setView, count, filtersActive, onClear,
}: {
  search: string;
  setSearch: (v: string) => void;
  status: string;
  setStatus: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  view: View;
  setView: (v: View) => void;
  count: number;
  filtersActive: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, address or provider…"
          className="pl-8"
          aria-label="Search nodes"
        />
      </div>
      <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className="max-w-[9.5rem]">
        <option value="all">Any status</option>
        <option value="online">Online</option>
        <option value="offline">Offline</option>
        <option value="degraded">Degraded</option>
        <option value="maintenance">Maintenance</option>
      </Select>
      <Select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by region" className="max-w-[9.5rem]">
        <option value="all">Any region</option>
        <option value="international">International</option>
        <option value="iran">Iran</option>
      </Select>
      {filtersActive && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X size={13} /> Clear
        </Button>
      )}
      <span className="hidden text-2xs text-faint sm:inline tnum">{count} shown</span>
      <div className="ml-auto flex items-center gap-0.5 rounded-default border border-line bg-surface-2 p-0.5">
        {([["table", List, "Table view"], ["grid", LayoutGrid, "Card view"]] as const).map(([v, Icon, label]) => (
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
}

function NodeActions({
  node, onOpen, onApprove, onRevoke, onCopy,
}: {
  node: NodeRecord;
  onOpen: () => void;
  onApprove: () => void;
  onRevoke: () => void;
  onCopy: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <IconButton aria-label={`Actions for ${node.name}`} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={15} />
        </IconButton>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem onSelect={onOpen}>
          <Server size={13} /> Open details
        </DropdownItem>
        <DropdownItem onSelect={onCopy}>
          <Copy size={13} /> Copy address
        </DropdownItem>
        {node.enrollmentState === "enrolled" && (
          <>
            <DropdownSeparator />
            <DropdownItem onSelect={onApprove}>
              <ShieldCheck size={13} /> Approve enrollment
            </DropdownItem>
          </>
        )}
        {node.enrollmentState === "approved" && (
          <>
            <DropdownSeparator />
            <DropdownItem danger onSelect={onRevoke}>
              <Ban size={13} /> Revoke enrollment
            </DropdownItem>
          </>
        )}
      </DropdownContent>
    </DropdownMenu>
  );
}

function NodeGrid({
  nodes, loading, onOpen, toolbar, empty,
}: {
  nodes: NodeRecord[];
  loading: boolean;
  onOpen: (n: NodeRecord) => void;
  toolbar: React.ReactNode;
  empty: React.ReactNode;
}) {
  return (
    <Card>
      <div className="border-b border-line px-3 py-2.5">{toolbar}</div>
      {loading ? (
        <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="panel space-y-3 p-3.5">
              <div className="shimmer h-4 w-24 rounded" />
              <div className="shimmer h-3 w-40 rounded" />
              <div className="shimmer h-3 w-28 rounded" />
            </div>
          ))}
        </div>
      ) : nodes.length === 0 ? (
        empty
      ) : (
        <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => onOpen(n)}
              className="panel panel-hover group flex flex-col gap-3 p-3.5 text-left"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-text">{n.name}</span>
                    <span className="text-3xs uppercase tracking-wider text-faint">{n.role}</span>
                  </div>
                  <div className="mono mt-0.5 truncate text-2xs text-faint">{n.address ?? "no address reported"}</div>
                </div>
                <UnifiedStatus status={n.status} />
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-2xs">
                <Meta label="Region" value={`${n.regionClass === "iran" ? "Iran" : "International"}${n.country ? ` · ${n.country}` : ""}`} />
                <Meta label="Agent" value={n.enrollmentState.replace(/_/g, " ")} />
                <Meta label="Provider" value={n.provider ?? "—"} />
                <Meta label="Last seen" value={timeAgo(n.lastHeartbeatAt)} />
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-line/70 pt-2.5 text-3xs text-faint">
                <span className="mono truncate">{n.agentPlatform ?? "platform unknown"}</span>
                <span className="flex items-center gap-1 text-muted opacity-0 transition-opacity group-hover:opacity-100">
                  Open <CheckCircle2 size={11} />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="label-micro">{label}</div>
      <div className="mt-0.5 truncate capitalize text-muted">{value}</div>
    </div>
  );
}

function AddNodeDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState({ name: "", role: "vpn", regionClass: "international", country: "", provider: "", description: "" });
  const [submitting, setSubmitting] = useState(false);
  const [enrollment, setEnrollment] = useState<{ nodeId: string; token: string; expiresAt: string } | null>(null);

  const reset = () => {
    setStep(1);
    setForm({ name: "", role: "vpn", regionClass: "international", country: "", provider: "", description: "" });
    setEnrollment(null);
  };

  const close = () => {
    onClose();
    reset();
  };

  const submit = async () => {
    if (!form.name.trim()) {
      toast.error("Node name is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ node: NodeRecord; enrollment: { token: string; expiresAt: string } }>("/nodes", {
        name: form.name.trim(),
        role: form.role,
        regionClass: form.regionClass,
        country: form.country || null,
        provider: form.provider || null,
        description: form.description || null,
      });
      setEnrollment({ nodeId: res.node.id, token: res.enrollment.token, expiresAt: res.enrollment.expiresAt });
      setStep(2);
      onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const controlPlaneUrl = window.location.origin.replace(/:\d+$/, ":4001");
  const enrollCommand = `ARVOO_CONTROL_PLANE_URL=${controlPlaneUrl} npx tsx src/index.ts enroll ${enrollment?.token ?? ""}`;

  return (
    <Drawer
      open={open}
      onOpenChange={(v) => !v && close()}
      title={step === 1 ? "Add node" : "Node created — enroll the agent"}
      desc={
        step === 1
          ? "Register a real server. The Arvoo agent must then be installed and enrolled on that machine."
          : "Run the agent on the server with this one-time token. It expires in 10 minutes and can be used once."
      }
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} loading={submitting}>
              Create node & issue token
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const id = enrollment?.nodeId;
                close();
                if (id) window.location.assign(`/nodes/${id}`);
              }}
            >
              Open node page
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="space-y-5">
          <section className="space-y-3">
            <div className="label-micro">Identity</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Node name" required hint="Short, unique label — e.g. DE-01">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="DE-01" autoFocus />
              </Field>
              <Field label="Role">
                <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="vpn">VPN</option>
                  <option value="master">Master (this server)</option>
                  <option value="edge">Edge</option>
                  <option value="gateway">Gateway</option>
                  <option value="transit">Transit</option>
                  <option value="custom">Custom</option>
                </Select>
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <div className="label-micro">Location</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Region class" hint="Drives routing and quota policy defaults">
                <Select value={form.regionClass} onChange={(e) => setForm({ ...form, regionClass: e.target.value })}>
                  <option value="international">International</option>
                  <option value="iran">Iran</option>
                </Select>
              </Field>
              <Field label="Country">
                <Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Germany" />
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <div className="label-micro">Metadata</div>
            <Field label="Provider">
              <Input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="Hetzner" />
            </Field>
            <Field label="Description" hint="Visible to operators only — never sent to the node">
              <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this node used for?" />
            </Field>
          </section>
        </div>
      ) : (
        <div className="space-y-4">
          <ol className="space-y-2">
            {[
              "Install Node.js 22+ on the server.",
              "Copy the Arvoo agent folder to the node (signed package distribution is planned).",
              "Run the enrollment command below on the node.",
              "Approve the node from its detail page once it appears as enrolled.",
            ].map((line, i) => (
              <li key={i} className="flex gap-2.5 text-xs leading-relaxed text-muted">
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-3xs text-muted tnum">
                  {i + 1}
                </span>
                {line}
              </li>
            ))}
          </ol>
          <CodeRow value={enrollCommand} />
          <div className="flex items-start gap-2.5 rounded-default border border-warning/25 bg-warning-soft px-3 py-2.5 text-2xs leading-relaxed text-warning">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            <span>
              This token is shown once and expires {new Date(enrollment?.expiresAt ?? "").toLocaleTimeString()}. Anyone holding it can enroll a
              node — treat it like a password.
            </span>
          </div>
        </div>
      )}
    </Drawer>
  );
}

function CodeRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="inset flex items-start gap-2 p-3">
      <code className="mono min-w-0 flex-1 break-all text-2xs leading-relaxed text-text/90">{value}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
          toast.success("Command copied");
        }}
      >
        {copied ? <CheckCircle2 size={13} className="text-success" /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
