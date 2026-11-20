import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const targets = ["packages/shared", "packages/plugins/sdk"];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-certificate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `
const fs = require("node:fs");
const path = require("node:path");
const target = path.relative(process.cwd(), path.dirname(process.argv[3]));
fs.appendFileSync("builds", target + "\\n");
fs.mkdirSync(path.join(target, "dist"), { recursive: true });
fs.writeFileSync(path.join(target, "dist/index.js"), "export {};\\n");
`);
  for (const target of targets) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const marker = (target) => path.join(root, target, "dist/.paperclip-build-complete");
  const log = () => fs.readFileSync(path.join(root, "builds"), "utf8");
  const run = () => {
    const result = spawnSync(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(fs.existsSync(path.join(root, "node_modules/.cache/paperclip-plugin-build-deps.lock")), false);
    return result.stdout;
  };
  return { root, marker, log, run };
}

const corruptions = {
  missing: (file) => fs.unlinkSync(file),
  malformed: (file) => fs.writeFileSync(file, "{broken"),
  "missing fingerprints": (file) => fs.writeFileSync(file, "{}"),
  "wrong sources": (file) => {
    const marker = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...marker, sources: "incorrect" }));
  },
  "wrong outputs": (file) => {
    const marker = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...marker, outputs: "incorrect" }));
  },
};

for (const target of targets) {
  for (const [name, corrupt] of Object.entries(corruptions)) {
    test(`${target}: ${name} certificate rebuilds only that target and is reused`, (t) => {
      const f = fixture(t);
      assert.equal(f.run(), "[paperclip] Building @myrmidon/shared...\n[paperclip] Building @myrmidon/plugin-sdk...\n");
      const initialLog = `${targets.join("\n")}\n`;
      assert.equal(f.log(), initialLog);
      const original = fs.readFileSync(f.marker(target), "utf8");
      const other = targets.find((item) => item !== target);
      const otherMarker = fs.readFileSync(f.marker(other), "utf8");
      assert.match(JSON.parse(original).sources, /^[a-f0-9]{64}$/);
      assert.match(JSON.parse(original).outputs, /^[a-f0-9]{64}$/);
      assert.equal(f.run(), "");
      assert.equal(f.log(), initialLog);
      corrupt(f.marker(target));
      assert.equal(fs.readFileSync(path.join(f.root, target, "dist/index.js"), "utf8"), "export {};\n");
      const label = target === targets[0] ? "@myrmidon/shared" : "@myrmidon/plugin-sdk";
      assert.equal(f.run(), `[paperclip] Building ${label}...\n`);
      assert.equal(f.log(), `${initialLog}${target}\n`);
      assert.equal(fs.readFileSync(f.marker(target), "utf8"), original);
      assert.equal(fs.readFileSync(f.marker(other), "utf8"), otherMarker);
      assert.equal(f.run(), "");
      assert.equal(f.log(), `${initialLog}${target}\n`);
    });
  }
}
