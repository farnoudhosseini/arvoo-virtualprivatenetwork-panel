/**
 * Agent state: persisted locally after enrollment (0600). Contains the node
 * identity issued by the control plane - never committed to git.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AgentState {
  controlPlaneUrl: string;
  nodeId: string;
  nodeSecret: string;
  heartbeatIntervalSec: number;
}

/**
 * Where the installer keeps (and the systemd unit reads) the node identity.
 * /etc/arvoo/agent.env sets ARVOO_AGENT_STATE_DIR to this path for the service,
 * but a shell that runs `node .../index.js status` has no such environment.
 */
export const STANDARD_STATE_DIR = "/var/lib/arvoo";

/**
 * Resolve the state directory:
 *   1. ARVOO_AGENT_STATE_DIR when set (that is what the systemd unit uses);
 *   2. the installation's own path, /var/lib/arvoo, when it exists;
 *   3. ~/.arvoo, the development default.
 *
 * Step 2 is what makes `node apps/agent/dist/index.js status` truthful from a
 * plain shell on an enrolled node. It used to look only in the home directory,
 * find nothing and report "Not enrolled." for a node whose identity was present
 * and being used by the running service.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  isDirectory: (candidate: string) => boolean = (candidate) => {
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  },
): string {
  const explicit = env.ARVOO_AGENT_STATE_DIR?.trim();
  if (explicit) return explicit;
  if (platform === "linux" && isDirectory(STANDARD_STATE_DIR)) return STANDARD_STATE_DIR;
  return path.join(os.homedir(), ".arvoo");
}

const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, "agent-state.json");

export type StateLoadReason = "ok" | "missing" | "unreadable" | "invalid";

export interface StateLoad {
  state: AgentState | null;
  path: string;
  reason: StateLoadReason;
  error?: string;
}

/**
 * Load the identity together with the reason it could not be used, so callers
 * can tell "no identity yet" apart from "identity present but not readable"
 * (the file is mode 0600 and root-owned, which is exactly what a non-root shell
 * hits). Both used to be reported as "Not enrolled.", which sent operators
 * looking for a missing enrollment that was never missing.
 */
export function loadStateDetailed(file: string = STATE_FILE): StateLoad {
  if (!existsSync(file)) return { state: null, path: file, reason: "missing" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { state: null, path: file, reason: "unreadable", error: (err as Error).message };
  }
  try {
    return { state: JSON.parse(text) as AgentState, path: file, reason: "ok" };
  } catch (err) {
    return { state: null, path: file, reason: "invalid", error: (err as Error).message };
  }
}

export function loadState(): AgentState | null {
  return loadStateDetailed().state;
}

export function saveState(state: AgentState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  // writeFileSync only applies the mode when it creates the file; enforce it so
  // an identity file that lost its permissions is tightened on the next write.
  chmodSync(STATE_FILE, 0o600);
}

export function stateFile(): string {
  return STATE_FILE;
}

export function stateDirectory(): string {
  return STATE_DIR;
}

export function controlPlaneUrlFromEnv(): string {
  return process.env.ARVOO_CONTROL_PLANE_URL ?? "http://127.0.0.1:4001";
}
