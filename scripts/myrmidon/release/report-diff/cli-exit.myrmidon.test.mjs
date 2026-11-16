import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildReport } from "../verify-on-prod.mjs";

const cli = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const done = { identifier: "OPE-1", title: "First", status: "done" };

function report(tasks = [done], version = "1.7.0") {
  return buildReport({ version, label: "1.7", generatedAt: "2026-01-01", health: { status: "ok", version }, tasks });
}

function runDiff(before, after, expectedExit) {
  const dir = mkdtempSync(join(tmpdir(), "report-diff-"));
  try {
    const paths = [join(dir, "before.json"), join(dir, "after.json")];
    const bytes = [Buffer.from(JSON.stringify(before)), Buffer.from(JSON.stringify(after))];
    paths.forEach((path, i) => writeFileSync(path, bytes[i]));
    const result = spawnSync(process.execPath, [cli, ...paths], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    paths.forEach((path, i) => assert.deepEqual(readFileSync(path), bytes[i]));
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI exits zero for byte-identical reports", () => {
  const before = report();
  const output = runDiff(before, structuredClone(before), 0);
  assert.equal(output.status, "identical");
  assert.deepEqual(output.added, []);
  assert.deepEqual(output.removed, []);
  assert.deepEqual(output.regressions, []);
});

test("CLI exits one when a task is added", () => {
  const output = runDiff(report(), report([done, { identifier: "OPE-2", title: "Second", status: "done" }]), 1);
  assert.equal(output.status, "changed");
  assert.deepEqual(output.added, ["OPE-2"]);
  assert.deepEqual(output.removed, []);
  assert.deepEqual(output.regressions, []);
});

test("CLI exits one when the version changes", () => {
  const output = runDiff(report(), report([done], "1.7.1"), 1);
  assert.equal(output.status, "changed");
  assert.deepEqual(output.version, { before: "1.7.0", after: "1.7.1" });
  assert.deepEqual(output.regressions, []);
});

test("CLI reports a task regression when PASS changes to FAIL", () => {
  const output = runDiff(report(), report([{ ...done, status: "blocked" }]), 1);
  assert.equal(output.status, "changed");
  assert.deepEqual(output.previous, { verified: true });
  assert.deepEqual(output.current, { verified: false });
  assert.deepEqual(output.regressions, ["OPE-1"]);
  assert.deepEqual(output.added, []);
  assert.deepEqual(output.removed, []);
});
