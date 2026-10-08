#!/usr/bin/env node
/**
 * arvoo-firewall - privileged ufw helper.
 *
 * The control plane runs as an unprivileged user and must never be able to run
 * arbitrary privileged commands. Instead it writes a firewall *request* (plan +
 * rendered ufw argv) into a spool directory; a systemd path unit on this host
 * runs this helper as root, which applies the plan and writes the real result
 * back. The panel reads that result, so what it shows is measured, not assumed.
 *
 * Manual use (also what the CLI does for the current host):
 *   arvoo-firewall --plan /path/plan.json --action enable
 *   arvoo-firewall --spool /var/lib/arvoo/firewall-spool
 *
 * This file is intentionally dependency-free (only Node builtins): it runs
 * before/independently of the agent service.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FirewallRule } from "@arvoo/shared";
import { applyFirewallPlan } from "./ufw.js";

interface SpoolRequest {
  id: string;
  host: string;
  hostName?: string;
  action: "enable" | "update" | "disable";
  requestedBy?: string | null;
  requestedAt?: string;
  plan: {
    nodeName: string;
    role: string;
    generatedAt: string;
    hash: string;
    defaultDenyIncoming: true;
    rules: FirewallRule[];
  } | null;
  commands?: string[][];
  previousRuleIds?: string[];
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function defaultSpoolDir(): string {
  return process.env.ARVOO_FIREWALL_SPOOL ?? "/var/lib/arvoo/firewall-spool";
}

async function runOnce(planFile: string, action: "enable" | "update" | "disable", stateFile?: string): Promise<void> {
  if (!existsSync(planFile)) fail(`plan file not found: ${planFile}`);
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as SpoolRequest["plan"];
  if (!plan) fail("plan file does not contain a plan");
  const applied = await applyFirewallPlan(plan, action, stateFile);
  // The result is the whole contract with the caller: never exit 0 without it.
  process.stdout.write(`${JSON.stringify({ ...applied, hash: plan.hash }, null, 2)}\n`);
  process.exit(applied.ok ? 0 : 1);
}

async function runSpool(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const requests = readdirSync(dir).filter((f) => f.endsWith(".request.json"));
  // Oldest first so a queue drains in order even if several requests arrived
  // while the unit was busy.
  requests.sort();
  for (const file of requests) {
    const full = path.join(dir, file);
    let request: SpoolRequest | null = null;
    try {
      request = JSON.parse(readFileSync(full, "utf8")) as SpoolRequest;
    } catch (err) {
      // An unreadable request is discarded with a recorded result instead of
      // blocking the queue forever.
      const stamp = new Date().toISOString();
      const resultFile = full.replace(/\.request\.json$/, ".result.json");
      writeFileSync(
        resultFile,
        JSON.stringify({ id: file.replace(/\.request\.json$/, ""), ok: false, error: `unreadable request: ${(err as Error).message}`, at: stamp }, null, 2),
        { mode: 0o640 },
      );
      unlinkSync(full);
      continue;
    }
    if (!request) continue;

    const applied = await applyFirewallPlan(
      request.plan ?? { rules: [] as FirewallRule[], hash: "disabled", defaultDenyIncoming: true },
      request.action,
    );
    const resultFile = full.replace(/\.request\.json$/, ".result.json");
    writeFileSync(
      resultFile,
      JSON.stringify(
        {
          id: request.id,
          host: request.host,
          hostName: request.hostName ?? null,
          action: request.action,
          at: new Date().toISOString(),
          ok: applied.ok,
          error: applied.error,
          output: `added ${applied.added.length}, removed ${applied.removed.length}; ${applied.status.split("\n")[0] ?? ""}`,
          appliedRules: applied.rules,
          verified: applied.verified,
          enabled: applied.enabled,
          missing: applied.missing,
          failures: applied.failures,
        },
        null,
        2,
      ),
      { mode: 0o640 },
    );
    unlinkSync(full);
  }
}

async function main(): Promise<void> {
  const spoolDir = arg("--spool") ?? (process.argv.includes("--spool") ? defaultSpoolDir() : null);
  if (spoolDir !== null) {
    mkdirSync(spoolDir, { recursive: true, mode: 0o750 });
    await runSpool(spoolDir);
    return;
  }

  const planFile = arg("--plan");
  const action = (arg("--action") ?? "enable") as "enable" | "update" | "disable";
  if (!planFile) {
    process.stdout.write(
      "usage: arvoo-firewall --plan <plan.json> [--action enable|update|disable] [--state-file <path>]\n" +
        "       arvoo-firewall --spool [dir]\n",
    );
    process.exit(2);
  }
  const stateFile = arg("--state-file");
  await runOnce(planFile, action, stateFile ?? undefined);
}

void main().catch((err: Error) => fail(err.message));
