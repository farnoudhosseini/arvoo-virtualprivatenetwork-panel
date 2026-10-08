/**
 * install.sh: the parts that only fail on a real Ubuntu 24.04 host.
 *
 *   * BUG 3 - a freshly installed PostgreSQL refused the installer with
 *     "role \"arvoo_user\" does not exist" because only `ALTER ROLE` was issued.
 *     Here the SQL that install.sh generates is captured and executed against a
 *     real PostgreSQL server, twice, exactly as two installer runs do.
 *   * BUG 4 - `curl .../install.sh | bash` staged whatever directory the
 *     operator happened to be in, so /opt/arvoo ended up without deploy/, cli/
 *     or site/. The detection is exercised against real directories.
 *   * BUG 5 - the generated vhost used `http2 on;`, which nginx 1.24 (Ubuntu
 *     24.04) rejects with "unknown directive".
 *   * BUG 11 - /var/lib/ufw missing while the agent unit lists it in
 *     ReadWritePaths made systemd fail with status=226/NAMESPACE.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../apps/api/test/helpers/testdb.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(repoRoot, "install.sh");
const ISOLATED_PORT = 54332;

const tempDirs: string[] = [];
let work = "";
let db: TestDatabase;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Run a command with a script fed through stdin, like `curl ... | bash -s --`. */
function runWithStdin(cmd: string, args: string[], input: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * Source install.sh (main() is guarded for exactly this) and exercise the
 * functions under test. Nothing here touches the host: every output path is
 * redirected into the scratch directory.
 */
const DRIVER = [
  "set -uo pipefail",
  'root="$1"; work="$2"',
  'export ARVOO_INSTALL_ROOT="$work/install-root"',
  'export ARVOO_ENV_FILE="$work/arvoo.env"',
  'export ARVOO_BACKUP_DIR="$work/backups"',
  'export ARVOO_NGINX_SITE_FILE="$work/nginx-arvoo.conf"',
  'export ARVOO_DOMAIN="panel.example.com"',
  'export ARVOO_API_PORT="4001"',
  'source "$root/install.sh"',
  "",
  "# ---- checkout detection (BUG 4) ----",
  'mkdir -p "$work/only-installer" "$work/full/apps" "$work/full/deploy" "$work/full/cli"',
  'cp "$root/install.sh" "$work/only-installer/install.sh"',
  'cp "$root/install.sh" "$root/package.json" "$work/full/"',
  'if looks_like_checkout "$work/only-installer"; then echo "checkout-only-installer: yes"; else echo "checkout-only-installer: no"; fi',
  'if looks_like_checkout "$work/full"; then echo "checkout-full: yes"; else echo "checkout-full: no"; fi',
  'if looks_like_checkout "$root"; then echo "checkout-repo: yes"; else echo "checkout-repo: no"; fi',
  'if looks_like_checkout "$work/does-not-exist"; then echo "checkout-missing: yes"; else echo "checkout-missing: no"; fi',
  "",
  "# ---- TLS vhost (BUG 5) ----",
  'export ARVOO_DOMAIN="panel.example.com"',
  "render_tls_site",
  'echo "rendered: $ARVOO_NGINX_SITE_FILE"',
  "",
  "# ---- PostgreSQL role SQL (BUG 3) ----",
  'psql_super() { cat; }',
  'echo "---SQL-START---"',
  'set_role_password "first-password"',
  'echo "---SQL-END---"',
  'echo "---SQL-ESCAPED-START---"',
  'set_role_password "pa\'ss word"',
  'echo "---SQL-ESCAPED-END---"',
  "",
  "# ---- ufw sandbox paths (BUG 11, static source checks) ----",
  'echo "ensure-ufw-dirs-defined: $(declare -F ensure_ufw_dirs >/dev/null && echo yes || echo no)"',
  "",
  "# ---- enrollment reuse on a second --node run (BUG 10 / Test 4) ----",
  'export AGENT_STATE_DIR="$work/agent-state"',
  'export AGENT_ENTRY="$root/install.sh"',
  'mkdir -p "$AGENT_STATE_DIR"',
  'cat > "$AGENT_STATE_DIR/agent-state.json" <<\'JSON\'',
  '{"controlPlaneUrl":"https://panel.example.com","nodeId":"node-xyz","nodeSecret":"s","heartbeatIntervalSec":15}',
  "JSON",
  'write_agent_env() { echo "agent-env rewritten for: $1"; }',
  'ask_control_plane_url() { printf "%s" "https://panel.example.com"; }',
  'validate_control_plane() { echo "VALIDATE-MUST-NOT-RUN"; }',
  'if enroll_agent; then echo "enroll-reuse: ok"; else echo "enroll-reuse: failed"; fi',
  'echo "enroll-node-id: $(agent_node_id)"',
];

function writeDriver(): string {
  const file = path.join(work, "driver.sh");
  writeFileSync(file, `${DRIVER.join("\n")}\n`);
  return file;
}

let driverOutput = "";

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), "arvoo-installer-"));
  tempDirs.push(work);
  const driver = writeDriver();
  const env: NodeJS.ProcessEnv = { ...process.env, ARVOO_DOMAIN: "panel.example.com" };
  const result = await run("bash", [driver, repoRoot, work], env, repoRoot);
  if (result.code !== 0) {
    throw new Error(`installer driver failed (${result.code}):\n${result.stdout}\n${result.stderr}`);
  }
  driverOutput = result.stdout;

  db = await createTestDatabase({ port: ISOLATED_PORT, databaseName: "arvoo_installer" });
}, 180_000);

