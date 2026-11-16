import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

function report(version = "1.7.0") {
  return buildReport({
    version,
    label: "1.7",
    generatedAt: "2026-01-01T00:00:00.000Z",
    health: { status: "ok", version },
    tasks: [{ identifier: "OPE-1", title: "Release task", status: "done" }],
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPair(before, after, status, beforeVersion, afterVersion) {
  const originalBefore = structuredClone(before);
  const originalAfter = structuredClone(after);
  deepFreeze(before);
  deepFreeze(after);
  for (const [left, right, leftVersion, rightVersion] of [
    [before, after, beforeVersion, afterVersion],
    [after, before, afterVersion, beforeVersion],
  ]) {
    assert.deepEqual(diffReports(left, right), {
      status,
      version: { before: leftVersion, after: rightVersion },
      added: [], removed: [], regressions: [],
      previous: { verified: true }, current: { verified: true },
    });
  }
  assert.deepEqual(before, originalBefore);
  assert.deepEqual(after, originalAfter);
}

test("cloned reports are identical in both directions without mutation", () => {
  const before = report();
  assertPair(before, structuredClone(before), "identical", "1.7.0", "1.7.0");
});

for (const [name, change] of [
  ["generatedAt", value => { value.generatedAt = "2026-01-02T00:00:00.000Z"; }],
  ["task title", value => { value.tasks[0].title = "Renamed release task"; }],
  ["check order", value => { value.checks.reverse(); }],
]) {
  test(`${name} changes the report without task regression in both directions`, () => {
    const before = report();
    const after = structuredClone(before);
    change(after);
    assertPair(before, after, "changed", "1.7.0", "1.7.0");
  });
}

test("version changes with matching production health without task regression in both directions", () => {
  assertPair(report("1.7.0"), report("1.7.1"), "changed", "1.7.0", "1.7.1");
});
