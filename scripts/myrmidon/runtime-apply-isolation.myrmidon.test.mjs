import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const src = { ".": "./src/index.js" };
const dist = { ".": "./dist/index.js" };

function snapshot(root, dir = root) {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(root, file)) : [[path.relative(root, file), fs.readFileSync(file)]];
  }));
}

test("apply limits its write and backup sets to selected runtime dependencies", async (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "runtime-apply-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, contents) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  };
  const manifests = {
    entry: { name: "@test/entry", exports: src, publishConfig: { exports: dist }, dependencies: { "@test/b": "workspace:*", "@test/c": "workspace:*", "@test/e": "^1.0.0", "external-f": "^1.0.0" }, optionalDependencies: { "@test/a": "workspace:*" }, devDependencies: { "@test/d": "workspace:*" } },
    a: { name: "@test/a", exports: src, publishConfig: { exports: dist } },
    b: { name: "@test/b", exports: dist, publishConfig: { exports: dist } },
    c: { name: "@test/c", exports: src },
    d: { name: "@test/d", exports: src, publishConfig: { exports: dist } },
    e: { name: "@test/e", exports: src, publishConfig: { exports: dist } },
  };
  put("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put("sentinel.bin", Buffer.from([0, 255, 10, 42]));
  for (const [name, manifest] of Object.entries(manifests)) {
    put(`packages/${name}/package.json`, json(manifest));
    put(`packages/${name}/dist/sentinel.bin`, Buffer.from([name.charCodeAt(0), 0, 255]));
  }
  put("node_modules/external-f/package.json", json({ name: "external-f", exports: src, publishConfig: { exports: dist } }));
  put("node_modules/external-f/sentinel.bin", Buffer.from([255, 0, 70]));
  const before = snapshot(root);
  const lines = [];
  const errors = [];
  const code = main(["apply", "--entry", "@test/entry", "--root", root], { log: (line) => lines.push(line), error: (line) => errors.push(line) });
  const after = snapshot(root);
  const backup = "node_modules/.cache/myrmidon-prod-exports/backup.json";

  await t.test("apply returns success and reports the exact selected and skipped packages", () => {
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(lines, [
      "applied: @test/a (packages/a/package.json)",
      "skipped (already serving dist): @test/b",
      "skipped (no publishConfig main/types/exports): @test/c",
      "skipped (entry package): @test/entry",
      `apply: 1 package.json rewritten; backup: ${backup}`,
    ]);
  });
  await t.test("optional-only A is rewritten to the exact publish manifest", () => {
    assert.deepEqual(after["packages/a/package.json"], Buffer.from(json({ ...manifests.a, exports: dist })));
    assert.notDeepEqual(after["packages/a/package.json"], before["packages/a/package.json"]);
  });
  await t.test("backup contains exactly A and its original bytes", () => {
    assert.deepEqual(JSON.parse(after[backup].toString()), {
      version: 1,
      packages: { "@test/a": { packageFile: "packages/a/package.json", originalText: before["packages/a/package.json"].toString(), originalFields: { exports: src }, appliedFields: ["exports"] } },
    });
  });
  for (const [name, file] of Object.entries({ "already-dist B": "packages/b/package.json", "no-publish C": "packages/c/package.json", "dev-only D": "packages/d/package.json", "npm-spec E": "packages/e/package.json", "external F": "node_modules/external-f/package.json", entry: "packages/entry/package.json" })) {
    await t.test(`${name} remains byte-identical`, () => assert.deepEqual(after[file], before[file]));
  }
  await t.test("all other files and sentinels remain byte-identical", () => {
    const expected = { ...before, "packages/a/package.json": Buffer.from(json({ ...manifests.a, exports: dist })), [backup]: after[backup] };
    assert.deepEqual(after, expected);
  });
});
