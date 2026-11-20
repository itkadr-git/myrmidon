import { test } from "node:test";
import assert from "node:assert/strict";
import { listReleaseIssues } from "./cut-rc.mjs";

const api = { companyId: "company-test" };
const labelPath = "/api/companies/company-test/labels";
const label = { id: "label-17", name: "1.7" };
const issues = Array.from({ length: 203 }, (_, index) => ({ id: `issue-${index + 1}` }));

function board(pages) {
  const calls = [];
  return {
    calls,
    async fetchBoard(actualApi, pathname) {
      assert.equal(actualApi, api);
      calls.push(pathname);
      if (pathname === labelPath) return [label];
      const page = pages[calls.length - 2];
      assert.notEqual(page, undefined, "unexpected extra page request");
      if (page instanceof Error) throw page;
      return page;
    },
  };
}

function assertCalls(calls, offsets) {
  assert.equal(calls[0], labelPath);
  assert.equal(calls.length, offsets.length + 1);
  for (const [index, offset] of offsets.entries()) {
    const url = new URL(calls[index + 1], "http://board.invalid");
    assert.equal(url.pathname, "/api/companies/company-test/issues");
    assert.deepEqual([...url.searchParams.entries()].sort(), [
      ["labelId", "label-17"], ["limit", "100"], ["offset", String(offset)], ["view", "compact"],
    ]);
  }
}

test("listReleaseIssues returns every ID once across 100, 100, and 3 results", async () => {
  const fake = board([issues.slice(0, 100), issues.slice(100, 200), issues.slice(200)]);
  const result = await listReleaseIssues(api, "1.7", () => {}, fake.fetchBoard);
  assert.deepEqual(result.map((issue) => issue.id), issues.map((issue) => issue.id));
  assert.equal(new Set(result.map((issue) => issue.id)).size, 203);
  assertCalls(fake.calls, [0, 100, 200]);
});

test("listReleaseIssues stops after an empty second page", async () => {
  const fake = board([issues.slice(0, 100), []]);
  const result = await listReleaseIssues(api, "1.7", () => {}, fake.fetchBoard);
  assert.deepEqual(result.map((issue) => issue.id), issues.slice(0, 100).map((issue) => issue.id));
  assertCalls(fake.calls, [0, 100]);
});

test("listReleaseIssues rejects instead of returning a partial page on a thrown error", async () => {
  const failure = new Error("connection reset");
  const fake = board([issues.slice(0, 100), failure]);
  await assert.rejects(listReleaseIssues(api, "1.7", () => {}, fake.fetchBoard), (error) => error === failure);
  assertCalls(fake.calls, [0, 100]);
});

test("listReleaseIssues rejects instead of returning a partial page on HTTP 503", async (t) => {
  const calls = [];
  const httpApi = { ...api, apiUrl: "http://board.invalid", apiKey: "test-only" };
  t.mock.method(globalThis, "fetch", async (url) => {
    const pathname = url.slice(httpApi.apiUrl.length);
    calls.push(pathname);
    if (pathname === labelPath) return new Response(JSON.stringify([label]));
    if (calls.length === 2) return new Response(JSON.stringify(issues.slice(0, 100)));
    assert.equal(calls.length, 3, "unexpected extra page request");
    return new Response("unavailable", { status: 503 });
  });
  await assert.rejects(listReleaseIssues(httpApi, "1.7"), /HTTP 503 unavailable/);
  assertCalls(calls, [0, 100]);
});
