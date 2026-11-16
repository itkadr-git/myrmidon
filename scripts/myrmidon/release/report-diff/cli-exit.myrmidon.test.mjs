import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";

const cli = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || (tmpdir() === "/tmp" ? homedir() : tmpdir());
const task = (identifier, status = "done") => ({ identifier, title: "Test task", status });
const report = (tasks, version = "1.7.0") => buildReport({
  version, label: "1.7", generatedAt: "2026-01-01", health: { status: "ok", version }, tasks,
});

function runDiff(before, after, expectedCode) {
  const dir = mkdtempSync(join(scratch, "report-diff-"));
  try {
    const paths = [join(dir, "before.json"), join(dir, "after.json")];
    const bytes = [before, after].map(value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    paths.forEach((path, index) => writeFileSync(path, bytes[index]));
    const result = spawnSync(process.execPath, [cli, ...paths], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedCode);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytes[index]));
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI returns zero for byte-identical reports", () => {
  const before = report([task("TASK-1")]);
  const result = runDiff(before, structuredClone(before), 0);
  assert.equal(result.status, "identical");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.previous, { verified: true });
  assert.deepEqual(result.current, { verified: true });
});

test("CLI returns changed when a task is added", () => {
  const result = runDiff(report([task("TASK-1")]), report([task("TASK-1"), task("TASK-2")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.added, ["TASK-2"]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI returns changed when the version changes", () => {
  const result = runDiff(report([task("TASK-1")]), report([task("TASK-1")], "1.7.1"), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.version, { before: "1.7.0", after: "1.7.1" });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI returns changed and identifies a PASS to FAIL regression", () => {
  const result = runDiff(report([task("TASK-1")]), report([task("TASK-1", "blocked")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.regressions, ["TASK-1"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.previous, { verified: true });
  assert.deepEqual(result.current, { verified: false });
});
