import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// .env loader (dev convenience; production is configured through the systemd
// EnvironmentFile, which populates process.env before the process starts).
// Existing process.env values always win.
// ---------------------------------------------------------------------------

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  try {
    const text = readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // Never fail startup because of a malformed .env line; validation of
    // required values happens below.
  }
}

loadDotEnv();

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const appEnv = env("APP_ENV", "development");

/**
 * PostgreSQL connection string.
 * Required, e.g. postgresql://arvoo_user:STRONG_PASSWORD@127.0.0.1:5432/arvoo
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in .env (see .env.example), e.g. " +
        "postgresql://arvoo_user:password@127.0.0.1:5432/arvoo",
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error("DATABASE_URL must be a postgresql:// connection string");
  }
  return url;
}

export const config = {
  appEnv,
  isProduction: appEnv === "production",
  port: Number(env("PORT", "4001")),
  host: env("HOST", "127.0.0.1"),
  /** PostgreSQL connection string (lazy: validated on first use). */
  get databaseUrl(): string {
    return databaseUrl();
  },
  /** PostgreSQL connection pool size. */
  poolMax: Number(env("ARVOO_POOL_MAX", "10")),
  migrationsDir: env("ARVOO_MIGRATIONS_DIR", path.resolve(__dirname, "migrations")),
  /** AES-256-GCM master key material for secret encryption at rest. */
  appSecret: env("ARVOO_APP_SECRET", ""),
  jwtTtlSec: Number(env("ARVOO_JWT_TTL_SEC", String(12 * 3600))),
  /**
   * Idle window: a session that has not been refreshed within this many
   * seconds is rejected, independently of the absolute lifetime above. The
   * panel refreshes as the window nears its end, so an active operator is
   * never logged out mid-task.
   */
  sessionIdleSec: Number(env("ARVOO_SESSION_IDLE_SEC", String(30 * 60))),
  corsOrigins: env("ARVOO_CORS_ORIGINS", "http://localhost:5173").split(",").map((s) => s.trim()),
  bootstrapAdminUser: env("ARVOO_ADMIN_USER", "admin"),
  bootstrapAdminPassword: env("ARVOO_ADMIN_PASSWORD", "arvoo-admin"),
  /** Seconds without heartbeat before a node is considered offline. */
  heartbeatOfflineSec: Number(env("ARVOO_HEARTBEAT_OFFLINE_SEC", "90")),
  /** Health sample retention (days). */
  healthRetentionDays: Number(env("ARVOO_HEALTH_RETENTION_DAYS", "14")),
  logLevel: env("LOG_LEVEL", "info"),
  agent: {
    heartbeatIntervalSec: 15,
    enrollmentTokenTtlMin: 10,
  },
};

/**
 * Fail fast in production when a required secret is missing, instead of
 * silently falling back to a development default.
 */
export function assertProductionConfig(adminExists: boolean): void {
  if (!config.isProduction) return;
  const problems: string[] = [];
  if (!config.appSecret) {
    problems.push("ARVOO_APP_SECRET is not set (generate: openssl rand -hex 32)");
  }
  if (!adminExists && config.bootstrapAdminPassword === "arvoo-admin") {
    problems.push("ARVOO_ADMIN_PASSWORD is not set and no admin account exists yet");
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join("\n  - ")}`);
  }
}

/** JWT secret: env or persisted generated value. */
let cachedJwtSecret: string | null = null;

/**
 * Session cookies are marked Secure whenever the control plane is actually
 * served over TLS. Behind the bundled nginx that is the production case; a
 * plain-HTTP address cannot set Secure cookies at all, so the flag follows the
 * transport instead of being hardcoded in either direction.
 */
export function cookiesSecure(requestProto?: string): boolean {
  if (config.isProduction) return true;
  return requestProto === "https";
}

export function jwtSecret(): string {
  if (config.appSecret) return config.appSecret;
  if (cachedJwtSecret) return cachedJwtSecret;
  // Generated per-installation and persisted via settings service by bootstrap.
  cachedJwtSecret = env("ARVOO_JWT_SECRET", "");
  return cachedJwtSecret;
}

export function setJwtSecret(secret: string): void {
  cachedJwtSecret = secret;
}
