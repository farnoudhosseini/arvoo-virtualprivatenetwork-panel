/**
 * BUG 12: `node /opt/arvoo/apps/agent/dist/index.js status` said "Not enrolled."
 * on a node whose identity existed, because the state directory was only read
 * from ARVOO_AGENT_STATE_DIR / ~/.arvoo and a plain shell has neither the
 * systemd EnvironmentFile nor the installation's path in its home directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STANDARD_STATE_DIR, loadStateDetailed, resolveStateDir } from "../src/config.js";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "arvoo-agent-state-"));
}

describe("state directory resolution", () => {
  it("uses ARVOO_AGENT_STATE_DIR when the systemd environment provides it", () => {
    expect(resolveStateDir({ ARVOO_AGENT_STATE_DIR: "/srv/arvoo" } as NodeJS.ProcessEnv, "linux", () => false)).toBe("/srv/arvoo");
  });

  it("falls back to the installation path on a node, even without any environment", () => {
    // This is the shell case: no ARVOO_AGENT_STATE_DIR and /var/lib/arvoo exists.
    const dir = resolveStateDir({} as NodeJS.ProcessEnv, "linux", (candidate) => candidate === STANDARD_STATE_DIR);
    expect(dir).toBe(STANDARD_STATE_DIR);
    // path.posix so the expectation is the Linux path, not a Windows join.
    expect(path.posix.join(dir, "agent-state.json")).toBe("/var/lib/arvoo/agent-state.json");
  });

  it("keeps the home directory for a development machine", () => {
    const dir = resolveStateDir({} as NodeJS.ProcessEnv, "linux", () => false);
    expect(dir.endsWith(".arvoo")).toBe(true);
    expect(dir).not.toBe(STANDARD_STATE_DIR);
  });

  it("does not point a non-Linux host at the Linux installation path", () => {
    expect(resolveStateDir({} as NodeJS.ProcessEnv, "win32", () => true).endsWith(".arvoo")).toBe(true);
  });

  it("ignores an empty override instead of resolving to an empty directory", () => {
    const dir = resolveStateDir({ ARVOO_AGENT_STATE_DIR: "  " } as NodeJS.ProcessEnv, "linux", (candidate) => candidate === STANDARD_STATE_DIR);
    expect(dir).toBe(STANDARD_STATE_DIR);
  });
});

describe("identity load reporting", () => {
  it("distinguishes missing, unreadable, invalid and valid state", () => {
    const dir = scratch();
    try {
      const missing = loadStateDetailed(path.join(dir, "agent-state.json"));
      expect(missing.reason).toBe("missing");
      expect(missing.state).toBeNull();

      // A directory where the identity file is expected is unreadable, not
      // "not enrolled": the operator needs to know the difference.
      const asDirectory = path.join(dir, "as-directory");
      mkdirSync(asDirectory);
      expect(loadStateDetailed(asDirectory).reason).toBe("unreadable");

      const invalid = path.join(dir, "invalid.json");
      writeFileSync(invalid, "{ this is not json");
      expect(loadStateDetailed(invalid).reason).toBe("invalid");

      const valid = path.join(dir, "valid.json");
      writeFileSync(
        valid,
        JSON.stringify({ controlPlaneUrl: "https://vpn.example.com", nodeId: "node-1", nodeSecret: "s", heartbeatIntervalSec: 15 }),
      );
      const loaded = loadStateDetailed(valid);
      expect(loaded.reason).toBe("ok");
      expect(loaded.state?.nodeId).toBe("node-1");
      expect(loaded.path).toBe(valid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
