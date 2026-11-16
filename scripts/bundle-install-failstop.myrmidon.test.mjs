import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
const moduleUrl = new URL("./prepare-bundled-package.mjs", import.meta.url).href;
const sourceManifest = {
  name: "fixture", version: "1.0.0", files: ["index.js"],
  bundleDependencies: ["fixture-dep"], dependencies: { "fixture-dep": "1.0.0", external: "2.0.0" },
  devDependencies: { dev: "3.0.0" }, publishConfig: { main: "published.js" },
};
const publishManifest = {
  name: "fixture", version: "1.0.0", files: ["index.js"],
  bundleDependencies: ["fixture-dep"], dependencies: { "fixture-dep": "1.0.0", external: "2.0.0" },
  devDependencies: { dev: "3.0.0" }, main: "published.js",
};
const installManifest = {
  name: "fixture", version: "1.0.0", files: ["index.js"],
  bundleDependencies: ["fixture-dep"], dependencies: { "fixture-dep": "1.0.0" }, main: "published.js",
};
const bytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

function runScenario(mode) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "bundle-failstop-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const sourceRoot = join(root, "root");
  const bin = join(root, "bin");
  const trace = join(root, "trace");
  try {
    for (const dir of [source, sourceRoot, bin]) mkdirSync(dir);
    writeFileSync(join(source, "package.json"), bytes(sourceManifest));
    writeFileSync(join(source, "index.js"), "original source bytes\n");
    writeFileSync(join(sourceRoot, "package.json"), bytes({ pnpm: { patchedDependencies: { "fixture-dep@1.0.0": "fixture.patch" } } }));
    writeFileSync(join(sourceRoot, "fixture.patch"), "synthetic patch bytes\n");
    const executable = (name, code) => writeFileSync(join(bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
    if (mode !== "missing") executable("npm", `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(trace)}, 'npm\\n');
      ${mode === "failure" ? "process.exit(23);" : `fs.mkdirSync('node_modules/fixture-dep', { recursive: true }); fs.writeFileSync('node_modules/fixture-dep/package.json', JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }));`}
    `);
    executable("patch", `require('node:fs').appendFileSync(${JSON.stringify(trace)}, 'patch\\n');`);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { prepareBundledPackage } from ${JSON.stringify(moduleUrl)};
      try {
        prepareBundledPackage(${JSON.stringify(source)}, ${JSON.stringify(destination)}, { sourceRoot: ${JSON.stringify(sourceRoot)} });
        process.stdout.write(JSON.stringify({ result: 'success' }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ result: 'throw', status: error.status, code: error.code }));
      }
    `], { env: { PATH: bin }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.error, undefined);
    const result = JSON.parse(child.stdout);
    if (mode === "failure") assert.deepEqual(result, { result: "throw", status: 23 });
    if (mode === "missing") assert.deepEqual(result, { result: "throw", status: null, code: "ENOENT" });
    if (mode === "success") assert.deepEqual(result, { result: "success" });
    assert.equal(existsSync(trace) ? readFileSync(trace, "utf8") : "", mode === "success" ? "npm\npatch\n" : mode === "failure" ? "npm\n" : "");
    assert.equal(readFileSync(join(destination, "package.json"), "utf8"), bytes(mode === "success" ? publishManifest : installManifest));
    assert.equal(readFileSync(join(destination, "index.js"), "utf8"), "original source bytes\n");
    assert.equal(readFileSync(join(source, "package.json"), "utf8"), bytes(sourceManifest));
    assert.equal(readFileSync(join(source, "index.js"), "utf8"), "original source bytes\n");
    assert.equal(readFileSync(join(sourceRoot, "fixture.patch"), "utf8"), "synthetic patch bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("npm exit 23 stops before publish and patch", () => runScenario("failure"));
test("missing npm stops before publish and patch", () => runScenario("missing"));
test("successful npm reaches patch and publishes the manifest", () => runScenario("success"));
