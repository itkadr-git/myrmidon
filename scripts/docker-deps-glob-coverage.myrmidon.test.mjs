import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./check-docker-deps-stage.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-scratch");

function filesAt(root, dir = root) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(filesAt(root, full)) : [[path.relative(root, full), readFileSync(full, "utf8")]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

function runFixture(pattern, packages, missing, workspace = "packages:\n  - 'packages/*'\n  - 'packages/a/*'\n") {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "deps-glob-"));
  try {
    const files = {
      Dockerfile: `FROM node AS deps\nCOPY ${pattern} /dest/\n`,
      "pnpm-workspace.yaml": workspace,
      ...Object.fromEntries(packages.map((pkg, index) => [pkg, JSON.stringify({ name: `fixture-${index}`, version: "1.0.0" }) + "\n"])),
    };
    for (const [name, content] of Object.entries(files)) {
      const destination = path.join(root, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    const before = filesAt(root);
    const child = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, missing.length ? 1 : 0);
    assert.equal(child.stdout, missing.length ? "" : "PASS\n");
    const expected = missing.map((pkg) => `Dockerfile deps stage missing package manifest coverage for: ${pkg}\n`).join("");
    assert.equal(child.stderr, missing.length ? expected + "Dockerfile deps stage is out of sync. Update it to cover the missing files.\n" : "");
    assert.deepEqual(filesAt(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cases = [
  ["single star stays in one segment", "packages/*/package.json", ["packages/a/package.json", "packages/a/b/package.json"], ["packages/a/b/package.json"]],
  ["double star spans segments", "packages/a/**/package.json", ["packages/a/b/package.json", "packages/a/b/c/package.json", "packages/ab/b/package.json"], ["packages/ab/b/package.json"]],
  ["question mark matches one character", "packages/a?/package.json", ["packages/ab/package.json", "packages/a/package.json", "packages/abc/package.json"], ["packages/a/package.json", "packages/abc/package.json"]],
  ["dot segment is normalized", "packages/./a/package.json", ["packages/a/package.json", "packages/ab/package.json"], ["packages/ab/package.json"]],
  ["literal plus", "packages/a+b/package.json", ["packages/a+b/package.json", "packages/ab/package.json"], ["packages/ab/package.json"]],
  ["literal parentheses", "packages/a(b)/package.json", ["packages/a(b)/package.json", "packages/ab/package.json"], ["packages/ab/package.json"]],
  ["literal brackets", "packages/a[b]/package.json", ["packages/a[b]/package.json", "packages/ab/package.json"], ["packages/ab/package.json"]],
  ["literal dollar", "packages/a$b/package.json", ["packages/a$b/package.json", "packages/ab/package.json"], ["packages/ab/package.json"]],
  ["path anchors reject prefix and suffix", "packages/a/package.json", ["packages/a/package.json", "packages/aa/package.json", "packages/xa/package.json"], ["packages/aa/package.json", "packages/xa/package.json"]],
];

for (const [name, pattern, packages, missing] of cases) {
  test(`${name}: covered manifests`, () => runFixture(pattern, packages.filter((pkg) => !missing.includes(pkg)), []));
  test(`${name}: nearest misses`, () => runFixture(pattern, packages, missing));
}

test("deep workspace manifest is enumerated", () => {
  runFixture("packages/a/*/package.json", ["packages/a/b/c/package.json"], ["packages/a/b/c/package.json"]);
});

test("start anchor rejects a leading path prefix", () => {
  runFixture("packages/a/package.json", ["xpackages/a/package.json"], ["xpackages/a/package.json"], "packages:\n  - 'xpackages/*'\n");
});

test("end anchor rejects a trailing path suffix", () => {
  runFixture("packages/a/package.json", ["packages/a/package.json/package.json"], ["packages/a/package.json/package.json"], "packages:\n  - 'packages/a/*'\n");
});
