import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool, types } = pg;

// ---------------------------------------------------------------------------
// Type parsers
// ---------------------------------------------------------------------------
// Our schema stores byte counters and counters as BIGINT and aggregate sums
// come back as NUMERIC. node-postgres returns both as strings by default,
// which would silently break arithmetic and JSON responses that previously
// flowed through SQLite as numbers. Parse them as JS numbers (safe up to
// 2^53 - far beyond any realistic traffic counter for this platform).
types.setTypeParser(20, (v: string) => Number(v)); // int8 / bigint
types.setTypeParser(1700, (v: string) => Number(v)); // numeric

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export interface DbOptions {
  /** postgresql://user:pass@host:port/db */
  url: string;
  /** Max pooled connections (default 10). */
  max?: number;
  /** application_name shown in pg_stat_activity. */
  applicationName?: string;
}

let pool: pg.Pool | null = null;

export function openDatabase(opts: DbOptions): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: opts.url,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: opts.applicationName ?? "arvoo-api",
    options: "-c timezone=UTC",
  });
  // An idle client erroring (server restart, network blip) must not take the
  // process down; pg evicts it and the next query opens a fresh connection.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });
  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Database not opened");
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** Health probe used by /health. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await query(`SELECT 1`, []);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Placeholder translation: application SQL uses `?`, PostgreSQL uses `$n`
// ---------------------------------------------------------------------------
// `?` inside string literals, quoted identifiers and comments is left alone.

const translationCache = new Map<string, string>();

export function toPostgresPlaceholders(sql: string): string {
  const cached = translationCache.get(sql);
  if (cached !== undefined) return cached;

  let out = "";
  let p = 0;
  let n = 0;
  while (p < sql.length) {
    const ch = sql[p];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      p++;
      while (p < sql.length) {
        out += sql[p];
        if (sql[p] === quote) {
          if (sql[p + 1] === quote) {
            out += quote;
            p += 2;
            continue;
          }
          p++;
          break;
        }
        p++;
      }
      continue;
    }
    if (ch === "-" && sql[p + 1] === "-") {
      while (p < sql.length && sql[p] !== "\n") {
        out += sql[p];
        p++;
      }
      continue;
    }
    if (ch === "/" && sql[p + 1] === "*") {
      while (p < sql.length && !(sql[p] === "*" && sql[p + 1] === "/")) {
        out += sql[p];
        p++;
      }
      if (p < sql.length) {
        out += "*/";
        p += 2;
      }
      continue;
    }
    if (ch === "?") {
      n++;
      out += `$${n}`;
      p++;
      continue;
    }
    out += ch;
    p++;
  }
  if (translationCache.size < 2000) translationCache.set(sql, out);
  return out;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Active transaction client (set by tx()); queries inside tx() share it. */
const txStorage = new AsyncLocalStorage<pg.PoolClient>();

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((v) => (v === undefined ? null : v));
}

async function query(sql: string, params: unknown[]): Promise<pg.QueryResult> {
  const prepared = toPostgresPlaceholders(sql);
  const values = normalizeParams(params);
  const client = txStorage.getStore();
  if (client) return client.query(prepared, values);
  return getPool().query(prepared, values);
}

export async function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await query(sql, params);
  return res.rows as T[];
}

export async function q1<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  const res = await query(sql, params);
  return (res.rows[0] as T | undefined) ?? undefined;
}

export async function run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
  const res = await query(sql, params);
  return { changes: res.rowCount ?? 0 };
}

/**
 * Run fn inside a transaction on a single pooled client. Queries issued
 * through q/q1/run while fn is executing automatically join the transaction
 * (AsyncLocalStorage), so existing call sites keep their shape.
 */
export async function tx<T>(fn: () => T | Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await txStorage.run(client, async () => fn());
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed:", (rollbackErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Migrations (versioned, reproducible, advisory-locked)
// ---------------------------------------------------------------------------

/** App-wide lock key so concurrent starts cannot race migrations. */
const MIGRATION_LOCK_KEY = 814_739_201;

/**
 * Upgrade migrations are `NNNN_name.sql`; the optional reverse of a migration
 * is `NNNN_name.down.sql`. Both live in the same directory, are versioned by
 * filename and are applied exactly once in filename order.
 */
export function listMigrations(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

function downFileFor(migrationsDir: string, name: string): string {
  return path.join(migrationsDir, name.replace(/\.sql$/, ".down.sql"));
}

/**
 * Apply every pending upgrade migration, each in its own transaction, under an
 * advisory lock so concurrent starts cannot race. Returns how many ran.
 */
export async function migrate(migrationsDir: string): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
    );
    const applied = new Set(
      (await client.query(`SELECT name FROM _migrations`)).rows.map((r) => (r as { name: string }).name),
    );

    const files = listMigrations(migrationsDir);

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO _migrations (name, applied_at) VALUES ($1, $2)`, [
          file,
          new Date().toISOString(),
        ]);
        await client.query("COMMIT");
        count++;
        console.log(`[db] applied migration ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return count;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/**
 * Revert migrations, newest first, using their `.down.sql` counterpart.
 * A migration without a reverse file is refused rather than guessed at, and
 * `stopBefore` keeps everything up to (and including) that migration applied.
 * Returns the names of the migrations that were reverted.
 */
export async function migrateDown(
  migrationsDir: string,
  opts: { steps?: number; stopBefore?: string } = {},
): Promise<string[]> {
  const steps = opts.steps ?? Number.POSITIVE_INFINITY;
  const client = await getPool().connect();
  const reverted: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
    );

    const appliedNames = (await client.query(`SELECT name FROM _migrations ORDER BY name DESC`)).rows.map(
      (r) => (r as { name: string }).name,
    );
    const known = new Set(listMigrations(migrationsDir));

    for (const name of appliedNames) {
      if (reverted.length >= steps) break;
      if (opts.stopBefore && name <= opts.stopBefore) break;
      if (!known.has(name)) {
        throw new Error(`Migration ${name} is recorded as applied but no longer exists on disk; refusing to continue.`);
      }
      const downFile = downFileFor(migrationsDir, name);
      if (!existsSync(downFile)) {
        throw new Error(
          `No reverse migration for ${name} (expected ${path.basename(downFile)}). ` +
            `Write the reverse migration explicitly instead of guessing, or restore from a backup.`,
        );
      }
      const sql = readFileSync(downFile, "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`DELETE FROM _migrations WHERE name = $1`, [name]);
        await client.query("COMMIT");
        reverted.push(name);
        console.log(`[db] reverted migration ${name}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Downgrade ${path.basename(downFile)} failed: ${(err as Error).message}`);
      }
    }
    return reverted;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Migration inventory used by `db:migrate --status`. */
export async function migrationStatus(
  migrationsDir: string,
): Promise<Array<{ name: string; appliedAt: string | null; reversible: boolean }>> {
  const applied = new Map<string, string>();
  try {
    const rows = await q<{ name: string; applied_at: string }>(`SELECT name, applied_at FROM _migrations`);
    for (const row of rows) applied.set(row.name, row.applied_at);
  } catch {
    // No _migrations table yet: nothing has been applied.
  }
  return listMigrations(migrationsDir).map((name) => ({
    name,
    appliedAt: applied.get(name) ?? null,
    reversible: existsSync(downFileFor(migrationsDir, name)),
  }));
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
