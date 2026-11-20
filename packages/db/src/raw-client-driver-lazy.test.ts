import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("raw PostgreSQL client imports", () => {
  it("does not load the Drizzle postgres driver for a raw client", () => {
    const clientUrl = new URL("./client.ts", import.meta.url).href;
    const source = `
      import { registerHooks } from "node:module";
      let drizzleLoaded = false;
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier.includes("drizzle-orm/postgres-js")) drizzleLoaded = true;
        return nextResolve(specifier, context);
      }});
      const { createPostgresJsClient } = await import(${JSON.stringify(clientUrl)});
      const client = createPostgresJsClient("postgres://localhost:5432/unused");
      await client.end();
      if (drizzleLoaded) throw new Error("raw client loaded the Drizzle postgres driver");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 40_000);
});
