import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createAutoSlicePolicy } from "./auto-slice-policy.ts";

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
