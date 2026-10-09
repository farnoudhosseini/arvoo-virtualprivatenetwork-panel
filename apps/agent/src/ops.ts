/**
 * Typed operation executors. Each operation is a structured payload; no
 * arbitrary shell commands are ever accepted from the control plane.
 *
 * Linux is required for networking/OpenVPN operations. On other platforms the
 * executor fails honestly with an explicit message instead of simulating.
 */

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type {
  BenchmarkOpInput,
  CleanupNodeOpInput,
  FirewallOpInput,
  FirewallRule,
  GreOpInput,
  IPsecOpInput,
  NodeCapabilities,
  OpenVPNOpInput,
  TestTunnelOpInput,
  TunnelTestResult,
} from "@arvoo/shared";
import {
  GRE_KEY_RULE,
  canonicalGreKey,
  greKeyCliValue,
  greKeyFromLinkShow,
  greLinkStateFromLinkShow,
  routeDeviceFromRouteGet,
  tunnelAddressesFromAddrShow,
  verifyGreTunnel,
} from "@arvoo/shared";
import { applyFirewallPlan, ufwAvailable } from "./ufw.js";
import { exec } from "./linux.js";

export interface OpResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

function requiresLinux(): OpResult {
  return {
    success: false,
    error:
      "This operation requires a Linux node (iproute2/systemd/OpenVPN). The current agent host is not Linux, so the operation was not executed.",
  };
}

// ---------------------------------------------------------------------------
// Shared privileged helpers
// ---------------------------------------------------------------------------

/**
 * Is `port` already listening for the given protocol?
 *
 * `ss` is invoked with an argv array (never a shell pipeline), and the
 * human-readable output is parsed here. Returns null when `ss` is unavailable,
 * so callers can decide instead of guessing. Checking the matching protocol
 * matters: a TCP inbound must not be declared free just because no UDP socket
 * holds the port (and vice versa).
 */
async function portIsListening(port: number, protocol: "udp" | "tcp"): Promise<boolean | null> {
  const args = protocol === "tcp" ? ["-ltn"] : ["-lun"];
  const res = await exec("ss", args, 5000).catch(() => null);
  if (!res || res.code !== 0) return null;
  const suffix = `:${port}`;
  return res.stdout.split(/\r?\n/).some((line) => {
    const fields = line.trim().split(/\s+/);
    // ss prints: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port ...
    if (fields.length < 5) return false;
    return fields[3]!.endsWith(suffix);
  });
}

/**
 * Verify (and only if necessary enable) IPv4 forwarding.
 *
 * The installer enables this persistently in /etc/sysctl.d/99-arvoo.conf, so a
 * rebooted node already has it set and the agent only needs to read /proc/sys.
 * The `sysctl -w` fallback exists for hosts where forwarding was turned off by
 * hand; it fails cleanly instead of pretending the deployment succeeded.
 */
async function ensureIpForward(): Promise<string | null> {
  const current = await readFile("/proc/sys/net/ipv4/ip_forward", "utf8").catch(() => null);
  if (current?.trim() === "1") return null;

  const sysctl = await exec("sysctl", ["-w", "net.ipv4.ip_forward=1"]).catch(() => null);
  if (sysctl?.code === 0) return null;

  return (
    "IPv4 forwarding is disabled on this node and the agent could not enable it " +
    "(writing /proc/sys is not permitted in the agent sandbox). Enable it persistently and retry: " +
    "echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-arvoo.conf && sysctl --system"
  );
}

// ---------------------------------------------------------------------------
// GRE
// ---------------------------------------------------------------------------

/**
 * The `ip link add` argv for a GRE interface, key field included. Pure, so the
 * exact command - and the exact spelling of the key - can be asserted in tests
 * without root. `canonicalKey` is the validated 32-bit key or null.
 */
export function greLinkArgs(input: GreOpInput, canonicalKey: string | null): string[] {
  const args = [
    "link",
    "add",
    input.interfaceName,
    "type",
    "gre",
    "local",
    input.localEndpoint,
    "remote",
    input.remoteEndpoint,
    "ttl",
    String(input.ttl),
  ];
  if (canonicalKey !== null) args.push("key", greKeyCliValue(canonicalKey)!);
  return args;
}

