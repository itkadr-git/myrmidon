import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(homedir(), ".cache", "myrmidon-tests");

function runFixture(t, workspace, publicPackages) {
  mkdirSync(scratch, { recursive: true });
  const dir = realpathSync(mkdtempSync(path.join(scratch, "standalone-selection-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "bin"));
  for (const file of ["build-standalone-public-packages.mjs", "link-plugin-dev-sdk.mjs"]) {
    copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  }
  writeFileSync(path.join(dir, "pnpm-workspace.yaml"), workspace);
  const packages = ["workspace", "excluded", "reincluded", "private"];
  for (const name of packages) {
    const pkg = path.join(dir, "packages", name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, private: name === "private", scripts: { build: "unused" } }));
    mkdirSync(path.join(pkg, "node_modules"));
    writeFileSync(path.join(pkg, "node_modules", "sentinel"), name);
  }
  const lines = publicPackages.map((name) => `packages/${name}\t${name}`).join("\n");
  writeFileSync(path.join(dir, "scripts", "release-package-map.mjs"), `process.stdout.write(${JSON.stringify(lines)});\n`);
  const log = path.join(dir, "calls.jsonl");
  writeFileSync(path.join(dir, "bin", "pnpm"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), ci: process.env.CI}) + '\\n');\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "build-standalone-public-packages.mjs")], {
    cwd: dir, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`, CALL_LOG: log, STANDALONE_BUILD_CONCURRENCY: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { dir, result, calls };
}

test("CLI selects only excluded public packages and respects ordered workspace rules", (t) => {
  const { dir, result, calls } = runFixture(t, `packages:\n  - 'packages/*'\n  - '!packages/excluded'\n  - '!packages/reincluded'\n  - 'packages/reincluded'\n`, ["workspace", "excluded", "reincluded"]);
  assert.match(result.stdout, /Building 1 standalone package\(s\)/);
  assert.deepEqual(calls, [
    { args: ["install", "--ignore-workspace", "--no-lockfile"], cwd: path.join(dir, "packages/excluded"), ci: "true" },
    { args: ["run", "build"], cwd: path.join(dir, "packages/excluded"), ci: "true" },
  ]);
  assert.equal(existsSync(path.join(dir, "packages/excluded/node_modules/sentinel")), false);
  for (const name of ["workspace", "reincluded", "private"]) {
    assert.equal(readFileSync(path.join(dir, "packages", name, "node_modules/sentinel"), "utf8"), name);
  }
});

test("CLI exits successfully without pnpm calls when no public package is standalone", (t) => {
  const { dir, result, calls } = runFixture(t, "packages:\n  - 'packages/*'\n", ["workspace", "excluded", "reincluded"]);
  assert.match(result.stdout, /No standalone public packages detected/);
  assert.deepEqual(calls, []);
  for (const name of ["workspace", "excluded", "reincluded", "private"]) {
    assert.equal(readFileSync(path.join(dir, "packages", name, "node_modules/sentinel"), "utf8"), name);
  }
});
