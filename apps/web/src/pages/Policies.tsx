import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitBranch, Plus, ShieldCheck, Trash2, Zap } from "lucide-react";
import { api } from "../lib/api";
import type { PolicyRuleRecord, PolicyCondition, PolicyAction } from "@arvoo/shared";
import { Badge, Button, Card, EmptyState, Field, Input, LoadingState, PageHeader, Select, Switch, cx } from "../components/ui/primitives";
import { StatCard } from "../components/ui/data";
import { ConfirmDialog, Drawer } from "../components/ui/overlay";
import { timeAgo } from "../lib/format";

const CONDITION_TYPES = [
  ["client", "Client ID"],
  ["inbound", "Inbound"],
  ["node", "Node"],
  ["sourceIp", "Source IP"],
  ["timeOfDay", "Time of day (minutes)"],
  ["dayOfWeek", "Day of week (0=Sun)"],
  ["trafficUsedBytes", "Traffic used (bytes)"],
  ["activeSessions", "Active sessions"],
  ["deviceCount", "Device count"],
] as const;

const ACTIONS: Array<{ type: PolicyAction["type"]; label: string; params?: string[] }> = [
  { type: "apply_multiplier", label: "Apply usage multiplier", params: ["multiplier"] },
  { type: "deny", label: "Deny connection" },
  { type: "suspend", label: "Suspend client" },
  { type: "limit_bandwidth", label: "Limit bandwidth", params: ["downloadKbps", "uploadKbps"] },
  { type: "limit_sessions", label: "Limit concurrent sessions", params: ["max"] },
  { type: "limit_devices", label: "Limit devices", params: ["max"] },
  { type: "alert", label: "Raise alert" },
];

