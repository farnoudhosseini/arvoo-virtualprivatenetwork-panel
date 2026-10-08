import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip as ReTooltip, CartesianGrid } from "recharts";
import { toast } from "sonner";
import {
  Activity, Download, Gauge, MoreHorizontal, PauseCircle, PlayCircle, RefreshCcw, ShieldCheck, ShieldOff, Smartphone, Users,
} from "lucide-react";
import { api, downloadText } from "../lib/api";
import type { ClientRecord } from "@arvoo/shared";
import {
  BackLink, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, KeyValue, LoadingState,
  Meter, PageHeader, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { CodeBlock, DataTable, StatCard } from "../components/ui/data";
import { ConfirmDialog, Dialog, DialogContent, DropdownMenu, DropdownTrigger, DropdownContent, DropdownItem, DropdownSeparator, Tabs } from "../components/ui/overlay";
import { chart } from "../lib/charts";
import { formatBytes, formatDateTime, formatDuration, timeAgo } from "../lib/format";

interface ClientDetailResponse {
  client: ClientRecord;
  inbounds: Array<{ id: string; name: string; status: string }>;
  devices: Array<{ id: string; hwid: string; label: string | null; first_seen_at: string; last_seen_at: string; last_ip: string | null; revoked: number }>;
  sessions: Array<{ id: string; common_name: string; source_ip: string | null; vpn_ip: string | null; connected_at: string; duration_sec: number; rx_bytes: number; tx_bytes: number; active: number; inbound_id: string | null }>;
  usageSeries: Array<{ at: string; rx_bytes: number; tx_bytes: number; billed_bytes: number }>;
  policies: Array<{ id: string; name: string; actions: Array<{ type: string }>; enabled: boolean }>;
}

export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"suspend" | "resume" | "revoke" | "rotate" | null>(null);
  const [busy, setBusy] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ ovpn: string; filename: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["client", id],
    queryFn: () => api.get<ClientDetailResponse>(`/clients/${id}`),
    refetchInterval: 10_000,
    enabled: !!id,
  });

  const { data: inboundsAll } = useQuery({
    queryKey: ["inbounds"],
    queryFn: () => api.get<{ inbounds: Array<{ id: string; name: string }> }>("/inbounds"),
    enabled: !!id,
  });

  if (isLoading) return <LoadingState label="Loading client…" />;
  if (isError) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;
  if (!data) return null;
  const { client } = data;

  const quotaPct =
    client.limits.trafficQuotaBytes != null && client.limits.trafficQuotaBytes > 0
      ? (client.usedBilledBytes / client.limits.trafficQuotaBytes) * 100
      : null;
  const timeQuotaPct = client.limits.timeQuotaSec != null && client.limits.timeQuotaSec > 0 ? (client.usedTimeSec / client.limits.timeQuotaSec) * 100 : null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["client", id] });
    void queryClient.invalidateQueries({ queryKey: ["clients"] });
  };

  const act = async (kind: "suspend" | "resume" | "revoke" | "rotate") => {
    setBusy(true);
    try {
      await api.post(`/clients/${id}/${kind}`);
      toast.success(
        kind === "suspend"
          ? "Client suspended — new connections are denied"
          : kind === "resume"
            ? "Client resumed"
            : kind === "revoke"
              ? "Client revoked — certificate invalidated"
              : "Certificate rotated — profiles must be re-downloaded",
      );
      invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const generateProfile = async (inboundId: string) => {
    setProfileFor(inboundId);
    try {
      const res = await api.post<{ ovpn: string; filename: string }>(`/clients/${id}/config`, { inboundId });
      setProfile(res);
      downloadText(res.filename, res.ovpn, "application/x-openvpn-profile");
      toast.success(`Profile ${res.filename} downloaded`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setProfileFor(null);
    }
  };

  const sessionsActive = data.sessions.filter((s) => s.active);

  return (
    <div>
      <div className="mb-3">
        <BackLink label="Clients" onClick={() => navigate("/clients")} />
      </div>

      <PageHeader
        icon={<Users size={15} />}
        title={<span className="mono">{client.displayName || client.username}</span>}
        badge={<UnifiedStatus status={client.status} />}
        desc={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="mono">CN {client.username}</span>
            <span className="text-faint">·</span>
            <span>created {formatDateTime(client.createdAt)}</span>
            {client.baseMultiplier !== 1 && <Badge tone="info">{client.baseMultiplier}× billing</Badge>}
            {client.tags.map((t) => (
              <Badge key={t} tone="neutral">
                {t}
              </Badge>
            ))}
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
              Edit limits
            </Button>
            <DropdownMenu>
              <DropdownTrigger asChild>
                <IconButton variant="secondary" aria-label="Client actions">
                  <MoreHorizontal size={15} />
                </IconButton>
              </DropdownTrigger>
              <DropdownContent>
                {client.status === "suspended" ? (
                  <DropdownItem onSelect={() => setConfirm("resume")}>
                    <PlayCircle size={13} /> Resume access
                  </DropdownItem>
                ) : (
                  <DropdownItem onSelect={() => setConfirm("suspend")}>
                    <PauseCircle size={13} /> Suspend access
                  </DropdownItem>
                )}
                <DropdownItem onSelect={() => setConfirm("rotate")}>
                  <RefreshCcw size={13} /> Rotate certificate
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem danger onSelect={() => setConfirm("revoke")}>
                  <ShieldOff size={13} /> Revoke permanently
                </DropdownItem>
              </DropdownContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="grid-cards mb-4">
        <StatCard
          label="Billed usage"
          value={formatBytes(client.usedBilledBytes)}
          tone={quotaPct != null && quotaPct > 80 ? "warning" : "default"}
          icon={<Gauge size={14} />}
          sub={client.limits.trafficQuotaBytes != null ? `of ${formatBytes(client.limits.trafficQuotaBytes)} quota` : "unlimited quota"}
        />
        <StatCard
          label="Raw traffic"
          value={formatBytes(client.rxBytes + client.txBytes)}
          icon={<Activity size={14} />}
          sub={`${formatBytes(client.rxBytes)} down · ${formatBytes(client.txBytes)} up`}
        />
        <StatCard
          label="Sessions now"
          value={sessionsActive.length}
          tone={sessionsActive.length > 0 ? "success" : "default"}
          sub={`limit: ${client.limits.concurrentSessions ?? "∞"}`}
        />
        <StatCard
          label="Devices"
          value={data.devices.filter((d) => !d.revoked).length}
          icon={<Smartphone size={14} />}
          sub={`limit: ${client.limits.deviceLimit ?? "∞"} · IP limit: ${client.limits.ipLimit ?? "∞"}`}
        />
        <StatCard label="Expires" value={client.limits.expiresAt ? timeAgo(client.limits.expiresAt) : "never"} sub={formatDateTime(client.limits.expiresAt)} />
      </div>

      {(quotaPct != null || timeQuotaPct != null) && (
        <Card className="mb-4">
          <CardHeader title="Quota consumption" desc="Enforced at connection time — billed bytes apply the effective multiplier" />
          <div className="space-y-4 px-4 py-3.5">
            {quotaPct != null && (
              <Meter
                pct={quotaPct}
                label={
                  <span>
                    Traffic — {formatBytes(client.usedBilledBytes)} of {formatBytes(client.limits.trafficQuotaBytes!)} billed
                  </span>
                }
              />
            )}
            {timeQuotaPct != null && <Meter pct={timeQuotaPct} label={<span>Connected time — {formatDuration(client.usedTimeSec)} used</span>} />}
          </div>
        </Card>
      )}

      <Tabs
        variant="segmented"
        items={[
          {
            value: "traffic",
            label: "Traffic",
            content: (
              <Card>
                <CardHeader title="Usage history" desc="Billed traffic from real session accounting" icon={<Activity size={14} />} />
                {data.usageSeries.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<Activity size={18} />}
                    title="No usage recorded"
                    message="Traffic appears here once the client connects through a deployed inbound."
                  />
                ) : (
                  <div className="h-60 p-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.usageSeries.map((u) => ({ at: formatDateTime(u.at), billed: u.billed_bytes / 1024 / 1024 }))}>
                        <defs>
                          <linearGradient id="clientTrafficFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
                            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke={chart.grid} strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="at" tick={chart.tick} tickLine={false} axisLine={{ stroke: chart.grid }} minTickGap={50} />
                        <YAxis tick={chart.tick} tickLine={false} axisLine={false} width={58} tickFormatter={(v: number) => `${v.toFixed(1)} MB`} />
                        <ReTooltip contentStyle={chart.tooltip} labelStyle={chart.tooltipLabel} formatter={(v: number) => [`${v.toFixed(2)} MB`, "Billed"]} />
                        <Area type="monotone" dataKey="billed" stroke={chart.accent} strokeWidth={1.75} fill="url(#clientTrafficFill)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
            ),
          },
          {
            value: "sessions",
            label: "Sessions",
            count: data.sessions.length,
            content: (
              <DataTable
                columns={[
                  { key: "ip", header: "Source IP", primary: true, render: (s) => <span className="mono text-xs">{s.source_ip ?? "—"}</span> },
                  { key: "vpn", header: "VPN IP", hideBelow: "sm", render: (s) => <span className="mono text-2xs text-muted">{s.vpn_ip ?? "—"}</span> },
                  { key: "active", header: "State", render: (s) => <UnifiedStatus status={s.active ? "online" : "offline"} /> },
                  { key: "dur", header: "Duration", align: "right", sortValue: (s) => s.duration_sec, render: (s) => <span className="text-2xs text-muted tnum">{formatDuration(s.duration_sec)}</span> },
                  { key: "traffic", header: "Traffic", align: "right", hideBelow: "md", sortValue: (s) => s.rx_bytes + s.tx_bytes, render: (s) => <span className="text-2xs text-muted tnum">{formatBytes(s.rx_bytes + s.tx_bytes)}</span> },
                  { key: "at", header: "Connected", align: "right", hideBelow: "lg", sortValue: (s) => s.connected_at, render: (s) => <span className="text-2xs text-faint">{formatDateTime(s.connected_at)}</span> },
                ]}
                rows={data.sessions}
                rowKey={(s) => s.id}
                initialSort={{ key: "at", dir: "desc" }}
                empty={<EmptyState compact icon={<Activity size={18} />} title="No sessions recorded" message="Sessions appear when this client connects to a deployed inbound." />}
              />
            ),
          },
          {
            value: "devices",
            label: "Devices",
            count: data.devices.length,
            content: (
              <DataTable
                columns={[
                  { key: "hwid", header: "Device ID", primary: true, render: (d) => <span className="mono text-xs">{d.hwid}</span> },
                  { key: "ip", header: "Last IP", hideBelow: "sm", render: (d) => <span className="mono text-2xs text-muted">{d.last_ip ?? "—"}</span> },
                  { key: "state", header: "State", render: (d) => <UnifiedStatus status={d.revoked ? "revoked" : "active"} /> },
                  { key: "seen", header: "Last seen", align: "right", sortValue: (d) => d.last_seen_at, render: (d) => <span className="text-2xs text-muted">{timeAgo(d.last_seen_at)}</span> },
                ]}
                rows={data.devices}
                rowKey={(d) => d.id}
                empty={<EmptyState compact icon={<Smartphone size={18} />} title="No devices seen yet" message="Devices register automatically on first connection." />}
                rowActions={(d) =>
                  !d.revoked ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api.post(`/clients/${id}/devices/${d.id}/revoke`);
                          toast.success("Device revoked");
                          invalidate();
                        } catch (err) {
                          toast.error((err as Error).message);
                        }
                      }}
                    >
                      <ShieldOff size={12} /> Revoke
                    </Button>
                  ) : null
                }
              />
            ),
          },
          {
            value: "config",
            label: "Configuration",
            content: (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
                <Card>
                  <CardHeader title="Client profiles" desc="Each profile embeds the certificate, key and CA bundle" icon={<Download size={14} />} />
                  <div className="space-y-3 p-4">
                    {(inboundsAll?.inbounds ?? []).length === 0 ? (
                      <p className="text-2xs text-faint">No inbounds exist yet — create an endpoint before downloading a profile.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {(inboundsAll?.inbounds ?? []).map((i) => (
                          <Button key={i.id} size="sm" variant="secondary" onClick={() => generateProfile(i.id)} loading={profileFor === i.id}>
                            <Download size={12} /> {i.name}
                          </Button>
                        ))}
                      </div>
                    )}
                    <p className="text-2xs leading-relaxed text-faint">
                      Profiles become invalid the moment the certificate is rotated or revoked. Deliver them over a channel you trust.
                    </p>
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Profile preview" desc={profile ? profile.filename : "Generate a profile to preview it here"} icon={<ShieldCheck size={14} />} />
                  {profile ? (
                    <div className="p-4">
                      <CodeBlock code={profile.ovpn} filename={profile.filename} language="openvpn" maxHeight="420px" />
                    </div>
                  ) : (
                    <EmptyState
                      compact
                      icon={<Download size={18} />}
                      title="No profile generated yet"
                      message="Pick an inbound on the left; the .ovpn downloads immediately and stays visible here."
                    />
                  )}
                </Card>
              </div>
            ),
          },
          {
            value: "policies",
            label: "Policies & access",
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Matching policies" desc="Rules whose conditions reference this client or its group" icon={<ShieldCheck size={14} />} />
                  {data.policies.length === 0 ? (
                    <EmptyState compact title="No targeted policies" message="Platform-wide policies still apply — see the Policies page." />
                  ) : (
                    <div className="divide-y divide-line/70">
                      {data.policies.map((p) => (
                        <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <span className="min-w-0">
                            <span className="block truncate text-xs text-text">{p.name}</span>
                            <span className="text-3xs text-faint">{p.enabled ? "enabled" : "disabled"}</span>
                          </span>
                          <span className="flex shrink-0 flex-wrap justify-end gap-1">
                            {p.actions.map((a, i) => (
                              <Badge key={i} tone={a.type === "deny" ? "danger" : a.type === "alert" ? "warning" : "info"}>
                                {a.type}
                              </Badge>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
                <Card>
                  <CardHeader title="Inbounds assigned" desc="Endpoints this identity can connect to" icon={<Users size={14} />} />
                  {data.inbounds.length === 0 ? (
                    <EmptyState compact title="Not assigned to any inbound" message="Assign inbounds from the client list or during creation." />
                  ) : (
                    <div className="divide-y divide-line/70">
                      {data.inbounds.map((i) => (
                        <button
                          key={i.id}
                          type="button"
                          onClick={() => navigate(`/inbounds/${i.id}`)}
                          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
                        >
                          <span className="mono truncate text-xs text-text">{i.name}</span>
                          <UnifiedStatus status={i.status} />
                        </button>
                      ))}
                    </div>
                  )}
                </Card>

                <Card className="lg:col-span-2">
                  <CardHeader title="Access rules" desc="Network restrictions evaluated on every connection" />
                  <div className="px-4 py-2">
                    <KeyValue label="Device (HWID) limit" value={client.limits.deviceLimit ?? "unlimited"} />
                    <KeyValue label="IP limit" value={client.limits.ipLimit ?? "unlimited"} />
                    <KeyValue label="Concurrent sessions" value={client.limits.concurrentSessions ?? "unlimited"} />
                    <KeyValue label="Download cap" value={client.limits.downloadSpeedKbps != null ? `${client.limits.downloadSpeedKbps} kbps` : "unlimited"} />
                    <KeyValue label="Upload cap" value={client.limits.uploadSpeedKbps != null ? `${client.limits.uploadSpeedKbps} kbps` : "unlimited"} />
                    <KeyValue label="IP allowlist" value={client.limits.ipAllowlist.length > 0 ? client.limits.ipAllowlist.join(", ") : "any"} mono />
                    <KeyValue label="IP denylist" value={client.limits.ipDenylist.length > 0 ? client.limits.ipDenylist.join(", ") : "none"} mono />
                    <KeyValue label="Starts at" value={client.limits.startsAt ? formatDateTime(client.limits.startsAt) : "immediately"} />
                    <KeyValue label="Base multiplier" value={`${client.baseMultiplier}×`} />
                    {client.notes && <KeyValue label="Notes" value={client.notes} />}
                  </div>
                </Card>
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirm === "suspend"}
        onOpenChange={() => setConfirm(null)}
        title={`Suspend ${client.username}?`}
        message="New connections are denied immediately. Existing sessions drop at the next status sync; usage and configuration are preserved."
        confirmLabel="Suspend client"
        onConfirm={() => act("suspend")}
        loading={busy}
      />
      <ConfirmDialog
        open={confirm === "resume"}
        onOpenChange={() => setConfirm(null)}
        title={`Resume ${client.username}?`}
        message="The client can connect again, subject to quotas and policies."
        confirmLabel="Resume client"
        onConfirm={() => act("resume")}
        loading={busy}
      />
      <ConfirmDialog
        open={confirm === "revoke"}
        onOpenChange={() => setConfirm(null)}
        title={`Revoke ${client.username}?`}
        message="This invalidates the client certificate permanently. The client cannot connect again until a new certificate is rotated in. This is the destructive form of suspension."
        confirmLabel="Revoke permanently"
        danger
        onConfirm={() => act("revoke")}
        loading={busy}
      />
      <ConfirmDialog
        open={confirm === "rotate"}
        onOpenChange={() => setConfirm(null)}
        title={`Rotate certificate for ${client.username}?`}
        message="A fresh certificate is issued. Old profiles stop working — the new .ovpn must be delivered to the client."
        confirmLabel="Rotate certificate"
        onConfirm={() => act("rotate")}
        loading={busy}
      />

      <EditClientDialog open={editOpen} onOpenChange={setEditOpen} client={client} onSaved={invalidate} />
    </div>
  );
}

function EditClientDialog({ open, onOpenChange, client, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; client: ClientRecord; onSaved: () => void }) {
  const [trafficGb, setTrafficGb] = useState(client.limits.trafficQuotaBytes != null ? String(Math.round(client.limits.trafficQuotaBytes / 1024 ** 3)) : "");
  const [deviceLimit, setDeviceLimit] = useState(client.limits.deviceLimit != null ? String(client.limits.deviceLimit) : "");
  const [ipLimit, setIpLimit] = useState(client.limits.ipLimit != null ? String(client.limits.ipLimit) : "");
  const [multiplier, setMultiplier] = useState(String(client.baseMultiplier));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/clients/${client.id}`, {
        baseMultiplier: Number(multiplier) || 1,
        limits: {
          trafficQuotaBytes: trafficGb ? Number(trafficGb) * 1024 ** 3 : null,
          deviceLimit: deviceLimit ? Number(deviceLimit) : null,
          ipLimit: ipLimit ? Number(ipLimit) : null,
        },
      });
      toast.success("Client limits updated");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Edit limits · ${client.username}`}
        desc="Quota and policy changes are evaluated at the next connection check."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Traffic quota (GB)" hint="Empty = unlimited">
            <Input type="number" value={trafficGb} onChange={(e) => setTrafficGb(e.target.value)} />
          </Field>
          <Field label="Device limit">
            <Input type="number" value={deviceLimit} onChange={(e) => setDeviceLimit(e.target.value)} />
          </Field>
          <Field label="IP limit">
            <Input type="number" value={ipLimit} onChange={(e) => setIpLimit(e.target.value)} />
          </Field>
          <Field label="Base multiplier" hint="1.0 = normal billing">
            <Input type="number" step="0.1" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}
