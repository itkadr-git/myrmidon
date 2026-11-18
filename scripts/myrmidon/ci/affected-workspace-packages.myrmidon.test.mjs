import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(fileURLToPath(new URL("./affected-tests.mjs", import.meta.url))).href;
const scratch = process.env.MYRMIDON_RUN_SCRATCH_DIR || process.env.PAPERCLIP_RUN_SCRATCH_DIR || path.join(os.homedir(), ".myrmidon-test-scratch");
fs.mkdirSync(scratch, { recursive: true });

function fixture(t, { packages = [], projects = [], output, exit = 0 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "workspace-packages-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "vitest.config.ts"), `export default { projects: ${JSON.stringify(projects)} };`);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const entries = [{ name: "root", path: root }];
  for (const pkg of packages) {
    const dir = path.join(root, pkg.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), pkg.raw ?? JSON.stringify(pkg.manifest ?? {}));
    entries.push({ name: pkg.name, path: dir });
  }
  fs.writeFileSync(path.join(root, "pnpm-output"), output ?? JSON.stringify(entries));
  const executable = path.join(root, "bin", "pnpm");
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync('pnpm-call.json', JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}));\nprocess.stdout.write(fs.readFileSync('pnpm-output'));\nprocess.exit(${exit});\n`, { mode: 0o755 });
  const script = `import { workspacePackages } from ${JSON.stringify(moduleUrl)};\nconsole.log(JSON.stringify(workspacePackages(${JSON.stringify(root)})));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { PATH: path.join(root, "bin"), HOME: root },
  });
  return { root, result, call: JSON.parse(fs.readFileSync(path.join(root, "pnpm-call.json"), "utf8")) };
}

function rows(t, options) {
  const f = fixture(t, options);
  assert.equal(f.result.status, 0, f.result.stderr);
  return JSON.parse(f.result.stdout);
}

const pkg = (name, dir, manifest = {}) => ({ name, dir, manifest });

test("excludes the workspace root", (t) => {
  assert.deepEqual(rows(t, {}), []);
});
test("returns the listed package name", (t) => {
  assert.equal(rows(t, { packages: [pkg("listed", "packages/a", { name: "manifest-name" })] })[0].name, "listed");
});
test("returns a root-relative package directory", (t) => {
  assert.equal(rows(t, { packages: [pkg("a", "packages/nested/a")] })[0].dir, "packages/nested/a");
});
test("marks a listed vitest project", (t) => {
  assert.equal(rows(t, { packages: [pkg("a", "packages/a")], projects: ["packages/a"] })[0].vitestProject, true);
});
test("does not mark a non-project package", (t) => {
  assert.equal(rows(t, { packages: [pkg("a", "packages/a")], projects: ["packages/other"] })[0].vitestProject, false);
});
test("matches project directories exactly", (t) => {
  assert.equal(rows(t, { packages: [pkg("a", "packages/a")], projects: ["packages/a-extra"] })[0].vitestProject, false);
});
test("defaults missing scripts to an empty object", (t) => {
  assert.deepEqual(rows(t, { packages: [pkg("a", "a")] })[0].scripts, {});
});
test("defaults missing exports to null", (t) => {
  assert.equal(rows(t, { packages: [pkg("a", "a")] })[0].exports, null);
});
test("preserves scripts and object exports", (t) => {
  const manifest = { scripts: { test: "node test.js", build: "node build.js" }, exports: { ".": "./index.js", "./x": { import: "./x.mjs" } } };
  const [row] = rows(t, { packages: [pkg("a", "a", manifest)] });
  assert.deepEqual(row.scripts, manifest.scripts);
  assert.deepEqual(row.exports, manifest.exports);
});
test("preserves string exports", (t) => {
  assert.equal(rows(t, { packages: [pkg("a", "a", { exports: "./index.js" })] })[0].exports, "./index.js");
});
test("preserves package order and complete rows", (t) => {
  assert.deepEqual(rows(t, { packages: [pkg("z", "z"), pkg("a", "a")], projects: ["a"] }), [
    { name: "z", dir: "z", vitestProject: false, scripts: {}, exports: null },
    { name: "a", dir: "a", vitestProject: true, scripts: {}, exports: null },
  ]);
});
test("calls pnpm with the contract arguments in the fixture root", (t) => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.call, { argv: ["-r", "ls", "--depth", "-1", "--json"], cwd: f.root });
});
test("rejects invalid pnpm JSON", (t) => {
  const { result } = fixture(t, { output: "not-json" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError/);
  assert.equal(result.stdout, "");
});
test("rejects malformed package manifests", (t) => {
  const { result } = fixture(t, { packages: [{ name: "broken", dir: "broken", raw: "{" }] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SyntaxError/);
  assert.equal(result.stdout, "");
});
test("rejects a nonzero pnpm exit", (t) => {
  const { result } = fixture(t, { exit: 7 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed: pnpm/);
  assert.equal(result.stdout, "");
});
