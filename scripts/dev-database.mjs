#!/usr/bin/env node
/**
 * Development / E2E helper: run a throwaway PostgreSQL server locally.
 *
 *   node scripts/dev-database.mjs
 *
 * Boots real PostgreSQL binaries (via the embedded-postgres devDependency) on a
 * private port, creates the application database and prints the connection
 * string to use:
 *
 *   DATABASE_URL=postgresql://arvoo_dev:arvoo_dev@127.0.0.1:54331/arvoo_dev
 *
 * It stays in the foreground; Ctrl+C stops the server and deletes its temporary
 * data directory. Override with ARVOO_DEV_DB_PORT / _NAME / _USER / _PASSWORD or
 * ARVOO_DEV_DB_DIR (an existing directory is reused and preserved).
 *
 * Production never uses this: DEPLOYMENT.md provisions a real cluster owned by
 * the dedicated arvoo_user role.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const port = Number(process.env.ARVOO_DEV_DB_PORT ?? 54331);
const databaseName = process.env.ARVOO_DEV_DB_NAME ?? "arvoo_dev";
const user = process.env.ARVOO_DEV_DB_USER ?? "arvoo_dev";
const password = process.env.ARVOO_DEV_DB_PASSWORD ?? "arvoo_dev";

const explicitDir = process.env.ARVOO_DEV_DB_DIR;
const dataDir = explicitDir ?? mkdtempSync(path.join(tmpdir(), "arvoo-dev-pg-"));
const temporary = !explicitDir;

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: !temporary,
});

await server.initialise();
await server.start();
await server.createDatabase(databaseName);

console.log(`[dev-db] PostgreSQL listening on 127.0.0.1:${port}`);
console.log(`[dev-db] data directory: ${dataDir}${temporary ? " (temporary)" : ""}`);
console.log(`[dev-db] DATABASE_URL=postgresql://${user}:${password}@127.0.0.1:${port}/${databaseName}`);
console.log("[dev-db] press Ctrl+C to stop");

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[dev-db] ${signal} - stopping PostgreSQL...`);
  try {
    await server.stop();
  } finally {
    if (temporary) rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
