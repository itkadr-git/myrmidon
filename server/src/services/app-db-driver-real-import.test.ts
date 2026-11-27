import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("application startup import graph", () => {
  it("keeps optional dependencies out of entry import and loads them on demand", () => {
    const entryUrl = new URL("../index.ts", import.meta.url).href;
    const animationUrl = new URL("./announcement-animation.ts", import.meta.url).href;
    const discordLoaderUrl = new URL("./discord-adapter-loader.ts", import.meta.url).href;
    const source = `
      import { registerHooks } from "node:module";
      const loaded = new Set();
      const dbInit = new Set();
      const optional = new Set();
      const deferredDbFiles = new Set([
        "backup-lib.ts", "embedded-postgres-native.ts", "migration-init.ts",
        "migration-inspection.ts", "postgres-maintenance.ts", "test-embedded-postgres.ts",
      ]);
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (["jsdom", "@chat-adapter/discord", "@chat-adapter/teams"].includes(specifier) || specifier.startsWith("@microsoft/teams.")) optional.add(specifier);
        if (specifier === "postgres" || specifier.includes("/postgres/src/index.js")) loaded.add("postgres");
        if (specifier === "drizzle-orm/postgres-js" || specifier.includes("/drizzle-orm/postgres-js/index.js")) loaded.add("drizzle");
        const result = nextResolve(specifier, context);
        const dbFile = result.url.split("/packages/db/src/")[1];
        if (deferredDbFiles.has(dbFile)) dbInit.add(dbFile);
        return result;
      }});
      await import(${JSON.stringify(entryUrl)});
      if (loaded.size || dbInit.size) throw new Error("database initialization loaded during entry import: " + [...loaded, ...dbInit]);
      if (optional.size) throw new Error("optional dependencies loaded during entry import: " + [...optional]);
      const { validateAnnouncementAnimation } = await import(${JSON.stringify(animationUrl)});
      await validateAnnouncementAnimation(new TextEncoder().encode("<p>Animation</p>"));
      if (!optional.has("jsdom")) throw new Error("animation validation did not load jsdom on demand");
      const { preloadDiscordAdapter } = await import(${JSON.stringify(discordLoaderUrl)});
      await preloadDiscordAdapter();
      if (!optional.has("@chat-adapter/discord")) throw new Error("Discord loader did not load the SDK on demand");
      const { createStartupDb } = await import("@myrmidon/db/client");
      const db = await createStartupDb("postgres://localhost:5432/unused");
      try {
        if (!loaded.has("postgres") || !loaded.has("drizzle")) {
          throw new Error("database creation did not load both drivers: " + [...loaded]);
        }
        if (dbInit.size) throw new Error("database creation loaded unrelated initialization modules: " + [...dbInit]);
        const { PostgresJsDatabase } = await import("drizzle-orm/postgres-js");
        if (!(db instanceof PostgresJsDatabase)) throw new Error("database class identity changed");
      } finally {
        await db.$client.end();
      }
      const { getEmbeddedPostgresTestSupport } = await import("@myrmidon/db");
      await getEmbeddedPostgresTestSupport();
      if (!dbInit.has("test-embedded-postgres.ts")) throw new Error("test helper did not load on demand");
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
