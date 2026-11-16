import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanModuleBoundaries } from "./check-module-boundaries.mjs";

const databaseReason = "domain cannot import database packages";
const outerReason = "domain cannot import server services, routes, or adapters";
const cases = [
  ["@myrmidon/db", databaseReason],
  ["@myrmidon/db/schema", databaseReason],
  ["drizzle-orm", databaseReason],
  ["drizzle-orm/sql", databaseReason],
  ["embedded-postgres", databaseReason],
  ["embedded-postgres/client", databaseReason],
  ["postgres", databaseReason],
  ["postgres/types", databaseReason],
  ["node:fs", "domain cannot import Node.js runtime modules"],
  ["../../../services/example.js", outerReason],
  ["../../../routes/example.js", outerReason],
  ["../../../adapters/example.js", outerReason],
  ["../adapters/example.js", outerReason],
  ["../application/example.js", "domain cannot depend on outer module layers"],
  ["postgres-helper", null],
  ["@myrmidon/db-extra", null],
  ["./policy.js", null],
];

for (const [specifier, reason] of cases) {
  test(`domain import ${specifier}: ${reason ?? "allowed"}`, (t) => {
    const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), "cache", "scratch");
    mkdirSync(scratch, { recursive: true });
    const serverSrc = mkdtempSync(join(scratch, "module-domain-matrix-"));
    t.after(() => rmSync(serverSrc, { recursive: true, force: true }));
    const modulesRoot = join(serverSrc, "modules");
    const source = join(modulesRoot, "watchdog", "domain", "policy.ts");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, `import ${JSON.stringify(specifier)};\n`);
    const violations = scanModuleBoundaries({ serverSrc, modulesRoot });
    assert.equal(violations.length, reason === null ? 0 : 1);
    assert.deepEqual(violations.map(({ layer, specifier: found, reason: why }) => ({ layer, specifier: found, reason: why })),
      reason === null ? [] : [{ layer: "domain", specifier, reason }]);
  });
}
