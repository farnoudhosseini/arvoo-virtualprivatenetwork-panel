/**
 * Agent state: persisted locally after enrollment (0600). Contains the node
 * identity issued by the control plane - never committed to git.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AgentState {
  controlPlaneUrl: string;
  nodeId: string;
  nodeSecret: string;
  heartbeatIntervalSec: number;
}

const STATE_DIR = process.env.ARVOO_AGENT_STATE_DIR ?? path.join(os.homedir(), ".arvoo");
const STATE_FILE = path.join(STATE_DIR, "agent-state.json");

export function loadState(): AgentState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as AgentState;
  } catch {
    return null;
  }
}

export function saveState(state: AgentState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function stateFile(): string {
  return STATE_FILE;
}

export function controlPlaneUrlFromEnv(): string {
  return process.env.ARVOO_CONTROL_PLANE_URL ?? "http://127.0.0.1:4001";
}
