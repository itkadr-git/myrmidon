import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

const text = (value) => `${JSON.stringify(value, null, 2)}\n`;

test("closure expansion preserves first originals through repeated apply and restore", (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "runtime-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  const a = { name: "@test/a", main: "./src/a.js", exports: { ".": "./src/a.js" }, publishConfig: { main: "./dist/a.js", exports: { ".": "./dist/a.js" } } };
  const b = { name: "@test/b", types: "./src/b.d.ts", publishConfig: { types: "./dist/b.d.ts" } };
  const entry = { name: "@test/entry", dependencies: { "@test/a": "workspace:*" } };
  const originalA = text(a);
  const originalB = text(b);
  const workspace = "packages:\n  - packages/*\n";
  const untouched = "leave these bytes intact\n";
  write("pnpm-workspace.yaml", workspace);
  write("packages/entry/package.json", text(entry));
  write("packages/a/package.json", originalA);
  write("packages/b/package.json", originalB);
  write("packages/entry/keep.txt", untouched);
  fs.mkdirSync(path.join(root, "packages/a/dist"));
  fs.mkdirSync(path.join(root, "packages/b/dist"));
  const backup = "node_modules/.cache/myrmidon-prod-exports/backup.json";
  const recordA = { packageFile: "packages/a/package.json", originalText: originalA, originalFields: { main: a.main, exports: a.exports }, appliedFields: ["main", "exports"] };
  const recordB = { packageFile: "packages/b/package.json", originalText: originalB, originalFields: { types: b.types }, appliedFields: ["types"] };
  const run = (args) => {
    const lines = [];
    const code = main([...args, "--root", root], { log: (line) => lines.push(line), error: (line) => lines.push(line) });
    return { code, lines };
  };
  const apply = () => run(["apply", "--entry", "@test/entry"]);
  const appliedA = text({ ...a, main: a.publishConfig.main, exports: a.publishConfig.exports });
  const appliedB = text({ ...b, types: b.publishConfig.types });

  assert.deepEqual(apply(), { code: 0, lines: ["applied: @test/a (packages/a/package.json)", "skipped (entry package): @test/entry", `apply: 1 package.json rewritten; backup: ${backup}`] });
  assert.deepEqual(JSON.parse(read(backup)), { version: 1, packages: { "@test/a": recordA } });
  assert.equal(read("packages/a/package.json"), appliedA);
  assert.equal(read("packages/b/package.json"), originalB);

  entry.dependencies["@test/b"] = "workspace:*";
  const changedEntry = text(entry);
  write("packages/entry/package.json", changedEntry);
  // Re-select A to verify that an existing record is not replaced by later edits.
  write("packages/a/package.json", text({ ...a, main: "./edited/a.js" }));
  assert.deepEqual(apply(), { code: 0, lines: ["applied: @test/a (packages/a/package.json)", "applied: @test/b (packages/b/package.json)", "skipped (entry package): @test/entry", `apply: 2 package.json rewritten; backup: ${backup}`] });
  const expectedBackup = { version: 1, packages: { "@test/a": recordA, "@test/b": recordB } };
  assert.deepEqual(JSON.parse(read(backup)), expectedBackup);
  assert.equal(read("packages/a/package.json"), appliedA);
  assert.equal(read("packages/b/package.json"), appliedB);
  const backupBytes = read(backup);

  assert.deepEqual(apply(), { code: 0, lines: ["skipped (already serving dist): @test/a", "skipped (already serving dist): @test/b", "skipped (entry package): @test/entry", `apply: 0 package.json rewritten; backup: ${backup}`] });
  assert.equal(read(backup), backupBytes);
  assert.deepEqual(JSON.parse(read(backup)), expectedBackup);
  assert.equal(read("packages/a/package.json"), appliedA);
  assert.equal(read("packages/b/package.json"), appliedB);
  assert.deepEqual(run(["restore"]), { code: 0, lines: ["restored: @test/a (packages/a/package.json)", "restored: @test/b (packages/b/package.json)", "restore: 2 package.json restored from backup; backup removed."] });
  assert.equal(read("packages/a/package.json"), originalA);
  assert.equal(read("packages/b/package.json"), originalB);
  assert.equal(read("packages/entry/package.json"), changedEntry);
  assert.equal(read("packages/entry/keep.txt"), untouched);
  assert.equal(read("pnpm-workspace.yaml"), workspace);
  assert.equal(fs.existsSync(path.join(root, backup)), false);
});
