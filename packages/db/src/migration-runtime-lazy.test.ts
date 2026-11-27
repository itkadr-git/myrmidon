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

it("keeps the application database client and schema out of the status command", () => {
  const statusUrl = new URL("./migration-status.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    const forbidden = new Set(["client.ts", "migration-init.ts", "embedded-postgres-native.ts", "schema/index.ts"]);
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "postgres") {
        const stub = \`export default () => Object.assign(async (parts) => {
          return parts[0].includes("information_schema.tables") ? [{ count: 0 }] : [];
        }, { end: async () => {} });\`;
        return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
      }
      const resolved = nextResolve(specifier, context);
      if (resolved.url.startsWith("file:") && [...forbidden].some((name) => resolved.url.endsWith("/" + name))) {
        throw new Error("migration status loaded " + resolved.url);
      }
      return resolved;
    }});
    process.argv.push("--json");
    await import(${JSON.stringify(statusUrl)});
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: "postgres://localhost:5432/unused" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "needsMigrations",
    reason: "no-migration-journal-empty-db",
  });
}, 35_000);