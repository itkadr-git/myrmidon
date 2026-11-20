import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".myrmidon-scratch");

test("standalone CLI installs before relinking SDK, skips missing build, and repeats safely", { timeout: 30000 }, (t) => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "standalone-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const file of ["build-standalone-public-packages.mjs", "link-plugin-dev-sdk.mjs", "release-package-map.mjs"]) {
    copyFileSync(path.join(checkout, "scripts", file), path.join(scripts, file));
  }
  const pkgDirs = ["packages/buildable", "packages/no-build"];
  for (const [index, dir] of pkgDirs.entries()) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "package.json"), JSON.stringify({ name: `fixture-${index}`, version: "1.0.0", ...(index === 0 ? { scripts: { build: "ignored" } } : {}) }));
  }
  const sdk = path.join(root, "packages/plugins/sdk");
  mkdirSync(sdk, { recursive: true });
  mkdirSync(path.join(root, "cli"));
  writeFileSync(path.join(root, "cli", "package.json"), JSON.stringify({ name: "myrmidon", version: "1.0.0" }));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'cli'\n");
  writeFileSync(path.join(scripts, "release-package-manifest.json"), JSON.stringify([...pkgDirs.map((dir, index) => ({ dir, name: `fixture-${index}`, publishFromCi: true })), { dir: "cli", name: "myrmidon", publishFromCi: true }]));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const shim = path.join(bin, "pnpm");
  writeFileSync(shim, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = process.cwd();
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args, cwd, ci: process.env.CI }) + '\\n');
const scope = path.join(cwd, 'node_modules', '@myrmidon');
const link = path.join(scope, 'plugin-sdk');
if (args[0] === 'install') {
  if (fs.existsSync(path.join(cwd, 'node_modules'))) process.exit(44);
  fs.mkdirSync(scope, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules', 'stale-sentinel'), 'stale');
  fs.symlinkSync(process.env.STALE_TARGET, link, 'dir');
} else if (args.join(' ') === 'run build') {
  if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(process.env.SDK_TARGET)) process.exit(42);
} else process.exit(43);
`);
  chmodSync(shim, 0o755);
  const stale = path.join(root, "stale-sdk");
  mkdirSync(stale);
  const log = path.join(root, "calls.jsonl");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FIXTURE_LOG: log, SDK_TARGET: sdk, STALE_TARGET: stale, STANDALONE_BUILD_CONCURRENCY: "1" };
  for (let run = 0; run < 2; run++) {
    for (const dir of pkgDirs) {
      const modules = path.join(root, dir, "node_modules");
      if (run === 0) {
        mkdirSync(path.join(modules, "@myrmidon"), { recursive: true });
        writeFileSync(path.join(modules, "old-sentinel"), "old");
        symlinkSync(stale, path.join(modules, "@myrmidon", "plugin-sdk"), "dir");
      }
    }
    const result = spawnSync(process.execPath, [path.join(scripts, "build-standalone-public-packages.mjs")], { cwd: root, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, `CLI failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    const expected = pkgDirs.flatMap((dir, index) => [
      { args: ["install", "--ignore-workspace", "--no-lockfile"], cwd: path.join(root, dir), ci: "true" },
      ...(index === 0 ? [{ args: ["run", "build"], cwd: path.join(root, dir), ci: "true" }] : []),
    ]);
    assert.deepEqual(calls, Array.from({ length: run + 1 }, () => expected).flat());
    for (const dir of pkgDirs) {
      const modules = path.join(root, dir, "node_modules");
      const link = path.join(modules, "@myrmidon", "plugin-sdk");
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(realpathSync(link), realpathSync(sdk));
      assert.equal(existsSync(path.join(modules, "old-sentinel")), false);
      assert.equal(readFileSync(path.join(modules, "stale-sentinel"), "utf8"), "stale");
    }
  }
});
