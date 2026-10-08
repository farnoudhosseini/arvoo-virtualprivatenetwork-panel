import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRight, Check, ChevronLeft, Globe, Info, Layers, Rocket, ShieldCheck, Sliders, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import type { NodeRecord, OpenVPNStructuredConfig, TunnelRecord } from "@arvoo/shared";
import {
  BackLink, Badge, Button, Card, CardHeader, Field, Input, KeyValue, LoadingState, PageHeader, Select, UnifiedStatus, cx,
} from "../components/ui/primitives";
import { CodeBlock } from "../components/ui/data";
import { PROFILE_DESCRIPTIONS } from "../lib/profiles";

const STEPS = [
  { key: "basic", label: "Basics", desc: "Identity and placement", icon: <Layers size={14} /> },
  { key: "network", label: "Network", desc: "Addressing and client routing", icon: <Globe size={14} /> },
  { key: "security", label: "Security", desc: "TLS and PKI behaviour", icon: <ShieldCheck size={14} /> },
  { key: "performance", label: "Performance", desc: "Profile and packet overhead", icon: <Sliders size={14} /> },
  { key: "review", label: "Review", desc: "Validated before creation", icon: <Rocket size={14} /> },
] as const;

function defaultConfig(): OpenVPNStructuredConfig {
  return {
    port: 1194,
    listenAddress: "0.0.0.0",
    transport: "udp",
    device: "tun",
    topology: "subnet",
    serverNetwork: "",
    dnsServers: ["1.1.1.1", "1.0.0.1"],
    redirectGateway: true,
    clientToClient: false,
    tunMtu: 1420,
    mssFix: 1380,
    fragment: null,
    dataCiphers: ["AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305"],
    fallbackCipher: null,
    authDigest: "SHA256",
    tlsMode: "tls-crypt",
    tlsVersionMin: "1.2",
    keepaliveInterval: 10,
    keepaliveTimeout: 60,
    maxClients: 100,
    performanceProfile: "balanced",
    compression: "off",
    duplicateCn: false,
    pushRoutes: [],
    logVerbosity: 3,
    deploymentMode: "direct",
    tunnelId: null,
    egressNodeId: null,
  };
}

