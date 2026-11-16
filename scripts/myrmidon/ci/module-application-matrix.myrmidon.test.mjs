import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanModuleBoundaries } from "../../check-module-boundaries.mjs";

const database = "application cannot import database packages";
const adapters = "application cannot import concrete adapters";
const server = "application cannot import server services or routes";
const errors = "application cannot import HTTP error helpers";

const cases = [
  ["@myrmidon/db", database],
  ["@myrmidon/db/schema", database],
  ["drizzle-orm", database],
  ["drizzle-orm/pg-core", database],
  ["embedded-postgres", database],
  ["embedded-postgres/client", database],
  ["postgres", database],
  ["postgres/types", database],
  ["../adapters/postgres.js", adapters],
  ["../../../adapters/client.js", adapters],
  ["../../../services/example.js", server],
  ["../../../routes/example.js", server],
  ["../../../errors.js", errors],
  ["../../../errors.ts", errors],
  ["../domain/policy.js", null],
  ["node:fs", null],
  ["../../../errors-helper.js", null],
  ["../../../other/errors.js", null],
  ["../../../services-helper/example.js", null],
  ["../../../routes-extra/example.js", null],
  ["../../../adapters-extra/example.js", null],
  ["postgres-helper", null],
  ["@myrmidon/db-extra", null],
];

test("application import boundaries enforce exact paths and reasons", (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), "cache/scratch");
  mkdirSync(scratch, { recursive: true });
  const serverSrc = mkdtempSync(join(scratch, "application-matrix-"));
  t.after(() => rmSync(serverSrc, { recursive: true, force: true }));
  const modulesRoot = join(serverSrc, "modules");
  const application = join(modulesRoot, "example/application");
  mkdirSync(application, { recursive: true });
  writeFileSync(join(application, "run.ts"), cases.map(([specifier]) => `import ${JSON.stringify(specifier)};`).join("\n"));

  const violations = scanModuleBoundaries({ serverSrc, modulesRoot });
  assert.deepEqual(
    violations.map(({ layer, specifier, reason }) => ({ layer, specifier, reason })),
    cases.filter(([, reason]) => reason !== null).map(([specifier, reason]) => ({ layer: "application", specifier, reason })),
  );
});
