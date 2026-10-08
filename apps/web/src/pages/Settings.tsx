import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, KeyRound, Plus, Settings2, ShieldCheck, UserCog } from "lucide-react";
import { api } from "../lib/api";
import {
  Badge, Button, Card, CardHeader, Field, Input, LoadingState, PageHeader, Select, UnifiedStatus,
} from "../components/ui/primitives";
import { DataTable } from "../components/ui/data";
import { Drawer, Tabs } from "../components/ui/overlay";
import { timeAgo } from "../lib/format";

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  active: number;
  last_login_at: string | null;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: Record<string, string> }>("/settings"),
  });
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ user: { id: string; username: string; role: string } }>("/auth/me"),
  });
  const { data: users } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<UserRow[]>("/users"),
  });

  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [userDrawerOpen, setUserDrawerOpen] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", password: "", role: "operator" });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data]);

  if (isLoading) return <LoadingState label="Loading settings…" />;

  const isAdmin = me?.user.role === "admin";
  const roleCounts = (users ?? []).reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.role]: (acc[u.role] ?? 0) + 1 }), {});

  const save = async () => {
    setSaving(true);
    try {
      await api.patch("/settings", form);
      toast.success("Settings saved");
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const createUser = async () => {
    setCreating(true);
    try {
      await api.post("/users", newUser);
      toast.success(`User ${newUser.username} created`);
      setNewUser({ username: "", password: "", role: "operator" });
      setUserDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const toggleUser = async (u: UserRow) => {
    try {
      await api.patch(`/users/${u.id}`, { active: !u.active });
      toast.success(u.active ? `${u.username} disabled` : `${u.username} enabled`);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<Settings2 size={15} />}
        title="Settings"
        badge={isAdmin ? <Badge tone="accent">admin</Badge> : <Badge tone="neutral">read-only</Badge>}
        desc="Platform configuration. Infrastructure operations require node agents — this page manages the control plane itself."
      />

      <Tabs
        variant="segmented"
        items={[
          {
            value: "general",
            label: "General",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Platform" desc="Identity and session behaviour" icon={<Settings2 size={14} />} />
                  <div className="grid gap-3 p-4 sm:grid-cols-2">
                    <Field label="Platform name" hint="Shown as the browser title and in the sidebar">
                      <Input value={form["ui.siteName"] ?? ""} onChange={(e) => setForm({ ...form, "ui.siteName": e.target.value })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Session TTL (seconds)" hint="How long a signed-in session stays valid">
                      <Input value={form["security.sessionTtlSec"] ?? ""} onChange={(e) => setForm({ ...form, "security.sessionTtlSec": e.target.value })} disabled={!isAdmin} />
                    </Field>
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Retention" desc="Sweeps keep the database lean without losing history you need" icon={<Database size={14} />} />
                  <div className="grid gap-3 p-4 sm:grid-cols-2">
                    <Field label="Health samples (days)">
                      <Input value={form["retention.healthDays"] ?? ""} onChange={(e) => setForm({ ...form, "retention.healthDays": e.target.value })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Usage samples (days)">
                      <Input value={form["retention.usageDays"] ?? ""} onChange={(e) => setForm({ ...form, "retention.usageDays": e.target.value })} disabled={!isAdmin} />
                    </Field>
                    <Field label="Audit entries (days)" className="sm:col-span-2" hint="Audit history is never trimmed below this window">
                      <Input value={form["retention.auditDays"] ?? ""} onChange={(e) => setForm({ ...form, "retention.auditDays": e.target.value })} disabled={!isAdmin} />
                    </Field>
                  </div>
                  {isAdmin ? (
                    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
                      <span className="text-2xs text-faint">Changes apply to new sweeps immediately.</span>
                      <Button variant="primary" size="sm" onClick={save} loading={saving}>
                        Save settings
                      </Button>
                    </div>
                  ) : (
                    <div className="border-t border-line px-4 py-3 text-2xs text-faint">
                      Only an administrator can change platform settings.
                    </div>
                  )}
                </Card>
              </div>
            ),
          },
          {
            value: "users",
            label: "Users & access",
            count: users?.length ?? 0,
            content: (
              <>
                <div className="mb-4 grid gap-3 sm:grid-cols-3">
                  <Card className="px-3.5 py-3">
                    <div className="label-micro">Administrators</div>
                    <div className="mt-1 text-[20px] font-semibold leading-none text-text tnum">{roleCounts.admin ?? 0}</div>
                    <div className="mt-1 text-2xs text-muted">full platform control</div>
                  </Card>
                  <Card className="px-3.5 py-3">
                    <div className="label-micro">Operators</div>
                    <div className="mt-1 text-[20px] font-semibold leading-none text-text tnum">{roleCounts.operator ?? 0}</div>
                    <div className="mt-1 text-2xs text-muted">infrastructure changes</div>
                  </Card>
                  <Card className="px-3.5 py-3">
                    <div className="label-micro">Viewers</div>
                    <div className="mt-1 text-[20px] font-semibold leading-none text-text tnum">{roleCounts.viewer ?? 0}</div>
                    <div className="mt-1 text-2xs text-muted">read-only access</div>
                  </Card>
                </div>

                <DataTable
                  columns={[
                    {
                      key: "username",
                      header: "User",
                      primary: true,
                      sortValue: (u) => u.username,
                      render: (u) => (
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-text">{u.username}</span>
                            {u.id === me?.user.id && <Badge tone="accent">you</Badge>}
                          </div>
                          <div className="mt-0.5 truncate text-2xs text-faint">{u.display_name ?? "no display name"}</div>
                        </div>
                      ),
                    },
                    {
                      key: "role",
                      header: "Role",
                      sortValue: (u) => u.role,
                      render: (u) => <Badge tone={u.role === "admin" ? "danger" : u.role === "operator" ? "info" : "neutral"}>{u.role}</Badge>,
                    },
                    {
                      key: "active",
                      header: "State",
                      render: (u) => <UnifiedStatus status={u.active ? "active" : "suspended"} />,
                    },
                    {
                      key: "login",
                      header: "Last login",
                      align: "right",
                      sortValue: (u) => u.last_login_at ?? "",
                      render: (u) => <span className="text-2xs text-muted">{u.last_login_at ? timeAgo(u.last_login_at) : "never"}</span>,
                    },
                  ]}
                  rows={users ?? []}
                  rowKey={(u) => u.id}
                  toolbar={
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-2xs text-faint">
                        RBAC: admin (all) · operator (infrastructure) · viewer (read-only)
                      </span>
                      {isAdmin && (
                        <Button variant="primary" size="sm" onClick={() => setUserDrawerOpen(true)}>
                          <Plus size={14} /> New user
                        </Button>
                      )}
                    </div>
                  }
                  rowActions={(u) =>
                    isAdmin && u.id !== me?.user.id ? (
                      <Button size="sm" variant="ghost" onClick={() => toggleUser(u)}>
                        {u.active ? "Disable" : "Enable"}
                      </Button>
                    ) : null
                  }
                  empty={<div className="p-6 text-center text-xs text-faint">No users beyond your own account.</div>}
                />
              </>
            ),
          },
          {
            value: "system",
            label: "System",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Runtime" desc="What this control plane is actually running" icon={<Database size={14} />} />
                  <div className="divide-y divide-line/70">
                    <SystemRow label="Control plane API" value={<><UnifiedStatus status="online" /> <span className="mono text-2xs">/api/v1</span></>} />
                    <SystemRow label="Database" value="PostgreSQL · versioned SQL migrations" />
                    <SystemRow label="Connection handling" value="pooled, parameterised statements" />
                    <SystemRow label="Web server" value="Nginx reverse proxy · systemd services" />
                    <SystemRow label="PKI" value="Arvoo Root CA · AES-256-GCM at rest" />
                    <SystemRow label="Agent protocol" value="authenticated poll + per-node secret" />
                    <SystemRow label="Metrics export (Prometheus)" value={<Badge tone="neutral">planned</Badge>} />
                    <SystemRow label="WireGuard / IKEv2 inbounds" value={<Badge tone="neutral">planned</Badge>} />
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Security notes" desc="How this control plane protects itself" icon={<ShieldCheck size={14} />} />
                  <ul className="space-y-2.5 px-4 py-3.5 text-xs leading-relaxed text-muted">
                    {[
                      "Node agents authenticate with per-node secrets (hashed at rest); enrollment tokens are single-use and expire in 10 minutes.",
                      "Every privileged action requires a session and passes RBAC checks, and lands in the audit log with the acting user and IP.",
                      "Private keys (CA, server, client) are AES-256-GCM encrypted at rest and never leave the backend unredacted.",
                      "Operations are typed payloads — the control plane cannot send arbitrary shell commands to agents.",
                      "Login is rate-limited, and deployments require an online approved agent rather than reporting an optimistic success.",
                    ].map((line) => (
                      <li key={line} className="flex gap-2.5">
                        <KeyRound size={13} className="mt-0.5 shrink-0 text-faint" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            ),
          },
        ]}
      />

      <Drawer
        open={userDrawerOpen}
        onOpenChange={setUserDrawerOpen}
        width="max-w-md"
        title="New user"
        desc="Users sign in with a username and password. Every action they take is audited."
        footer={
          <>
            <Button variant="ghost" onClick={() => setUserDrawerOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={createUser} loading={creating} disabled={!newUser.username || newUser.password.length < 8}>
              <UserCog size={13} /> Create user
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Username" required hint="Minimum 3 characters">
            <Input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} placeholder="operator-1" autoFocus />
          </Field>
          <Field label="Password" required hint="Minimum 8 characters">
            <Input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="••••••••" />
          </Field>
          <Field label="Role" hint="Operator can change infrastructure; viewers are read-only">
            <Select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
              <option value="viewer">viewer</option>
            </Select>
          </Field>
          <div className="rounded-default border border-line bg-surface-2 px-3 py-2.5 text-2xs leading-relaxed text-muted">
            Passwords are stored as bcrypt hashes. Sessions are signed with the application secret and expire according to the session TTL.
          </div>
        </div>
      </Drawer>
    </div>
  );
}

function SystemRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-2xs text-muted">{label}</span>
      <span className="flex items-center gap-2 text-right text-2xs text-text">{value}</span>
    </div>
  );
}