export async function applyGre(input: GreOpInput): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();

  // Canonical payload from the control plane (validated again in validate-op.ts);
  // iproute2 parses `key` with base 0, so the hex value is passed 0x-prefixed to
  // keep the exact 32-bit field instead of being read as a decimal number.
  const canonicalKey = input.key === null || input.key === undefined ? null : canonicalGreKey(input.key);
  if (canonicalKey === null && input.key !== null && input.key !== undefined) {
    return { success: false, error: `key must be ${GRE_KEY_RULE}` };
  }

  // Idempotent: remove pre-existing interface of the same name first
  await exec("ip", ["link", "del", input.interfaceName], 5000).catch(() => undefined);

  const args = greLinkArgs(input, canonicalKey);

  if (input.fouPort != null) {
    // GRE over FOU: the kernel sends GRE inside UDP on the given port. The FOU
    // receiver must listen on the same port on the remote node (same ipproto 47).
    await exec("modprobe", ["fou"]);
    await exec("ip", ["fou", "del", "port", String(input.fouPort)]).catch(() => undefined);
    const fou = await exec("ip", ["fou", "add", "port", String(input.fouPort), "ipproto", "47"]);
    if (fou.code !== 0 && !fou.stderr.includes("File exists")) {
      return { success: false, error: `FOU listener on port ${input.fouPort} failed: ${fou.stderr.trim()}` };
    }
    args.push("encap", "fou", "encap-sport", "auto", "encap-dport", String(input.fouPort));
  }

  const add = await exec("ip", args);
  if (add.code !== 0) return { success: false, error: `ip link add failed: ${add.stderr.trim()}` };

  // GRO on the receive path can collapse FOU-encapsulated packets and cut
  // throughput sharply; disable it on the tunnel device when FOU is in use.
  if (input.fouPort != null) {
    await exec("ethtool", ["-K", input.interfaceName, "gro", "off"]).catch(() => undefined);
  }

  const addr = await exec("ip", ["addr", "add", `${input.localTunnelIp}/30`, "dev", input.interfaceName]);
  if (addr.code !== 0 && !addr.stderr.includes("File exists")) {
    return { success: false, error: `addr add failed: ${addr.stderr.trim()}` };
  }

  const up = await exec("ip", ["link", "set", "dev", input.interfaceName, "mtu", String(input.mtu), "up"]);
  if (up.code !== 0) return { success: false, error: `link set up failed: ${up.stderr.trim()}` };

  for (const route of input.routes) {
    const rArgs = ["route", "replace", route.destination];
    if (route.gateway) rArgs.push("via", route.gateway);
    if (route.device) rArgs.push("dev", route.device);
    const r = await exec("ip", rArgs);
    if (r.code !== 0) return { success: false, error: `route add failed: ${r.stderr.trim()}` };
  }

  // Persist under /etc/arvoo/gre so the network can be re-applied after reboot
  // by `arvoo-agent apply-persisted` (systemd unit optional).
  try {
    const dir = "/etc/arvoo/gre";
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${input.interfaceName}.json`), JSON.stringify(input, null, 2), { mode: 0o600 });
  } catch {
    // persistence best-effort; runtime state still applied
  }

  // In-place verification: the interface exists, the kernel installed the key we
  // asked for, and ping crosses the tunnel. `-d` is needed to see the key field.
  const link = await exec("ip", ["-d", "link", "show", input.interfaceName]);
  if (link.code !== 0) return { success: false, error: "Interface not present after creation" };

  // Read the key back from the kernel: a key that was parsed differently (for
  // example a decimal number read as hex) must be reported, not assumed.
  const observedKey = greKeyFromLinkShow(link.stdout);
  if (canonicalKey !== null && observedKey !== null && observedKey !== canonicalKey) {
    return {
      success: false,
      error: `Kernel installed GRE key ${observedKey} but ${canonicalKey} was requested`,
    };
  }
  const keyVerified = canonicalKey === null ? null : observedKey !== null && observedKey === canonicalKey;

  const ping = await exec("ping", ["-c", "3", "-W", "2", "-I", input.interfaceName, input.remoteTunnelIp], 15000);
  const lossMatch = ping.stdout.match(/(\d+(?:\.\d+)?)% packet loss/);
  const lossPct = lossMatch ? Number(lossMatch[1]) : null;
  const rttMatch = ping.stdout.match(/= [\d.]+\/([\d.]+)\//);
  const latencyMs = rttMatch ? Number(rttMatch[1]) : null;
  const pingOk = ping.code === 0;

  return {
    success: pingOk,
    error: pingOk ? undefined : "Tunnel interface created but remote tunnel IP did not answer ping (side may be down)",
    output: {
      ok: pingOk,
      latencyMs,
      lossPct,
      interfacePresent: true,
      pingOk,
      mtuDetected: input.mtu,
      key: canonicalKey,
      keyVerified,
      error: pingOk ? null : "ping across tunnel failed",
    } satisfies TunnelTestResult & { ok: boolean },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation: re-apply what this agent recorded, report everything else
// ---------------------------------------------------------------------------

export interface DriftEntry {
  kind: "gre";
  name: string;
  state: "present" | "restored" | "missing-and-restore-failed";
  error?: string;
}

/**
 * Compare the GRE interfaces this agent persisted in /etc/arvoo/gre with what
 * Linux has, and re-apply only the ones that are missing. Only specs written
 * by this agent are touched, so unrelated interfaces and routes are never
 * flushed or altered.
 */
export async function reconcileGre(): Promise<DriftEntry[]> {
  if (process.platform !== "linux") return [];
  const dir = "/etc/arvoo/gre";
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f: string) => f.endsWith(".json"));
  const report: DriftEntry[] = [];
  for (const file of files) {
    const spec = JSON.parse(await readFile(path.join(dir, file), "utf8")) as GreOpInput;
    if (!/^[a-z0-9][a-z0-9-]{1,14}$/.test(spec.interfaceName)) continue;
    const link = await exec("ip", ["link", "show", spec.interfaceName]);
    if (link.code === 0) {
      report.push({ kind: "gre", name: spec.interfaceName, state: "present" });
      continue;
    }
    const restored = await applyGre(spec);
    report.push(
      restored.success
        ? { kind: "gre", name: spec.interfaceName, state: "restored" }
        : { kind: "gre", name: spec.interfaceName, state: "missing-and-restore-failed", error: restored.error },
    );
  }
  return report;
}

export async function deleteGre(input: { interfaceName: string }): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const del = await exec("ip", ["link", "del", input.interfaceName]);
  await rm(`/etc/arvoo/gre/${input.interfaceName}.json`, { force: true }).catch(() => undefined);
  if (del.code !== 0 && !del.stderr.includes("Cannot find device")) {
    return { success: false, error: del.stderr.trim() };
  }
  return { success: true, output: { removed: true } };
}

/**
 * Verify the tunnel that is actually configured on this node.
 *
 * Every value is read back from the kernel - the interface state from
 * `ip -d link show`, the assigned addresses from `ip -4 addr show dev`, the
 * egress decision from `ip route get <remote>` - and the data plane from a real
 * ICMP probe. The panel's expected configuration is compared field by field, so
 * an interface that exists but has the wrong key, address, MTU or no route fails
 * the test instead of being reported as a healthy tunnel. Each check is reported
 * individually (`failedChecks`) and the operation itself is failed when the
 * tunnel does not verify, so the dashboard cannot show green for a dead tunnel.
 */
export async function testGre(input: TestTunnelOpInput): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();

  const link = await exec("ip", ["-d", "link", "show", input.interfaceName]).catch(() => null);
  const state = greLinkStateFromLinkShow(link?.code === 0 ? link.stdout : "");

  let addresses: string[] = [];
  let routeDev: string | null = null;
  if (state.present) {
    const addr = await exec("ip", ["-4", "addr", "show", "dev", input.interfaceName]).catch(() => null);
    addresses = addr?.code === 0 ? tunnelAddressesFromAddrShow(addr.stdout) : [];
    const route = await exec("ip", ["route", "get", input.remoteTunnelIp], 8000).catch(() => null);
    routeDev = route?.code === 0 ? routeDeviceFromRouteGet(route.stdout) : null;
  }

  // One real probe across the tunnel interface. "No reply" is a measurement of a
  // broken data plane, not an error of the check itself.
  const ping = state.present
    ? await exec("ping", ["-c", "5", "-W", "2", "-I", input.interfaceName, input.remoteTunnelIp], 20000).catch(() => null)
    : null;
  const lossMatch = ping?.stdout.match(/(\d+(?:\.\d+)?)% packet loss/);
  const lossPct = lossMatch ? Number(lossMatch[1]) : null;
  const receivedMatch = ping?.stdout.match(/(\d+) received/);
  const received = receivedMatch ? Number(receivedMatch[1]) : null;
  const rttMatch = ping?.stdout.match(/= [\d.]+\/([\d.]+)\//);
  const latencyMs = rttMatch ? Number(rttMatch[1]) : null;
  const pingOk = state.present && ping?.code === 0;

  const check = verifyGreTunnel(input, { link: state, addresses, routeDev, pingOk: state.present ? pingOk : false });

  const output: TunnelTestResult = {
    ok: check.ok,
    latencyMs,
    lossPct,
    samples: received,
    interfacePresent: check.interfacePresent,
    pingOk,
    mtuDetected: check.mtuDetected,
    key: check.observedKey,
    keyVerified: check.keyVerified,
    ifUp: check.ifUp,
    carrierUp: check.carrierUp,
    endpointVerified: check.endpointVerified,
    addressVerified: check.addressVerified,
    mtuVerified: check.mtuVerified,
    ttlVerified: check.ttlVerified,
    routeOk: check.routeOk,
    failedChecks: check.failedChecks,
    error: check.failures.length > 0 ? check.failures.join("; ") : null,
  };

  if (!check.ok) {
    return {
      success: false,
      output,
      error: `Tunnel ${input.interfaceName} failed verification: ${check.failures.join("; ") || "unknown reason"}`,
    };
  }
  return { success: true, output };
}

// ---------------------------------------------------------------------------
// GRE over IPsec (strongSwan swanctl, transport mode, PSK)
// ---------------------------------------------------------------------------

const SWANCTL_DIR = "/etc/swanctl/conf.d";

function swanctlConnName(interfaceName: string): string {
  return `arvoo-${interfaceName}`;
}

/**
 * Transport-mode IKEv2 + ESP that protects only GRE (IP protocol 47) between
 * the two public endpoints. GRE itself carries no encryption, so this is the
 * only thing that makes an "encrypted" tunnel true.
 */
export async function applyIPsec(input: IPsecOpInput): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const caps = await probeIPsec();
  if (!caps.available) {
    return { success: false, error: "strongSwan (swanctl) is not installed or its charon daemon is not running on this node." };
  }

  const name = swanctlConnName(input.interfaceName);
  const conf = `connections {
  ${name} {
    version = 2
    local_addrs = ${input.localPublicIp}
    remote_addrs = ${input.remotePublicIp}
    proposals = aes256gcm16-prfsha256-ecp256
    local {
      auth = psk
      id = ${input.localPublicIp}
    }
    remote {
      auth = psk
      id = ${input.remotePublicIp}
    }
    children {
      ${name} {
        local_ts = ${input.localPublicIp}/32[47]
        remote_ts = ${input.remotePublicIp}/32[47]
        mode = transport
        esp_proposals = aes256gcm16
        start_action = start
        dpd_action = restart
      }
    }
  }
}
secrets {
  ike-${name} {
    id-local = ${input.localPublicIp}
    id-remote = ${input.remotePublicIp}
    secret = ${input.psk}
  }
}
`;
  await mkdir(SWANCTL_DIR, { recursive: true });
  await writeFile(path.join(SWANCTL_DIR, `${name}.conf`), conf, { mode: 0o600 });

  const load = await exec("swanctl", ["--load-all"], 30000);
  if (load.code !== 0) return { success: false, error: `swanctl --load-all failed: ${load.stderr.trim()}` };

  const init = await exec("swanctl", ["--initiate", "--child", name, "--timeout", "15"], 25000);
  const sas = await exec("swanctl", ["--list-sas", "--ike", name], 10000);
  const established = /ESTABLISHED/.test(sas.stdout) && /INSTALLED/.test(sas.stdout);
  if (!established) {
    return { success: false, error: `IKE/ESP not established: ${init.stderr.trim() || sas.stdout.trim() || "no SA"}` };
  }
  return { success: true, output: { established: true, connection: name } };
}

export async function removeIPsec(input: { interfaceName: string }): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const name = swanctlConnName(input.interfaceName);
  await exec("swanctl", ["--terminate", "--ike", name], 10000).catch(() => undefined);
  await rm(path.join(SWANCTL_DIR, `${name}.conf`), { force: true }).catch(() => undefined);
  await exec("swanctl", ["--load-all"], 30000).catch(() => undefined);
  return { success: true, output: { removed: true } };
}

async function probeIPsec(): Promise<{ available: boolean; tool: string | null; version: string | null }> {
  const r = await exec("swanctl", ["--version"], 4000).catch(() => null);
  if (!r || r.code !== 0) return { available: false, tool: null, version: null };
  const version = r.stdout.match(/strongSwan\s+(\S+)/i)?.[1] ?? null;
  // The charon daemon must answer; a binary without a running daemon is not usable.
  const stats = await exec("swanctl", ["--stats"], 4000).catch(() => null);
  return { available: stats?.code === 0, tool: "swanctl", version };
}

// ---------------------------------------------------------------------------
// Capability discovery (real probes, never assumed)
// ---------------------------------------------------------------------------

/**
 * Discover what this node can actually do. Every field is measured:
 * a kernel module must load, a binary must answer, a daemon must respond.
 */
export async function probeCapabilities(openvpnVersion: string | null): Promise<NodeCapabilities> {
  if (process.platform !== "linux") {
    return {
      gre: null,
      fou: null,
      nftables: null,
      ipsec: { available: false, tool: null, version: null },
      dco: { supported: false, reason: "not a Linux node" },
      openvpnVersion,
      kernel: null,
    };
  }
  const kernel = (await exec("uname", ["-r"], 3000).catch(() => null))?.stdout.trim() ?? null;

  const gre = await moduleLoadable("ip_gre");
  const fou = await moduleLoadable("fou");
  const nft = await exec("nft", ["--version"], 3000).catch(() => null);
  const ipsec = await probeIPsec();

  let dco: { supported: boolean; reason: string };
  const dcoModule = (await moduleLoadable("ovpn_dco_v2")) || (await moduleLoadable("ovpn"));
  if (dcoModule) dco = { supported: true, reason: "ovpn kernel module available" };
  else dco = { supported: false, reason: "ovpn / ovpn_dco_v2 kernel module not loadable on this kernel" };

  return {
    gre,
    fou,
    nftables: nft?.code === 0,
    ipsec,
    dco,
    openvpnVersion,
    kernel,
  };
}

async function moduleLoadable(name: string): Promise<boolean> {
  const r = await exec("modprobe", ["-n", name], 4000).catch(() => null);
  return r?.code === 0;
}

// ---------------------------------------------------------------------------
// Benchmark (real measurements over the tunnel)
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  latencyMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  throughputMbps: number | null;
  /** ICMP replies actually received - never the number that was requested. */
  samples: number | null;
  /** Set when the probe measured partial connectivity (packet loss). */
  warning?: string | null;
}

/** Parse the received throughput from `iperf3 -J` output. Null when absent or invalid. */
export function parseIperfMbps(json: string): number | null {
  try {
    const bps = (JSON.parse(json) as { end?: { sum_received?: { bits_per_second?: unknown } } }).end?.sum_received?.bits_per_second;
    return typeof bps === "number" && Number.isFinite(bps) ? Math.round((bps / 1e6) * 10) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * Measure latency, jitter and loss with ICMP across the tunnel interface, and
 * throughput with iperf3 when a server answers on the remote tunnel IP.
 */
export async function runBenchmark(input: BenchmarkOpInput): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const count = input.pingCount ?? 20;
  const ping = await exec("ping", ["-c", String(count), "-i", "0.2", "-W", "2", "-I", input.interfaceName, input.remoteTunnelIp], count * 1000 + 10000);
  const lossMatch = ping.stdout.match(/(\d+(?:\.\d+)?)% packet loss/);
  const receivedMatch = ping.stdout.match(/(\d+) received/);
  const rtt = ping.stdout.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?/);
  const result: BenchmarkResult = {
    latencyMs: rtt ? Number(rtt[2]) : null,
    jitterMs: rtt && rtt[4] ? Number(rtt[4]) : null,
    lossPct: lossMatch ? Number(lossMatch[1]) : null,
    throughputMbps: null,
    // Replies, not probes: a benchmark that measured nothing must not report a
    // sample count as if it had.
    samples: receivedMatch ? Number(receivedMatch[1]) : null,
    warning: null,
  };

  if (input.iperfSeconds) {
    // Binds the client to the tunnel interface address; an unreachable iperf3
    // server leaves throughput null instead of a guessed value.
    const iperf = await exec(
      "iperf3",
      ["-c", input.remoteTunnelIp, "-B", input.localTunnelIp, "-t", String(input.iperfSeconds), "-J"],
      (input.iperfSeconds + 15) * 1000,
    ).catch(() => null);
    result.throughputMbps = parseIperfMbps(iperf?.stdout ?? "");
  }

  // Success requires a tunnel that answered with measurements. 100% loss, a ping
  // that never printed a summary (timeout) or nothing parsable at all is a
  // failed benchmark - it may never be reported as a successful empty one.
  const totalLoss = (result.lossPct != null && result.lossPct >= 100) || result.samples === 0;
  if (totalLoss || (result.lossPct == null && result.latencyMs == null)) {
    return {
      success: false,
      output: result,
      error: totalLoss
        ? `Benchmark produced no measurements: 100% packet loss to ${input.remoteTunnelIp} across ${input.interfaceName}.`
        : "Benchmark produced no measurements: the tunnel did not answer ICMP.",
    };
  }

  // Partial connectivity is reported explicitly instead of being averaged away.
  if (result.lossPct != null && result.lossPct > 0) {
    result.warning = `Partial connectivity: ${result.lossPct}% packet loss to ${input.remoteTunnelIp} across ${input.interfaceName}.`;
  }
  return { success: true, output: result };
}

// ---------------------------------------------------------------------------
// OpenVPN
// ---------------------------------------------------------------------------

function hookScript(kind: "connect" | "disconnect", inboundName: string, controlPlaneUrl: string, nodeSecretFile: string): string {
  // Called by OpenVPN with env vars: common_name, trusted_ip, ifconfig_pool_local_ip, IV_HWADDR, script_type
  if (kind === "connect") {
    return `#!/bin/sh
# Arvoo admission hook - generated, do not edit
URL="${controlPlaneUrl}/api/v1/agent/authorize"
SECRET="$(cat ${nodeSecretFile})"
BODY=$(printf '{"commonName":"%s","sourceIp":"%s","vpnIp":"%s","hwid":"%s","inboundName":"%s"}' \\
  "$common_name" "$trusted_ip" "$ifconfig_pool_local_ip" "$IV_HWADDR" "${inboundName}")
RESP=$(curl -sS -m 8 -X POST "$URL" \\
  -H "Authorization: Bearer arvoo-node $(cat /etc/arvoo/node-id):$SECRET" \\
  -H "Content-Type: application/json" -d "$BODY")
ALLOW=$(printf '%s' "$RESP" | sed -n 's/.*"allow":\\([a-z]*\\).*/\\1/p')
if [ "$ALLOW" != "true" ]; then
  logger -t arvoo "connect denied for $common_name: $RESP"
  exit 1
fi
exit 0
`;
  }
  return `#!/bin/sh
# Arvoo disconnect hook - generated, do not edit
SECRET="$(cat ${nodeSecretFile})"
BODY=$(printf '{"inboundName":"%s","vpnIp":"%s","sourceIp":"%s"}' "${inboundName}" "$ifconfig_pool_local_ip" "$trusted_ip")
curl -sS -m 8 -X POST "${controlPlaneUrl}/api/v1/agent/disconnect" \\
  -H "Authorization: Bearer arvoo-node $(cat /etc/arvoo/node-id):$SECRET" \\
  -H "Content-Type: application/json" -d "$BODY" >/dev/null 2>&1 || true
exit 0
`;
}

/**
 * OpenVPN calls this with `via-file`: argv[1] is a temporary file whose first
 * line is the username and second line the password. The node forwards the
 * attempt to the control plane with its own node identity - the password is
 * never compared, cached or logged locally.
 */
function authUserPassHookShell(inboundName: string): string {
  return `#!/bin/sh
# Arvoo username/password verification hook - generated, do not edit.
# OpenVPN calls this as: auth-user-pass-verify <this> via-file
# JSON encoding of the credential is done in the Node helper, so a password
# containing quotes or percent signs cannot corrupt the request body.
NODE_BIN="$(command -v node || echo /usr/bin/node)"
exec "$NODE_BIN" /etc/arvoo/openvpn/${inboundName}/hooks/auth-user-pass.js "$1"
`;
}

/**
 * The Node helper the shell hook execs: it reads the credential file OpenVPN
 * wrote, posts it to the control plane with the node identity and exits 0
 * (allow) or 1 (deny). JSON encoding happens here so a password containing
 * quotes, backslashes or percent signs cannot corrupt the request.
 */
function authUserPassHookJs(inboundName: string, controlPlaneUrl: string, nodeSecretFile: string): string {
  return `#!/usr/bin/env node
// Arvoo username/password verification helper - generated, do not edit.
const fs = require("node:fs");
const process = require("node:process");

const credentialFile = process.argv[2];
if (!credentialFile) {
  console.error("arvoo: missing credential file argument");
  process.exit(1);
}
let username = "";
let password = "";
try {
  const lines = fs.readFileSync(credentialFile, "utf8").split(/\r?\n/);
  username = lines[0] ?? "";
  password = lines[1] ?? "";
} catch (err) {
  console.error("arvoo: cannot read credential file:", err && err.message);
  process.exit(1);
}

const secret = fs.readFileSync("${nodeSecretFile}", "utf8").trim();
const nodeId = fs.readFileSync("/etc/arvoo/node-id", "utf8").trim();
const body = JSON.stringify({
  username,
  password,
  commonName: process.env.common_name || null,
  inboundName: "${inboundName}",
});

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10000);
fetch("${controlPlaneUrl}/api/v1/agent/openvpn-auth", {
  method: "POST",
  headers: {
    Authorization: "Bearer arvoo-node " + nodeId + ":" + secret,
    "Content-Type": "application/json",
  },
  body,
  signal: controller.signal,
})
  .then(async (res) => {
    clearTimeout(timer);
    const text = await res.text();
    let allow = false;
    let reason = "unreadable response from control plane";
    try {
      const parsed = JSON.parse(text);
      allow = parsed.allow === true;
      reason = parsed.reason ?? reason;
    } catch {
      reason = "control plane returned a non-JSON response";
    }
    // Only the username and the reason are ever logged - never the password.
    if (!allow) console.error("arvoo: openvpn auth denied for " + username + ": " + reason);
    process.exit(allow ? 0 : 1);
  })
  .catch((err) => {
    clearTimeout(timer);
    // A control plane that cannot be reached is a denial, not an allow.
    console.error("arvoo: control plane unreachable for openvpn auth:", err && err.message);
    process.exit(1);
  });
