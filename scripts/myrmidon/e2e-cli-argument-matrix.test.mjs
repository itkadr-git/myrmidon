import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratch = realpathSync(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || os.homedir());
const root = mkdtempSync(path.join(scratch, "e2e-cli-matrix-"));
const scripts = path.join(root, "scripts");
const e2e = path.join(root, "tests", "e2e");
mkdirSync(scripts, { recursive: true });
mkdirSync(e2e, { recursive: true });
for (const name of ["e2e-shard.mjs", "general-server-shard.mjs"]) {
  copyFileSync(path.join(repoRoot, "scripts", name), path.join(scripts, name));
}
writeFileSync(path.join(scripts, "e2e-shard-durations.json"), "{}");
for (const name of ["a.spec.ts", "b.spec.ts"]) writeFileSync(path.join(e2e, name), "");
after(() => rmSync(root, { recursive: true, force: true }));

function run(args) {
  const result = spawnSync(process.execPath, [path.join(scripts, "e2e-shard.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: scratch },
  });
  assert.ifError(result.error);
  return result;
}

const invalid = [
  ["count zero", ["--shard-count", "0"], "--shard-count must be a positive integer, got 0"],
  ["count negative", ["--shard-count", "-1"], "--shard-count must be a positive integer, got -1"],
  ["count fractional", ["--shard-count", "1.5"], "--shard-count must be a positive integer, got 1.5"],
  ["count NaN", ["--shard-count", "NaN"], "--shard-count must be a positive integer, got NaN"],
  ["count infinity", ["--shard-count", "Infinity"], "--shard-count must be a positive integer, got Infinity"],
  ["count missing", ["--shard-count"], "--shard-count must be a positive integer, got NaN"],
  ["index negative", ["--shard-count", "2", "--shard-index", "-1"], "--shard-index must be in [0, 2), got -1"],
  ["index equal count", ["--shard-count", "2", "--shard-index", "2"], "--shard-index must be in [0, 2), got 2"],
  ["index greater than count", ["--shard-count", "2", "--shard-index", "3"], "--shard-index must be in [0, 2), got 3"],
  ["index fractional", ["--shard-count", "2", "--shard-index", "1.5"], "--shard-index must be in [0, 2), got 1.5"],
  ["index NaN", ["--shard-index", "NaN"], "--shard-index must be in [0, 1), got NaN"],
  ["index infinity", ["--shard-index", "Infinity"], "--shard-index must be in [0, 1), got Infinity"],
  ["index missing", ["--shard-index"], "--shard-index must be in [0, 1), got NaN"],
  ["count checked first", ["--shard-index", "-1", "--shard-count", "0"], "--shard-count must be a positive integer, got 0"],
  ["last count invalid", ["--shard-count", "1", "--shard-count", "0"], "--shard-count must be a positive integer, got 0"],
  ["last index invalid", ["--shard-index", "0", "--shard-index", "-1"], "--shard-index must be in [0, 1), got -1"],
];

for (const [name, args, diagnostic] of invalid) {
  test(`rejects ${name} before discovery`, () => {
    // A missing discovery directory makes validation order observable.
    rmSync(e2e, { recursive: true, force: true });
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(`Error: ${diagnostic}\n`), result.stderr);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  });
}

const valid = [
  ["defaults", []],
  ["explicit single shard", ["--shard-index", "0", "--shard-count", "1"]],
  ["last count wins", ["--shard-count", "0", "--shard-count", "1"]],
  ["last index wins", ["--shard-index", "-1", "--shard-index", "0"]],
  ["unknown flag", ["--unrecognized", "value"]],
  ["numeric exponent", ["--shard-count", "1e0"]],
];
for (const [name, args] of valid) {
  test(`accepts ${name} and prints only the spec paths`, () => {
    mkdirSync(e2e, { recursive: true });
    for (const file of ["a.spec.ts", "b.spec.ts"]) writeFileSync(path.join(e2e, file), "");
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "tests/e2e/a.spec.ts tests/e2e/b.spec.ts\n");
  });
}
