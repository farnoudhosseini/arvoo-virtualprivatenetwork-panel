import { buildApp } from "./app.js";
import { initDatabase, bootstrap, closeDatabase } from "./bootstrap.js";
import { config } from "./config.js";
import { maybeAutoRotate } from "./services/management-secret.js";

/**
 * Periodic maintenance. The management access secret rotates on its own
 * schedule when the install asks for it (default: every 6 hours), keeping the
 * previous value valid for a grace window so nobody is locked out mid-change.
 * A failure here is logged, never fatal: a broken rotation must not take the
 * control plane down.
 */
function startSchedulers(): NodeJS.Timeout {
  const interval = setInterval(() => {
    void maybeAutoRotate()
      .then((result) => {
        if (result.rotated) console.log("[security] management access secret rotated (scheduled)");
      })
      .catch((err) => console.error("[security] scheduled rotation failed:", (err as Error).message));
  }, 5 * 60 * 1000);
  interval.unref();
  return interval;
}

async function main(): Promise<void> {
  // Migrations MUST complete (and the pool must exist) before bootstrap() runs
  // its first queries and before HTTP traffic is accepted.
  const applied = await initDatabase();
  if (applied > 0) console.log(`[db] ${applied} migration(s) applied`);
  await bootstrap();

  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Arvoo Control Plane listening on http://${config.host}:${config.port}`);
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }

  const scheduler = startSchedulers();

  // Graceful shutdown: systemd sends SIGTERM (TimeoutStopSec), terminals SIGINT.
  // Stop accepting connections, drain in-flight requests, then close the pool.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down...`);
    try {
      clearInterval(scheduler);
      await app.close();
      await closeDatabase();
      process.exit(0);
    } catch (err) {
      console.error("[api] shutdown error:", err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
