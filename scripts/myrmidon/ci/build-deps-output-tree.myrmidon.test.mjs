import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "build-output-tree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `
const fs = require('node:fs');
const path = require('node:path');
const target = path.dirname(process.argv[3]);
fs.appendFileSync('builds', path.relative(process.cwd(), target) + '\\n');
fs.mkdirSync(path.join(target, 'dist/nested'), { recursive: true });
fs.writeFileSync(path.join(target, 'dist/index.js'), 'index\\n');
fs.writeFileSync(path.join(target, 'dist/nested/output.js'), 'original');
`);
  for (const target of ["packages/shared", "packages/plugins/sdk"]) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const run = () => {
    const result = spawnSync(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], {
      cwd: root, env: { ...process.env, TMPDIR: root }, encoding: "utf8", timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const log = () => fs.readFileSync(path.join(root, "builds"), "utf8");
  return { root, run, log, dist: path.join(root, "packages/plugins/sdk/dist") };
}

const scenarios = {
  add(dist) { fs.writeFileSync(path.join(dist, "nested/extra.js"), "extra"); },
  change(dist) { fs.writeFileSync(path.join(dist, "nested/output.js"), "changed!"); },
  delete(dist) { fs.unlinkSync(path.join(dist, "nested/output.js")); },
  rename(dist) { fs.renameSync(path.join(dist, "nested/output.js"), path.join(dist, "nested/renamed.js")); },
  "same size and mtime"(dist) {
    const file = path.join(dist, "nested/output.js");
    const fixed = new Date(1_700_000_000_000);
    fs.utimesSync(file, fixed, fixed);
    const before = fs.statSync(file);
    fs.writeFileSync(file, "modified");
    fs.utimesSync(file, before.atime, before.mtime);
    assert.equal(fs.statSync(file).size, before.size);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  },
};

for (const [name, mutate] of Object.entries(scenarios)) {
  test(`SDK nested output ${name} triggers exactly one rebuild`, (t) => {
    const f = fixture(t);
    const initial = f.run();
    assert.match(initial, /Building @myrmidon\/shared/);
    assert.match(initial, /Building @myrmidon\/plugin-sdk/);
    const baseline = "packages/shared\npackages/plugins/sdk\n";
    assert.equal(f.log(), baseline);
    assert.equal(f.run(), "");
    const index = fs.readFileSync(path.join(f.dist, "index.js"));
    mutate(f.dist);
    assert.deepEqual(fs.readFileSync(path.join(f.dist, "index.js")), index);
    const output = f.run();
    assert.equal(output, "[paperclip] Building @myrmidon/plugin-sdk...\n");
    assert.equal(f.log(), baseline + "packages/plugins/sdk\n");
    assert.deepEqual(fs.readFileSync(path.join(f.dist, "index.js")), index);
    assert.equal(f.run(), "");
    assert.equal(f.log(), baseline + "packages/plugins/sdk\n");
  });
}

test("timestamp-only changes do not rebuild", (t) => {
  const f = fixture(t);
  f.run();
  const baseline = f.log();
  for (const file of ["index.js", "nested/output.js"]) {
    const target = path.join(f.dist, file);
    const time = new Date(Date.now() + 60000);
    fs.utimesSync(target, time, time);
  }
  assert.equal(f.run(), "");
  assert.equal(f.log(), baseline);
});
