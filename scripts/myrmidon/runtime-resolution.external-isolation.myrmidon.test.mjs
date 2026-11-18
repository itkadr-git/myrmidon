import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures } from "./check-prod-runtime-resolution.mjs";

const externalImports = [
  'import "node:fs";',
  'import "fs";',
  'import "external-uninstalled-package";',
  'import "@vendor/tool/subpath";',
  'export * from "node:fs";',
  'export * from "fs";',
  'export * from "external-uninstalled-package";',
  'export * from "@vendor/tool/subpath";',
  'import("node:fs");',
  'import("fs");',
  'import("external-uninstalled-package");',
  'import("@vendor/tool/subpath");',
].join("\n");

test("external imports stay isolated while reached workspace failures are reported without execution", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "external-isolation-"));
  try {
    const dist = path.join(dir, "server", "dist");
    const pkg = path.join(dir, "node_modules", "@myrmidon", "fixture");
    const entry = path.join(pkg, "dist", "index.js");
    const sentinel = path.join(dir, "executed");
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
      name: "@myrmidon/fixture", type: "module", exports: "./dist/index.js",
    }));
    fs.writeFileSync(path.join(dist, "index.js"), `${externalImports}\nimport "@myrmidon/fixture";\n`);
    const packageBody = `${externalImports}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "executed");\nthrow new Error("fixture executed");\n`;
    fs.writeFileSync(entry, `${packageBody}import "@myrmidon/absent/subpath";\n`);

    assert.deepEqual(collectFailures(dist), [{
      file: entry,
      line: 16,
      specifier: "@myrmidon/absent/subpath",
      reason: "пакет не найден в node_modules",
      packageName: "@myrmidon/absent",
    }]);
    assert.equal(fs.existsSync(sentinel), false);

    fs.writeFileSync(entry, packageBody);
    assert.deepEqual(collectFailures(dist), []);
    assert.equal(fs.existsSync(sentinel), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