afterAll(async () => {
  await db?.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function capturedSql(startMarker: string, endMarker: string): string {
  const start = driverOutput.indexOf(startMarker);
  const end = driverOutput.indexOf(endMarker);
  expect(start, `${startMarker} missing from the driver output`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return driverOutput.slice(start + startMarker.length, end).trim();
}

describe("PostgreSQL role provisioning is idempotent (BUG 3)", () => {
  it("runs the generated SQL on a fresh server: create, then alter, then create for a new role", async () => {
    const sql = capturedSql("---SQL-START---", "---SQL-END---");
    // PostgreSQL itself decides between CREATE and ALTER - no fragile parsing.
    expect(sql).toContain("pg_catalog.pg_roles");
    expect(sql).toContain("CREATE ROLE arvoo_user LOGIN PASSWORD");
    expect(sql).toContain("ALTER ROLE arvoo_user WITH LOGIN PASSWORD");
    expect(sql).toContain("DO $$");

    const admin = new Client({ connectionString: db.url });
    await admin.connect();
    try {
      // Run 1 of the installer on a freshly installed PostgreSQL.
      await admin.query(sql);
      const role = await admin.query<{ rolname: string; rolcanlogin: boolean }>(
        `SELECT rolname, rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'arvoo_user'`,
      );
      expect(role.rows).toHaveLength(1);
      expect(role.rows[0]!.rolcanlogin).toBe(true);

      // Run 2 of the installer: the same statement must succeed again.
      await admin.query(sql);

      // The password that install.sh wrote into DATABASE_URL really works.
      const app = new Client({ connectionString: `postgresql://arvoo_user:first-password@127.0.0.1:${ISOLATED_PORT}/arvoo_installer` });
      await app.connect();
      const who = await app.query<{ current_user: string }>("SELECT current_user");
      expect(who.rows[0]!.current_user).toBe("arvoo_user");
      await app.end();

      // A later run with a new password rotates it instead of failing.
      await admin.query(sql.replace(/first-password/g, "rotated-password"));
      const rotated = new Client({ connectionString: `postgresql://arvoo_user:rotated-password@127.0.0.1:${ISOLATED_PORT}/arvoo_installer` });
      await rotated.connect();
      await rotated.end();

      const old = new Client({ connectionString: `postgresql://arvoo_user:first-password@127.0.0.1:${ISOLATED_PORT}/arvoo_installer` });
      await expect(old.connect()).rejects.toBeTruthy();
    } finally {
      await admin.end();
    }
  });

  it("escapes a quote in the password instead of breaking the statement", async () => {
    const sql = capturedSql("---SQL-ESCAPED-START---", "---SQL-ESCAPED-END---");
    expect(sql).toContain("'pa''ss word'");
    const admin = new Client({ connectionString: db.url });
    await admin.connect();
    try {
      await admin.query(sql);
      const app = new Client({ connectionString: `postgresql://arvoo_user:pa'ss word@127.0.0.1:${ISOLATED_PORT}/arvoo_installer` });
      await app.connect();
      await app.end();
    } finally {
      await admin.end();
    }
  });
});

describe("checkout detection (BUG 4)", () => {
  it("refuses a directory that only contains install.sh", () => {
    expect(driverOutput).toContain("checkout-only-installer: no");
  });

  it("accepts a complete checkout (and the repository itself)", () => {
    expect(driverOutput).toContain("checkout-full: yes");
    expect(driverOutput).toContain("checkout-repo: yes");
  });

  it("treats a missing directory as no checkout", () => {
    expect(driverOutput).toContain("checkout-missing: no");
  });

  it("sees no checkout when the installer is piped from stdin", async () => {
    // `curl .../install.sh | bash` runs with $0 = "bash": there is no directory
    // next to the script, so the repository must be fetched instead.
    const piped = await run("bash", ["-c", `source "${repoRoot.replace(/\\/g, "/")}/install.sh"; script_dir || echo "(none)"`], process.env);
    expect(piped.stdout.trim()).toBe("(none)");
  });

  it("still runs when it is piped in, which is the documented install command", async () => {
    // `bash` reports an EMPTY BASH_SOURCE[0] for a piped script. The guard that
    // keeps the test suite from executing main() must not swallow this case.
    const script = readFileSync(INSTALLER, "utf8");
    const piped = await runWithStdin("bash", ["-s", "--", "--help"], script, process.env, repoRoot);
    expect(piped.stdout).toContain("Arvoo Control Plane - installer and maintenance");
    expect(piped.code).toBe(0);

    // ...and sourcing the file must NOT run the installer.
    const sourced = await run("bash", ["-c", `source "${repoRoot.replace(/\\/g, "/")}/install.sh"; echo "main-not-run"`], process.env, repoRoot);
    expect(sourced.stdout).toContain("main-not-run");
    expect(sourced.stdout).not.toContain("ARVOO INSTALLATION COMPLETE");
  });

  it("aborts an incomplete staging with the missing paths named", () => {
    const source = readFileSync(INSTALLER, "utf8");
    expect(source).toContain("require_checkout_layout");
    expect(source).toContain("deploy/arvoo.service deploy/arvoo-agent.service deploy/nginx-common.conf deploy/nginx-arvoo.conf");
    // The repository is fetched when no checkout is visible, never assumed.
    expect(source).toContain("git clone --quiet --depth 1");
    expect(source).toContain("DEFAULT_SOURCE_URL=");
  });
});

describe("nginx TLS vhost (BUG 5)", () => {
  it("enables HTTP/2 through the listen directive, not the 1.25-only directive", () => {
    const file = path.join(work, "nginx-arvoo.conf");
    expect(existsSync(file)).toBe(true);
    const config = readFileSync(file, "utf8");

    // nginx 1.24 (Ubuntu 24.04) aborts on `http2 on;`.
    expect(config).not.toMatch(/^\s*http2\s+on\s*;/m);
    expect(config).toMatch(/^\s*listen 443 ssl http2;$/m);
    expect(config).toMatch(/^\s*listen \[::\]:443 ssl http2;$/m);
    // The rest of the TLS vhost is untouched.
    expect(config).toContain("ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem");
    expect(config).toContain("return 301 https://$host$request_uri");
    expect(config).toContain("server 127.0.0.1:4001");
  });

  it("keeps no stale http2 directive in the installer either", () => {
    const source = readFileSync(INSTALLER, "utf8");
    const offenders = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), index: index + 1 }))
      .filter((entry) => /^http2\s+on\s*;/.test(entry.line));
    expect(offenders).toEqual([]);
    expect(source).toContain("listen 443 ssl http2;");
  });
});

