import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

function report(tasks = [{ identifier: "OPE-1", status: "done" }], version = "1.7.0") {
  return buildReport({ version, label: "1.7", generatedAt: "2026-01-01", health: { status: "ok", version }, tasks });
}

test("identical reports are stable and inputs are unchanged", () => {
  const a = report(); const b = structuredClone(a); const original = structuredClone(a);
  assert.equal(diffReports(a, b).status, "identical");
  assert.deepEqual(a, original); assert.deepEqual(b, original);
});

test("recomputes a forged overall PASS and detects PASS to FAIL", () => {
  const a = report(); const b = report([{ identifier: "OPE-1", status: "blocked" }]);
  b.verified = true; b.checks.find(c => c.name === "release-tasks").verified = true;
  const result = diffReports(a, b);
  assert.equal(result.current.verified, false);
  assert.deepEqual(result.regressions, ["OPE-1"]);
  assert.notEqual(result.status, "identical");
});

test("reports removed and added tasks and version changes", () => {
  const result = diffReports(report(), report([{ identifier: "OPE-2", status: "done" }], "1.7.1"));
  assert.deepEqual(result.removed, ["OPE-1"]); assert.deepEqual(result.added, ["OPE-2"]);
  assert.deepEqual(result.version, { before: "1.7.0", after: "1.7.1" });
});

test("empty task list fails aggregate", () => {
  const result = diffReports(report(), report([]));
  assert.equal(result.current.verified, false); assert.deepEqual(result.removed, ["OPE-1"]);
});

test("rejects duplicate identifiers, count mismatch and incompatible schemas", () => {
  const dup = report([{ identifier: "OPE-1", status: "done" }, { identifier: "OPE-1", status: "done" }]);
  assert.equal(diffReports(report(), dup).status, "invalid");
  const count = report(); count.checks.find(c => c.name === "release-tasks").details.count = 2;
  assert.equal(diffReports(report(), count).status, "invalid");
  assert.equal(diffReports(report(), { verified: true, tasks: [] }).status, "invalid");
  const unknown = report([{ identifier: "unknown", status: "done" }]);
  assert.equal(diffReports(report(), unknown).status, "invalid");
});

test("failed production check and malformed checks cannot produce a PASS", () => {
  const failed = report();
  failed.checks.find(c => c.name === "production-version").details.actual = "1.6.0";
  assert.equal(diffReports(report(), failed).current.verified, false);
  const malformed = report(); malformed.checks.push(structuredClone(malformed.checks[0]));
  assert.equal(diffReports(report(), malformed).status, "invalid");
});

test("CLI returns invalid for missing files", () => {
  const result = spawnSync(process.execPath, [new URL("./diff.mjs", import.meta.url).pathname, "missing-a", "missing-b"], { encoding: "utf8" });
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).status, "invalid");
});
