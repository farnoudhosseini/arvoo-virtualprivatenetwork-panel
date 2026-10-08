/**
 * CLI: manage the database schema and exit.
 *
 *   npm run db:migrate                        apply every pending migration
 *   npm run db:migrate -- --status            list migrations and their state
 *   npm run db:migrate -- --down 1 --force    revert the newest migration(s)
 *
 * Upgrades are applied automatically at application start; this CLI exists for
 * installation, updates, inspection and the rare, explicit downgrade.
 *
 * Downgrades run the matching `*.down.sql` file and therefore require --force:
 * they can drop tables and rows, and a migration without a reverse file is
 * refused rather than guessed at.
 *
 * Exit code 0 on success, 1 on failure (install.sh / --update rely on it).
 */
import { openDatabaseFromConfig } from "../bootstrap.js";
import { closeDatabase, migrate, migrateDown, migrationStatus } from "./index.js";

function printUsage(): void {
  console.log(
    [
      "Usage: node dist/migrate.js [--status | --down [count] --force]",
      "",
      "  (no arguments)   apply all pending migrations (upgrade)",
      "  --status         show every migration and whether it is applied",
      "  --down [count]   revert the newest `count` migrations (default 1); needs --force",
      "  --force          confirm a destructive downgrade",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const migrationsDir = await openDatabaseFromConfig();

  if (args.includes("--status")) {
    const rows = await migrationStatus(migrationsDir);
    if (rows.length === 0) {
      console.log("[db] no migrations found");
      return;
    }
    for (const row of rows) {
      const state = row.appliedAt ? `applied ${row.appliedAt}` : "pending";
      const reverse = row.reversible ? "reversible" : "no reverse migration";
      console.log(`[db] ${row.name.padEnd(28)} ${state.padEnd(32)} ${reverse}`);
    }
    return;
  }

  const downIndex = args.indexOf("--down");
  if (downIndex !== -1) {
    if (!args.includes("--force")) {
      throw new Error(
        "Reverting migrations can destroy data. Take a backup first (scripts/backup.sh) and re-run with --force.",
      );
    }
    const raw = args[downIndex + 1];
    const steps = raw && /^\d+$/.test(raw) ? Number(raw) : 1;
    if (steps <= 0) throw new Error("--down requires a positive count");

    const reverted = await migrateDown(migrationsDir, { steps });
    console.log(
      reverted.length > 0
        ? `[db] reverted ${reverted.length} migration(s): ${reverted.join(", ")}`
        : "[db] nothing to revert (no applied migrations left)",
    );
    return;
  }

  const applied = await migrate(migrationsDir);
  console.log(applied > 0 ? `[db] ${applied} migration(s) applied` : `[db] schema is up to date`);
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[db] migration failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
