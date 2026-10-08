/**
 * ufw application core.
 *
 * Used by two callers that must behave identically:
 *   * the node agent, through the `ConfigureFirewall` operation;
 *   * the privileged helper on the master host (`arvoo-ufw-apply`), which the
 *     unprivileged control plane triggers through a spool directory.
 *
 * Everything here shells out through `execFile` with argv arrays - never a
 * shell string - so a rule can never turn into an arbitrary command.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { FirewallPlan, FirewallRule } from "@arvoo/shared";
import { ruleToUfwArgs, ufwDeleteArgs } from "@arvoo/shared";
import { exec } from "./linux.js";

/** Where the rules Arvoo applied are remembered, so an update can withdraw them. */
export const FIREWALL_STATE_FILE = "/etc/arvoo/firewall/applied.json";

export interface UfwApplyResult {
  ok: boolean;
  error: string | null;
  added: string[];
  removed: string[];
  failures: string[];
  missing: string[];
  enabled: boolean;
  verified: boolean;
  status: string;
  rules: FirewallRule[];
}

export async function ufwAvailable(): Promise<boolean> {
  return exec("ufw", ["version"], 8000)
    .then((r) => r.code === 0)
    .catch(() => false);
}

/**
 * Does `ufw status` really contain this rule?
 *
 * Verification is what separates "queued" from "applied", so the status text is
 * parsed instead of trusted: a rule that ufw silently rejected must not be
 * reported as active.
 */
export function ufwStatusContains(statusText: string, rule: FirewallRule): boolean {
  const lines = statusText.split(/\r?\n/).map((l) => l.trimEnd());
  for (const line of lines) {
    const body = line.split("#")[0]!.trim();
    if (body.length === 0) continue;
    if (/^To\s+Action/i.test(body) || /^-+\s+-+/.test(body)) continue;
    if (rule.from && !body.includes(rule.from)) continue;
    if (rule.proto === "icmp") {
      if (/\bicmp\b/i.test(body)) return true;
      continue;
    }
    if (rule.proto === "gre" || rule.proto === "esp") {
      if (new RegExp(`(^|\\s)(47/${rule.proto}|${rule.proto})(\\s|$)`, "i").test(body)) return true;
      continue;
    }
    if (rule.port == null) continue;
    if (!new RegExp(`(^|\\s)${rule.port}/${rule.proto}(\\s|$)`).test(body)) continue;
    if (!/(ALLOW|LIMIT)/i.test(body)) continue;
    return true;
  }
  return false;
}

export async function readAppliedRules(stateFile = FIREWALL_STATE_FILE): Promise<FirewallRule[]> {
  const parsed = await readFile(stateFile, "utf8")
    .then((text) => JSON.parse(text) as { rules?: FirewallRule[] })
    .catch(() => null);
  return parsed && Array.isArray(parsed.rules) ? parsed.rules : [];
}

/**
 * Apply a plan with ufw and verify the result against `ufw status`.
 *
 * `action = "disable"` turns ufw off and forgets the applied rules; any other
 * action withdraws rules that are no longer part of the plan (that is what
 * "Update UFW" does after inbounds changed), adds the current ones, sets the
 * default policy and enables ufw.
 */
export async function applyFirewallPlan(
  plan: Pick<FirewallPlan, "rules" | "hash" | "defaultDenyIncoming"> & { defaultDenyIncoming?: boolean },
  action: "enable" | "update" | "disable",
  stateFile = FIREWALL_STATE_FILE,
): Promise<UfwApplyResult> {
  if (!(await ufwAvailable())) {
    return {
      ok: false,
      error: "ufw is not installed on this host. Install it first (sudo apt-get install -y ufw) and retry.",
      added: [],
      removed: [],
      failures: [],
      missing: [],
      enabled: false,
      verified: false,
      status: "",
      rules: [],
    };
  }

  await mkdir("/etc/arvoo/firewall", { recursive: true });
  const previousRules = await readAppliedRules(stateFile);
  const nextRules = action === "disable" ? [] : (plan.rules as FirewallRule[]);
  const nextIds = new Set(nextRules.map((r) => r.id));

  const removed: string[] = [];
  const added: string[] = [];
  const failures: string[] = [];

  for (const rule of previousRules) {
    if (nextIds.has(rule.id)) continue;
    const result = await exec("ufw", ufwDeleteArgs(rule), 15000).catch((err: Error) => ({
      code: -1,
      stdout: "",
      stderr: err.message,
    }));
    if (result.code === 0) removed.push(rule.id);
    else failures.push(`${rule.id}: ${result.stderr.trim() || "delete failed"}`);
  }

  for (const rule of nextRules) {
    const result = await exec("ufw", ruleToUfwArgs(rule), 15000).catch((err: Error) => ({
      code: -1,
      stdout: "",
      stderr: err.message,
    }));
    if (result.code === 0) added.push(rule.id);
    else failures.push(`${rule.id}: ${result.stderr.trim() || "rule add failed"}`);
  }

  if (plan.defaultDenyIncoming && action !== "disable") {
    for (const args of [
      ["default", "deny", "incoming"],
      ["default", "allow", "outgoing"],
    ]) {
      const d = await exec("ufw", args).catch(() => null);
      if (d && d.code !== 0) failures.push(`default policy: ${d.stderr.trim()}`);
    }
  }

  if (action === "disable") {
    await exec("ufw", ["--force", "disable"], 20000).catch(() => undefined);
  } else {
    const enable = await exec("ufw", ["--force", "enable"], 30000).catch((err: Error) => ({
      code: -1,
      stdout: "",
      stderr: err.message,
    }));
    if (enable.code !== 0) {
      return {
        ok: false,
        error: `ufw --force enable failed: ${enable.stderr.trim() || enable.stdout.trim()}`,
        added,
        removed,
        failures,
        missing: nextRules.map((r) => r.id),
        enabled: false,
        verified: false,
        status: "",
        rules: [],
      };
    }
  }

  const status = await exec("ufw", ["status", "verbose"], 15000).catch(() => ({
    code: -1,
    stdout: "",
    stderr: "",
  }));
  const enabled = /^Status: active/m.test(status.stdout);
  const missing = action === "disable" ? [] : nextRules.filter((rule) => !ufwStatusContains(status.stdout, rule));
  const verified = action === "disable" ? !enabled : missing.length === 0 && enabled;

  await writeFile(
    stateFile,
    JSON.stringify(
      {
        appliedAt: new Date().toISOString(),
        hash: plan.hash,
        action,
        enabled,
        rules: nextRules,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  ).catch(() => undefined);

  return {
    ok: verified,
    error: verified
      ? null
      : action === "disable"
        ? "ufw still reports itself as active after the disable request."
        : `ufw did not report these rules after applying them: ${missing.map((r) => r.id).join(", ")}`,
    added,
    removed,
    failures,
    missing: missing.map((r) => r.id),
    enabled,
    verified,
    status: status.stdout.slice(0, 6000),
    rules: nextRules,
  };
}
