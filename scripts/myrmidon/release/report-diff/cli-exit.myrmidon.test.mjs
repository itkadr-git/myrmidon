import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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

const cliExit = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const scratchExit = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || (tmpdir() === "/tmp" ? homedir() : tmpdir());
const taskExit = (identifier, status = "done") => ({ identifier, title: "Test task", status });
const reportExit = (tasks, version = "1.7.0") => buildReport({
  version, label: "1.7", generatedAt: "2026-01-01", health: { status: "ok", version }, tasks,
});

function runDiffExit(before, after, expectedCode) {
  const dir = mkdtempSync(join(scratchExit, "report-diff-"));
  try {
    const paths = [join(dir, "before.json"), join(dir, "after.json")];
    const bytes = [before, after].map(value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    paths.forEach((path, index) => writeFileSync(path, bytes[index]));
    const result = spawnSync(process.execPath, [cliExit, ...paths], { encoding: "utf8" });
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
  const before = reportExit([taskExit("TASK-1")]);
  const result = runDiffExit(before, structuredClone(before), 0);
  assert.equal(result.status, "identical");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.previous, { verified: true });
  assert.deepEqual(result.current, { verified: true });
});

test("CLI returns changed when a task is added", () => {
  const result = runDiffExit(reportExit([taskExit("TASK-1")]), reportExit([taskExit("TASK-1"), taskExit("TASK-2")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.added, ["TASK-2"]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI returns changed when the version changes", () => {
  const result = runDiffExit(reportExit([taskExit("TASK-1")]), reportExit([taskExit("TASK-1")], "1.7.1"), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.version, { before: "1.7.0", after: "1.7.1" });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.regressions, []);
});

test("CLI returns changed and identifies a PASS to FAIL regression", () => {
  const result = runDiffExit(reportExit([taskExit("TASK-1")]), reportExit([taskExit("TASK-1", "blocked")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.regressions, ["TASK-1"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.previous, { verified: true });
  assert.deepEqual(result.current, { verified: false });
});