export function PoliciesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PolicyRuleRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["policies"],
    queryFn: () => api.get<{ policies: PolicyRuleRecord[] }>("/policies"),
  });

  const policies = data?.policies ?? [];
  const enabled = policies.filter((p) => p.enabled).length;
  const restrictive = policies.filter((p) => p.actions.some((a) => a.type === "deny" || a.type === "suspend")).length;

  const toggle = async (p: PolicyRuleRecord) => {
    try {
      await api.patch(`/policies/${p.id}`, { enabled: !p.enabled });
      void queryClient.invalidateQueries({ queryKey: ["policies"] });
      toast.success(p.enabled ? `${p.name} disabled` : `${p.name} enabled`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.delete(`/policies/${deleteTarget.id}`);
      toast.success(`Policy ${deleteTarget.name} deleted`);
      void queryClient.invalidateQueries({ queryKey: ["policies"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<ShieldCheck size={15} />}
        title="Policies"
        badge={policies.length > 0 ? <Badge tone="neutral" mono>{policies.length}</Badge> : undefined}
        desc="IF-THEN rules evaluated on every connection: multipliers, bandwidth caps, session and device limits, denial windows. Lower priority number wins."
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New policy
          </Button>
        }
      />

      {policies.length > 0 && (
        <div className="grid-cards mb-4">
          <StatCard label="Policies" value={policies.length} icon={<ShieldCheck size={14} />} sub={`${enabled} enabled · ${policies.length - enabled} disabled`} />
          <StatCard label="Restrictive" value={restrictive} tone={restrictive > 0 ? "warning" : "default"} icon={<Zap size={14} />} sub="rules that deny or suspend" />
          <StatCard label="Conditional" value={policies.filter((p) => p.conditions.length > 0).length} icon={<GitBranch size={14} />} sub="rules with explicit conditions" />
        </div>
      )}

      {isLoading ? (
        <LoadingState label="Loading policies…" />
      ) : policies.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldCheck size={18} />}
            title="No policies defined"
            message="Policies compose: multipliers multiply across matching rules, first-wins applies to caps. Example: a 1.5× multiplier during peak hours."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} /> Create first policy
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {policies.map((p) => (
            <Card key={p.id} className={cx("flex flex-col", !p.enabled && "opacity-70")}>
              <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-[13px] font-semibold text-text">{p.name}</h3>
                    <Badge tone={p.enabled ? "success" : "neutral"}>{p.enabled ? "enabled" : "disabled"}</Badge>
                  </div>
                  {p.description && <p className="mt-0.5 text-2xs text-muted">{p.description}</p>}
                </div>
                <Switch checked={!!p.enabled} onCheckedChange={() => toggle(p)} label={`Toggle ${p.name}`} />
              </div>

              <div className="flex-1 space-y-3 px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="neutral" mono>
                    priority {p.priority}
                  </Badge>
                  {p.effectiveFrom && <Badge tone="info">from {timeAgo(p.effectiveFrom)}</Badge>}
                  {p.effectiveUntil && <Badge tone="warning">until {timeAgo(p.effectiveUntil)}</Badge>}
                </div>

                <div>
                  <div className="label-micro mb-1.5">If</div>
                  {p.conditions.length === 0 ? (
                    <div className="rounded-default border border-line/70 bg-surface-2 px-2.5 py-1.5 text-2xs text-muted">
                      Always — every client
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {p.conditions.map((c, i) => (
                        <ConditionRow key={i} cond={c} />
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="label-micro mb-1.5">Then</div>
                  <div className="flex flex-wrap gap-1.5">
                    {p.actions.map((a, i) => (
                      <Badge
                        key={i}
                        tone={a.type === "deny" || a.type === "suspend" ? "danger" : a.type === "apply_multiplier" ? "info" : "neutral"}
                        mono
                      >
                        {a.type}
                        {a.params ? ` ${Object.values(a.params).join("/")}` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
                <span className="text-3xs text-faint">applies at the next connection check</span>
                <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(p)} aria-label={`Delete ${p.name}`}>
                  <Trash2 size={13} className="text-danger" /> Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <NewPolicyDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["policies"] })}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={() => setDeleteTarget(null)}
        title={`Delete policy “${deleteTarget?.name}”?`}
        message="The rule stops applying immediately to every client it matched. This cannot be undone."
        confirmLabel="Delete policy"
        danger
        loading={busy}
        onConfirm={remove}
      />
    </div>
  );
}

function ConditionRow({ cond }: { cond: PolicyCondition }) {
  return (
    <div className="mono flex items-center gap-2 rounded-default border border-line/70 bg-surface-2 px-2.5 py-1.5 text-2xs">
      <span className="text-text">{cond.type}</span>
      <span className="text-faint">{cond.op}</span>
      <span className="min-w-0 truncate text-muted">{JSON.stringify(cond.value)}</span>
    </div>
  );
}

function NewPolicyDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("100");
  const [conditions, setConditions] = useState<Array<{ type: string; op: string; value: string }>>([{ type: "client", op: "eq", value: "" }]);
  const [actionType, setActionType] = useState<PolicyAction["type"]>("apply_multiplier");
  const [param1, setParam1] = useState("1.5");
  const [param2, setParam2] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const actionDef = ACTIONS.find((a) => a.type === actionType)!;

  const submit = async () => {
    setSubmitting(true);
    try {
      const cleanConditions = conditions
        .filter((c) => c.value !== "")
        .map((c) => {
          const numeric = ["timeOfDay", "dayOfWeek", "trafficUsedBytes", "activeSessions", "deviceCount"].includes(c.type);
          return { type: c.type, op: c.op, value: numeric ? Number(c.value) : c.value } as PolicyCondition;
        });
      const params: Record<string, number> = {};
      if (actionDef.params?.[0]) params[actionDef.params[0]] = Number(param1);
      if (actionDef.params?.[1] && param2) params[actionDef.params[1]] = Number(param2);
      await api.post("/policies", {
        name: name.trim(),
        priority: Number(priority) || 100,
        conditions: cleanConditions,
        actions: [{ type: actionType, params: actionDef.params ? params : undefined }],
      });
      toast.success("Policy created");
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
      title="New policy"
      desc="Every condition must match for the action to apply. Lower priority numbers evaluate first."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={submitting} disabled={!name.trim()}>
            Create policy
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <div className="label-micro">Rule</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Policy name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="peak-hours-multiplier" className="mono" autoFocus />
            </Field>
            <Field label="Priority" hint="Lower evaluates first; first rule wins for caps">
              <Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <div className="label-micro">Conditions</div>
          <div className="space-y-2">
            {conditions.map((c, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <Select
                  value={c.type}
                  onChange={(e) => setConditions(conditions.map((x, i) => (i === idx ? { ...x, type: e.target.value } : x)))}
                  className="max-w-[11rem]"
                  aria-label="Condition type"
                >
                  {CONDITION_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Select
                  value={c.op}
                  onChange={(e) => setConditions(conditions.map((x, i) => (i === idx ? { ...x, op: e.target.value } : x)))}
                  className="max-w-[6.5rem]"
                  aria-label="Operator"
                >
                  {["eq", "ne", "in", "not_in", "lt", "lte", "gt", "gte"].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
                <Input
                  value={c.value}
                  onChange={(e) => setConditions(conditions.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)))}
                  className="min-w-32 flex-1"
                  placeholder="value"
                  aria-label="Condition value"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove condition"
                  onClick={() => setConditions(conditions.filter((_, i) => i !== idx))}
                  disabled={conditions.length === 1}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setConditions([...conditions, { type: "client", op: "eq", value: "" }])}>
            <Plus size={12} /> Add condition
          </Button>
          <p className="text-2xs text-faint">Conditions left empty are ignored — a policy with no conditions applies to every client.</p>
        </section>

        <section className="space-y-3">
          <div className="label-micro">Action</div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={actionType} onChange={(e) => setActionType(e.target.value as PolicyAction["type"])} className="max-w-[15rem]" aria-label="Action">
              {ACTIONS.map((a) => (
                <option key={a.type} value={a.type}>
                  {a.label}
                </option>
              ))}
            </Select>
            {actionDef.params?.[0] && <Input value={param1} onChange={(e) => setParam1(e.target.value)} placeholder={actionDef.params[0]} className="max-w-36" />}
            {actionDef.params?.[1] && <Input value={param2} onChange={(e) => setParam2(e.target.value)} placeholder={actionDef.params[1]} className="max-w-36" />}
          </div>
        </section>
      </div>
    </Drawer>
  );
}
