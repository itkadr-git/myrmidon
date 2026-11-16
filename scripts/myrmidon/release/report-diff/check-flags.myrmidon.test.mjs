import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

function report({ releaseVerified, reportVerified, tasks = [{ identifier: "OPE-1", status: "done" }] }) {
  const result = buildReport({
    version: "1.7.0",
    label: "1.7",
    generatedAt: "2026-01-01",
    health: { status: "ok", version: "1.7.0" },
    tasks,
  });
  result.checks.find((check) => check.name === "release-tasks").verified = releaseVerified;
  result.verified = reportVerified;
  return result;
}

function compare(before, after, expectedPrevious, expectedCurrent, expectedStatus) {
  const beforeSnapshot = structuredClone(before);
  const afterSnapshot = structuredClone(after);
  const result = diffReports(before, after);
  assert.equal(result.status, expectedStatus);
  assert.equal(result.previous.verified, expectedPrevious);
  assert.equal(result.current.verified, expectedCurrent);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(before, beforeSnapshot);
  assert.deepEqual(after, afterSnapshot);
}

const flagCombinations = [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
];

for (const [releaseVerified, reportVerified] of flagCombinations) {
  for (const side of ["previous", "current"]) {
    test(`${side}: release=${releaseVerified}, overall=${reportVerified}`, () => {
      const baseline = report({ releaseVerified: true, reportVerified: true });
      const variant = report({ releaseVerified, reportVerified });
      const status = releaseVerified && reportVerified ? "identical" : "changed";
      if (side === "previous") compare(variant, baseline, releaseVerified, true, status);
      else compare(baseline, variant, true, releaseVerified, status);
    });
  }
}

test("both checks true override a false overall flag", () => {
  const forged = report({ releaseVerified: true, reportVerified: false });
  const baseline = report({ releaseVerified: true, reportVerified: true });
  compare(baseline, forged, true, true, "changed");
  compare(forged, baseline, true, true, "changed");
});

test("a forged overall PASS cannot hide a failed release check", () => {
  const forged = report({ releaseVerified: false, reportVerified: true });
  const baseline = report({ releaseVerified: true, reportVerified: true });
  compare(baseline, forged, true, false, "changed");
  compare(forged, baseline, false, true, "changed");
});

test("empty tasks fail with forged release and overall flags, without a schema error", () => {
  const forged = report({ releaseVerified: true, reportVerified: true, tasks: [] });
  const baseline = report({ releaseVerified: false, reportVerified: false, tasks: [] });
  assert.equal(forged.checks.find((check) => check.name === "release-tasks").details.count, 0);
  compare(baseline, forged, false, false, "changed");
  compare(forged, baseline, false, false, "changed");
});
