/**
 * Real telemetry collection. Cross-platform via Node's own APIs; Linux-only
 * details (systemctl, ip, openvpn) are probed defensively and degrade to
 * "unknown" - never fabricated.
 */

import os from "node:os";
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { NodeCapabilities, NodeTelemetry } from "@arvoo/shared";
import { readOpenvpnProcesses, readGreInterfaces, readOpenvpnStatus, type OpenvpnStatusEntry } from "./linux.js";
import { probeCapabilities } from "./ops.js";

export interface TelemetryExtras {
  openvpnStatus: OpenvpnStatusEntry[];
}

let lastCpuSnapshot: { idle: number; total: number; at: number } | null = null;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function cpuUsagePct(): number | null {
  const snap = cpuTimes();
  if (lastCpuSnapshot) {
    const dTotal = snap.total - lastCpuSnapshot.total;
    const dIdle = snap.idle - lastCpuSnapshot.idle;
    lastCpuSnapshot = { ...snap, at: Date.now() };
    if (dTotal <= 0) return null;
    return Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
  }
  lastCpuSnapshot = { ...snap, at: Date.now() };
  return null; // first sample: no delta yet, honest "unknown"
}

function execProbe(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

/**
 * Probe that reads the command's output even when it exits non-zero - `systemctl
 * is-active` prints "inactive"/"failed" and returns 1, and that answer is the
 * useful one. Returns null when nothing was printed (tool missing, timeout).
 */
function execProbeAny(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (_err, stdout) => {
      const text = stdout?.toString().trim();
      resolve(text ? text : null);
    });
  });
}

export async function collectTelemetry(): Promise<{ telemetry: NodeTelemetry; extras: TelemetryExtras }> {
  const memTotal = os.totalmem();
  const memFree = os.freemem();

  let diskTotal: number | null = null;
  let diskUsed: number | null = null;
  try {
    const s = await statfs(process.platform === "win32" ? process.env.SystemDrive ?? "C:\\" : "/");
    diskTotal = s.blocks * s.bsize;
    diskUsed = (s.blocks - s.bfree) * s.bsize;
  } catch {
    // leave unknown
  }

  const interfaces: Array<{ name: string; addresses: string[] }> = [];
  const counters: Record<string, { rx: number; tx: number }> = {};
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    const addresses = (infos ?? []).map((i) => `${i.address}/${i.cidr?.split("/")[1] ?? ""}`).filter(Boolean);
    interfaces.push({ name, addresses });
  }

  // OpenVPN version probe
  let openvpnVersion: string | null = null;
  const ov = await execProbe("openvpn", ["--version"], 3000);
  if (ov) {
    const m = ov.match(/OpenVPN (\d+\.\d+\.\S+)/);
    if (m) openvpnVersion = m[1]!;
  }

  const isLinux = process.platform === "linux";
  const openvpnProcesses = isLinux ? await readOpenvpnProcesses() : [];
  const greInterfaces = isLinux ? await readGreInterfaces() : [];
  const openvpnStatus = isLinux ? await readOpenvpnStatus() : [];

  const services: Array<{ name: string; status: "running" | "stopped" | "unknown" }> = [];
  if (isLinux) {
    // Read the state of the unit this agent really runs as. It used to push a
    // hardcoded "running", which made the panel show a healthy agent even when
    // the service was failing, and it probed a unit name (node-agent) that does
    // not exist on an Arvoo installation.
    const active = await execProbeAny("systemctl", ["is-active", "arvoo-agent"], 3000);
    services.push({
      name: "arvoo-agent",
      status: active === null ? "unknown" : active === "active" ? "running" : "stopped",
    });
  } else {
    // Not Linux: this very process is the agent loop, so it is running.
    services.push({ name: "arvoo-agent", status: "running" });
  }

  const telemetry: NodeTelemetry = {
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCores: os.cpus().length,
    cpuUsagePct: cpuUsagePct(),
    memoryTotalBytes: memTotal,
    memoryUsedBytes: memTotal - memFree,
    memoryUsagePct: memTotal > 0 ? ((memTotal - memFree) / memTotal) * 100 : null,
    diskTotalBytes: diskTotal,
    diskUsedBytes: diskUsed,
    diskUsagePct: diskTotal && diskUsed != null && diskTotal > 0 ? (diskUsed / diskTotal) * 100 : null,
    loadAvg: os.loadavg() as [number, number, number],
    uptimeSec: Math.round(os.uptime()),
    os: `${os.type()} ${os.release()} (${process.platform})`,
    kernel: os.version() || null,
    openvpnVersion,
    interfaces,
    trafficCounters: counters,
    services,
    greInterfaces,
    openvpnProcesses,
    capabilities: await cachedCapabilities(openvpnVersion),
  };

  return { telemetry, extras: { openvpnStatus } };
}

/** Capability probes load modules and start daemons, so they are refreshed slowly. */
const CAPABILITY_TTL_MS = 10 * 60 * 1000;
let capabilityCache: { at: number; openvpnVersion: string | null; value: NodeCapabilities } | null = null;

async function cachedCapabilities(openvpnVersion: string | null): Promise<NodeCapabilities> {
  if (capabilityCache && Date.now() - capabilityCache.at < CAPABILITY_TTL_MS && capabilityCache.openvpnVersion === openvpnVersion) {
    return capabilityCache.value;
  }
  const value = await probeCapabilities(openvpnVersion);
  capabilityCache = { at: Date.now(), openvpnVersion, value };
  return value;
}
