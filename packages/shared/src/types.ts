/**
 * Arvoo shared domain types.
 * These types are the contract between Control Plane (api), Node Agent and Web UI.
 */

export type UUID = string;
/** ISO-8601 timestamp string (UTC). */
export type ISODate = string;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeRole =
  | "master"
  | "vpn"
  | "edge"
  | "gateway"
  | "transit"
  | "custom";

export type NodeRegionClass = "iran" | "international";

/**
 * Derived from agent heartbeats. `pending` = created, agent not yet approved.
 * The control plane never guesses: absence of heartbeats means `offline`/`unknown`.
 */
export type NodeStatus =
  | "pending"
  | "online"
  | "offline"
  | "degraded"
  | "maintenance"
  | "error"
  | "unknown";

export type AgentEnrollmentState = "not_enrolled" | "enrolled" | "approved" | "revoked";

export interface NodeRecord {
  id: UUID;
  name: string;
  hostname: string | null;
  /** Public management address the agent connects from (informational; auth is cryptographic). */
  address: string | null;
  region: string | null;
  country: string | null;
  provider: string | null;
  role: NodeRole;
  regionClass: NodeRegionClass;
  tags: string[];
  description: string | null;
  status: NodeStatus;
  enrollmentState: AgentEnrollmentState;
  agentVersion: string | null;
  agentPlatform: string | null;
  lastHeartbeatAt: ISODate | null;
  isSelf: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface NodeInterfaceInfo {
  name: string;
  addresses: string[];
}

export interface NodeTelemetry {
  cpuModel: string | null;
  cpuCores: number;
  cpuUsagePct: number | null;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsagePct: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskUsagePct: number | null;
  loadAvg: [number, number, number];
  uptimeSec: number;
  os: string;
  kernel: string | null;
  openvpnVersion: string | null;
  interfaces: NodeInterfaceInfo[];
  /** Per-interface byte counters (real values read from the OS, may be absent). */
  trafficCounters: Record<string, { rx: number; tx: number }>;
  services: Array<{ name: string; status: "running" | "stopped" | "unknown" }>;
  /** GRE interfaces observed on the node. */
  greInterfaces: Array<{ name: string; local: string | null; remote: string | null }>;
  /** OpenVPN server processes observed on the node. */
  openvpnProcesses: Array<{ name: string; status: "running" | "stopped" }>;
  /** Discovered feature support, probed for real on the node (may be null on non-Linux). */
  capabilities?: NodeCapabilities | null;
}

export interface NodeHealthSample {
  id: UUID;
  nodeId: UUID;
  at: ISODate;
  cpuUsagePct: number | null;
  memoryUsagePct: number | null;
  diskUsagePct: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  openvpnClients: number | null;
}

// ---------------------------------------------------------------------------
// Inbounds
// ---------------------------------------------------------------------------

export type VpnProtocol = "openvpn";
export type TransportProtocol = "udp" | "tcp";
export type InboundStatus = "draft" | "active" | "deploying" | "error" | "stopped";
export type PerformanceProfile = "balanced" | "low-latency" | "throughput" | "compatibility";
export type TlsMode = "tls-crypt" | "tls-auth" | "none";

export interface OpenVPNStructuredConfig {
  port: number;
  listenAddress: string;
  transport: TransportProtocol;
  device: "tun";
  topology: "subnet";
  /** VPN client subnet, e.g. "10.40.0.0/24". */
  serverNetwork: string;
  dnsServers: string[];
  redirectGateway: boolean;
  clientToClient: boolean;
  tunMtu: number;
  mssFix: number | null;
  fragment: number | null;
  dataCiphers: string[];
  /** Legacy fallback cipher only for the compatibility profile. */
  fallbackCipher: string | null;
  authDigest: string;
  tlsMode: TlsMode;
  tlsVersionMin: "1.2" | "1.3";
  keepaliveInterval: number;
  keepaliveTimeout: number;
  maxClients: number;
  performanceProfile: PerformanceProfile;
  compression: "off";
  duplicateCn: boolean;
  pushRoutes: string[];
  logVerbosity: number;
  /** Deployment path selector: direct on node, or egress through a GRE tunnel. */
  deploymentMode: "direct" | "through-tunnel";
  /** When deploymentMode = through-tunnel: tunnel used for egress. */
  tunnelId: UUID | null;
  /** Egress node when traffic must exit through another node. */
  egressNodeId: UUID | null;
}

export interface InboundRecord {
  id: UUID;
  name: string;
  description: string | null;
  protocol: VpnProtocol;
  nodeId: UUID;
  status: InboundStatus;
  structuredConfig: OpenVPNStructuredConfig;
  currentVersion: number;
  clientCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface InboundVersionRecord {
  id: UUID;
  inboundId: UUID;
  version: number;
  structuredConfig: OpenVPNStructuredConfig;
  generatedConfig: string;
  checksumSha256: string;
  createdBy: string | null;
  createdAt: ISODate;
}

export interface InboundDeploymentRecord {
  id: UUID;
  inboundId: UUID;
  nodeId: UUID;
  version: number;
  operationId: UUID;
  status: "queued" | "running" | "success" | "failed" | "rolled_back";
  error: string | null;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export type ClientStatus = "active" | "suspended" | "expired" | "revoked";

export interface ClientLimits {
  /** Total billed traffic quota in bytes. null = unlimited. */
  trafficQuotaBytes: number | null;
  timeQuotaSec: number | null;
  expiresAt: ISODate | null;
  startsAt: ISODate | null;
  concurrentSessions: number | null;
  deviceLimit: number | null;
  ipLimit: number | null;
  ipAllowlist: string[];
  ipDenylist: string[];
  /** Static bandwidth cap in kbps; null = unlimited. */
  downloadSpeedKbps: number | null;
  uploadSpeedKbps: number | null;
}

export interface ClientRecord {
  id: UUID;
  username: string;
  displayName: string | null;
  description: string | null;
  status: ClientStatus;
  groupId: UUID | null;
  tags: string[];
  notes: string | null;
  limits: ClientLimits;
  /** Base usage multiplier (1.0 = normal consumption). */
  baseMultiplier: number;
  /** Billed bytes (rx+tx multiplied by effective multiplier). */
  usedBilledBytes: number;
  /** Raw received bytes. */
  rxBytes: number;
  /** Raw sent bytes. */
  txBytes: number;
  usedTimeSec: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ClientDeviceRecord {
  id: UUID;
  clientId: UUID;
  /** Device identifier: IV_HWADDR (MAC) when provided by the client, else IP-derived. */
  hwid: string;
  label: string | null;
  firstSeenAt: ISODate;
  lastSeenAt: ISODate;
  lastIp: string | null;
  revoked: boolean;
}

export interface ClientSessionRecord {
  id: UUID;
  clientId: UUID;
  inboundId: UUID | null;
  nodeId: UUID | null;
  commonName: string;
  sourceIp: string | null;
  vpnIp: string | null;
  hwid: string | null;
  connectedAt: ISODate;
  lastSeenAt: ISODate;
  durationSec: number;
  rxBytes: number;
  txBytes: number;
  active: boolean;
}

export interface ClientUsageSample {
  id: UUID;
  clientId: UUID;
  at: ISODate;
  rxBytes: number;
  txBytes: number;
  billedBytes: number;
}

export interface ClientGroupRecord {
  id: UUID;
  name: string;
  description: string | null;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export type PolicyConditionType =
  | "client"
  | "group"
  | "inbound"
  | "node"
  | "sourceIp"
  | "timeOfDay"
  | "dayOfWeek"
  | "trafficUsedBytes"
  | "activeSessions"
  | "deviceCount";

export type PolicyConditionOp =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "lt"
  | "lte"
  | "gt"
  | "gte";

export interface PolicyCondition {
  type: PolicyConditionType;
  op: PolicyConditionOp;
  value: unknown;
}

export type PolicyActionType =
  | "deny"
  | "suspend"
  | "limit_bandwidth"
  | "limit_sessions"
  | "limit_devices"
  | "apply_multiplier"
  | "alert";

export interface PolicyAction {
  type: PolicyActionType;
  params?: Record<string, unknown>;
}

export interface PolicyRuleRecord {
  id: UUID;
  name: string;
  description: string | null;
  enabled: boolean;
  /** Lower number = evaluated first. */
  priority: number;
  effectiveFrom: ISODate | null;
  effectiveUntil: ISODate | null;
  conditions: PolicyCondition[];
  actions: PolicyAction[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ---------------------------------------------------------------------------
// Tunnels (GRE)
// ---------------------------------------------------------------------------

export type TunnelType = "gre";
export type TunnelStatus = "planned" | "deploying" | "up" | "degraded" | "down" | "error";

/** UDP (FOU) port this GRE tunnel is encapsulated in, null = raw GRE. */
export interface TunnelEncap {
  fouPort: number | null;
  ipsecEnabled: boolean;
}

export interface TunnelRecord {
  id: UUID;
  name: string;
  type: TunnelType;
  sourceNodeId: UUID;
  destNodeId: UUID;
  /** Public endpoint IPs used to carry the tunnel. */
  sourceEndpoint: string;
  destEndpoint: string;
  /** /30 transport network carved out for this tunnel. */
  tunnelNetwork: string;
  localTunnelIp: string;
  remoteTunnelIp: string;
  mtu: number;
  ttl: number;
  key: string | null;
  keepaliveIntervalSec: number;
  keepaliveRetries: number;
  /** FOU (UDP) encapsulation port; null = raw GRE (IP protocol 47). */
  fouPort: number | null;
  /** GRE over IPsec (strongSwan, transport-mode ESP on the public endpoints). */
  ipsecEnabled: boolean;
  status: TunnelStatus;
  latencyMs: number | null;
  lossPct: number | null;
  lastVerifiedAt: ISODate | null;
  /** Manual MTU override set by the administrator (bypasses the engine). */
  mtuOverride: number | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface RouteRecord {
  id: UUID;
  nodeId: UUID;
  destination: string;
  gateway: string | null;
  device: string | null;
  metric: number | null;
  scope: "tunnel" | "inbound" | "manual";
  refId: UUID | null;
  comment: string | null;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type OperationType =
  | "InstallOpenVPN"
  | "CreateOpenVPNInbound"
  | "UpdateOpenVPNInbound"
  | "DeleteOpenVPNInbound"
  | "RestartOpenVPN"
  | "StopOpenVPN"
  | "KillClient"
  | "ApplyIPsec"
  | "RemoveIPsec"
  | "CreateGRE"
  | "DeleteGRE"
  | "AddRoute"
  | "DeleteRoute"
  | "ApplyFirewallPolicy"
  | "CollectDiagnostics"
  | "TestTunnel"
  | "RunBenchmark"
  | "SyncConfiguration";

export type OperationStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "rolled_back";

export interface OperationRecord {
  id: UUID;
  type: OperationType;
  nodeId: UUID | null;
  refType: "inbound" | "tunnel" | "route" | "node" | null;
  refId: UUID | null;
  requestedBy: string | null;
  status: OperationStatus;
  progress: number;
  input: unknown;
  output: unknown;
  error: string | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export interface OperationLogRecord {
  id: UUID;
  operationId: UUID;
  at: ISODate;
  level: "info" | "warn" | "error";
  step: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Audit / Alerts
// ---------------------------------------------------------------------------

export type AuditAction =
  | "auth.login"
  | "auth.logout"
  | "auth.failed"
  | "user.create"
  | "user.update"
  | "user.disable"
  | "node.create"
  | "node.update"
  | "node.delete"
  | "node.approve"
  | "node.revoke"
  | "inbound.create"
  | "inbound.update"
  | "inbound.delete"
  | "inbound.deploy"
  | "inbound.rollback"
  | "client.create"
  | "client.update"
  | "client.suspend"
  | "client.resume"
  | "client.revoke"
  | "client.rotate"
  | "client.config_generate"
  | "policy.create"
  | "policy.update"
  | "policy.delete"
  | "tunnel.create"
  | "tunnel.delete"
  | "tunnel.deploy"
  | "tunnel.mesh"
  | "tunnel.benchmark"
  | "route.create"
  | "route.delete"
  | "settings.update"
  | "alert.resolve"
  | "routing.place"
  | "routing.policy"
  | "routing.admin"
  | "routing.probe"
  | "system.secret_rotate"
  | "security.management_secret_rotate"
  | "security.management_secret_disable"
  | "security.management_secret_policy"
  | "security.management_secret_previous_used";

export interface AuditRecord {
  id: UUID;
  at: ISODate;
  actorId: UUID | null;
  actorName: string | null;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  entityName: string | null;
  summary: string;
  detail: unknown;
  ip: string | null;
}

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface AlertRecord {
  id: UUID;
  severity: AlertSeverity;
  type: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  status: AlertStatus;
  createdAt: ISODate;
  resolvedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Users / RBAC
// ---------------------------------------------------------------------------

export type UserRole = "admin" | "operator" | "viewer";

export interface UserRecord {
  id: UUID;
  username: string;
  displayName: string | null;
  role: UserRole;
  active: boolean;
  lastLoginAt: ISODate | null;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Agent API contracts
// ---------------------------------------------------------------------------

export interface AgentHelloRequest {
  enrollmentToken: string;
  hostname: string;
  platform: string;
  agentVersion: string;
}

export interface AgentHelloResponse {
  nodeId: UUID;
  nodeSecret: string;
  /** Minimum seconds between heartbeats. */
  heartbeatIntervalSec: number;
}

export interface AgentHeartbeatRequest {
  telemetry: NodeTelemetry;
  /** Delta of openvpn connected client lists parsed from live status. */
  openvpnStatus?: Array<{
    inboundName: string;
    connected: Array<{
      commonName: string;
      realIp: string;
      vpnIp: string | null;
      rxBytes: number;
      txBytes: number;
      connectedSinceSec: number;
    }>;
  }>;
}

export interface AgentHeartbeatResponse {
  heartbeatIntervalSec: number;
}

export interface AgentAuthorizeRequest {
  commonName: string;
  sourceIp: string;
  vpnIp: string | null;
  hwid: string | null;
  inboundName: string;
}

export interface AgentAuthorizeResponse {
  allow: boolean;
  reason: string | null;
  /** Extra config directives to push on connect (empty normally). */
  directives: string[];
}

export interface AgentOperationPayload {
  id: UUID;
  type: OperationType;
  input: unknown;
}

export interface GreOpInput {
  interfaceName: string;
  localEndpoint: string;
  remoteEndpoint: string;
  localTunnelIp: string;
  remoteTunnelIp: string;
  tunnelNetwork: string;
  mtu: number;
  ttl: number;
  key: string | null;
  /** UDP port for GRE-over-FOU encapsulation; null/absent = raw GRE. */
  fouPort: number | null;
  routes: Array<{ destination: string; gateway?: string; device?: string }>;
}

export interface BenchmarkOpInput {
  interfaceName: string;
  localTunnelIp: string;
  remoteTunnelIp: string;
  /** ICMP echo count for latency/loss/jitter (default 20). */
  pingCount?: number;
  /** Try iperf3 to the remote tunnel IP for throughput (server side required). */
  iperfSeconds?: number | null;
}

export interface IPsecOpInput {
  interfaceName: string;
  localPublicIp: string;
  remotePublicIp: string;
  /** Pre-shared key for IKEv2 (stored encrypted at rest, never logged). */
  psk: string;
}

export interface NodeCapabilities {
  gre: boolean | null;
  fou: boolean | null;
  nftables: boolean | null;
  ipsec: { available: boolean; tool: string | null; version: string | null };
  dco: { supported: boolean; reason: string };
  openvpnVersion: string | null;
  kernel: string | null;
}

export interface OpenVPNOpInput {
  inboundName: string;
  port: number;
  protocol: TransportProtocol;
  configText: string;
  /** PKI material to write on the node (never stored in plaintext at rest here). */
  pki: {
    ca: string;
    cert: string;
    key: string;
    tlsKey: string | null;
    tlsMode: TlsMode;
    dhParam: string | null;
  };
  clientNetwork: string;
  /** NAT/forwarding to apply when this inbound egresses via a tunnel. */
  egress?: {
    egressInterface: string | null;
    masqueradeSourceNetworks: string[];
    forwardFromSubnet: string;
  } | null;
  clientConnectHook: string | null;
}

export interface TunnelTestResult {
  ok: boolean;
  latencyMs: number | null;
  lossPct: number | null;
  interfacePresent: boolean;
  pingOk: boolean;
  mtuDetected: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export interface TopologyGraph {
  nodes: Array<{
    id: UUID;
    name: string;
    role: NodeRole;
    regionClass: NodeRegionClass;
    status: NodeStatus;
    isSelf: boolean;
    openvpnClients: number;
  }>;
  links: Array<{
    id: UUID;
    kind: "tunnel";
    sourceNodeId: UUID;
    destNodeId: UUID;
    status: TunnelStatus;
    latencyMs: number | null;
    name: string;
  }>;
  inbounds: Array<{
    id: UUID;
    name: string;
    nodeId: UUID;
    status: InboundStatus;
    clientCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardStats {
  nodes: { total: number; online: number; offline: number; pending: number; degraded: number };
  inbounds: { total: number; active: number };
  clients: { total: number; active: number; connected: number };
  tunnels: { total: number; up: number; degraded: number; down: number };
  traffic: { last24hBilledBytes: number | null };
}
