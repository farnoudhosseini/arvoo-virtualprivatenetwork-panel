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
  let mode: "none" | "v3" | "v1" = "none";
  const now = Date.now();
  for (const line of lines) {
    // status-version 3
    if (line.startsWith("HEADER,CLIENT_LIST") || line.startsWith("CLIENT_LIST,")) {
      mode = "v3";
    }
    if (line.startsWith("CLIENT_LIST,")) {
      const parts = line.split(",");
      // CLIENT_LIST,Common Name,Real Address,Virtual Address,Virtual IPv6,Bytes Received,Bytes Sent,Connected Since,...
      // Some builds omit Virtual IPv6: CLIENT_LIST,cn,real,virt,bytesR,bytesS,since
      const commonName = parts[1] ?? "";
      if (!commonName || commonName === "UNDEF") continue;
      const realIp = (parts[2] ?? "").split(":")[0] ?? "";
      let virtualIp: string | null = null;
      let rx = 0;
      let tx = 0;
      let sinceStr = "";
      // Heuristic: if parts[4] is numeric bytes, no IPv6 column
      if (parts.length >= 8 && !/^\d+$/.test(parts[4] ?? "")) {
        virtualIp = parts[3] && parts[3] !== "" ? parts[3] : null;
        rx = Number(parts[5] ?? 0);
        tx = Number(parts[6] ?? 0);
        sinceStr = parts[7] ?? "";
      } else {
        virtualIp = parts[3] && parts[3] !== "" ? parts[3] : null;
        rx = Number(parts[4] ?? 0);
        tx = Number(parts[5] ?? 0);
        sinceStr = parts[7] ?? parts[6] ?? "";
      }
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
    // status-version 1 (default without status-version directive)
    if (line.startsWith("OpenVPN CLIENT LIST") || line.startsWith("Updated,")) {
      mode = "v1";
      continue;
    }
    if (mode === "v1" && line.startsWith("Common Name,")) continue;
    if (mode === "v1" && line && !line.startsWith("ROUTING") && !line.startsWith("GLOBAL") && !line.startsWith("Max") && line.includes(",")) {
      const parts = line.split(",");
      // Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since
      if (parts.length >= 5 && parts[0] && !parts[0].startsWith("HEADER")) {
        const commonName = parts[0].trim();
        if (commonName === "Common Name") continue;
        const realIp = (parts[1] ?? "").split(":")[0] ?? "";
        const rx = Number(parts[2] ?? 0);
        const tx = Number(parts[3] ?? 0);
        const since = Date.parse(parts[4] ?? "");
        out.push({
          commonName,
          realIp,
          vpnIp: null,
          rxBytes: Number.isFinite(rx) ? rx : 0,
          txBytes: Number.isFinite(tx) ? tx : 0,
          connectedSinceSec: Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : 0,
        });
      }
    }
    if (line.startsWith("ROUTING TABLE") || line.startsWith("GLOBAL STATS")) {
      mode = "none";
    }
  }
  return out;
}

export async function readOpenvpnStatus(): Promise<OpenvpnStatusEntry[]> {
  const entries: OpenvpnStatusEntry[] = [];
  try {
    const bases = ["/var/log/arvoo/openvpn", "/etc/arvoo/openvpn"];
    const seen = new Set<string>();
    for (const base of bases) {
      const names = await readdir(base).catch(() => [] as string[]);
      for (const name of names) {
        if (seen.has(name)) continue;
        // Prefer the log path written by current configs; fall back to legacy.
        let text =
          (await readFile(`/var/log/arvoo/openvpn/${name}/status.log`, "utf8").catch(() => null)) ??
          (await readFile(`/etc/arvoo/openvpn/${name}/status.log`, "utf8").catch(() => null));
        if (!text) continue;
        seen.add(name);
        const connected = parseOpenvpnStatus3(text);
        entries.push({ inboundName: name, connected });
      }
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
