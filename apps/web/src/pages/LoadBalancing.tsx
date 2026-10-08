import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Gauge, Plus, RefreshCcw, Scale, ShieldOff, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, KeyValue, LoadingState, PageHeader, Select,
  Switch, cx,
} from "../components/ui/primitives";
import { Dialog, DialogContent } from "../components/ui/overlay";
import { timeAgo } from "../lib/format";

interface MemberView {
  id: string;
  kind: "inbound" | "node";
  refId: string;
  name: string;
  nodeName: string | null;
  weight: number;
  priority: number;
  enabled: boolean;
  drained: boolean;
  drainReason: string | null;
  healthy: boolean;
  state: string;
  reasons: string[];
  latencyMs: number | null;
  lossPct: number | null;
  successRatePct: number | null;
  checkedAt: string | null;
  activeSessions: number;
  inboundStatus: string | null;
  weightSharePct: number;
}

interface GroupView {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  mode: "weighted" | "failover" | "least-load";
  healthRequirements: { minSuccessRatePct: number | null; maxLatencyMs: number | null; maxLossPct: number | null; requireNodeOnline: boolean };
  failover: { redirectNewSessions: boolean; keepExistingSessions: boolean; autoDrain: boolean; autoRestore: boolean };
  members: MemberView[];
  healthyMembers: number;
  totalMembers: number;
  activeSessions: number;
}

const stateTone: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  healthy: "success",
  degraded: "warning",
  unhealthy: "danger",
  drained: "info",
  disabled: "neutral",
  unknown: "neutral",
};

/**
 * Load balancing: a small, deliberately simple layer over the routing engine.
 * Every number shown here is measured (probe success rate, latency, loss,
 * sessions, traffic). Members that were never probed are labelled "unknown"
 * instead of being presented as healthy.
 */