describe("ufw sandbox paths (BUG 11)", () => {
  it("creates /var/lib/ufw before the agent unit is started", () => {
    const source = readFileSync(INSTALLER, "utf8");
    const nodeInstall = source.slice(source.indexOf("mode_install_node()"), source.indexOf("mode_repair()"));
    expect(nodeInstall).toContain("ensure_ufw_dirs");
    expect(nodeInstall.indexOf("ensure_ufw_dirs")).toBeLessThan(nodeInstall.indexOf("systemctl restart arvoo-agent"));
    // And the panel path prepares the same directories.
    expect(source).toContain("ensure_ufw_dirs\n\n  # Firewall request spool");
  });

  it("installs ufw on both the panel and the node", () => {
    const source = readFileSync(INSTALLER, "utf8");
    const panelPackages = source.slice(source.indexOf("apt-get install -y -qq \\\n    ca-certificates"), source.indexOf("# Node.js LTS"));
    expect(panelPackages).toContain("ufw");
    expect(source).toContain("iptables nftables ufw ethtool");
  });

  it("prefixes the ufw paths in both units so a missing path cannot fail the namespace setup", () => {
    for (const unit of ["deploy/arvoo-agent.service", "deploy/arvoo-ufw-apply.service"]) {
      const content = readFileSync(path.join(repoRoot, unit), "utf8");
      const readWrite = content.split("\n").find((line) => line.startsWith("ReadWritePaths="));
      expect(readWrite, `${unit} has no ReadWritePaths`).toBeTruthy();
      expect(readWrite).toContain("-/etc/ufw");
      expect(readWrite).toContain("-/var/lib/ufw");
    }
  });

  it("keeps ufw optional in the installer instead of failing the run", () => {
    const source = readFileSync(INSTALLER, "utf8");
    expect(source).toContain("command_exists ufw || { warn \"ufw is not installed");
  });
});

