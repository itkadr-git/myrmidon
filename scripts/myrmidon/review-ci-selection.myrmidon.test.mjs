import assert from "node:assert/strict";
import { test } from "node:test";
import { selectCiResultConclusion } from "./review-approve-label.mjs";

const run = (id, started_at, status, conclusion, name = "CI result") => ({
  id, started_at, status, conclusion, name,
});
const early = "2026-11-01T10:00:00Z";
const middle = "2026-11-01T11:00:00Z";
const late = "2026-11-01T12:00:00Z";

const cases = [
  ["unsorted runs select newest failure", [run(2, middle, "completed", "failure"), run(1, early, "completed", "success")], "failure"],
  ["unsorted runs select newest success", [run(1, early, "completed", "failure"), run(3, late, "completed", "success"), run(2, middle, "completed", "failure")], "success"],
  ["equal timestamps use numeric id", [run(9, late, "completed", "failure"), run(10, late, "completed", "success")], "success"],
  ["custom check name", [run(1, late, "completed", "failure"), run(2, early, "completed", "success", "build")], "success", "build"],
  ["irrelevant and null entries are ignored", [null, run(1, late, "completed", "failure", "other"), run(2, early, "completed", "success")], "success"],
  ["irrelevant checks alone are missing", [null, run(1, late, "completed", "success", "other")], "missing"],
  ["null input is missing", null, "missing"],
  ["object input is missing", { name: "CI result" }, "missing"],
  ["empty array is missing", [], "missing"],
  ["all skipped is pending", [run(1, early, "completed", "skipped"), run(2, late, "completed", "skipped")], "pending"],
  ["completed without conclusion is unknown", [run(1, late, "completed", null)], "unknown"],
  ["queued run beats previous success", [run(1, early, "completed", "success"), run(2, late, "queued", null)], "queued"],
  ["in progress run beats previous success", [run(1, early, "completed", "success"), run(2, late, "in_progress", null)], "in_progress"],
  ["missing status is pending", [run(1, late, undefined, "success")], "pending"],
  ["skipped above success", [run(2, late, "completed", "skipped"), run(1, early, "completed", "success")], "success"],
  ["skipped above failure", [run(2, late, "completed", "skipped"), run(1, early, "completed", "failure")], "failure"],
  ...["neutral", "cancelled", "timed_out", "action_required"].map((conclusion) => [
    `${conclusion} is not success`, [run(1, early, "completed", "success"), run(2, late, "completed", conclusion)], conclusion,
  ]),
];

for (const [name, runs, expected, checkName] of cases) {
  test(name, () => assert.equal(selectCiResultConclusion(runs, checkName), expected));
}

test("selection does not mutate the input array or its entries", () => {
  const runs = [run(1, early, "completed", "success"), run(2, late, "completed", "failure")];
  const before = structuredClone(runs);
  const entries = [...runs];
  assert.equal(selectCiResultConclusion(runs), "failure");
  assert.deepEqual(runs, before);
  assert.equal(runs[0], entries[0]);
  assert.equal(runs[1], entries[1]);
});
