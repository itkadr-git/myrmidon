import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = ["build-standalone-public-packages.mjs", "release-package-map.mjs", "link-plugin-dev-sdk.mjs"];

function runScenario(failure) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".cache", "myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const fixture = mkdtempSync(path.join(scratch, "standalone-cli-"));
  try {
    const scriptDir = path.join(fixture, "scripts");
    const bin = path.join(fixture, "bin");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(bin);
    for (const script of scripts) copyFileSync(path.join(root, "scripts", script), path.join(scriptDir, script));
    const manifest = ["a", "b"].map((name) => ({ dir: `packages/${name}`, name: name === "b" ? "myrmidon" : "fixture-a", publishFromCi: true }));
    writeFileSync(path.join(scriptDir, "release-package-manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(fixture, "pnpm-workspace.yaml"), "packages:\n  - 'not-a-package/**'\n");
    for (const entry of manifest) {
      const dir = path.join(fixture, entry.dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: entry.name, version: "1.0.0", scripts: { build: "unused" } }));
    }
    const log = path.join(fixture, "commands.jsonl");
    writeFileSync(path.join(bin, "pnpm"), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({cwd: process.cwd(), args, ci: process.env.CI, concurrency: process.env.STANDALONE_BUILD_CONCURRENCY}) + '\\n');\nif (process.cwd().endsWith('/packages/a') && args[0] === process.env.FIXTURE_FAILURE) process.exit(42);\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [path.join(scriptDir, scripts[0])], {
      cwd: fixture,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_LOG: log, FIXTURE_FAILURE: failure, STANDALONE_BUILD_CONCURRENCY: "1" },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Failed standalone package build\(s\): fixture-a/);
    assert.match(result.stdout, /Building 2 standalone package\(s\) with concurrency 1/);
    const records = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    const expected = failure === "install"
      ? [["a", ["install", "--ignore-workspace", "--no-lockfile"]], ["b", ["install", "--ignore-workspace", "--no-lockfile"]], ["b", ["run", "build"]]]
      : [["a", ["install", "--ignore-workspace", "--no-lockfile"]], ["a", ["run", "build"]], ["b", ["install", "--ignore-workspace", "--no-lockfile"]], ["b", ["run", "build"]]];
    assert.deepEqual(records, expected.map(([name, args]) => ({ cwd: path.join(fixture, "packages", name), args, ci: "true", concurrency: "1" })));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("install failure skips that build and drains remaining packages", { timeout: 20000 }, () => runScenario("install"));
test("build failure still drains remaining packages", { timeout: 20000 }, () => runScenario("run"));
