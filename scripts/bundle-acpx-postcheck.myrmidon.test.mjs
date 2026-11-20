import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache", "myrmidon-tests");
mkdirSync(scratch, { recursive: true });

function runFixture({ version = "0.12.0", runtime = "onAgentStderr", bundled = true }, check) {
  const root = mkdtempSync(join(scratch, "acpx-postcheck-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const bin = join(root, "bin");
  const sourceRoot = join(root, "source-root");
  const trace = join(root, "trace.json");
  try {
    for (const dir of [source, bin, sourceRoot]) mkdirSync(dir);
    const bundleDependencies = bundled ? ["acpx"] : ["other"];
    const manifest = { name: "fixture", version: "1.0.0", files: ["index.js"], bundleDependencies, dependencies: { [bundleDependencies[0]]: "1.0.0" } };
    writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(source, "index.js"), "fixture bytes\n");
    writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ pnpm: { patchedDependencies: {} } }));
    writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(process.env.TRACE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), manifest: JSON.parse(fs.readFileSync('package.json', 'utf8')) }));
if (process.env.BUNDLED === 'yes') {
  const dir = path.join(process.cwd(), 'node_modules', 'acpx');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acpx', version: process.env.VERSION }));
  if (process.env.HAS_RUNTIME === 'yes') fs.writeFileSync(path.join(dir, 'dist', 'runtime.js'), process.env.RUNTIME);
}
`, { mode: 0o755 });
    const runner = `import { prepareBundledPackage } from ${JSON.stringify(new URL("./prepare-bundled-package.mjs", import.meta.url).href)};\nprepareBundledPackage(process.argv[1], process.argv[2], { sourceRoot: process.argv[3] });`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", runner, source, destination, sourceRoot], {
      encoding: "utf8",
      env: { PATH: [bin, dirname(process.execPath)].join(delimiter), TRACE: trace, BUNDLED: bundled ? "yes" : "no", VERSION: version, HAS_RUNTIME: runtime === null ? "no" : "yes", RUNTIME: runtime ?? "" },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
      args: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: destination, manifest,
    });
    assert.equal(readFileSync(join(destination, "index.js"), "utf8"), "fixture bytes\n");
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")), manifest);
    if (bundled) {
      assert.deepEqual(JSON.parse(readFileSync(join(destination, "node_modules/acpx/package.json"), "utf8")), { name: "acpx", version });
      assert.equal(existsSync(join(destination, "node_modules/acpx/dist/runtime.js")), runtime !== null);
      if (runtime !== null) assert.equal(readFileSync(join(destination, "node_modules/acpx/dist/runtime.js"), "utf8"), runtime);
    } else {
      assert.equal(existsSync(join(destination, "node_modules/acpx")), false);
    }
    check(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [version, marker, other] of [["0.12.0", "onAgentStderr", "spawnEnvironment"], ["0.13.1", "spawnEnvironment", "onAgentStderr"]]) {
  test(`${version} accepts its own marker`, () => runFixture({ version, runtime: marker }, (result) => {
    assert.equal(result.status, 0, result.stderr);
  }));
  for (const [label, runtime] of [["no marker", "unpatched"], ["the other version's marker", other]]) {
    test(`${version} rejects ${label}`, () => runFixture({ version, runtime }, (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`staged acpx@${version.replaceAll(".", "\\.")} runtime is missing the repository patch`));
    }));
  }
}

test("rejects an unknown version even with both markers", () => runFixture({ version: "9.9.9", runtime: "onAgentStderr spawnEnvironment" }, (result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staged acpx@9\.9\.9 runtime is missing the repository patch/);
}));

test("rejects a missing runtime file", () => runFixture({ runtime: null }, (result) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT.*runtime\.js/s);
}));

test("stages successfully without acpx when it is not bundled", () => runFixture({ bundled: false }, (result) => {
  assert.equal(result.status, 0, result.stderr);
}));
