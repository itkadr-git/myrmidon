import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, formatReport, releaseTaskResults, EXIT_OK, EXIT_FAILED, EXIT_USAGE } from "./verify-on-prod.mjs";

test("release tasks map to per-task verification results", () => {
  const results = releaseTaskResults([
    { identifier: "OPE-1", title: "Ship it", status: "done" },
    { identifier: "OPE-2", title: "Deploy it", status: "in_progress" },
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { identifier: "OPE-1", title: "Ship it", status: "done", verified: true });
  assert.equal(results[1].verified, false);
});

test("release gate refuses while any release task is unverified", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.8.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }, { identifier: "OPE-2", title: "Deploy it", status: "blocked" }],
  });
  assert.equal(report.verified, false);
  const tasksCheck = report.checks.find((check) => check.name === "release-tasks");
  assert.equal(tasksCheck.verified, false);
});

test("success path requires ok health at the exact version and every task done", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.8.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }],
  });
  assert.equal(report.verified, true);
});

test("health version mismatch fails even when all tasks are done", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.7.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }],
  });
  assert.equal(report.verified, false);
  const versionCheck = report.checks.find((check) => check.name === "production-version");
  assert.equal(versionCheck.verified, false);
});

test("empty release task list fails the gate rather than passing vacuously", () => {
  const report = buildReport({ version: "1.8.0", label: "1.8", health: { status: "ok", version: "1.8.0" }, tasks: [] });
  assert.equal(report.verified, false);
});

test("report names the version and per-item outcomes", () => {
  const report = buildReport({
    version: "1.8.0",
    label: "1.8",
    health: { status: "ok", version: "1.8.0" },
    tasks: [{ identifier: "OPE-1", title: "Ship it", status: "done" }],
  });
  const text = formatReport(report);
  assert.match(text, /VERIFY-ON-PROD 1\.8\.0/);
  assert.match(text, /PASS OPE-1 — Ship it \[done\]/);
});

test("exit codes distinguish usage errors from gate failures", () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FAILED, 1);
  assert.equal(EXIT_USAGE, 2);
});
