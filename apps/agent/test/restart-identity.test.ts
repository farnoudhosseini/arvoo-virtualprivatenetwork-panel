/**
 * BUG 10: `systemctl restart arvoo-agent` must bring the agent back, actively,
 * with the SAME node identity - no new enrollment, no new token. A restart that
 * enrolled again would leave the control plane with a duplicate node and the
 * operator hunting for a token that is not needed.
 *
 * The agent runs for real here (tsx + src) against a fake control plane that
 * records enrollment calls and the credentials of every heartbeat, so both
 * claims are measured: the identity is the one in the state file, and /hello is
 * never called while an identity exists.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const AGENT = path.join(repoRoot, "apps", "agent", "src", "index.ts");

const NODE_ID = "node-keep-0001";
const NODE_SECRET = "secret-keep-0001";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface FakeControlPlane {
  url: string;
  hellos: string[];
  heartbeatAuth: string[];
  close(): Promise<void>;
}

async function startFakeControlPlane(): Promise<FakeControlPlane> {
  const hellos: string[] = [];
  const heartbeatAuth: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      if (url === "/api/v1/agent/hello") {
        hellos.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ nodeId: "enrollment-must-not-happen", nodeSecret: "x", heartbeatIntervalSec: 1 }));
        return;
      }
      if (url === "/api/v1/agent/heartbeat") {
        heartbeatAuth.push(String(req.headers.authorization ?? ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", heartbeatIntervalSec: 1 }));
        return;
      }
      if (url === "/api/v1/agent/operations") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ operation: null }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hellos,
    heartbeatAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seedState(dir: string, controlPlaneUrl: string): string {
  const file = path.join(dir, "agent-state.json");
  writeFileSync(
    file,
    `${JSON.stringify({ controlPlaneUrl, nodeId: NODE_ID, nodeSecret: NODE_SECRET, heartbeatIntervalSec: 1 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return file;
}

function spawnAgent(stateDir: string, controlPlaneUrl: string, args: string[] = []): ChildProcess {
  return spawn(process.execPath, [TSX, AGENT, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ARVOO_AGENT_STATE_DIR: stateDir,
      ARVOO_CONTROL_PLANE_URL: controlPlaneUrl,
      ARVOO_ENROLLMENT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Run the agent until it has heartbeated, then stop it - a service restart. */
async function runAgentUntilHeartbeat(plane: FakeControlPlane, stateDir: string): Promise<{ heartbeats: number; wasAlive: boolean }> {
  const child = spawnAgent(stateDir, plane.url);
  const before = plane.heartbeatAuth.length;
  const deadline = Date.now() + 30_000;
  while (plane.heartbeatAuth.length === before && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const wasAlive = child.exitCode === null;
  const heartbeats = plane.heartbeatAuth.length - before;
  child.kill("SIGTERM");
  await waitForExit(child, 10_000);
  if (child.exitCode === null) child.kill("SIGKILL");
  return { heartbeats, wasAlive };
}

describe("agent restart keeps the node identity (BUG 10)", () => {
  it("starts from the persisted identity on every restart without enrolling again", async () => {
    const plane = await startFakeControlPlane();
    const stateDir = mkdtempSync(path.join(tmpdir(), "arvoo-agent-restart-"));
    tempDirs.push(stateDir);
    try {
      const stateFile = seedState(stateDir, plane.url);
      const seeded = readFileSync(stateFile, "utf8");

      const first = await runAgentUntilHeartbeat(plane, stateDir);
      expect(first.wasAlive, "the agent exited instead of running").toBe(true);
      expect(first.heartbeats).toBeGreaterThan(0);

      // A restart (what `systemctl restart arvoo-agent` does).
      const second = await runAgentUntilHeartbeat(plane, stateDir);
      expect(second.wasAlive, "the agent did not come back after a restart").toBe(true);
      expect(second.heartbeats).toBeGreaterThan(0);

      // It authenticated with the stored identity both times...
      for (const auth of plane.heartbeatAuth) {
        expect(auth).toBe(`Bearer arvoo-node ${NODE_ID}:${NODE_SECRET}`);
      }
      // ...and never asked for a new identity.
      expect(plane.hellos).toEqual([]);
      // The identity on disk is untouched by restarts.
      expect(readFileSync(stateFile, "utf8")).toBe(seeded);
    } finally {
      await plane.close();
    }
  }, 90_000);

  it("refuses to enroll again while an identity exists", async () => {
    const plane = await startFakeControlPlane();
    const stateDir = mkdtempSync(path.join(tmpdir(), "arvoo-agent-enroll-"));
    tempDirs.push(stateDir);
    try {
      const stateFile = seedState(stateDir, plane.url);
      const seeded = readFileSync(stateFile, "utf8");

      const child = spawnAgent(stateDir, plane.url, ["enroll", "one-time-token"]);
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const code = await waitForExit(child, 30_000);

      expect(code).toBe(1);
      expect(stderr).toContain("already enrolled");
      expect(plane.hellos).toEqual([]);
      expect(readFileSync(stateFile, "utf8")).toBe(seeded);
    } finally {
      await plane.close();
    }
  }, 60_000);

  it("reports the enrolled node for `status`, with the state file it used", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "arvoo-agent-status-"));
    tempDirs.push(stateDir);
    const stateFile = seedState(stateDir, "https://vpn.example.com");

    const child = spawnAgent(stateDir, "https://vpn.example.com", ["status"]);
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const code = await waitForExit(child, 30_000);

    expect(code).toBe(0);
    expect(stdout).toContain(`Node: ${NODE_ID}`);
    expect(stdout).toContain("Control plane: https://vpn.example.com");
    expect(stdout).toContain("agent-state.json");
    expect(stdout).not.toContain("Not enrolled.");
    expect(readFileSync(stateFile, "utf8")).toContain(NODE_ID);
  }, 60_000);
});
