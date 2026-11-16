import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport } from "../verify-on-prod.mjs";
import { diffReports } from "./diff.mjs";

function report() {
  return buildReport({
    version: "1.7.0", label: "1.7", generatedAt: "2026-01-01",
    health: { status: "ok", version: "1.7.0" },
    tasks: [{ identifier: "OPE-1", title: "Done", status: "done" }],
  });
}

function production(value) {
  return value.checks.find(check => check.name === "production-version");
}

function compare(before, after) {
  const originals = [structuredClone(before), structuredClone(after)];
  const result = diffReports(before, after);
  assert.deepEqual([before, after], originals, "diff must not mutate its inputs");
  return result;
}

for (const [name, change] of [
  ["production check fails despite matching version", p => { p.verified = false; }],
  ["null health status", p => { p.details.status = null; }],
  ["error health status", p => { p.details.status = "error"; }],
  ["null actual version", p => { p.details.actual = null; }],
  ["different actual version", p => { p.details.actual = "1.6.0"; }],
]) {
  test(`valid production FAIL: ${name}`, () => {
    const before = report();
    const after = report();
    change(production(after));
    const result = compare(before, after);
    assert.equal(result.status, "changed");
    assert.equal(result.previous.verified, true);
    assert.equal(result.current.verified, false);
    assert.deepEqual(result.regressions, []);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
  });
}

for (const [name, change] of [
  ["expected differs from report version", p => { p.details.expected = "1.6.0"; }],
  ["numeric actual", p => { p.details.actual = 17; }],
  ["object actual", p => { p.details.actual = {}; }],
  ["numeric status", p => { p.details.status = 200; }],
  ["boolean status", p => { p.details.status = true; }],
]) {
  test(`invalid production schema: ${name}`, () => {
    const bad = report();
    change(production(bad));
    for (const [before, after] of [[report(), bad], [bad, report()]]) {
      const result = compare(before, after);
      assert.equal(result.status, "invalid");
      assert.ok(result.errors.some(error => error.includes("invalid production-version details")));
    }
  });
}

test("forged aggregate and both checks cannot mask a mismatched production version", () => {
  const forged = report();
  production(forged).details.actual = "1.6.0";
  forged.verified = true;
  for (const check of forged.checks) check.verified = true;
  const result = compare(report(), forged);
  assert.equal(result.status, "changed");
  assert.equal(result.previous.verified, true);
  assert.equal(result.current.verified, false);
  assert.deepEqual(result.regressions, []);
});

test("FAIL to PASS recomputes previous and current independently", () => {
  const failed = report();
  production(failed).details.status = "error";
  const result = compare(failed, report());
  assert.equal(result.status, "changed");
  assert.equal(result.previous.verified, false);
  assert.equal(result.current.verified, true);
  assert.deepEqual(result.regressions, []);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});

test("unchanged valid PASS reports remain identical", () => {
  const result = compare(report(), report());
  assert.equal(result.status, "identical");
  assert.equal(result.previous.verified, true);
  assert.equal(result.current.verified, true);
  assert.deepEqual(result.regressions, []);
});
