import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("CLI installs standalone packages with lockfile-specific arguments and exact cwd", { timeout: 30000 }, (t) => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".cache", "myrmidon-test");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "standalone install "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  const bin = path.join(root, "shim bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of ["build-standalone-public-packages.mjs", "release-package-map.mjs", "link-plugin-dev-sdk.mjs"]) {
    copyFileSync(path.join(repo, "scripts", name), path.join(scripts, name));
  }
  const dirs = ["packages/with lock", "packages/without lock", "cli"];
  const names = ["fixture-locked", "fixture-unlocked", "myrmidon"];
  const originals = new Map();
  for (let i = 0; i < dirs.length; i++) {
    const dir = path.join(root, dirs[i]);
    mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, "package.json");
    const content = JSON.stringify({ name: names[i], version: "1.0.0", scripts: { build: "not executed" } });
    writeFileSync(manifest, content);
    originals.set(manifest, content);
  }
  const lock = path.join(root, dirs[0], "pnpm-lock.yaml");
  writeFileSync(lock, "lockfileVersion: '9.0'\n");
  originals.set(lock, readFileSync(lock, "utf8"));
  const workspace = path.join(root, "pnpm-workspace.yaml");
  writeFileSync(workspace, "packages:\n  - 'cli'\n");
  originals.set(workspace, readFileSync(workspace, "utf8"));
  const release = path.join(scripts, "release-package-manifest.json");
  writeFileSync(release, JSON.stringify(dirs.map((dir, i) => ({ dir, name: names[i], publishFromCi: true }))));
  originals.set(release, readFileSync(release, "utf8"));
  const log = path.join(root, "calls.ndjson");
  writeFileSync(path.join(bin, "pnpm"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), ci: process.env.CI}) + '\\n');\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(scripts, "build-standalone-public-packages.mjs")], {
    cwd: root, encoding: "utf8", timeout: 20000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CI: "false", STANDALONE_BUILD_CONCURRENCY: "1" },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Building 2 standalone package\(s\)/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const expected = dirs.slice(0, 2).flatMap((dir, i) => [
    { args: ["install", "--ignore-workspace", i === 0 ? "--frozen-lockfile" : "--no-lockfile"], cwd: path.join(root, dir), ci: "true" },
    { args: ["run", "build"], cwd: path.join(root, dir), ci: "true" },
  ]);
  assert.deepEqual(calls, expected);
  for (const [file, content] of originals) assert.equal(readFileSync(file, "utf8"), content, file);
  assert.equal(existsSync(path.join(root, dirs[1], "pnpm-lock.yaml")), false);
  assert.equal(existsSync(path.join(root, "cli", "node_modules")), false);
});
