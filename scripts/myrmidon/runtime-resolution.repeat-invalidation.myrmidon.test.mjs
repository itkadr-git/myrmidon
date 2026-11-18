import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectFailures } from "./check-prod-runtime-resolution.mjs";

function snapshot(root) {
  const entries = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) {
        entries.push([relative, "directory"]);
        visit(file);
      } else if (entry.isFile()) {
        entries.push([relative, fs.readFileSync(file).toString("base64")]);
      } else {
        throw new Error(`Unexpected fixture entry: ${relative}`);
      }
    }
  }
  visit(root);
  return entries;
}

test("repeat audits observe file and manifest changes without modifying the fixture", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "resolution-repeat-"));
  try {
    const dist = path.join(root, "server", "dist");
    const pkg = path.join(root, "node_modules", "@myrmidon", "fixture");
    const pkgDist = path.join(pkg, "dist");
    const server = path.join(dist, "index.js");
    const first = path.join(pkgDist, "first.js");
    const second = path.join(pkgDist, "second.js");
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(pkgDist, { recursive: true });
    const manifest = (target) => fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@myrmidon/fixture", version: "1.0.0", type: "module", exports: { ".": `./dist/${target}` } }));
    const audit = (expected) => {
      const before = snapshot(root);
      const result = collectFailures(dist);
      assert.deepEqual(snapshot(root), before, "audit must not change fixture bytes or entries");
      assert.deepEqual(result, expected);
      return result;
    };
    const missing = (file, specifier) => [{ file, line: 1, specifier, reason: "пакет не найден в node_modules", packageName: specifier }];
    fs.writeFileSync(server, 'import "@myrmidon/fixture";\n');
    fs.writeFileSync(first, "export const value = 1;\n");
    fs.writeFileSync(second, 'import "@myrmidon/new-absent";\n');
    manifest("first.js");

    const initial = audit([]);
    fs.writeFileSync(first, 'import "@myrmidon/absent";\n');
    const originalFailure = audit(missing(first, "@myrmidon/absent"));
    fs.writeFileSync(first, "export const value = 2;\n");
    audit([]);
    fs.rmSync(first);
    audit([{ file: server, line: 1, specifier: "@myrmidon/fixture", reason: "файл не собран", packageName: "@myrmidon/fixture" }]);
    fs.writeFileSync(first, "export const value = 3;\n");
    audit([]);

    fs.writeFileSync(first, 'import "@myrmidon/old-absent";\n');
    audit(missing(first, "@myrmidon/old-absent"));
    manifest("second.js");
    audit(missing(second, "@myrmidon/new-absent"));
    fs.writeFileSync(second, "export const value = 4;\n");
    audit([]);
    assert.deepEqual(initial, []);
    assert.deepEqual(originalFailure, missing(first, "@myrmidon/absent"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
