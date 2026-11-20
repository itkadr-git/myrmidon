import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(repo, "scripts/bootstrap-npm-package.mjs");
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? join(homedir(), ".cache/myrmidon-tests");
const packageName = "@myrmidon/dryrun-failstop-fixture";

function repositoryState() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
}

for (const mode of ["exit", "signal"]) {
  test(`CLI stops and cleans staging when dry-run terminates with ${mode}`, (t) => {
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, "npm-failstop-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    const tmp = join(root, "tmp");
    const journal = join(root, "journal");
    const sentinel = join(root, "sentinel");
    mkdirSync(bin);
    mkdirSync(tmp);
    writeFileSync(sentinel, "outside unchanged\n");
    writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.JOURNAL, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
if (args[0] === 'view') {
  process.stderr.write('E404 fixture not found\\n');
  process.exit(1);
}
process.stdout.write('FAKE_NPM_STDOUT\\n');
process.stderr.write('FAKE_NPM_STDERR\\n');
if (process.env.FAIL_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
else process.exit(7);
`, { mode: 0o755 });
    const before = repositoryState();
    const sourceBefore = readFileSync(cli);
    const env = { PATH: bin, HOME: root, TMPDIR: tmp, TMP: tmp, TEMP: tmp, JOURNAL: journal, FAIL_MODE: mode };
    const result = spawnSync(process.execPath, [cli, packageName], { cwd: repo, env, timeout: 10000, encoding: "utf8" });
    assert.equal(result.error, undefined, `CLI timed out or could not start: ${result.error}`);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    const calls = readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { args: ["view", packageName, "version", "--json"], cwd: repo });
    assert.deepEqual(calls[1].args, ["publish", "--dry-run", "--access", "public"]);
    const stage = calls[1].cwd;
    assert.equal(dirname(stage), tmp);
    assert.match(stage, /paperclip-npm-placeholder-[^/]+$/);
    assert.equal(result.stdout, `${packageName} is not on npm yet; continuing with placeholder bootstrap.\nStaged placeholder for ${packageName} in ${stage}\nPreviewing publish payload (npm publish --dry-run)...\nFAKE_NPM_STDOUT\n`);
    assert.equal(result.stderr, `FAKE_NPM_STDERR\nnpm publish --dry-run failed with status ${mode === "exit" ? "7" : "unknown"}\n`);
    assert.deepEqual(readdirSync(tmp), []);
    assert.equal(readFileSync(sentinel, "utf8"), "outside unchanged\n");
    assert.deepEqual(readFileSync(cli), sourceBefore);
    assert.equal(repositoryState(), before);
  });
}