`;
}

export async function applyOpenVPNInbound(
  input: OpenVPNOpInput,
  ctx: { controlPlaneUrl: string; nodeId: string; nodeSecret: string },
): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();

  // The payload is validated in runner.ts, but this function is the one that
  // builds filesystem paths, so it re-checks the name it interpolates.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(input.inboundName) || input.inboundName === "." || input.inboundName === "..") {
    return { success: false, error: `Refusing to use unsafe inbound name "${input.inboundName}".` };
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { success: false, error: `Refusing to deploy with invalid port ${String(input.port)}.` };
  }

  const dir = `/etc/arvoo/openvpn/${input.inboundName}`;
  await mkdir(`${dir}/pki`, { recursive: true });
  await mkdir(`${dir}/hooks`, { recursive: true });

  await writeFile(`${dir}/server.conf`, input.configText, { mode: 0o640 });

  // Validate the configuration BEFORE touching the running service:
  // OpenVPN exits non-zero on unknown/invalid directives when asked to just parse.
  const dryRun = await exec("openvpn", ["--config", `${dir}/server.conf`, "--test-crypto", "--verb", "0"], 2000).catch(
    () => ({ code: -1, stdout: "", stderr: "openvpn not installed" }),
  );
  // --test-crypto is only meaningful with static keys; a server config parse
  // error still surfaces through it. Missing binary is not fatal here - the
  // strict systemd start + port verification below is the real gate.
  void dryRun;

  await writeFile(`${dir}/pki/ca.crt`, input.pki.ca, { mode: 0o644 });
  await writeFile(`${dir}/pki/server.crt`, input.pki.cert, { mode: 0o644 });
  await writeFile(`${dir}/pki/server.key`, input.pki.key, { mode: 0o600 });
  // The static key is written exactly as received: OpenVPN only accepts the
  // "OpenVPN Static key V1" format, so re-encoding it here would corrupt it.
  if (input.pki.tlsKey && input.pki.tlsMode === "tls-crypt") {
    await writeFile(`${dir}/pki/tls-crypt.key`, input.pki.tlsKey, { mode: 0o600 });
  }
  if (input.pki.tlsKey && input.pki.tlsMode === "tls-auth") {
    await writeFile(`${dir}/pki/tls-auth.key`, input.pki.tlsKey, { mode: 0o600 });
  }

  // Node secret + id for hooks
  const secretFile = "/etc/arvoo/node-secret";
  await mkdir("/etc/arvoo", { recursive: true });
  await writeFile(secretFile, ctx.nodeSecret, { mode: 0o600 });
  await writeFile("/etc/arvoo/node-id", ctx.nodeId, { mode: 0o644 });
  await writeFile(`${dir}/hooks/client-connect`, hookScript("connect", input.inboundName, ctx.controlPlaneUrl, secretFile), { mode: 0o755 });
  await writeFile(`${dir}/hooks/client-disconnect`, hookScript("disconnect", input.inboundName, ctx.controlPlaneUrl, secretFile), { mode: 0o755 });

  // Username/password authentication (spec §39). The hook receives the login
  // attempt from OpenVPN (`via-file`) and asks the control plane, which is the
  // only place a password hash ever exists. Nothing is cached on the node, so
  // changing or revoking a password takes effect on the next connection.
  if (input.authMode === "password" || input.authMode === "certificate+password") {
    await writeFile(`${dir}/hooks/auth-user-pass`, authUserPassHookShell(input.inboundName), { mode: 0o755 });
    await writeFile(`${dir}/hooks/auth-user-pass.js`, authUserPassHookJs(input.inboundName, ctx.controlPlaneUrl, secretFile), {
      mode: 0o755,
    });
  } else {
    // Certificate-only inbound: remove any hook left by a previous mode so a
    // stale script can never authenticate a client.
    await exec("rm", ["-f", `${dir}/hooks/auth-user-pass`]).catch(() => undefined);
  }

  // Port availability check (protocol-aware, argv-only, no shell)
  const inUse = await portIsListening(input.port, input.protocol);
  if (inUse === true) {
    return { success: false, error: `Port ${input.port}/${input.protocol} is already occupied on this node. Choose another port or stop the conflicting service.` };
  }

  // Forwarding + NAT for the VPN subnet
  const forwardError = await ensureIpForward();
  if (forwardError) return { success: false, error: forwardError };

  if (input.egress?.masqueradeSourceNetworks?.length) {
    for (const net of input.egress.masqueradeSourceNetworks) {
      const ifname = input.egress.egressInterface ?? "eth0";
      const masq = await exec("iptables", ["-t", "nat", "-C", "POSTROUTING", "-s", net, "-o", ifname, "-j", "MASQUERADE"]);
      if (masq.code !== 0) {
        await exec("iptables", ["-t", "nat", "-A", "POSTROUTING", "-s", net, "-o", ifname, "-j", "MASQUERADE"]);
      }
    }
  }

  // Install systemd unit and start
  const unit = `[Unit]
