import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reads migration metadata without loading database migration execution", () => {
  const clientUrl = new URL("./client.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "postgres" || specifier.endsWith("/migration-init.js")) {
        throw new Error("migration metadata loaded " + specifier);
      }
      return nextResolve(specifier, context);
    }});
    try {
      const { listMigrationChain } = await import(${JSON.stringify(clientUrl)});
      if ((await listMigrationChain()).length === 0) throw new Error("empty migration chain");
    } finally {
      hooks.deregister();
    }
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 35_000);
