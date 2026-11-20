import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../server/scripts/write-build-stamp.mjs", import.meta.url));

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-test-scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "build-stamp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = join(root, "server");
  const script = join(server, "scripts", "write-build-stamp.mjs");
  const bin = join(root, "bin");
  const trace = join(root, "git-trace.json");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(bin);
  copyFileSync(source, script);
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.TRACE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nif (process.env.GIT_FAIL === '1') process.exit(1);\nprocess.stdout.write(process.env.GIT_SHA + '\\n');\n`);
  chmodSync(fakeGit, 0o755);
  const dist = join(server, "dist");
  const output = join(dist, "build-info.json");
  function run({ gitSha = "", fail = false, supplied } = {}) {
    const env = { PATH: bin, TRACE: trace, GIT_SHA: gitSha, GIT_FAIL: fail ? "1" : "0" };
    if (supplied !== undefined) env.PAPERCLIP_BUILD_COMMIT = supplied;
    const child = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8" });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), { argv: ["rev-parse", "--short", "HEAD"], cwd: server });
  }
  function stamp(commit) {
    const content = readFileSync(output, "utf8");
    assert.deepEqual(JSON.parse(content), { commit });
    assert.equal(content, `${JSON.stringify({ commit }, null, 2)}\n`);
  }
  return { run, stamp, dist };
}

test("git commit takes precedence over the supplied commit", (t) => {
  const f = fixture(t);
  f.run({ gitSha: "abcdef123456", supplied: "fedcba987654" });
  f.stamp("abcdef123456");
});

test("a failed git command falls back to the supplied commit", (t) => {
  const f = fixture(t);
  f.run({ fail: true, supplied: "fedcba987654" });
  f.stamp("fedcba987654");
});

test("no commit exits successfully without creating dist", (t) => {
  const f = fixture(t);
  assert.equal(existsSync(f.dist), false);
  f.run({ fail: true });
  assert.equal(existsSync(f.dist), false);
});

test("a second invocation replaces the stamp without trailing content", (t) => {
  const f = fixture(t);
  f.run({ gitSha: "abcdef1234567890" });
  f.stamp("abcdef1234567890");
  f.run({ gitSha: "abc123" });
  f.stamp("abc123");
});
