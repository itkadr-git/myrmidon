import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("application database driver loading", () => {
  it("loads the real PostgreSQL and Drizzle drivers only when a database is created", () => {
    const appUrl = new URL("../app.ts", import.meta.url).href;
    const source = `
      import { registerHooks } from "node:module";
      const loaded = new Set();
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "postgres" || specifier.includes("/postgres/src/index.js")) loaded.add("postgres");
        if (specifier === "drizzle-orm/postgres-js" || specifier.includes("/drizzle-orm/postgres-js/index.js")) loaded.add("drizzle");
        return nextResolve(specifier, context);
      }});
      await import(${JSON.stringify(appUrl)});
      if (loaded.size) throw new Error("drivers loaded during app import: " + [...loaded]);
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
