import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Flame, RefreshCcw, ShieldCheck, ShieldOff } from "lucide-react";
import { api } from "../lib/api";
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, KeyValue, LoadingState, PageHeader, Switch,
  cx,
} from "../components/ui/primitives";
import { CodeBlock } from "../components/ui/data";
import { Dialog, DialogContent } from "../components/ui/overlay";
import { formatDateTime, timeAgo } from "../lib/format";

interface FirewallRuleView {
  id: string;
  proto: string;
  port: number | null;
  from: string | null;
  comment: string;
  origin: string;
}

interface HostView {
  key: string;
  kind: "self" | "node";
  name: string;
  role: "master" | "node";
  address: string | null;
  sshPort: number;
  planHash: string;
  appliedHash: string | null;
  enabled: boolean;
  inSync: boolean;
  rulesCount: number;
  publicPorts: number[];
  warnings: string[];
  verifiedAt: string | null;
  detail: string | null;
  lastApply: {
    at: string;
    action: string;
    status: string;
    requestedBy: string | null;
    rulesCount: number;
    error: string | null;
  } | null;
}

interface Overview {
  policy: {
    sshPorts: number[];
    adminSources: string[];
    panelPorts: number[];
    restrictPanel: boolean;
    exposeApiPort: boolean;
    allowIcmp: boolean;
    includeInactiveInbounds: boolean;
  };
  hosts: HostView[];
  spoolDir: string;
}

interface PlanResponse {
  plan: { nodeName: string; rules: FirewallRuleView[]; warnings: string[]; hash: string };
  commands: Array<{ id: string; argv: string[]; remove: string[] }>;
  diff: { added: FirewallRuleView[]; removed: FirewallRuleView[]; unchanged: number };
}

/**
 * Firewall (UFW) management.
 *
 * "Config & Enable UFW" and "Update UFW" are not cosmetic buttons: each one
 * asks the API to build a plan from the ports that actually exist (SSH, panel,
 * every deployed inbound, GRE/IPsec/FOU peers of every tunnel on that host) and
 * to apply it - on a node through its agent, on the panel host through the
 * privileged helper that watches the request spool. The result the API reports
 * is the host's real `ufw status`.
 */
