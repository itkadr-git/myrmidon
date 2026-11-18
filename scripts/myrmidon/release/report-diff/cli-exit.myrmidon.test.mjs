import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";

const cli = fs.realpathSync(fileURLToPath(new URL("./diff.mjs", import.meta.url)));
const task = (identifier, status = "done") => ({ identifier, status });
const report = (tasks = [task("OPE-1")], version = "1.7.0") => buildReport({
  version, label: "1.7", generatedAt: "2026-01-01", health: { status: "ok", version }, tasks,
});

function runDiff(before, after, expectedExit) {
  const dir = fs.mkdtempSync(path.join(process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR || path.join(os.homedir(), ".cache"), "report-diff-"));
  try {
    const previous = path.join(dir, "previous.json");
    const current = path.join(dir, "current.json");
    const previousBytes = Buffer.from(JSON.stringify(before));
    const currentBytes = Buffer.from(JSON.stringify(after));
    fs.writeFileSync(previous, previousBytes);
    fs.writeFileSync(current, currentBytes);
    const result = spawnSync(process.execPath, [cli, previous, current], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit);
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readFileSync(previous), previousBytes);
    assert.deepEqual(fs.readFileSync(current), currentBytes);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI returns identical for byte-identical reports", () => {
  const input = report();
  const result = runDiff(input, structuredClone(input), 0);
  assert.equal(result.status, "identical");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI reports an added task", () => {
  const result = runDiff(report(), report([task("OPE-1"), task("OPE-2")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.added, ["OPE-2"]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI reports a version change", () => {
  const result = runDiff(report(), report([task("OPE-1")], "1.7.1"), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.version, { before: "1.7.0", after: "1.7.1" });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI reports a task regression from PASS to FAIL", () => {
  const result = runDiff(report(), report([task("OPE-1", "blocked")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.regressions, ["OPE-1"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.equal(result.previous.verified, true);
  assert.equal(result.current.verified, false);
});
