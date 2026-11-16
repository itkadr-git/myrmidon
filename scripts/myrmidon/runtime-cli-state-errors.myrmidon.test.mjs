import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "./prod-runtime-exports.mjs";

const workspace = "packages:\n  - packages/*\n";
const entry = JSON.stringify({ name: "@test/entry", dependencies: { "@test/dep": "workspace:*" } }, null, 2) + "\n";
const dep = JSON.stringify({ name: "@test/dep", exports: "./src/index.js", publishConfig: { exports: "./dist/index.js" } }, null, 2) + "\n";
const applied = JSON.stringify({ ...JSON.parse(dep), exports: "./dist/index.js" }, null, 2) + "\n";
const backup = "node_modules/.cache/myrmidon-prod-exports/backup.json";
const emptyBackup = '{"version":1,"packages":{}}\n';

function write(root, file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function snapshot(root) {
  const result = {};
  function walk(dir, rel = "") {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(rel, item.name);
      if (item.isDirectory()) walk(path.join(dir, item.name), name);
      else result[name] = fs.readFileSync(path.join(dir, item.name)).toString("hex");
    }
  }
  walk(root);
  return result;
}

function fixture(t) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), "cache", "scratch");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "runtime-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "sentinel.bin", Buffer.from([0, 255, 17, 10]));
  write(root, "packages/entry/package.json", entry);
  write(root, "packages/dep/package.json", dep);
  write(root, "packages/dep/dist/keep.bin", Buffer.from([12, 0, 255]));
  write(root, backup, emptyBackup);
  return root;
}

function run(args) {
  const logs = [];
  const errors = [];
  const code = main(args, { log: (line) => logs.push(line), error: (line) => errors.push(line) });
  return { code, logs, errors };
}

function apply(root, name = "@test/entry") {
  return run(["apply", "--entry", name, "--root", root]);
}

function expectApply(root) {
  const before = snapshot(root);
  assert.deepEqual(apply(root), {
    code: 0,
    logs: ["applied: @test/dep (packages/dep/package.json)", "skipped (entry package): @test/entry", `apply: 1 package.json rewritten; backup: ${backup}`],
    errors: [],
  });
  assert.equal(fs.readFileSync(path.join(root, "packages/dep/package.json"), "utf8"), applied);
  const saved = JSON.parse(fs.readFileSync(path.join(root, backup), "utf8"));
  assert.equal(saved.packages["@test/dep"].originalText, dep);
  const after = snapshot(root);
  delete before[backup];
  delete after[backup];
  before["packages/dep/package.json"] = Buffer.from(applied).toString("hex");
  assert.deepEqual(after, before);
}

function jsonError(text) {
  try { JSON.parse(text); } catch (error) { return `error: ${error.message}`; }
  throw new Error("fixture must contain malformed JSON");
}

test("missing workspace returns 1 without writes and succeeds after repair", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.deepEqual(apply(root), { code: 1, logs: [], errors: [`pnpm-workspace.yaml not found under ${root}; pass --root with the repository root.`] });
  assert.deepEqual(snapshot(root), before);
  write(root, "pnpm-workspace.yaml", workspace);
  expectApply(root);
  assert.equal(fs.readFileSync(path.join(root, "sentinel.bin")).toString("hex"), before["sentinel.bin"]);
});

test("missing entry returns 3 without writes and succeeds after repair", (t) => {
  const root = fixture(t);
  write(root, "pnpm-workspace.yaml", workspace);
  const missing = entry.replace("@test/entry", "@test/other");
  write(root, "packages/entry/package.json", missing);
  const before = snapshot(root);
  assert.deepEqual(apply(root), { code: 3, logs: [], errors: ["error: Entry package @test/entry not found in the workspace"] });
  assert.deepEqual(snapshot(root), before);
  write(root, "packages/entry/package.json", entry);
  expectApply(root);
  assert.equal(fs.readFileSync(path.join(root, "sentinel.bin")).toString("hex"), before["sentinel.bin"]);
});

test("malformed package JSON returns 3 without writes and succeeds after repair", (t) => {
  const root = fixture(t);
  write(root, "pnpm-workspace.yaml", workspace);
  const broken = '{"name":';
  write(root, "packages/dep/package.json", broken);
  const before = snapshot(root);
  assert.deepEqual(apply(root), { code: 3, logs: [], errors: [jsonError(broken)] });
  assert.deepEqual(snapshot(root), before);
  write(root, "packages/dep/package.json", dep);
  expectApply(root);
  assert.equal(fs.readFileSync(path.join(root, "sentinel.bin")).toString("hex"), before["sentinel.bin"]);
});

test("malformed backup JSON returns 3 without writes and restore succeeds after repair", (t) => {
  const root = fixture(t);
  write(root, "pnpm-workspace.yaml", workspace);
  expectApply(root);
  const valid = fs.readFileSync(path.join(root, backup));
  const broken = '{"version":';
  write(root, backup, broken);
  const before = snapshot(root);
  assert.deepEqual(run(["restore", "--root", root]), { code: 3, logs: [], errors: [jsonError(broken)] });
  assert.deepEqual(snapshot(root), before);
  write(root, backup, valid);
  assert.deepEqual(run(["restore", "--root", root]), {
    code: 0,
    logs: ["restored: @test/dep (packages/dep/package.json)", "restore: 1 package.json restored from backup; backup removed."],
    errors: [],
  });
  const after = snapshot(root);
  const expected = { ...before, "packages/dep/package.json": Buffer.from(dep).toString("hex") };
  delete expected[backup];
  assert.deepEqual(after, expected);
});