export function FirewallPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [sshPorts, setSshPorts] = useState("22");
  const [adminSources, setAdminSources] = useState("");
  const [panelPorts, setPanelPorts] = useState("80,443");
  const [allowIcmp, setAllowIcmp] = useState(true);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [restrictPanel, setRestrictPanel] = useState(false);
  const [exposeApi, setExposeApi] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["firewall"],
    queryFn: () => api.get<Overview>("/firewall"),
    refetchInterval: 15_000,
  });

  const { data: plan } = useQuery({
    queryKey: ["firewall", "plan", planFor],
    queryFn: () => api.get<PlanResponse>(`/firewall/plan?host=${encodeURIComponent(planFor as string)}`),
    enabled: !!planFor,
  });

  const openPolicy = () => {
    if (!data) return;
    setSshPorts(data.policy.sshPorts.join(","));
    setAdminSources(data.policy.adminSources.join("\n"));
    setPanelPorts(data.policy.panelPorts.join(","));
    setAllowIcmp(data.policy.allowIcmp);
    setIncludeInactive(data.policy.includeInactiveInbounds);
    setRestrictPanel(data.policy.restrictPanel);
    setExposeApi(data.policy.exposeApiPort);
    setPolicyOpen(true);
  };

  const savePolicy = async () => {
    setBusy("policy");
    try {
      const parsePorts = (value: string) =>
        value
          .split(",")
          .map((p) => Number(p.trim()))
          .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
      await api.patch("/firewall/policy", {
        sshPorts: parsePorts(sshPorts),
        panelPorts: parsePorts(panelPorts),
        adminSources: adminSources
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        allowIcmp,
        includeInactiveInbounds: includeInactive,
        restrictPanel,
        exposeApiPort: exposeApi,
      });
      toast.success("Firewall policy saved - run 'Update UFW' to apply it");
      setPolicyOpen(false);
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const apply = async (host: string, action: "enable" | "update" | "disable") => {
    setBusy(`${host}:${action}`);
    try {
      const result = await api.post<{ status: string; detail: string; added: unknown[]; removed: unknown[] }>("/firewall/apply", {
        host,
        action,
      });
      if (result.status === "queued") toast.success(result.detail);
      else if (result.status === "unavailable") toast.warning(result.detail);
      else toast.error(result.detail);
      void refetch();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <LoadingState label="Building firewall plan…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Firewall (UFW)"
        desc="Ports are derived from the SSH port, the panel, every deployed inbound and every tunnel on each host — then applied with ufw and verified."
        actions={
          <>
            <Button variant="secondary" onClick={openPolicy}>
              Policy
            </Button>
            <Button variant="secondary" onClick={() => void refetch()} loading={busy === "refresh"}>
              <RefreshCcw size={14} /> Refresh
            </Button>
          </>
        }
      />

      {data.hosts.length === 0 && <EmptyState title="No hosts" message="Add a node to manage its firewall." />}

      <div className="grid gap-3">
        {data.hosts.map((host) => (
          <Card key={host.key}>
            <CardHeader
              title={host.name}
              desc={
                host.kind === "self"
                  ? "Panel host — applied by the privileged helper through the request spool"
                  : `${host.role} host${host.address ? ` · ${host.address}` : ""} — applied by the node agent`
              }
              icon={<Flame size={14} />}
              actions={
                <>
                  <Button
                    variant="primary"
                    loading={busy === `${host.key}:enable`}
                    onClick={() => void apply(host.key, "enable")}
                  >
                    <ShieldCheck size={14} /> Config & Enable UFW
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy === `${host.key}:update`}
                    onClick={() => void apply(host.key, "update")}
                  >
                    <RefreshCcw size={14} /> Update UFW
                  </Button>
                  <Button variant="ghost" onClick={() => setPlanFor(host.key)}>
                    Preview plan
                  </Button>
                  <Button
                    variant="ghost"
                    loading={busy === `${host.key}:disable`}
                    onClick={() => void apply(host.key, "disable")}
                  >
                    <ShieldOff size={14} /> Disable
                  </Button>
                </>
              }
            />
            <div className="grid gap-3 px-4 pb-4 sm:grid-cols-4">
              <KeyValue
                label="ufw state"
                value={
                  <Badge tone={host.enabled ? "success" : "neutral"}>
                    {host.enabled ? "active" : host.appliedHash ? "inactive" : "never applied"}
                  </Badge>
                }
              />
              <KeyValue
                label="Rules vs current state"
                value={
                  <span className={cx("flex items-center gap-2", host.inSync ? "text-success" : "text-warning")}>
                    {host.inSync ? "in sync" : "out of date"}
                    <span className="text-muted">
                      ({host.rulesCount} rule{host.rulesCount === 1 ? "" : "s"})
                    </span>
                  </span>
                }
              />
              <KeyValue
                label="Public ports"
                value={host.publicPorts.length > 0 ? host.publicPorts.join(", ") : "none"}
                mono
              />
              <KeyValue
                label="Last verified"
                value={host.verifiedAt ? timeAgo(host.verifiedAt) : "—"}
              />
            </div>
            {(host.warnings.length > 0 || host.lastApply) && (
              <div className="space-y-1 border-t border-line px-4 py-3 text-2xs">
                {host.warnings.map((w) => (
                  <div key={w} className="text-warning">
                    • {w}
                  </div>
                ))}
                {host.lastApply && (
                  <div className={host.lastApply.status === "success" ? "text-muted" : "text-danger"}>
                    Last action: {host.lastApply.action} by {host.lastApply.requestedBy ?? "system"} ·{" "}
                    {formatDateTime(host.lastApply.at)} · {host.lastApply.status}
                    {host.lastApply.error ? ` — ${host.lastApply.error}` : ""}
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>

      <Dialog open={!!planFor} onOpenChange={(open) => !open && setPlanFor(null)}>
        <DialogContent
          title="Firewall plan"
          desc="Exactly the ufw command lines that the apply step runs, computed from current state."
          size="xl"
          footer={
            <Button variant="ghost" onClick={() => setPlanFor(null)}>
              Close
            </Button>
          }
        >
          {!plan && <LoadingState label="Resolving DNS and ports…" />}
          {plan && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-2xs">
                <Badge tone="info">hash {plan.plan.hash}</Badge>
                <Badge tone={plan.diff.added.length > 0 ? "warning" : "neutral"}>{plan.diff.added.length} to add</Badge>
                <Badge tone={plan.diff.removed.length > 0 ? "warning" : "neutral"}>{plan.diff.removed.length} to remove</Badge>
                <Badge tone="neutral">{plan.diff.unchanged} unchanged</Badge>
              </div>
              {plan.plan.warnings.map((w) => (
                <div key={w} className="text-2xs text-warning">
                  • {w}
                </div>
              ))}
              <CodeBlock
                code={plan.commands.map((c) => `ufw ${c.argv.join(" ")}`).join("\n")}
                language="bash"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={policyOpen} onOpenChange={setPolicyOpen}>
        <DialogContent
          title="Firewall policy"
          desc="Inputs for the plan. Nothing here is applied until you run Config & Enable / Update."
          size="lg"
          footer={
            <>
              <Button variant="ghost" onClick={() => setPolicyOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={savePolicy} loading={busy === "policy"}>
                Save policy
              </Button>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SSH ports" hint="Comma separated; never leave this empty">
              <Input value={sshPorts} onChange={(e) => setSshPorts(e.target.value)} />
            </Field>
            <Field label="Panel ports" hint="Ports served by nginx on the panel host">
              <Input value={panelPorts} onChange={(e) => setPanelPorts(e.target.value)} />
            </Field>
            <Field label="Administrative source addresses" hint="One IPv4/CIDR per line; empty = any source">
              <Input value={adminSources} onChange={(e) => setAdminSources(e.target.value)} placeholder="203.0.113.4&#10;198.51.100.0/24" />
            </Field>
            <Field label="Extra rules" hint="Managed from the CLI: arvoo firewall policy --add-port">
              <Input value="see CLI: arvoo firewall policy --add-port 8080/tcp" readOnly />
            </Field>
          </div>
          <div className="mt-4 space-y-2">
            {[
              { label: "Allow ICMP (ping, traceroute)", value: allowIcmp, set: setAllowIcmp },
              { label: "Also open ports of inbounds that are not deployed yet", value: includeInactive, set: setIncludeInactive },
              { label: "Restrict the panel to the administrative addresses as well", value: restrictPanel, set: setRestrictPanel },
              { label: "Expose the API port publicly (not recommended)", value: exposeApi, set: setExposeApi },
            ].map((row) => (
              <label key={row.label} className="flex items-center gap-2 text-xs">
                <Switch checked={row.value} onCheckedChange={row.set} label={row.label} />
                <span className="text-muted">{row.label}</span>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
