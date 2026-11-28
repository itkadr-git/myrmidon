import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

const validReport = () => buildReport({
  version: "1.7.0",
  label: "1.7",
  generatedAt: "2026-01-01T00:00:00.000Z",
  health: { status: "ok", version: "1.7.0" },
  tasks: [{ identifier: "OPE-1", title: "Ship release", status: "done" }],
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const invalidReports = [
  ["report is null", report => null],
  ["report is an array", report => []],
  ["version is missing", report => { delete report.version; }],
  ["label is missing", report => { delete report.label; }],
  ["generatedAt is missing", report => { delete report.generatedAt; }],
  ["checks is not an array", report => { report.checks = {}; }],
  ["tasks is not an array", report => { report.tasks = {}; }],
  ["report verified is not boolean", report => { report.verified = "true"; }],
  ["check verified is not boolean", report => { report.checks[0].verified = 1; }],
  ["task verified is not boolean", report => { report.tasks[0].verified = 1; }],
  ["check details are missing", report => { delete report.checks[0].details; }],
  ["check is unknown", report => { report.checks[0].name = "unknown-check"; }],
  ["required check is missing", report => { report.checks = report.checks.filter(check => check.name !== "release-tasks"); }],
  ["task identifier is empty", report => { report.tasks[0].identifier = ""; }],
  ["task title is empty", report => { report.tasks[0].title = ""; }],
  ["task status is empty", report => { report.tasks[0].status = ""; }],
  ["details count is negative", report => { report.checks.find(check => check.name === "release-tasks").details.count = -1; }],
  ["details count is fractional", report => { report.checks.find(check => check.name === "release-tasks").details.count = 0.5; }],
  ["details count is not a number", report => { report.checks.find(check => check.name === "release-tasks").details.count = "1"; }],
  ["release label does not match", report => { report.checks.find(check => check.name === "release-tasks").details.label = "1.6"; }],
];

test("valid identical reports are not rejected", () => {
  const previous = deepFreeze(validReport());
  const current = deepFreeze(structuredClone(previous));
  const snapshot = structuredClone(previous);
  const result = diffReports(previous, current);
  assert.equal(result.status, "identical");
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(previous, snapshot);
  assert.deepEqual(current, snapshot);
});

for (const [name, invalidate] of invalidReports) {
  for (const side of ["previous", "current"]) {
    test(`${name} is rejected on ${side}`, () => {
      const previous = validReport();
      const current = validReport();
      const target = side === "previous" ? previous : current;
      const changed = invalidate(target);
      const frozenPrevious = deepFreeze(structuredClone(side === "previous" && changed !== undefined ? changed : previous));
      const frozenCurrent = deepFreeze(structuredClone(side === "current" && changed !== undefined ? changed : current));
      const snapshotPrevious = structuredClone(frozenPrevious);
      const snapshotCurrent = structuredClone(frozenCurrent);
      const result = diffReports(frozenPrevious, frozenCurrent);

      assert.equal(result.status, "invalid");
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.every(error => error.startsWith(`${side}:`)));
      assert.deepEqual(frozenPrevious, snapshotPrevious);
      assert.deepEqual(frozenCurrent, snapshotCurrent);
    });
  }
}
