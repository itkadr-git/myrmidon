import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchReleaseTasks } from "./verify-on-prod.mjs";

function fixture(fullPages) {
  const offsets = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://board.invalid");
    assert.equal(parsed.pathname, "/api/companies/test-company/issues");
    assert.equal(parsed.searchParams.get("labelId"), "test-label");
    assert.equal(parsed.searchParams.get("limit"), "1");
    assert.equal(parsed.searchParams.get("view"), "compact");
    const offset = offsets.length;
    assert.ok(offset < 10000, "unexpected 10001st request");
    assert.equal(parsed.searchParams.get("offset"), String(offset));
    offsets.push(offset);
    return { ok: true, json: async () => offset < fullPages ? [{ id: `issue-${offset}` }] : [] };
  };
  return { offsets, fetchImpl };
}

function fetchTasks(fetchImpl) {
  return fetchReleaseTasks({
    apiUrl: "https://board.invalid",
    apiKey: "synthetic-key",
    companyId: "test-company",
    labelId: "test-label",
    pageSize: 1,
    fetchImpl,
  });
}

test("10000 unique full pages reject without returning partial tasks", { timeout: 10000 }, async () => {
  const { offsets, fetchImpl } = fixture(10000);
  await assert.rejects(fetchTasks(fetchImpl), /maximum page count/);
  assert.deepEqual(offsets, Array.from({ length: 10000 }, (_, i) => i));
});

test("empty last permitted page returns all 9999 tasks in order", { timeout: 10000 }, async () => {
  const { offsets, fetchImpl } = fixture(9999);
  const tasks = await fetchTasks(fetchImpl);
  assert.deepEqual(tasks, Array.from({ length: 9999 }, (_, i) => ({ id: `issue-${i}` })));
  assert.deepEqual(offsets, Array.from({ length: 10000 }, (_, i) => i));
});

test("empty page before the boundary returns all 9998 tasks in order", { timeout: 10000 }, async () => {
  const { offsets, fetchImpl } = fixture(9998);
  const tasks = await fetchTasks(fetchImpl);
  assert.deepEqual(tasks, Array.from({ length: 9998 }, (_, i) => ({ id: `issue-${i}` })));
  assert.deepEqual(offsets, Array.from({ length: 9999 }, (_, i) => i));
});