Description=Arvoo OpenVPN inbound ${input.inboundName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/sbin/openvpn --config ${dir}/server.conf
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
  await writeFile(`/etc/systemd/system/arvoo-openvpn@.service`, unit, { mode: 0o644 }).catch(async () => {
    await writeFile(`/etc/systemd/system/arvoo-openvpn@${input.inboundName}.service`, unit, { mode: 0o644 });
  });
  await exec("systemctl", ["daemon-reload"]);
  const start = await exec("systemctl", ["restart", `arvoo-openvpn@${input.inboundName}`], 30000);
  if (start.code !== 0) {
    return { success: false, error: `systemctl restart failed: ${start.stderr.trim()}` };
  }
  const active = await exec("systemctl", ["is-active", `arvoo-openvpn@${input.inboundName}`], 8000);
  if (active.stdout.trim() !== "active") {
    const logs = await exec("journalctl", ["-u", `arvoo-openvpn@${input.inboundName}`, "-n", "20", "--no-pager"], 8000);
    return { success: false, error: `Service did not become active. Recent logs:\n${logs.stdout.trim()}` };
  }

  // Verify the listening socket. When `ss` is unavailable the systemd check
  // above (is-active) is the verification we can honestly report.
  const listening = await portIsListening(input.port, input.protocol);
  if (listening === false) {
    return { success: false, error: `Service is active but port ${input.port}/${input.protocol} is not listening.` };
  }

  return { success: true, output: { verified: true, port: input.port } };
}

