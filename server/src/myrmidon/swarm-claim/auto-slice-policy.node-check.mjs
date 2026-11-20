import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createAutoSlicePolicy, projectQueueShortages, runAutoSlicePass, releaseEpicCandidates } from "./auto-slice-policy.ts";

test("only open epics from the current release are candidates", () => {
  const rows = [
    { id: "a", identifier: "DEV-1", title: "Epic 1.6.9", status: "in_progress" },
    { id: "b", identifier: "DEV-2", title: "Epic 1.7.0", status: "todo" },
    { id: "c", identifier: "DEV-3", title: "Epic 1.6.9", status: "done" },
    { id: "d", identifier: "DEV-4", title: "Task 1.6.9", status: "todo" },
  ];
  assert.deepEqual(releaseEpicCandidates(rows, "1.6.9").map((row) => row.id), ["a"]);
  assert.deepEqual(releaseEpicCandidates(rows, null), []);
});

test("release separators are literal, not regex wildcards", () => {
  const rows = [
    { id: "wrong", identifier: "DEV-1", title: "Epic 1x6x9", status: "todo" },
    { id: "right", identifier: "DEV-2", title: "Epic 1.6.9", status: "todo" },
  ];
  assert.deepEqual(releaseEpicCandidates(rows, "1.6.9").map((row) => row.id), ["right"]);
});

test("counts project members with empty queues and ignores outsiders", () => {
  const result = projectQueueShortages("company", [
    { projectId: "a", memberIds: new Set(["one", "two", "three"]) },
    { projectId: "b", memberIds: new Set(["outsider"]) },
  ], ["one", "two", "three", "outsider"], [{ projectId: "b" }]);
  assert.deepEqual(result, [
    { companyId: "company", projectId: "a", ready: 0, free: 3 },
    { companyId: "company", projectId: "b", ready: 1, free: 1 },
  ]);
});

test("requests the shortage only after it persists for ten minutes", () => {
  const policy = createAutoSlicePolicy();
  const input = { companyId: "company", projectId: "project", ready: 0, free: 3 };
  assert.equal(policy.observe(input, 0), 0);
  assert.equal(policy.observe(input, 599_999), 0);
  assert.equal(policy.observe(input, 600_000), 3);
});

test("recovery resets the timer and projects are isolated", () => {
  const policy = createAutoSlicePolicy();
  const input = { companyId: "company", projectId: "project", ready: 1, free: 3 };
  assert.equal(policy.observe(input, 0), 0);
  assert.equal(policy.observe({ ...input, projectId: "other" }, 600_000), 0);
  assert.equal(policy.observe({ ...input, ready: 3 }, 600_000), 0);
  assert.equal(policy.observe(input, 600_001), 0);
  assert.equal(policy.observe(input, 1_200_001), 2);
});

test("company identifiers cannot collide with project identifiers", () => {
  const policy = createAutoSlicePolicy(10);
  assert.equal(policy.observe({ companyId: "a:b", projectId: "c", ready: 0, free: 1 }, 0), 0);
  assert.equal(policy.observe({ companyId: "a", projectId: "b:c", ready: 0, free: 1 }, 10), 0);
});

test("a sustained shortage creates one slicing task despite repeated passes", async () => {
  const policy = createAutoSlicePolicy();
  const shortage = { companyId: "company", projectId: "project", ready: 0, free: 3 };
  const created = [];
  const ports = {
    createIfAbsent: async (input) => {
      if (created.length) return false;
      created.push(input);
      return true;
    },
  };
  await runAutoSlicePass(policy, [shortage], 0, ports);
  await runAutoSlicePass(policy, [shortage], 600_000, ports);
  await runAutoSlicePass(policy, [shortage], 630_000, ports);
  assert.deepEqual(created, [{ companyId: "company", projectId: "project", needed: 3 }]);
});