export function InboundNewPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const profileEntries = Object.entries(PROFILE_DESCRIPTIONS) as Array<[string, { label: string; rationale: string }]>;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [cfg, setCfg] = useState<OpenVPNStructuredConfig>(defaultConfig());
  const [submitting, setSubmitting] = useState(false);
  const [validation, setValidation] = useState<{ errors: Array<{ field: string; message: string }>; warnings: Array<{ field: string; message: string }> } | null>(null);

  const { data: nodesData, isLoading: nodesLoading } = useQuery({
    queryKey: ["nodes"],
    queryFn: () => api.get<{ nodes: NodeRecord[] }>("/nodes"),
  });
  const { data: tunnelsData } = useQuery({
    queryKey: ["tunnels"],
    queryFn: () => api.get<{ tunnels: Array<TunnelRecord & { sourceName: string; destName: string }> }>("/tunnels"),
  });

  const nodes = nodesData?.nodes ?? [];
  const selectedNode = nodes.find((n) => n.id === nodeId);
  const onlineApprovedNodes = nodes.filter((n) => n.enrollmentState === "approved");

  // Adopt server-side defaults (auto port + subnet) once a node is chosen.
  useEffect(() => {
    if (!nodeId || cfg.serverNetwork) return;
    api
      .post<{ expanded: OpenVPNStructuredConfig }>("/inbounds/validate", { nodeId, config: { performanceProfile: cfg.performanceProfile } })
      .then((r) => setCfg((c) => ({ ...c, port: r.expanded.port, serverNetwork: r.expanded.serverNetwork })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const tunnels = (tunnelsData?.tunnels ?? []).filter((t) => t.sourceNodeId === nodeId && t.status === "up");

  const preview = useMemo(() => {
    const lines: string[] = [];
    lines.push(`# Arvoo OpenVPN server configuration (preview)`);
    lines.push(`port ${cfg.port}`);
    lines.push(`proto ${cfg.transport === "udp" ? "udp4" : "tcp4"}`);
    lines.push(`dev tun`);
    lines.push(`server ${cfg.serverNetwork || "10.40.x.0 255.255.255.0"}`);
    lines.push(`data-ciphers ${cfg.dataCiphers.join(":")}`);
    lines.push(`tun-mtu ${cfg.tunMtu}`);
    if (cfg.mssFix != null) lines.push(`mssfix ${cfg.mssFix}`);
    lines.push(`keepalive ${cfg.keepaliveInterval} ${cfg.keepaliveTimeout}`);
    if (cfg.deploymentMode === "through-tunnel") lines.push(`# egress routed through selected GRE tunnel`);
    return lines.join("\n");
  }, [cfg]);

  const validate = async (): Promise<boolean> => {
    try {
      const res = await api.post<{ validation: { errors: Array<{ field: string; message: string }>; warnings: Array<{ field: string; message: string }> } }>(
        "/inbounds/validate",
        { nodeId: nodeId || undefined, config: { ...cfg, serverNetwork: cfg.serverNetwork || undefined, port: cfg.port } },
      );
      setValidation(res.validation);
      if (res.validation.errors.length > 0) {
        toast.error(res.validation.errors[0]!.message);
        return false;
      }
      if (res.validation.warnings.length > 0) {
        toast.warning(res.validation.warnings[0]!.message);
      }
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
  };

  const next = async () => {
    if (step === 0) {
      if (!name.trim()) return toast.error("Inbound name is required");
      if (!nodeId) return toast.error("Select a node");
    }
    if (step === 3) {
      const ok = await validate();
      if (!ok) return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const create = async () => {
    setSubmitting(true);
    try {
      const res = await api.post<{ inbound: { id: string } }>("/inbounds", {
        name: name.trim(),
        description: description || null,
        nodeId,
        config: {
          ...cfg,
          serverNetwork: cfg.serverNetwork || undefined,
          port: cfg.port || undefined,
        },
      });
      toast.success("Inbound created with configuration v1");
      navigate(`/inbounds/${res.inbound.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (nodesLoading) return <LoadingState label="Preparing builder…" />;

  const readyToCreate = name.trim() !== "" && nodeId !== "";

  return (
    <div>
      <div className="mb-3">
        <BackLink label="Inbounds" onClick={() => navigate("/inbounds")} />
      </div>

      <PageHeader
        icon={<Globe size={15} />}
        title="New OpenVPN inbound"
        desc="Structured configuration builder. Nothing reaches a node until you explicitly deploy from the inbound page."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ------------------------------------------------------------ form */}
        <div className="min-w-0">
          {/* Horizontal step rail on small screens, vertical list on large */}
          <ol className="mb-4 flex flex-wrap items-center gap-1.5 lg:hidden">
            {STEPS.map((s, i) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => i <= step && setStep(i)}
                  className={cx(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs transition-colors duration-fast",
                    i === step ? "border-accent/50 bg-accent-soft text-text" : i < step ? "border-line bg-surface-2 text-muted" : "border-line text-faint",
                  )}
                >
                  {i < step ? <Check size={11} className="text-success" /> : <span className="tnum">{i + 1}</span>}
                  {s.label}
                </button>
              </li>
            ))}
          </ol>

          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {STEPS[step]!.icon}
                  {STEPS[step]!.label}
                </span>
              }
              desc={STEPS[step]!.desc}
              actions={
                <span className="text-3xs text-faint tnum">
                  step {step + 1} of {STEPS.length}
                </span>
              }
            />

            <div className="space-y-4 p-4">
              {step === 0 && (
                <>
                  {onlineApprovedNodes.length === 0 && (
                    <Note tone="warning">
                      No approved nodes are available. Approve a node agent first — deployment requires a real, approved node.
                    </Note>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Inbound name" required hint="Used as the interface/config identifier">
                      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ovpn-de-01" className="mono" autoFocus />
                    </Field>
                    <Field label="Node" required hint="Only nodes with approved agents can host inbounds">
                      <Select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                        <option value="">Select node…</option>
                        {nodes.map((n) => (
                          <option key={n.id} value={n.id} disabled={n.enrollmentState !== "approved"}>
                            {n.name} {n.enrollmentState !== "approved" ? `(agent ${n.enrollmentState})` : n.status === "online" ? "" : "(offline)"}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Description" className="sm:col-span-2">
                      <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional purpose" />
                    </Field>
                  </div>
                </>
              )}

              {step === 1 && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Transport" hint="UDP is the default for VPN data-plane traffic; TCP only when the path requires it">
                    <Select value={cfg.transport} onChange={(e) => setCfg({ ...cfg, transport: e.target.value as "udp" | "tcp" })}>
                      <option value="udp">UDP (recommended)</option>
                      <option value="tcp">TCP</option>
                    </Select>
                  </Field>
                  <Field label="Port" hint="Auto-selected to avoid collisions on the node">
                    <Input type="number" value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })} />
                  </Field>
                  <Field label="VPN client subnet" hint="Auto-allocated from 10.40.0.0/16 — override only with a reason">
                    <Input value={cfg.serverNetwork} onChange={(e) => setCfg({ ...cfg, serverNetwork: e.target.value })} placeholder="10.40.0.0/24" className="mono" />
                  </Field>
                  <Field label="Max clients">
                    <Input type="number" value={cfg.maxClients} onChange={(e) => setCfg({ ...cfg, maxClients: Number(e.target.value) })} />
                  </Field>
                  <Field label="DNS pushed to clients">
                    <Input
                      value={cfg.dnsServers.join(", ")}
                      onChange={(e) => setCfg({ ...cfg, dnsServers: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                      className="mono"
                    />
                  </Field>
                  <Field label="Redirect gateway" hint="Route all client traffic through the VPN">
                    <Select value={cfg.redirectGateway ? "1" : "0"} onChange={(e) => setCfg({ ...cfg, redirectGateway: e.target.value === "1" })}>
                      <option value="1">Yes — full tunnel</option>
                      <option value="0">No — split tunnel</option>
                    </Select>
                  </Field>
                  <Field label="Deployment mode" className="sm:col-span-2" hint="Through-tunnel egresses client traffic via a GRE tunnel to another node">
                    <Select value={cfg.deploymentMode} onChange={(e) => setCfg({ ...cfg, deploymentMode: e.target.value as "direct" | "through-tunnel" })}>
                      <option value="direct">Direct — egress from this node</option>
                      <option value="through-tunnel">Through tunnel — egress via another node</option>
                    </Select>
                  </Field>
                  {cfg.deploymentMode === "through-tunnel" && (
                    <Field label="GRE tunnel (from this node)" className="sm:col-span-2" hint="Only healthy tunnels originating on the selected node are listed">
                      <Select value={cfg.tunnelId ?? ""} onChange={(e) => setCfg({ ...cfg, tunnelId: e.target.value || null })}>
                        <option value="">Select tunnel…</option>
                        {tunnels.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} → {t.destName} ({t.status}
                            {t.latencyMs != null ? `, ${t.latencyMs} ms` : ""})
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
              )}

              {step === 2 && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Control channel protection" hint="tls-crypt encrypts and authenticates; tls-auth only authenticates">
                    <Select value={cfg.tlsMode} onChange={(e) => setCfg({ ...cfg, tlsMode: e.target.value as "tls-crypt" | "tls-auth" | "none" })}>
                      <option value="tls-crypt">tls-crypt (recommended)</option>
                      <option value="tls-auth">tls-auth</option>
                      <option value="none">none (not recommended)</option>
                    </Select>
                  </Field>
                  <Field label="Minimum TLS version">
                    <Select value={cfg.tlsVersionMin} onChange={(e) => setCfg({ ...cfg, tlsVersionMin: e.target.value as "1.2" | "1.3" })}>
                      <option value="1.2">TLS 1.2</option>
                      <option value="1.3">TLS 1.3</option>
                    </Select>
                  </Field>
                  <Field label="Data ciphers" className="sm:col-span-2" hint="AEAD ciphers only (CBC is reserved for the compatibility profile)">
                    <div className="flex flex-wrap gap-1.5">
                      {["AES-256-GCM", "AES-128-GCM", "CHACHA20-POLY1305", "AES-256-CBC"].map((c) => {
                        const active = cfg.dataCiphers.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              if (active) setCfg({ ...cfg, dataCiphers: cfg.dataCiphers.filter((x) => x !== c) });
                              else setCfg({ ...cfg, dataCiphers: [...cfg.dataCiphers, c] });
                            }}
                            className={cx(
                              "mono rounded-full border px-2.5 py-1 text-2xs transition-colors duration-fast",
                              active ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-muted hover:border-line-strong hover:text-text",
                            )}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  <Field label="Client certificates" hint="Arvoo PKI issues per-client certificates; revocation is immediate">
                    <Badge tone="success">Required · cert-based</Badge>
                  </Field>
                  <Field label="Duplicate CN" hint="Allow one certificate to connect several times — keep off unless required">
                    <Select value={cfg.duplicateCn ? "1" : "0"} onChange={(e) => setCfg({ ...cfg, duplicateCn: e.target.value === "1" })}>
                      <option value="0">Disallow</option>
                      <option value="1">Allow</option>
                    </Select>
                  </Field>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-4">
                  <Field label="Performance profile">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {profileEntries.map(([key, p]) => (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={cfg.performanceProfile === key}
                          onClick={() => setCfg((c) => ({ ...c, performanceProfile: key as OpenVPNStructuredConfig["performanceProfile"] }))}
                          className={cx(
                            "rounded-default border p-3 text-left transition-colors duration-fast",
                            cfg.performanceProfile === key ? "border-accent/50 bg-accent-soft" : "border-line hover:border-line-strong hover:bg-surface-2",
                          )}
                        >
                          <span className="flex items-center gap-2 text-[13px] font-medium text-text">
                            {p.label}
                            {cfg.performanceProfile === key && <Check size={13} className="text-accent" />}
                          </span>
                          <span className="mt-0.5 block text-2xs leading-snug text-muted">{p.rationale}</span>
                        </button>
                      ))}
                    </div>
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="TUN MTU" hint="Path MTU minus encapsulation overhead — 1420 is safe for UDP/IPv4">
                      <Input type="number" value={cfg.tunMtu} onChange={(e) => setCfg({ ...cfg, tunMtu: Number(e.target.value) })} />
                    </Field>
                    <Field label="MSS clamp" hint="Clamps TCP payloads to avoid fragmentation on tunnelled paths">
                      <Input type="number" value={cfg.mssFix ?? ""} onChange={(e) => setCfg({ ...cfg, mssFix: e.target.value ? Number(e.target.value) : null })} />
                    </Field>
                    <Field label="Keepalive interval (s)">
                      <Input type="number" value={cfg.keepaliveInterval} onChange={(e) => setCfg({ ...cfg, keepaliveInterval: Number(e.target.value) })} />
                    </Field>
                    <Field label="Keepalive timeout (s)">
                      <Input type="number" value={cfg.keepaliveTimeout} onChange={(e) => setCfg({ ...cfg, keepaliveTimeout: Number(e.target.value) })} />
                    </Field>
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-4">
                  <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <KeyValue label="Name" value={name || "—"} mono />
                    <KeyValue label="Node" value={selectedNode?.name ?? "—"} />
                    <KeyValue label="Transport" value={`${cfg.transport.toUpperCase()} / ${cfg.port}`} mono />
                    <KeyValue label="VPN network" value={cfg.serverNetwork || "auto"} mono />
                    <KeyValue label="DNS" value={cfg.dnsServers.join(", ") || "not pushed"} mono />
                    <KeyValue label="Profile" value={<span className="capitalize">{cfg.performanceProfile}</span>} />
                    <KeyValue label="MTU / MSS" value={`${cfg.tunMtu} / ${cfg.mssFix ?? "off"}`} mono />
                    <KeyValue label="TLS" value={`${cfg.tlsMode} · min ${cfg.tlsVersionMin}`} />
                    <KeyValue label="Ciphers" value={cfg.dataCiphers.join(", ")} mono />
                    <KeyValue label="Egress" value={cfg.deploymentMode === "through-tunnel" ? "via GRE tunnel" : "direct"} />
                    <KeyValue label="Max clients" value={cfg.maxClients} />
                    <KeyValue label="Duplicate CN" value={cfg.duplicateCn ? "allowed" : "rejected"} />
                  </div>

                  {validation?.errors.map((e, i) => (
                    <Note key={`e${i}`} tone="danger">
                      {e.field}: {e.message}
                    </Note>
                  ))}
                  {validation?.warnings.map((w, i) => (
                    <Note key={`w${i}`} tone="warning">
                      {w.message}
                    </Note>
                  ))}

                  <Note tone="info">
                    Creation generates PKI (CA, server certificate, TLS key) and configuration v1. Deployment happens from the inbound page and runs
                    through the node agent with validation, port checks and health verification — status never claims more than the node confirmed.
                  </Note>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
              <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
                <ChevronLeft size={13} /> Back
              </Button>
              <div className="flex items-center gap-2">
                {step < STEPS.length - 1 ? (
                  <Button variant="primary" onClick={next}>
                    Continue <ArrowRight size={13} />
                  </Button>
                ) : (
                  <Button variant="primary" onClick={create} loading={submitting} disabled={!readyToCreate}>
                    <Check size={14} /> Create inbound
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* --------------------------------------------------------- summary */}
        <aside className="lg:sticky lg:top-4 lg:h-fit">
          <Card>
            <CardHeader title="Live summary" desc="Updates as you configure" />
            <div className="px-4 py-2">
              <KeyValue label="Name" value={name || "—"} mono />
              <KeyValue label="Node" value={selectedNode ? <span className="flex items-center justify-end gap-1.5">{selectedNode.name} <UnifiedStatus status={selectedNode.status} /></span> : "—"} />
              <KeyValue label="Transport" value={`${cfg.transport.toUpperCase()} ${cfg.port}`} mono />
              <KeyValue label="Network" value={cfg.serverNetwork || "auto"} mono />
              <KeyValue label="Profile" value={<span className="capitalize">{cfg.performanceProfile}</span>} />
              <KeyValue label="TLS" value={cfg.tlsMode} />
              <KeyValue label="MTU / MSS" value={`${cfg.tunMtu} / ${cfg.mssFix ?? "off"}`} mono />
              <KeyValue label="Max clients" value={cfg.maxClients} />
              <KeyValue label="Egress" value={cfg.deploymentMode === "through-tunnel" ? "via GRE tunnel" : "direct"} />
            </div>
            <div className="border-t border-line p-3">
              <CodeBlock code={preview} filename="server.conf (preview)" maxHeight="176px" />
            </div>
            <div className="flex flex-col gap-2 border-t border-line p-3">
              {!readyToCreate && (
                <p className="flex items-start gap-2 text-2xs leading-snug text-faint">
                  <Info size={12} className="mt-0.5 shrink-0" /> A name and an approved node are required before creation.
                </p>
              )}
              <Button variant="primary" onClick={create} loading={submitting} disabled={!readyToCreate}>
                <Rocket size={13} /> Create inbound & generate PKI
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate("/inbounds")}>
                Cancel
              </Button>
            </div>
          </Card>

          <div className="mt-3 space-y-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s.key}
                type="button"
                disabled={i > step}
                onClick={() => setStep(i)}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-default border px-3 py-2 text-left transition-colors duration-fast",
                  i === step ? "border-accent/40 bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
                  i > step && "opacity-45",
                )}
              >
                <span
                  className={cx(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-3xs tnum",
                    i < step ? "border-success/40 bg-success-soft text-success" : i === step ? "border-accent/50 text-accent" : "border-line text-faint",
                  )}
                >
                  {i < step ? <Check size={11} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-2xs font-medium text-text">{s.label}</span>
                  <span className="block truncate text-3xs text-faint">{s.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Note({ tone, children }: { tone: "info" | "warning" | "danger"; children: React.ReactNode }) {
  const Icon = tone === "info" ? Info : TriangleAlert;
  return (
    <div
      className={cx(
        "flex items-start gap-2.5 rounded-default border px-3 py-2.5 text-2xs leading-relaxed",
        tone === "info" && "border-info/25 bg-info-soft text-muted",
        tone === "warning" && "border-warning/25 bg-warning-soft text-warning",
        tone === "danger" && "border-danger/25 bg-danger-soft text-danger",
      )}
    >
      <Icon size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
