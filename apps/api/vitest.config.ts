import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The API suite boots a real PostgreSQL server (embedded-postgres dev
    // dependency) and runs the shipped SQL migrations against it, so the tests
    // exercise the exact production stack: node-postgres, the `?` -> `$n`
    // placeholder translation and the migration runner.
  },
});