export async function deleteOpenVPNInbound(input: { inboundName: string; clientNetwork?: string | null }): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const stop = await exec("systemctl", ["stop", `arvoo-openvpn@${input.inboundName}`], 20000);
  await exec("systemctl", ["disable", `arvoo-openvpn@${input.inboundName}`]).catch(() => undefined);
  await rm(`/etc/arvoo/openvpn/${input.inboundName}`, { recursive: true, force: true });
  // The MASQUERADE rule only exists for an inbound with a client network; the
  // cleanup path has no network to hand and must not build a bogus iptables rule.
  if (input.clientNetwork) {
    const ifname = await detectDefaultInterface();
    await exec("iptables", ["-t", "nat", "-D", "POSTROUTING", "-s", input.clientNetwork, "-o", ifname, "-j", "MASQUERADE"]).catch(() => undefined);
  }
  // "Unit not loaded / not found" means the instance is already gone, which is
  // the state this call wants; anything else is a real failure and is reported.
  if (stop.code !== 0 && !/not found|not loaded|No such file/i.test(stop.stderr)) {
    return { success: false, error: stop.stderr.trim() || `systemctl stop exited ${stop.code}` };
  }
  return { success: true, output: { removed: true } };
}

/**
 * Remove exactly the Arvoo-owned resources this control plane names - one GRE
 * interface and one IPsec/FOU registration per tunnel it terminates, one
 * systemd instance and config directory per inbound it hosts.
 *
 * It is deliberately not a "clean the host" operation: an empty payload removes
 * nothing, an unrelated interface or service is never touched, a resource that is
 * already gone counts as success (the call must be safe to repeat), and anything
 * that fails is reported by name so the panel can keep the cleanup state at
 * `partial` instead of claiming the host is clean.
 */
