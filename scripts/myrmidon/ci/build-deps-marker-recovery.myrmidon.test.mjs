import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const targets = ["packages/shared", "packages/plugins/sdk"];
const names = ["@myrmidon/shared", "@myrmidon/plugin-sdk"];

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "marker-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `const fs = require('node:fs');
const path = require('node:path');
const target = path.dirname(process.argv[3]);
fs.appendFileSync('builds', path.relative(process.cwd(), target) + '\\n');
fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
fs.writeFileSync(path.join(target, 'dist/index.js'), 'export {};\\n');
fs.writeFileSync(path.join(target, 'dist/complete'), 'done');
`);
  for (const target of targets) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const marker = (index) => path.join(root, targets[index], "dist/.paperclip-build-complete");
  const readMarker = (index) => fs.readFileSync(marker(index), "utf8");
  const builds = () => fs.readFileSync(path.join(root, "builds"), "utf8");
  const run = (expected) => {
    const result = spawnSync(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], {
      cwd: root, env: { ...process.env, TMPDIR: root }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected.map((i) => `[paperclip] Building ${names[i]}...\n`).join(""));
    assert.equal(fs.existsSync(path.join(root, "node_modules/.cache/paperclip-plugin-build-deps.lock")), false);
  };
  return { root, marker, readMarker, builds, run };
}

const corruptions = {
  missing: (file) => fs.unlinkSync(file),
  "invalid JSON": (file) => fs.writeFileSync(file, "{invalid"),
  "empty object": (file) => fs.writeFileSync(file, "{}"),
  "wrong sources hash": (file, valid) => fs.writeFileSync(file, JSON.stringify({ ...valid, sources: "0".repeat(64) })),
  "wrong outputs hash": (file, valid) => fs.writeFileSync(file, JSON.stringify({ ...valid, outputs: "0".repeat(64) })),
};

for (const [index, target] of targets.entries()) {
  for (const [label, corrupt] of Object.entries(corruptions)) {
    test(`${target}: ${label} marker causes only that target to rebuild`, (t) => {
      const f = fixture(t);
      f.run([0, 1]);
      const original = targets.map((_, i) => f.readMarker(i));
      for (const text of original) {
        const marker = JSON.parse(text);
        assert.deepEqual(Object.keys(marker).sort(), ["outputs", "sources"]);
        assert.match(marker.sources, /^[a-f0-9]{64}$/);
        assert.match(marker.outputs, /^[a-f0-9]{64}$/);
      }
      assert.equal(f.builds(), `${targets[0]}\n${targets[1]}\n`);
      corrupt(f.marker(index), JSON.parse(original[index]));
      f.run([index]);
      assert.equal(f.builds(), `${targets[0]}\n${targets[1]}\n${target}\n`);
      assert.deepEqual(targets.map((_, i) => f.readMarker(i)), original);
      f.run([]);
      assert.equal(f.builds(), `${targets[0]}\n${targets[1]}\n${target}\n`);
      assert.deepEqual(targets.map((_, i) => f.readMarker(i)), original);
    });
  }
}
