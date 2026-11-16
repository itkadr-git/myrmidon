import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";

const cli = fileURLToPath(new URL("./diff.mjs", import.meta.url));
const task = (identifier, status = "done") => ({ identifier, status });
const report = (tasks, version = "1.7.0") => buildReport({
  version, label: "1.7", generatedAt: "2026-01-01",
  health: { status: "ok", version }, tasks,
});

function runDiff(before, after, expectedExit) {
  const dir = mkdtempSync(join(tmpdir(), "report-diff-"));
  try {
    const paths = [join(dir, "before.json"), join(dir, "after.json")];
    const bytes = [before, after].map(value => Buffer.from(JSON.stringify(value)));
    paths.forEach((path, index) => writeFileSync(path, bytes[index]));
    const result = spawnSync(process.execPath, [cli, ...paths], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedExit);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytes[index]));
    return output;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("byte-identical reports exit 0 with identical status", () => {
  const input = report([task("OPE-1")]);
  const result = runDiff(input, input, 0);
  assert.equal(result.status, "identical");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
});

test("adding a task exits 1 with changed status", () => {
  const result = runDiff(report([task("OPE-1")]), report([task("OPE-1"), task("OPE-2")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.added, ["OPE-2"]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
});

test("changing the version exits 1 with changed status", () => {
  const result = runDiff(report([task("OPE-1")]), report([task("OPE-1")], "1.7.1"), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.version, { before: "1.7.0", after: "1.7.1" });
  assert.deepEqual(result.regressions, []);
});

test("a PASS to FAIL task regression exits 1 with changed status", () => {
  const result = runDiff(report([task("OPE-1"), task("OPE-2")]), report([task("OPE-1", "blocked"), task("OPE-2")]), 1);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.regressions, ["OPE-1"]);
  assert.equal(result.previous.verified, true);
  assert.equal(result.current.verified, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});
