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
const report = (tasks = [task("OPE-1")], version = "1.7.0") => buildReport({
  version, label: "1.7", generatedAt: "2026-01-01", health: { status: "ok", version }, tasks,
});

function runDiff(before, after, expectedExit) {
  const dir = mkdtempSync(join(tmpdir(), "report-diff-cli-"));
  try {
    const paths = [join(dir, "before.json"), join(dir, "after.json")];
    const bytes = [Buffer.from(JSON.stringify(before)), Buffer.from(JSON.stringify(after))];
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

test("identical report bytes yield exit 0 and identical", () => {
  const original = report();
  const output = runDiff(original, original, 0);
  assert.equal(output.status, "identical");
  assert.deepEqual(output.added, []);
  assert.deepEqual(output.removed, []);
  assert.deepEqual(output.regressions, []);
  assert.deepEqual(output.previous, { verified: true });
  assert.deepEqual(output.current, { verified: true });
});

test("adding a task yields exit 1 and changed", () => {
  const output = runDiff(report(), report([task("OPE-1"), task("OPE-2")]), 1);
  assert.equal(output.status, "changed");
  assert.deepEqual(output.added, ["OPE-2"]);
  assert.deepEqual(output.removed, []);
  assert.deepEqual(output.regressions, []);
});

test("changing the version yields exit 1 and changed", () => {
  const output = runDiff(report(), report([task("OPE-1")], "1.7.1"), 1);
  assert.equal(output.status, "changed");
  assert.deepEqual(output.version, { before: "1.7.0", after: "1.7.1" });
  assert.deepEqual(output.regressions, []);
});

test("a passing task becoming failing yields exit 1 and its regression", () => {
  const output = runDiff(report(), report([task("OPE-1", "blocked")]), 1);
  assert.equal(output.status, "changed");
  assert.deepEqual(output.regressions, ["OPE-1"]);
  assert.deepEqual(output.added, []);
  assert.deepEqual(output.removed, []);
  assert.deepEqual(output.previous, { verified: true });
  assert.deepEqual(output.current, { verified: false });
});