export async function cleanupNode(input: CleanupNodeOpInput): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const removed: string[] = [];
  const absent: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const interfaceName of input.interfaceNames) {
    try {
      const del = await exec("ip", ["link", "del", interfaceName]);
      if (del.code === 0) removed.push(`interface:${interfaceName}`);
      else if (/cannot find device|does not exist/i.test(del.stderr)) absent.push(`interface:${interfaceName}`);
      else failed.push({ name: `interface:${interfaceName}`, error: del.stderr.trim() || `ip link del exited ${del.code}` });
    } catch (err) {
      failed.push({ name: `interface:${interfaceName}`, error: (err as Error).message });
    }
    // The tunnel's IPsec connection and its saved definition are ours as well.
    await removeIPsec({ interfaceName }).catch(() => undefined);
    await rm(`/etc/arvoo/gre/${interfaceName}.json`, { force: true }).catch(() => undefined);
  }

  for (const inboundName of input.inboundNames) {
    try {
      const res = await deleteOpenVPNInbound({ inboundName });
      if (res.success) removed.push(`inbound:${inboundName}`);
      else failed.push({ name: `inbound:${inboundName}`, error: res.error ?? "removal failed" });
    } catch (err) {
      failed.push({ name: `inbound:${inboundName}`, error: (err as Error).message });
    }
  }

  for (const port of input.fouPorts ?? []) {
    const del = await exec("ip", ["fou", "del", "port", String(port)]).catch(() => null);
    if (del?.code === 0) removed.push(`fou-port:${port}`);
    else if (del) absent.push(`fou-port:${port}`);
  }

  if (failed.length > 0) {
    return {
      success: false,
      output: { removed, absent, failed },
      error: `Cleanup incomplete: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}`,
    };
  }
  return { success: true, output: { removed, absent, failed } };
}

