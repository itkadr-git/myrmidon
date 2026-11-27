import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("validates database maintenance requests without loading migration code or drivers", () => {
  const entry = new URL("./client.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const { ensurePostgresDatabase, resetPostgresDatabase } = await import(${JSON.stringify(entry)});
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "postgres" || /(?:^|\\/)migration-init\\.[jt]s$/.test(specifier)) {
        throw new Error("maintenance loaded " + specifier);
      }
      return nextResolve(specifier, context);
    }});
    try {
      await assert.rejects(ensurePostgresDatabase("", "invalid-name"), /Unsafe database name/);
      await assert.rejects(resetPostgresDatabase("", "invalid-name"), /Unsafe SQL identifier/);
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