describe("installer idempotency on a re-run (BUG 10, Test 4)", () => {
  it("reuses an existing node identity instead of demanding a new token", () => {
    // The driver runs enroll_agent with a state file already present: no token,
    // no control plane round trip, and the same node id.
    expect(driverOutput).toContain("already enrolled (node node-xyz)");
    expect(driverOutput).toContain("enroll-reuse: ok");
    expect(driverOutput).not.toContain("VALIDATE-MUST-NOT-RUN");
    expect(driverOutput).toContain("enroll-node-id: node-xyz");
  });

  it("restarts the agent - not the panel - on a node, without changing the identity", () => {
    const source = readFileSync(INSTALLER, "utf8");
    const restart = source.slice(source.indexOf("mode_restart()"), source.indexOf("mode_update()"));
    expect(restart).toContain("Restarting the node agent");
    expect(restart.indexOf("Restarting the node agent")).toBeLessThan(restart.indexOf("Restarting application services"));
    expect(restart).toContain('systemctl restart arvoo-agent');
    expect(restart).toContain("identity preserved");
  });

  it("reports node status from the installer on a node instead of missing panel services", () => {
    const source = readFileSync(INSTALLER, "utf8");
    const status = source.slice(source.indexOf("mode_status()"), source.indexOf("mode_restart()"));
    expect(status).toContain("Arvoo node status (no panel on this host)");
    expect(status).toContain("node identity present");
    expect(status).toContain("net.ipv4.ip_forward");
  });
});

describe("the old broken implementations are gone (BUG 2, regression guard)", () => {
  it("uses systemd's own LoadState instead of list-unit-files", () => {
    const cli = readFileSync(path.join(repoRoot, "cli", "arvoo"), "utf8");
    const offenders = cli
      .split("\n")
      .map((line, index) => ({ line: line.trim(), index: index + 1 }))
      .filter((entry) => !entry.line.startsWith("#") && entry.line.includes("list-unit-files"));
    expect(offenders).toEqual([]);
    expect(cli).toContain('systemctl show "$1" -p LoadState --value');
  });

  it("installs the CLI from the repository so a re-run cannot restore an old one", () => {
    const source = readFileSync(INSTALLER, "utf8");
    expect(source).toContain('for candidate in "${INSTALL_ROOT}/cli/arvoo" "${NODE_AGENT_ROOT}/cli/arvoo" "./cli/arvoo"');
  });
});