/**
 * Disconnect a live OpenVPN client through the inbound's management socket.
 * Uses the unix socket written into server.conf, so no TCP port is opened.
 */
export async function killOpenVPNClient(input: { inboundName: string; commonName: string }): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const socketPath = `/etc/arvoo/openvpn/${input.inboundName}/mgmt.sock`;
  const response = await sendManagementCommand(socketPath, `kill ${input.commonName}`).catch((err: Error) => ({ error: err.message }));
  if ("error" in response) return { success: false, error: `management socket: ${response.error}` };
  const killed = /SUCCESS: common name/.test(response.text);
  return { success: true, output: { killed, commonName: input.commonName, reply: response.text.trim() } };
}

function sendManagementCommand(socketPath: string, command: string): Promise<{ text: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, 5000);
    socket.on("connect", () => {
      socket.write(`${command}\nquit\n`);
    });
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      resolve({ text });
    });
  });
}

export async function restartOpenVPN(input: { inboundName: string }): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const r = await exec("systemctl", ["restart", `arvoo-openvpn@${input.inboundName}`], 30000);
  if (r.code !== 0) return { success: false, error: r.stderr.trim() };
  return { success: true, output: { restarted: true } };
}

export async function stopOpenVPN(input: { inboundName: string }): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const r = await exec("systemctl", ["stop", `arvoo-openvpn@${input.inboundName}`], 20000);
  if (r.code !== 0) return { success: false, error: r.stderr.trim() };
  return { success: true, output: { stopped: true } };
}

