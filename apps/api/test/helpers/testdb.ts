/**
 * Test-only PostgreSQL lifecycle. Boots a throwaway embedded PostgreSQL
 * (real server binaries via the embedded-postgres dev dependency) on a private
 * port, so the suite exercises the exact production stack: node-postgres,
 * `?`→`$n` placeholder translation, tx() and the SQL migration runner.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export interface TestDatabase {
  url: string;
  stop(): Promise<void>;
}

/** Fixed high port so parallel vitest workers share one server, not races. */
const TEST_DB_PORT = 54329;
const TEST_DB_NAME = "arvoo_test";

let shared: TestDatabase | null = null;

/**
 * Boot an independent PostgreSQL server on a private port and create a database
 * in it. Callers that must not touch the main suite's cluster (for example the
 * destructive migration-downgrade tests) use this directly with their own port.
 */
export async function createTestDatabase(opts: { port: number; databaseName: string }): Promise<TestDatabase> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "arvoo-pg-test-"));
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "arvoo_test",
    password: "arvoo_test",
    port: opts.port,
    persistent: false,
  });
  await server.initialise();

  // Booting the server is a real process start, and the very first connect can
  // fail transiently while the postmaster finishes binding (notably when two
  // test files boot a cluster at the same time on Windows). Retry the same
  // start a bounded number of times; a genuine failure still surfaces.
  let lastError: unknown;
  let started = false;
  for (let attempt = 1; attempt <= 3 && !started; attempt++) {
    try {
      await server.start();
      started = true;
    } catch (err) {
      lastError = err;
      console.warn(`[testdb] PostgreSQL start attempt ${attempt} on port ${opts.port} failed: ${String(err)}`);
      await delay(500 * attempt);
    }
  }
  if (!started) {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`Could not start the test PostgreSQL on port ${opts.port}: ${String(lastError)}`);
  }

  await server.createDatabase(opts.databaseName);
  return {
    url: `postgresql://arvoo_test:arvoo_test@127.0.0.1:${opts.port}/${opts.databaseName}`,
    async stop(): Promise<void> {
      try {
        await server.stop();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared cluster for the current test file (memoized per module graph). */
export async function startTestDatabase(): Promise<string> {
  if (!shared) shared = await createTestDatabase({ port: TEST_DB_PORT, databaseName: TEST_DB_NAME });
  return shared.url;
}

export async function stopTestDatabase(): Promise<void> {
  const current = shared;
  shared = null;
  await current?.stop();
}
