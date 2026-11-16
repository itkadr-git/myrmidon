import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, releaseTaskResults } from "./verify-on-prod.mjs";

const generatedAt = "2026-11-16T00:00:00.000Z";

function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function reportFor(tasks, health = { status: "ok", version: "1.7.0" }) {
  const input = { version: "1.7.0", label: "1.7", generatedAt, health, tasks };
  const before = structuredClone(input);
  freezeDeep(input);
  const report = buildReport(input);
  assert.deepEqual(input, before);
  return report;
}

test("empty release tasks fail closed", () => {
  const report = reportFor([]);
  assert.equal(report.verified, false);
  assert.deepEqual(report.checks[1], {
    name: "release-tasks", verified: false, details: { label: "1.7", count: 0 },
  });
  assert.deepEqual(report.tasks, []);
});

for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "cancelled", "future_status"]) {
  test(`release task status ${status} fails closed`, () => {
    const tasks = [
      { identifier: "OPE-90", title: "First done", status: "done", extra: { value: 1 } },
      { identifier: "OPE-12", title: "Not done", status, extra: { value: 2 } },
      { identifier: "OPE-3", title: "Last done", status: "done", extra: { value: 3 } },
    ];
    const before = structuredClone(tasks);
    freezeDeep(tasks);
    const results = releaseTaskResults(tasks);
    assert.deepEqual(tasks, before);
    const expected = [
      { identifier: "OPE-90", title: "First done", status: "done", verified: true },
      { identifier: "OPE-12", title: "Not done", status, verified: false },
      { identifier: "OPE-3", title: "Last done", status: "done", verified: true },
    ];
    assert.deepEqual(results, expected);
    const report = reportFor(tasks);
    assert.equal(report.verified, false);
    assert.equal(report.checks[0].verified, true);
    assert.deepEqual(report.checks[1], {
      name: "release-tasks", verified: false, details: { label: "1.7", count: 3 },
    });
    assert.deepEqual(report.tasks, expected);
  });
}

for (const health of [{ status: "ok", version: "1.7.1" }, { status: "error", version: "1.7.0" }]) {
  test(`health mismatch ${health.status}/${health.version} fails closed`, () => {
    const report = reportFor([{ identifier: "OPE-2", title: "Done", status: "done" }], health);
    assert.equal(report.verified, false);
    assert.deepEqual(report.checks[0], {
      name: "production-version", verified: false,
      details: { expected: "1.7.0", actual: health.version, status: health.status },
    });
    assert.equal(report.checks[1].verified, true);
  });
}

test("exact matching health and completed tasks yield the complete ordered report", () => {
  const report = reportFor([
    { identifier: "OPE-99", title: "Second alphabetically", status: "done", extra: { nested: [1, 2] } },
    { identifier: "OPE-1", title: "First alphabetically", status: "done" },
  ]);
  assert.deepEqual(report, {
    version: "1.7.0", label: "1.7", generatedAt, verified: true,
    checks: [
      { name: "production-version", verified: true, details: { expected: "1.7.0", actual: "1.7.0", status: "ok" } },
      { name: "release-tasks", verified: true, details: { label: "1.7", count: 2 } },
    ],
    tasks: [
      { identifier: "OPE-99", title: "Second alphabetically", status: "done", verified: true },
      { identifier: "OPE-1", title: "First alphabetically", status: "done", verified: true },
    ],
  });
});
