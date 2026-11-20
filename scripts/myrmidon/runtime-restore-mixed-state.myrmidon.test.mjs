import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "runtime-restore-mixed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const originalA = '{\r\n\t"name" : "@test/a",\r\n  "main": "./src.js"\r\n}\r\n';
  const originalB = '{ "name": "@test/b", "main": "./src.js" }\n';
  const originalC = '{"name":"@test/c","main":"./src.js"}\n';
  const files = ["packages/a/package.json", "packages/b/package.json", "packages/c/package.json"];
  const backup = "node_modules/.cache/myrmidon-prod-exports/backup.json";
  const records = Object.fromEntries([originalA, originalB, originalC].map((originalText, i) => [
    `@test/${"abc"[i]}`,
    { packageFile: files[i], originalText, originalFields: { main: "./src.js" }, appliedFields: ["main"] },
  ]));
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(files[0], '{"name":"@test/a","main":"./dist.js"}\n');
  write(files[1], originalB);
  mkdirSync(join(root, "packages/c"), { recursive: true });
  write("packages/a/keep.bin", Buffer.from([0, 255, 10, 13]));
  write("packages/other/package.json", '{ "untouched": true }\r\n');
  write(backup, JSON.stringify({ version: 1, packages: records }));
  return { root, files, backup, originalA, originalB };
}

function restore(root) {
  const lines = [];
  const errors = [];
  const code = main(["restore", "--root", root], {
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  return { code, lines, errors };
}

function snapshot(root, files) {
  return Object.fromEntries(files.map((file) => [file, existsSync(join(root, file)) ? readFileSync(join(root, file)) : null]));
}

test("restore handles changed, already-original, and missing manifests in one backup", (t) => {
  const { root, files, backup, originalA, originalB } = fixture(t);
  const untouched = ["pnpm-workspace.yaml", "packages/a/keep.bin", "packages/other/package.json"];
  const before = snapshot(root, untouched);
  assert.deepEqual(restore(root), {
    code: 0,
    lines: [
      "restored: @test/a (packages/a/package.json)",
      "not restored (file gone): @test/c (packages/c/package.json)",
      "restore: 1 package.json restored from backup; backup removed.",
    ],
    errors: [],
  });
  assert.deepEqual(snapshot(root, [...files, backup]), {
    [files[0]]: Buffer.from(originalA),
    [files[1]]: Buffer.from(originalB),
    [files[2]]: null,
    [backup]: null,
  });
  assert.deepEqual(snapshot(root, untouched), before);

});

test("repeated restore reports no backup and leaves every fixture byte unchanged", (t) => {
  const { root, files, backup } = fixture(t);
  assert.equal(restore(root).code, 0);
  const paths = [...files, backup, "pnpm-workspace.yaml", "packages/a/keep.bin", "packages/other/package.json"];
  const after = snapshot(root, paths);
  assert.deepEqual(restore(root), { code: 0, lines: ["no backup: nothing to restore"], errors: [] });
  assert.deepEqual(snapshot(root, paths), after);
});
