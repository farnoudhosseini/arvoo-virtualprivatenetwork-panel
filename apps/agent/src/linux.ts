/**
 * Linux-only inspectors and typed command execution. Every command runs
 * through execFile with an argv array - the agent never builds shell strings
 * from user-controlled input.
 */

import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

export interface OpenvpnStatusEntry {
  inboundName: string;
  connected: Array<{
    commonName: string;
    realIp: string;
    vpnIp: string | null;
    rxBytes: number;
    txBytes: number;
    connectedSinceSec: number;
  }>;
}

export function exec(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number }) | null;
      if (e && typeof e.code !== "number") {
        reject(new Error(`${cmd} failed to start: ${e.message}`));
        return;
      }
      resolve({ code: e?.code ?? 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** Parse `status-version 3` OpenVPN status log (comma-separated). */
export function parseOpenvpnStatus3(text: string): Array<{
  commonName: string;
  realIp: string;
  vpnIp: string | null;
  rxBytes: number;
  txBytes: number;
  connectedSinceSec: number;
}> {
  const out: Array<{
    commonName: string;
    realIp: string;
    vpnIp: string | null;
    rxBytes: number;
    txBytes: number;
    connectedSinceSec: number;
  }> = [];
  const lines = text.split(/\r?\n/);
  let inTable = false;
  const now = Date.now();
  for (const line of lines) {
    if (line.startsWith("OpenVPN CLIENT LIST")) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith("HEADER,CLIENT_LIST")) {
      continue;
    }
    if (inTable && line.startsWith("CLIENT_LIST")) {
      const parts = line.split(",");
      // CLIENT_LIST,commonName,realIp,virtualIp,bytesRecv,bytesSent,sinceStr,...
      const commonName = parts[1] ?? "";
      const realIp = parts[2] ?? "";
      const virtualIp = parts[3] && parts[3] !== "" ? parts[3] : null;
      const rx = Number(parts[4] ?? 0);
      const tx = Number(parts[5] ?? 0);
      const sinceStr = parts[7] ?? parts[6] ?? "";
      const since = Date.parse(sinceStr);
      out.push({
        commonName,
        realIp,
        vpnIp: virtualIp,
        rxBytes: Number.isFinite(rx) ? rx : 0,
        txBytes: Number.isFinite(tx) ? tx : 0,
        connectedSinceSec: Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : 0,
      });
      continue;
    }
    if (inTable && (line.startsWith("GLOBAL STATS") || line.startsWith("ROUTING TABLE"))) {
      inTable = false;
    }
  }
  return out;
}

export async function readOpenvpnStatus(): Promise<OpenvpnStatusEntry[]> {
  const entries: OpenvpnStatusEntry[] = [];
  try {
    const base = "/etc/arvoo/openvpn";
    const names = (await readdir(base).catch(() => [] as string[])).filter(async () => true);
    for (const name of names) {
      const text = await readFile(`${base}/${name}/status.log`, "utf8").catch(() => null);
      if (!text) continue;
      const connected = parseOpenvpnStatus3(text);
      entries.push({ inboundName: name, connected });
    }
  } catch {
    // no telemetry available
  }
  return entries;
}

export async function readOpenvpnProcesses(): Promise<Array<{ name: string; status: "running" | "stopped" }>> {
  const result: Array<{ name: string; status: "running" | "stopped" }> = [];
  try {
    const base = "/etc/arvoo/openvpn";
    const names = await readdir(base).catch(() => [] as string[]);
    for (const name of names) {
      const active = await exec("systemctl", ["is-active", `arvoo-openvpn@${name}`], 3000);
      result.push({ name, status: active.code === 0 && active.stdout.trim() === "active" ? "running" : "stopped" });
    }
  } catch {
    // ignore
  }
  return result;
}

export async function readGreInterfaces(): Promise<Array<{ name: string; local: string | null; remote: string | null }>> {
  const out = await exec("ip", ["-d", "link", "show", "type", "gretap"], 4000).catch(() => null);
  const out2 = out ?? (await exec("ip", ["-d", "link", "show", "type", "gre"], 4000).catch(() => null));
  if (!out2 || out2.code !== 0) return [];
  const result: Array<{ name: string; local: string | null; remote: string | null }> = [];
  const blocks = out2.stdout.split(/^\d+:/m).filter(Boolean);
  for (const block of blocks) {
    const nameMatch = block.match(/^\s*([a-z0-9-]+)@/i) ?? block.match(/^\s*([a-z0-9-]+):/i);
    const local = block.match(/local (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
    const remote = block.match(/remote (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
    if (nameMatch) result.push({ name: nameMatch[1]!, local, remote });
  }
  return result;
}