// ---------------------------------------------------------------------------
// Egress policy (NAT on the egress node of a tunnel-backed inbound)
// ---------------------------------------------------------------------------

export async function applyFirewallPolicy(input: {
  masqueradeSourceNetworks: string[];
  forwardFromSubnet: string;
  routeViaTunnelIp: string;
  inboundName: string;
}): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();

  const forwardError = await ensureIpForward();
  if (forwardError) return { success: false, error: forwardError };

  // Route back to the VPN subnet via the tunnel peer
  const route = await exec("ip", ["route", "replace", input.forwardFromSubnet, "via", input.routeViaTunnelIp]);
  if (route.code !== 0) return { success: false, error: `route replace failed: ${route.stderr.trim()}` };

  // Loose rp_filter for asymmetric tunnel routing
  await exec("sysctl", ["-w", "net.ipv4.conf.all.rp_filter=2"]);

  const ifname = await detectDefaultInterface();
  for (const net of input.masqueradeSourceNetworks) {
    const check = await exec("iptables", ["-t", "nat", "-C", "POSTROUTING", "-s", net, "-o", ifname, "-j", "MASQUERADE"]);
    if (check.code !== 0) {
      const add = await exec("iptables", ["-t", "nat", "-A", "POSTROUTING", "-s", net, "-o", ifname, "-j", "MASQUERADE"]);
      if (add.code !== 0) return { success: false, error: `MASQUERADE failed: ${add.stderr.trim()}` };
    }
  }
  return { success: true, output: { applied: true, egressInterface: ifname } };
}

async function detectDefaultInterface(): Promise<string> {
  const r = await exec("ip", ["route", "show", "default"]);
  const m = r.stdout.match(/dev (\S+)/);
  return m?.[1] ?? "eth0";
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export async function installOpenVPN(): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  const probe = await exec("openvpn", ["--version"], 4000);
  if (probe.code === 0) {
    const version = probe.stdout.match(/OpenVPN (\d+\.\d+\.\S+)/)?.[1] ?? "present";
    return { success: true, output: { version, alreadyInstalled: true } };
  }
  for (const cmd of [["apt-get", ["install", "-y", "openvpn"]], ["dnf", ["install", "-y", "openvpn"]], ["yum", ["install", "-y", "openvpn"]]] as const) {
    const r = await exec(cmd[0], cmd[1] as unknown as string[], 300000);
    if (r.code === 0) {
      const v = await exec("openvpn", ["--version"], 4000);
      return { success: true, output: { version: v.stdout.match(/OpenVPN (\d+\.\d+\.\S+)/)?.[1] ?? "installed" } };
    }
  }
  return {
    success: false,
    error:
      "Could not install OpenVPN with apt/dnf/yum. The node agent runs in a sandboxed unit " +
      "(read-only /usr, /etc, /var) and is deliberately not allowed to run a package manager. " +
      "Install it on the node itself - sudo apt-get install -y openvpn (or run sudo ./install.sh) - then retry.",
  };
}

// ---------------------------------------------------------------------------
// Managed firewall (ufw) - the apply/verify core lives in ./ufw.ts
// ---------------------------------------------------------------------------

export async function configureFirewall(input: FirewallOpInput): Promise<OpResult> {
  if (process.platform !== "linux") return requiresLinux();
  if (!(await ufwAvailable())) {
    return {
      success: false,
      error: "ufw is not installed on this node. Install it as root (apt-get install -y ufw) and run the action again.",
    };
  }
  // The apply-and-verify core is shared with the master privileged helper
  // (apps/agent/src/ufw.ts), so a node and the panel host cannot drift apart.
  const result = await applyFirewallPlan(input.plan, input.action);
  const output = {
    added: result.added,
    removed: result.removed,
    failures: result.failures,
    missing: result.missing,
    enabled: result.enabled,
    verified: result.verified,
    status: result.status,
    rules: input.action === "disable" ? [] : (input.plan.rules as FirewallRule[]),
  };
  if (!result.ok) return { success: false, error: result.error ?? "ufw did not confirm the change", output };
  return { success: true, output };
}

export async function collectDiagnostics(): Promise<OpResult> {
  const output: Record<string, string> = {};
  if (process.platform === "linux") {
    for (const [key, cmd] of [
      ["ip-addr", ["ip", "-br", "addr"]],
      ["ip-route", ["ip", "route"]],
      ["listening", ["ss", "-tulnp"]],
    ] as const) {
      const r = await exec(cmd[0], cmd[1] as unknown as string[], 8000).catch(() => null);
      output[key] = r?.stdout ?? "unavailable";
    }
  }
  return { success: true, output };
}