export function LoadBalancingPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [memberGroup, setMemberGroup] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"weighted" | "failover" | "least-load">("weighted");
  const [autoDrain, setAutoDrain] = useState(false);
  const [autoRestore, setAutoRestore] = useState(false);
  const [minSuccess, setMinSuccess] = useState("80");
  const [maxLatency, setMaxLatency] = useState("250");
  const [maxLoss, setMaxLoss] = useState("10");
  const [memberKind, setMemberKind] = useState<"inbound" | "node">("inbound");
  const [memberRef, setMemberRef] = useState("");
  const [memberWeight, setMemberWeight] = useState("100");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["lb"],
    queryFn: () => api.get<{ groups: GroupView[] }>("/lb/groups"),
    refetchInterval: 15_000,
  });
  const { data: inbounds } = useQuery({
    queryKey: ["inbounds", "options"],
    queryFn: () => api.get<{ inbounds: Array<{ id: string; name: string; status: string }> }>("/inbounds"),
    enabled: !!memberGroup,
  });
  const { data: nodes } = useQuery({
    queryKey: ["nodes", "options"],
    queryFn: () => api.get<{ nodes: Array<{ id: string; name: string; status: string }> }>("/nodes"),
    enabled: !!memberGroup,
  });

  const createGroup = async () => {
    setBusy("create");
    try {
      await api.post("/lb/groups", {
        name,
        description: description || null,
        mode,
        healthRequirements: {
          minSuccessRatePct: minSuccess ? Number(minSuccess) : null,
          maxLatencyMs: maxLatency ? Number(maxLatency) : null,
          maxLossPct: maxLoss ? Number(maxLoss) : null,
          requireNodeOnline: true,
        },
        failover: { redirectNewSessions: true, keepExistingSessions: true, autoDrain, autoRestore },
      });
      toast.success(`Group ${name} created`);
      setCreateOpen(false);
      setName("");
      setDescription("");
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addMember = async (groupId: string) => {
    if (!memberRef) {
      toast.error("Select a member first");
      return;
    }
    setBusy(`member:${groupId}`);
    try {
      await api.post(`/lb/groups/${groupId}/members`, {
        kind: memberKind,
        refId: memberRef,
        weight: Number(memberWeight) || 100,
      });
      toast.success("Member added");
      setMemberGroup(null);
      setMemberRef("");
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const updateMember = async (memberId: string, patch: Record<string, unknown>) => {
    setBusy(memberId);
    try {
      await api.patch(`/lb/members/${memberId}`, patch);
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const memberAction = async (memberId: string, action: "drain" | "restore") => {
    setBusy(`${action}:${memberId}`);
    try {
      await api.post(`/lb/members/${memberId}/${action}`, { reason: action === "drain" ? "Manual drain from the panel" : undefined });
      toast.success(action === "drain" ? "Member drained (existing sessions stay)" : "Member restored");
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (memberId: string) => {
    setBusy(`remove:${memberId}`);
    try {
      await api.delete(`/lb/members/${memberId}`);
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteGroup = async (groupId: string) => {
    setBusy(`delete:${groupId}`);
    try {
      await api.delete(`/lb/groups/${groupId}`);
      toast.success("Group deleted");
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const choose = async (groupId: string) => {
    setBusy(`choose:${groupId}`);
    try {
      const result = await api.post<{ memberName: string | null; degraded: boolean; reason: string }>(
        `/lb/groups/${groupId}/choose`,
      );
      if (result.memberName) {
        toast.success(`Next session would go to ${result.memberName}${result.degraded ? " (unhealthy fallback)" : ""}`);
      } else {
        toast.error(result.reason);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <LoadingState label="Measuring member health…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  const groups = data?.groups ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Load balancing"
        desc="Groups of inbounds or nodes with weights, health thresholds and failover. Health comes from real probes and sessions."
        actions={
          <>
            <Button variant="secondary" onClick={() => void refetch()}>
              <RefreshCcw size={14} /> Refresh
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> New group
            </Button>
          </>
        }
      />

      {groups.length === 0 && (
        <EmptyState
          icon={<Scale size={18} />}
          title="No load-balancing group yet"
          message="Create a group, add inbounds or nodes as members and set weights and health limits. Failover decisions then use measured state."
        />
      )}

      <div className="grid gap-3">
        {groups.map((group) => (
          <Card key={group.id}>
            <CardHeader
              title={group.name}
              desc={`${group.mode} · ${group.healthyMembers}/${group.totalMembers} healthy · ${group.activeSessions} active session(s)`}
              icon={<Scale size={14} />}
              actions={
                <>
                  <Button variant="secondary" loading={busy === `choose:${group.id}`} onClick={() => void choose(group.id)}>
                    <Gauge size={14} /> Where next session goes
                  </Button>
                  <Button variant="secondary" onClick={() => setMemberGroup(group.id)}>
                    <Plus size={14} /> Add member
                  </Button>
                  <Button variant="ghost" loading={busy === `delete:${group.id}`} onClick={() => void deleteGroup(group.id)}>
                    <Trash2 size={14} />
                  </Button>
                </>
              }
            />
            <div className="grid gap-3 px-4 py-3 sm:grid-cols-4">
              <KeyValue label="Mode" value={group.mode} />
              <KeyValue
                label="Health limits"
                value={`${group.healthRequirements.minSuccessRatePct ?? "—"}% success · ${group.healthRequirements.maxLatencyMs ?? "—"} ms · ${group.healthRequirements.maxLossPct ?? "—"}% loss`}
              />
              <KeyValue
                label="Failover policy"
                value={`${group.failover.redirectNewSessions ? "redirect new" : "no redirect"} · ${
                  group.failover.autoDrain ? "auto-drain" : "manual drain"
                }`}
              />
              <KeyValue label="Active sessions" value={String(group.activeSessions)} />
            </div>

            <div className="divide-y divide-line border-t border-line">
              {group.members.length === 0 && (
                <div className="px-4 py-3 text-2xs text-muted">No members yet — add an inbound or a node.</div>
              )}
              {group.members.map((member) => (
                <div key={member.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[10rem] flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-text">{member.name}</span>
                      <Badge tone={stateTone[member.state] ?? "neutral"}>{member.state}</Badge>
                      {member.kind === "node" && <Badge tone="neutral">node</Badge>}
                    </div>
                    <div className="mt-0.5 text-2xs text-muted">
                      {member.kind === "inbound" ? `inbound · ${member.inboundStatus ?? "unknown state"}` : `node · ${member.nodeName ?? ""}`}
                      {member.checkedAt ? ` · probed ${timeAgo(member.checkedAt)}` : " · never probed"}
                    </div>
                    {member.reasons.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {member.reasons.map((r) => (
                          <div key={r} className="text-2xs text-warning">
                            • {r}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-2xs sm:gap-5">
                    <div>
                      <div className="text-muted">weight</div>
                      <div className="text-text">{member.weight}</div>
                    </div>
                    <div>
                      <div className="text-muted">share</div>
                      <div className="text-text">{member.weightSharePct}%</div>
                    </div>
                    <div>
                      <div className="text-muted">latency</div>
                      <div className="text-text">{member.latencyMs != null ? `${member.latencyMs} ms` : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted">sessions</div>
                      <div className="text-text">{member.activeSessions}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      title="Weight"
                      loading={busy === member.id}
                      onClick={() => {
                        const next = window.prompt(`Weight for ${member.name} (0-1000, 0 removes it from rotation)`, String(member.weight));
                        if (next != null) void updateMember(member.id, { weight: Number(next) });
                      }}
                    >
                      <Activity size={14} />
                    </Button>
                    {member.drained ? (
                      <Button variant="secondary" loading={busy === `restore:${member.id}`} onClick={() => void memberAction(member.id, "restore")}>
                        Restore
                      </Button>
                    ) : (
                      <Button variant="secondary" loading={busy === `drain:${member.id}`} onClick={() => void memberAction(member.id, "drain")}>
                        <ShieldOff size={14} /> Drain
                      </Button>
                    )}
                    <Switch
                      checked={member.enabled}
                      onCheckedChange={(checked) => void updateMember(member.id, { enabled: checked })}
                      label={`Enable ${member.name}`}
                    />
                    <Button variant="ghost" loading={busy === `remove:${member.id}`} onClick={() => void removeMember(member.id)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {group.members.some((m) => m.state === "unknown") && (
              <div className={cx("border-t border-line px-4 py-2 text-2xs text-muted")}>
                Members marked <span className="text-text">unknown</span> have no probe data yet: run a tunnel test or benchmark so health can
                be measured instead of assumed.
              </div>
            )}
            <div className="border-t border-line px-4 py-2 text-2xs text-muted">
              Members currently healthy: {group.healthyMembers} of {group.totalMembers} · total active sessions:{" "}
              {group.activeSessions}
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          title="New load-balancing group"
          desc="A group is a named pool with weights, health limits and a failover policy."
          size="lg"
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={createGroup} loading={busy === "create"} disabled={name.trim().length < 2}>
                Create group
              </Button>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Europe exit pool" />
            </Field>
            <Field label="Mode" hint="weighted spreads by weight, failover prefers priority order">
              <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="weighted">Weighted</option>
                <option value="failover">Failover (priority order)</option>
                <option value="least-load">Least load (fewest sessions)</option>
              </Select>
            </Field>
            <Field label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Minimum probe success rate (%)">
              <Input type="number" value={minSuccess} onChange={(e) => setMinSuccess(e.target.value)} />
            </Field>
            <Field label="Maximum latency (ms)">
              <Input type="number" value={maxLatency} onChange={(e) => setMaxLatency(e.target.value)} />
            </Field>
            <Field label="Maximum packet loss (%)">
              <Input type="number" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} />
            </Field>
          </div>
          <div className="mt-4 space-y-2">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={autoDrain} onCheckedChange={setAutoDrain} label="Automatically drain unhealthy members" />
              <span className="text-muted">Automatically drain a member that stays unhealthy</span>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={autoRestore} onCheckedChange={setAutoRestore} label="Automatically restore healthy members" />
              <span className="text-muted">Automatically restore a member drained automatically</span>
            </label>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!memberGroup} onOpenChange={(open) => !open && setMemberGroup(null)}>
        <DialogContent
          title="Add member"
          desc="Members are real inbounds or real nodes; health is measured on their node."
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setMemberGroup(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void addMember(memberGroup as string)} loading={busy?.startsWith("member:")}>
                Add member
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            <Field label="Member type">
              <Select value={memberKind} onChange={(e) => setMemberKind(e.target.value as "inbound" | "node")}>
                <option value="inbound">Inbound</option>
                <option value="node">Node</option>
              </Select>
            </Field>
            <Field label={memberKind === "inbound" ? "Inbound" : "Node"}>
              <Select value={memberRef} onChange={(e) => setMemberRef(e.target.value)}>
                <option value="">Select…</option>
                {memberKind === "inbound"
                  ? (inbounds?.inbounds ?? []).map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({i.status})
                      </option>
                    ))
                  : (nodes?.nodes ?? []).map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.status})
                      </option>
                    ))}
              </Select>
            </Field>
            <Field label="Weight" hint="0 removes the member from rotation">
              <Input type="number" value={memberWeight} onChange={(e) => setMemberWeight(e.target.value)} />
            </Field>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
