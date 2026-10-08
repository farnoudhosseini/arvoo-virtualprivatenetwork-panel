/**
 * Arvoo Node Agent main loop:
 *   heartbeat every N seconds (real telemetry)
 *   poll for operations and execute them
 */

import os from "node:os";
import { loadState, saveState, controlPlaneUrlFromEnv, type AgentState } from "./config.js";
import { collectTelemetry } from "./telemetry.js";
import { AgentApi, AGENT_VERSION } from "./api.js";
import { executeOperation } from "./runner.js";

let state: AgentState | null = loadState();
let heartbeatIntervalSec = 15;
let running = true;

function log(msg: string): void {
  console.log(`[arvoo-agent ${new Date().toISOString()}] ${msg}`);
}

async function enroll(token: string): Promise<void> {
  const url = controlPlaneUrlFromEnv();
  const api = new AgentApi(url, () => null);
  log(`enrolling with control plane ${url} ...`);
  const res = await api.hello(token, os.hostname(), `${process.platform}/${os.arch()}`, AGENT_VERSION);
  state = {
    controlPlaneUrl: url,
    nodeId: res.nodeId,
    nodeSecret: res.nodeSecret,
    heartbeatIntervalSec: res.heartbeatIntervalSec,
  };
  heartbeatIntervalSec = res.heartbeatIntervalSec;
  saveState(state);
  log(`enrolled as node ${res.nodeId}. Waiting for admin approval, then heartbeats start automatically.`);
}

async function heartbeatAndWork(api: AgentApi, ctx: { controlPlaneUrl: string; nodeId: string; nodeSecret: string }): Promise<void> {
  const { telemetry, extras } = await collectTelemetry();
  try {
    await api.heartbeat({ telemetry, openvpnStatus: extras.openvpnStatus });
  } catch (err) {
    log(`heartbeat failed: ${(err as Error).message}`);
    return;
  }

  // Opportunistically pull an operation after each heartbeat
  try {
    const { operation } = await api.nextOperation();
    if (operation) {
      log(`executing operation ${operation.type} (${operation.id})`);
      await executeOperation(operation as never, ctx, api);
      log(`operation ${operation.id} reported`);
    }
  } catch (err) {
    log(`operation poll failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "enroll") {
    const token = process.argv[3] ?? process.env.ARVOO_ENROLLMENT_TOKEN;
    if (!token) {
      console.error("Usage: arvoo-agent enroll <enrollment-token>");
      console.error("       (or set ARVOO_ENROLLMENT_TOKEN; ARVOO_CONTROL_PLANE_URL for the control plane URL)");
      process.exit(1);
    }
    await enroll(token);
    process.exit(0);
  }

  if (arg === "status") {
    const s = loadState();
    if (!s) {
      console.log("Not enrolled.");
    } else {
      console.log(`Node: ${s.nodeId}`);
      console.log(`Control plane: ${s.controlPlaneUrl}`);
    }
    process.exit(0);
  }

  if (!state) {
    console.error("Agent is not enrolled. Run: arvoo-agent enroll <token>");
    process.exit(1);
  }

  heartbeatIntervalSec = state.heartbeatIntervalSec ?? 15;
  const api = new AgentApi(state.controlPlaneUrl, () => (state ? { nodeId: state.nodeId, nodeSecret: state.nodeSecret } : null));
  const ctx = { controlPlaneUrl: state.controlPlaneUrl, nodeId: state.nodeId, nodeSecret: state.nodeSecret };

  log(`starting heartbeat loop against ${state.controlPlaneUrl} (node ${state.nodeId})`);

  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  let busy = false;
  while (running) {
    if (!busy) {
      busy = true;
      heartbeatAndWork(api, ctx)
        .catch((err) => log(`loop error: ${(err as Error).message}`))
        .finally(() => {
          busy = false;
        });
    }
    await new Promise((r) => setTimeout(r, heartbeatIntervalSec * 1000));
  }
  log("stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
