/**
 * cli/arvoo against a stubbed Ubuntu 24.04 host.
 *
 * These are the failures that could only be reproduced on a real node and not
 * by the TypeScript suite:
 *   * BUG 1 - `systemctl list-unit-files arvoo-agent` reports "0 unit files
 *     listed." with exit 1 on Ubuntu 24.04 for a unit installed by an installer
 *     even while the unit is active, so `arvoo node status` said "absent".
 *   * BUG 6 - a node-only host was reported as a broken panel: "API health:
 *     unreachable on 127.0.0.1:4001" and "database counts unavailable".
 *   * BUG 7 - the memory check divided MemAvailable by 1024 twice and warned
 *     "only 0 MiB available" on a healthy machine.
 *   * BUG 8 - an absent ACME certificate was a warning on a node, where TLS
 *     terminates on the control plane.
 *   * BUG 9 - service management tried to manage nginx/PostgreSQL/arvoo on a
 *     node that only runs the agent.
 *
 * The stubs model systemd's real answers, so the CLI is exercised end to end
 * (role detection, systemd calls, output) instead of being grepped.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "cli", "arvoo");

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Windows path -> MSYS path, so PATH entries and file arguments work in bash. */
function toPosix(p: string): string {
  return p.replace(/^([A-Za-z]):\\/, (_m, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, "/");
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  systemctlCalls: string[];
}

interface CliOptions {
  /** "unit|loadState|activeState|unitFileState|packageOwned" */
  units: string[];
  /** Environment values; "{dir}" is replaced with the scratch directory. */
  env?: Record<string, string>;
  /** Files to create in the scratch directory, keyed by relative path. */
  files?: Record<string, string>;
}

const SYSTEMCTL_STUB = [
  "#!/usr/bin/env bash",
  "# Test stub: systemd on Ubuntu 24.04, including the trap BUG 1 was about.",
  'units_file="${ARVOO_TEST_UNITS:?}"',
  'log_file="${ARVOO_TEST_SYSTEMCTL_LOG:-/dev/null}"',
  'action="${1:-}"',
  "shift || true",
  'record() { printf "%s\\n" "$*" >> "$log_file"; }',
  'lookup() { grep -m1 "^$1|" "$units_file" 2>/dev/null || true; }',
  'field() { printf "%s" "$1" | cut -d"|" -f"$2"; }',
  'case "$action" in',
  "  show)",
  '    unit="${1:-}"; shift || true',
  "    props=(); value=0",
  '    for a in "$@"; do',
  '      case "$a" in',
  "        --value) value=1 ;;",
  '        LoadState|ActiveState|SubState|UnitFileState|FragmentPath) props+=("$a") ;;',
  "      esac",
  "    done",
  '    line="$(lookup "$unit")"',
  '    if [[ -z "$line" ]]; then',
  '      for p in "${props[@]}"; do',
  "        if (( value )); then printf 'not-found\\n'; else printf '%s=not-found\\n' \"$p\"; fi",
  "      done",
  "      exit 0",
  "    fi",
  '    for p in "${props[@]}"; do',
  '      case "$p" in',
  '        LoadState) v="$(field "$line" 2)" ;;',
  '        ActiveState) v="$(field "$line" 3)" ;;',
  '        UnitFileState) v="$(field "$line" 4)" ;;',
  '        SubState) v="running" ;;',
  '        FragmentPath) v="/etc/systemd/system/${unit}.service" ;;',
  "      esac",
  "      if (( value )); then printf '%s\\n' \"$v\"; else printf '%s=%s\\n' \"$p\" \"$v\"; fi",
  "    done",
  "    ;;",
  "  is-active)",
  '    line="$(lookup "${1:-}")"',
  "    if [[ -z \"$line\" ]]; then printf 'unknown\\n'; exit 3; fi",
  '    state="$(field "$line" 3)"; printf "%s\\n" "$state"',
  '    [[ "$state" == "active" ]] || exit 3',
  "    ;;",
  "  is-enabled)",
  '    line="$(lookup "${1:-}")"',
  "    if [[ -z \"$line\" ]]; then printf 'disabled\\n'; exit 1; fi",
  '    state="$(field "$line" 4)"; printf "%s\\n" "$state"',
  '    [[ "$state" == "enabled" ]] || exit 1',
  "    ;;",
  "  list-unit-files)",
  "    printf 'UNIT FILE STATE PRESET\\n\\n'",
  '    line="$(lookup "${1:-}")"',
  '    if [[ -n "$line" && "$(field "$line" 5)" == "package" ]]; then',
  '      printf "%s enabled\\n" "${1:-}"; exit 0',
  "    fi",
  "    printf '0 unit files listed.\\n'",
  "    exit 1",
  "    ;;",
  "  cat)",
  '    line="$(lookup "${1:-}")"; [[ -n "$line" ]] || exit 1',
  "    printf '[Unit]\\nDescription=%s\\n' \"${1:-}\"",
  "    ;;",
  "  start|stop|restart|reload|enable|disable)",
  '    unit="${1:-}"',
  '    line="$(lookup "$unit")"',
  '    if [[ -z "$line" ]]; then record "$action $unit (skipped: absent)"; exit 4; fi',
  '    record "$action $unit"',
  "    ;;",
  "esac",
  "exit 0",
];

const UNAME_STUB = [
  "#!/usr/bin/env bash",
  'case "${1:-}" in',
  "  -s) printf 'Linux\\n' ;;",
  "  -r) printf '6.8.0-45-generic\\n' ;;",
  "  -m) printf 'x86_64\\n' ;;",
  "  *) printf 'Linux\\n' ;;",
  "esac",
];

const ID_STUB = ["#!/usr/bin/env bash", "printf '0\\n'"];

const CURL_STUB = [
  "#!/usr/bin/env bash",
  'if [[ -n "${ARVOO_TEST_CURL_FAIL:-}" ]]; then exit 7; fi',
  "printf '{\"status\":\"ok\",\"database\":\"ok\"}\\n'",
];

const JOURNALCTL_STUB = [
  "#!/usr/bin/env bash",
  'if [[ -n "${ARVOO_TEST_JOURNAL:-}" && -r "$ARVOO_TEST_JOURNAL" ]]; then cat "$ARVOO_TEST_JOURNAL"; else printf "[arvoo-agent] heartbeat sent\\n"; fi',
];

const SYSCTL_STUB = [
  "#!/usr/bin/env bash",
  'if [[ "${1:-}" == "-n" ]]; then printf "%s\\n" "${ARVOO_TEST_IP_FORWARD:-1}"; fi',
  "exit 0",
];

function writeStub(binDir: string, name: string, lines: string[]): void {
  const file = path.join(binDir, name);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function runCli(args: string[], options: CliOptions): Promise<CliResult> {
  const dir = mkdtempSync(path.join(tmpdir(), "arvoo-cli-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  const unitsFile = path.join(dir, "units.txt");
  writeFileSync(unitsFile, `${options.units.join("\n")}\n`);
  const logFile = path.join(dir, "systemctl.log");
  writeFileSync(logFile, "");

  for (const [name, lines] of [
    ["systemctl", SYSTEMCTL_STUB],
    ["uname", UNAME_STUB],
    ["id", ID_STUB],
    ["curl", CURL_STUB],
    ["journalctl", JOURNALCTL_STUB],
    ["sysctl", SYSCTL_STUB],
  ] as Array<[string, string[]]>) {
    writeStub(bin, name, lines);
  }

  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  const dirPosix = toPosix(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${toPosix(bin)}:${process.env.PATH ?? ""}`,
    ARVOO_TEST_UNITS: toPosix(unitsFile),
    ARVOO_TEST_SYSTEMCTL_LOG: toPosix(logFile),
    ARVOO_HOST_ROLE: "auto",
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    env[key] = value.replace(/\{dir\}/g, dirPosix);
  }

  const result = await run("bash", [CLI, ...args], env);
  const calls = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  return { ...result, systemctlCalls: calls };
}

interface CheckRow {
  name: string;
  status: string;
  detail: string;
}

/** `arvoo diagnostics --json` prints {"checks": [...]}. */
function checksOf(stdout: string): CheckRow[] {
  return (JSON.parse(stdout) as { checks: CheckRow[] }).checks;
}

const HEALTHY_NODE_UNITS = ["arvoo-agent|loaded|active|enabled|installer"];

const NODE_FILES = {
  "state/agent-state.json": JSON.stringify(
    { controlPlaneUrl: "https://vpn.example.com", nodeId: "node-abc", nodeSecret: "s", heartbeatIntervalSec: 15 },
    null,
    2,
  ),
  meminfo: "MemTotal:       16330960 kB\nMemAvailable:   1500000 kB\nMemFree:         900000 kB\n",
};

describe("systemd unit detection (BUG 1)", () => {
  it("reports an installer-managed unit as active even though list-unit-files does not track it", async () => {
    const result = await runCli(["node", "status"], {
      units: HEALTHY_NODE_UNITS,
      env: { ARVOO_AGENT_STATE_FILE: "{dir}/no-state-here.json" },
    });
    expect(result.stdout).toContain("host role:    node-only");
    expect(result.stdout).toContain("agent unit:   active");
    expect(result.stdout).not.toContain("absent");
  });

  it("still reports a genuinely missing unit as absent", async () => {
    const result = await runCli(["node", "status"], { units: ["nginx|loaded|active|enabled|package"] });
    expect(result.stdout).toContain("agent unit:   absent");
  });

  it("does not treat a masked unit as present", async () => {
    const result = await runCli(["diagnostics", "--json"], { units: ["arvoo-agent|masked||masked|installer"] });
    const agent = checksOf(result.stdout).find((c) => c.name === "arvoo-agent")!;
    expect(agent.status).toBe("fail");
    expect(agent.detail).toContain("masked");
    expect(result.code).toBe(1);
  });
});

describe("node-only hosts are not reported as broken panels (BUG 6/7/8)", () => {
  const nodeEnv = {
    ARVOO_AGENT_STATE_FILE: "{dir}/state/agent-state.json",
    ARVOO_MEMINFO_FILE: "{dir}/meminfo",
  };

  it("diagnoses the node stack and never the panel stack", async () => {
    const result = await runCli(["diagnostics", "--json"], { units: HEALTHY_NODE_UNITS, files: NODE_FILES, env: nodeEnv });

    const checks = checksOf(result.stdout);
    const names = checks.map((c) => c.name);
    expect(names).toContain("arvoo-agent");
    expect(names).toContain("Control plane");
    expect(names).toContain("Forwarding");
    // The panel stack does not exist on a node by design.
    expect(names).not.toContain("API");
    expect(names).not.toContain("API exposure");
    expect(names).not.toContain("PostgreSQL");
    expect(names).not.toContain("nginx config");
    expect(names).not.toContain("arvoo");
    expect(names).not.toContain("nginx");
    // Nothing may be reported as a failure on a healthy node.
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("reports real MiB instead of the fabricated 0 MiB (BUG 7)", async () => {
    const result = await runCli(["diagnostics", "--json"], { units: HEALTHY_NODE_UNITS, files: NODE_FILES, env: nodeEnv });
    const memory = checksOf(result.stdout).find((c) => c.name === "Memory")!;
    expect(memory.status).toBe("ok");
    expect(memory.detail).toContain("1464 MiB available");
    expect(memory.detail).not.toContain("0 MiB");
  });

  it("treats an absent certificate as information on a node, not a warning (BUG 8)", async () => {
    const result = await runCli(["diagnostics", "--json"], {
      units: HEALTHY_NODE_UNITS,
      files: NODE_FILES,
      env: { ...nodeEnv, ARVOO_CERT_DIR: "{dir}/no-letsencrypt-here" },
    });
    const certificate = checksOf(result.stdout).find((c) => c.name === "Certificate")!;
    expect(certificate.status).toBe("info");
    expect(certificate.detail).toContain("not required on a node");
  });

  it("reports the node health summary instead of an unreachable panel API", async () => {
    const result = await runCli(["status"], {
      units: HEALTHY_NODE_UNITS,
      files: NODE_FILES,
      env: { ARVOO_AGENT_STATE_FILE: "{dir}/state/agent-state.json" },
    });
    expect(result.stdout).toContain("Node health");
    expect(result.stdout).toContain("Agent:         active");
    expect(result.stdout).toContain("Enrollment:    enrolled");
    expect(result.stdout).toContain("Control plane: reachable");
    expect(result.stdout).toContain("Heartbeat:     healthy");
    expect(result.stdout).toContain("Forwarding:    enabled");
    expect(result.stdout).not.toContain("127.0.0.1:4001");
  });

  it("keeps the panel host checks on a panel host", async () => {
    const result = await runCli(["diagnostics", "--json"], {
      units: ["arvoo|loaded|active|enabled|installer", "nginx|loaded|active|enabled|package", "postgresql|loaded|active|enabled|package"],
      files: { "arvoo.env": "DATABASE_URL=postgresql://arvoo_user:pw@127.0.0.1:5432/arvoo\n" },
      env: { ARVOO_ENV_FILE: "{dir}/arvoo.env" },
    });
    const names = checksOf(result.stdout).map((c) => c.name);
    expect(names).toContain("API");
    expect(names).toContain("arvoo");
    expect(names).toContain("nginx");
    expect(names).not.toContain("Control plane");
    expect(names).not.toContain("Forwarding");
  });

  it("fails honestly when the control plane is unreachable", async () => {
    const result = await runCli(["diagnostics", "--json"], {
      units: HEALTHY_NODE_UNITS,
      files: NODE_FILES,
      env: { ...nodeEnv, ARVOO_TEST_CURL_FAIL: "1" },
    });
    const checks = checksOf(result.stdout);
    expect(checks.find((c) => c.name === "Control plane")?.status).toBe("fail");
    expect(result.code).toBe(1);
  });
});

describe("service management is role aware (BUG 9)", () => {
  it("restarts only the agent on a node, never nginx/PostgreSQL/arvoo", async () => {
    const result = await runCli(["restart", "--yes"], {
      units: ["arvoo-agent|loaded|active|enabled|installer", "nginx|loaded|active|enabled|package", "postgresql|loaded|active|enabled|package"],
    });
    expect(result.code).toBe(0);
    expect(result.systemctlCalls).toEqual(["restart arvoo-agent"]);
  });

  it("starts the panel stack in dependency order and never stops PostgreSQL", async () => {
    const panelUnits = ["arvoo|loaded|active|enabled|installer", "nginx|loaded|active|enabled|package", "postgresql|loaded|active|enabled|package"];
    const started = await runCli(["start", "--yes"], { units: panelUnits });
    expect(started.systemctlCalls).toEqual(["start postgresql", "start arvoo", "start nginx"]);

    const stopped = await runCli(["stop", "--yes"], { units: panelUnits });
    expect(stopped.systemctlCalls).toEqual(["stop nginx", "stop arvoo"]);
  });

  it("does not warn about a missing panel service on a node", async () => {
    const result = await runCli(["restart", "--yes"], { units: HEALTHY_NODE_UNITS });
    expect(result.stdout).not.toContain("is not installed on this host");
  });
});
