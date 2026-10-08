import bcrypt from "bcryptjs";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDatabase, migrate, closeDatabase, run, q1, uuid, nowIso } from "./db/index.js";
import { config, jwtSecret, setJwtSecret, assertProductionConfig } from "./config.js";
import { randomToken } from "./lib/crypto.js";
import { getSetting, setSetting } from "./services/settings.js";

/**
 * Locate the versioned SQL migrations that ship with the application.
 * When bundled with esbuild, __dirname no longer points at src, so the
 * repo-layout path is used as a fallback (and ARVOO_MIGRATIONS_DIR wins).
 */
export function resolveMigrationsDir(): string {
  let migrationsDir = config.migrationsDir;
  if (!existsSync(migrationsDir)) {
    migrationsDir = path.resolve(process.cwd(), "apps/api/src/migrations");
  }
  if (!existsSync(migrationsDir)) {
    throw new Error(
      `Migrations directory not found (looked at "${config.migrationsDir}" and "${migrationsDir}"). ` +
        `Set ARVOO_MIGRATIONS_DIR.`,
    );
  }
  return migrationsDir;
}

/**
 * Open the PostgreSQL pool without touching the schema.
 * Returns the directory the migration CLI should work against.
 */
export async function openDatabaseFromConfig(): Promise<string> {
  const migrationsDir = resolveMigrationsDir();
  openDatabase({
    url: config.databaseUrl,
    max: config.poolMax,
    applicationName: "arvoo-api",
  });
  return migrationsDir;
}

/**
 * Open the PostgreSQL pool and apply pending migrations.
 * Returns the number of migrations applied.
 */
export async function initDatabase(): Promise<number> {
  const migrationsDir = await openDatabaseFromConfig();
  return migrate(migrationsDir);
}

/**
 * Load the session signing secret from its single source of truth and apply it
 * to the running process. Startup calls this; rotation calls it again after
 * writing the new value, so there is exactly one way the secret ever reaches
 * the signer (spec §24).
 */
export async function loadSessionSecretFromStore(): Promise<void> {
  const stored = await getSetting("security.jwtSecret");
  if (stored) {
    setJwtSecret(stored);
    return;
  }
  const secret = randomToken(48);
  await setSetting("security.jwtSecret", secret);
  setJwtSecret(secret);
}

export async function bootstrap(): Promise<void> {
  // Fail fast in production when required secrets are missing.
  const existingAdmin = await q1<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  assertProductionConfig(Boolean(existingAdmin));

  // JWT secret: persisted per installation.
  if (!jwtSecret()) {
    await loadSessionSecretFromStore();
  }

  // Seed roles/permissions reference rows
  const roles: Array<[string, string]> = [
    ["admin", "Full control of the Arvoo platform"],
    ["operator", "Manage infrastructure and clients, no user administration"],
    ["viewer", "Read-only access"],
  ];
  for (const [name, description] of roles) {
    await run(
      `INSERT INTO roles (id, name, description) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING`,
      uuid(),
      name,
      description,
    );
  }

  // Bootstrap admin
  if (!existingAdmin) {
    const id = uuid();
    const now = nowIso();
    await run(
      `INSERT INTO users (id, username, password_hash, display_name, role, active, created_at, updated_at)
       VALUES (?,?,?,?,?,1,?,?)`,
      id,
      config.bootstrapAdminUser,
      bcrypt.hashSync(config.bootstrapAdminPassword, 10),
      "Arvoo Administrator",
      "admin",
      now,
      now,
    );
    console.log(
      `[bootstrap] created admin user "${config.bootstrapAdminUser}" (change the default password after first login)`,
    );
  }
}

export { closeDatabase };
