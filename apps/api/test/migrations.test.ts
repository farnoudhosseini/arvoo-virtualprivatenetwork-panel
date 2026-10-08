/**
 * Migration system: versioned, reproducible, reversible - verified against a
 * real PostgreSQL server and the migrations that ship in production.
 *
 * This file runs its own database instance (separate port) so the destructive
 * downgrade assertions cannot disturb the main API suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./helpers/testdb.js";
import { closeDatabase, migrate, migrateDown, migrationStatus, openDatabase, q } from "../src/db/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_MIGRATIONS = path.resolve(here, "../src/migrations");
const ISOLATED_PORT = 54330;

let db: TestDatabase;
let tempDir: string;

async function tableExists(name: string): Promise<boolean> {
  const rows = await q<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, `public.${name}`);
  return rows[0]?.exists === true;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await q<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS exists`,
    table,
    column,
  );
  return rows[0]?.exists === true;
}

beforeAll(async () => {
  db = await createTestDatabase({ port: ISOLATED_PORT, databaseName: "arvoo_migrations" });
  openDatabase({ url: db.url, max: 4, applicationName: "arvoo-migrations-test" });
  tempDir = mkdtempSync(path.join(tmpdir(), "arvoo-migrations-"));
});

afterAll(async () => {
  await closeDatabase();
  await db.stop();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("shipped migrations", () => {
  it("reports the versioned inventory with reversibility", async () => {
    const rows = await migrationStatus(SHIPPED_MIGRATIONS);
    expect(rows.map((r) => r.name)).toContain("0001_init.sql");
    expect(rows.map((r) => r.name)).toContain("0003_routing_intelligence.sql");
    const initial = rows.find((r) => r.name === "0001_init.sql")!;
    expect(initial.appliedAt).toBeNull();
    expect(initial.reversible).toBe(true);
    const routing = rows.find((r) => r.name === "0003_routing_intelligence.sql")!;
    expect(routing.reversible).toBe(true);
    const management = rows.find((r) => r.name === "0004_full_management.sql")!;
    expect(management.reversible).toBe(true);
  });

  it("applies, reverts and re-applies the initial schema (reproducible)", async () => {
    const applied = await migrate(SHIPPED_MIGRATIONS);
    expect(applied).toBe(4);
    expect(await tableExists("nodes")).toBe(true);
    expect(await tableExists("clients")).toBe(true);
    expect(await tableExists("tunnel_secrets")).toBe(true);
    expect(await tableExists("path_health")).toBe(true);
    expect(await tableExists("transport_health")).toBe(true);
    expect(await tableExists("client_assignments")).toBe(true);
    expect(await tableExists("routing_events")).toBe(true);
    expect(await tableExists("routing_policies")).toBe(true);
    expect(await tableExists("node_endpoints")).toBe(true);
    // §38/§39/§40/§41 schema: client identity columns, domain results, firewall
    // state and load-balancing tables.
    expect(await tableExists("firewall_state")).toBe(true);
    expect(await tableExists("firewall_applies")).toBe(true);
    expect(await tableExists("lb_groups")).toBe(true);
    expect(await tableExists("lb_members")).toBe(true);
    expect(await columnExists("clients", "ovpn_username")).toBe(true);
    expect(await columnExists("clients", "preferred_node_id")).toBe(true);
    expect(await columnExists("inbounds", "domain_status")).toBe(true);
    expect(await columnExists("nodes", "ssh_port")).toBe(true);

    // Re-running applies nothing: the runner is idempotent.
    expect(await migrate(SHIPPED_MIGRATIONS)).toBe(0);

    // Downgrade of the newest migration removes only its own objects.
    expect(await migrateDown(SHIPPED_MIGRATIONS, { steps: 1 })).toEqual(["0004_full_management.sql"]);
    expect(await tableExists("lb_groups")).toBe(false);
    expect(await tableExists("firewall_applies")).toBe(false);
    expect(await columnExists("clients", "ovpn_username")).toBe(false);
    expect(await columnExists("inbounds", "domain_status")).toBe(false);
    expect(await tableExists("clients")).toBe(true);
    expect(await tableExists("path_health")).toBe(true);

    // The routing migration reverts on its own after that.
    const routingReverted = await migrateDown(SHIPPED_MIGRATIONS, { steps: 1 });
    expect(routingReverted).toEqual(["0003_routing_intelligence.sql"]);
    expect(await tableExists("routing_policies")).toBe(false);
    expect(await tableExists("path_health")).toBe(false);
    expect(await tableExists("node_endpoints")).toBe(false);
    expect(await tableExists("tunnel_secrets")).toBe(true);
    expect(await tableExists("nodes")).toBe(true);

    // The encapsulation migration still reverts on its own.
    const encapReverted = await migrateDown(SHIPPED_MIGRATIONS, { steps: 1 });
    expect(encapReverted).toEqual(["0002_tunnel_encap_capabilities.sql"]);
    expect(await tableExists("tunnel_secrets")).toBe(false);
    expect(await tableExists("tunnel_meshes")).toBe(false);
    expect(await tableExists("nodes")).toBe(true);

    // Downgrade of the initial schema clears what it created.
    expect(await migrateDown(SHIPPED_MIGRATIONS, { steps: 1 })).toEqual(["0001_init.sql"]);
    expect(await tableExists("nodes")).toBe(false);
    expect(await tableExists("users")).toBe(false);
    expect((await migrationStatus(SHIPPED_MIGRATIONS))[0]!.appliedAt).toBeNull();

    // ...and the schema can be rebuilt exactly the same way.
    expect(await migrate(SHIPPED_MIGRATIONS)).toBe(4);
    expect(await tableExists("nodes")).toBe(true);
    expect(await tableExists("routing_policies")).toBe(true);
    expect(await tableExists("lb_members")).toBe(true);
    expect(await columnExists("clients", "ovpn_username")).toBe(true);
  });

  it("refuses to revert a migration that has no reverse file", async () => {
    // The previous test leaves the shipped schema applied. Revert it so the
    // scratch inventory is the only one in the migration table.
    while ((await migrationStatus(SHIPPED_MIGRATIONS)).some((r) => r.appliedAt)) {
      await migrateDown(SHIPPED_MIGRATIONS, { steps: 1 });
    }
    const dir = path.join(tempDir, "partial");
    mkdirSync(dir, { recursive: true });
    // A second migration in a scratch directory without a .down.sql file.
    writeFileSync(path.join(dir, "0001_only.sql"), "CREATE TABLE IF NOT EXISTS only_forward (id TEXT PRIMARY KEY);");
    writeFileSync(path.join(dir, "0001_only.down.sql"), "DROP TABLE IF EXISTS only_forward;");
    writeFileSync(path.join(dir, "0002_forever.sql"), "CREATE TABLE IF NOT EXISTS only_forward_2 (id TEXT PRIMARY KEY);");

    expect(await migrate(dir)).toBe(2);
    await expect(migrateDown(dir, { steps: 1 })).rejects.toThrow(/No reverse migration for 0002_forever\.sql/);

    // Clean up the scratch migration state so the database stays consistent.
    await q(`DELETE FROM _migrations WHERE name IN ($1, $2)`, "0001_only.sql", "0002_forever.sql");
    await q(`DROP TABLE IF EXISTS only_forward, only_forward_2`);
  });
});
