import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("resolves an external migration target without loading embedded Postgres setup", () => {
  const runtimeUrl = new URL("./migration-runtime.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    const hooks = registerHooks({ load(url, context, nextLoad) {
      if (new URL(url).pathname.split("/").at(-1) === "embedded-postgres-native.ts") {
        throw new Error("external migration target loaded embedded Postgres setup");
      }
      return nextLoad(url, context);
    }});
    try {
      const { resolveMigrationConnection } = await import(${JSON.stringify(runtimeUrl)});
      const target = await resolveMigrationConnection();
      if (target.connectionString !== process.env.DATABASE_URL) throw new Error("wrong migration target");
      await target.stop();
    } finally {
      hooks.deregister();
    }
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: "postgres://localhost:5432/unused" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 35_000);