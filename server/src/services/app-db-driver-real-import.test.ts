import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("application database driver loading", () => {
  it("loads the real PostgreSQL and Drizzle drivers only when a database is created", () => {
    const entryUrl = new URL("../index.ts", import.meta.url).href;
    const source = `
      import { registerHooks } from "node:module";
      const loaded = new Set();
      const dbInit = new Set();
      const teamsSdk = new Set();
      const deferredDbFiles = new Set([
        "backup-lib.ts", "embedded-postgres-native.ts", "migration-init.ts",
        "migration-inspection.ts", "postgres-maintenance.ts", "test-embedded-postgres.ts",
      ]);
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "@chat-adapter/teams" || specifier.startsWith("@microsoft/teams.")) teamsSdk.add(specifier);
        if (specifier === "postgres" || specifier.includes("/postgres/src/index.js")) loaded.add("postgres");
        if (specifier === "drizzle-orm/postgres-js" || specifier.includes("/drizzle-orm/postgres-js/index.js")) loaded.add("drizzle");
        const result = nextResolve(specifier, context);
        const dbFile = result.url.split("/packages/db/src/")[1];
        if (deferredDbFiles.has(dbFile)) dbInit.add(dbFile);
        return result;
      }});
      await import(${JSON.stringify(entryUrl)});
      if (loaded.size || dbInit.size) throw new Error("database initialization loaded during entry import: " + [...loaded, ...dbInit]);
      if (teamsSdk.size) throw new Error("Teams SDK loaded during entry import: " + [...teamsSdk]);
      const { getEmbeddedPostgresTestSupport } = await import("@myrmidon/db");
      await getEmbeddedPostgresTestSupport();
      if (!dbInit.has("test-embedded-postgres.ts")) throw new Error("test helper did not load on demand");
      const { createStartupDb } = await import("@myrmidon/db/client");
      const db = await createStartupDb("postgres://localhost:5432/unused");
      try {
        if (!loaded.has("postgres") || !loaded.has("drizzle")) {
          throw new Error("database creation did not load both drivers: " + [...loaded]);
        }
        const { PostgresJsDatabase } = await import("drizzle-orm/postgres-js");
        if (!(db instanceof PostgresJsDatabase)) throw new Error("database class identity changed");
      } finally {
        await db.$client.end();
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 130_000);
});
