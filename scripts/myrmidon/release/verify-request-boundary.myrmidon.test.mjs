import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyOnProduction } from "./verify-on-prod.mjs";

const options = {
  version: "1.7.0",
  label: "1.7",
  healthUrl: "https://health.example.test/api/health",
  apiUrl: "https://board.example.test/",
  apiKey: "synthetic-board-key",
  token: "synthetic-health-token",
  companyId: "company/a?b#c &",
  pageSize: 2,
};
const labelId = "label/a?b#c &";
const pages = [
  [{ id: "a", identifier: "A", title: "A", status: "done" }, { id: "b", identifier: "B", title: "B", status: "done" }],
  [{ id: "c", identifier: "C", title: "C", status: "done" }, { id: "d", identifier: "D", title: "D", status: "done" }],
  [],
];

function fakeRequests(failure) {
  const calls = [];
  const responses = [
    { status: 200, body: { status: "ok", version: "1.7.0" } },
    { status: 200, body: [{ id: labelId, name: "1.7" }] },
    ...pages.map((body) => ({ status: 200, body })),
  ];
  if (failure) responses[failure.index] = { status: failure.status, body: {} };
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses[calls.length - 1];
      if (!response) throw new Error("unexpected additional request");
      return { ok: response.status === 200, status: response.status, json: async () => response.body };
    },
  };
}

test("health and board credentials stay on their own origins; encoded pagination reaches the empty page", async () => {
  const { calls, fetchImpl } = fakeRequests();
  const report = await verifyOnProduction({ ...options, fetchImpl });
  assert.equal(report.verified, true);
  assert.deepEqual(report.tasks.map((task) => task.identifier), ["A", "B", "C", "D"]);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].url, options.healthUrl);
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${options.token}` });
  assert.equal(calls[1].url, "https://board.example.test/api/companies/company%2Fa%3Fb%23c%20%26/labels");
  for (const call of calls.slice(1)) {
    assert.equal(new URL(call.url).origin, "https://board.example.test");
    assert.deepEqual(call.init.headers, { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" });
  }
  const urls = calls.slice(2).map(({ url }) => new URL(url));
  for (const url of urls) {
    assert.equal(url.pathname, "/api/companies/company%2Fa%3Fb%23c%20%26/issues");
    assert.match(url.search, /labelId=label%2Fa%3Fb%23c%20%26/);
    assert.equal(url.searchParams.get("labelId"), labelId);
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(url.searchParams.get("view"), "compact");
  }
  assert.deepEqual(urls.map((url) => url.searchParams.get("offset")), ["0", "2", "4"]);
});

test("labels HTTP failure stops before requesting issues", async () => {
  const { calls, fetchImpl } = fakeRequests({ index: 1, status: 503 });
  await assert.rejects(verifyOnProduction({ ...options, fetchImpl }), /labels: HTTP 503/);
  assert.equal(calls.length, 2);
});

test("issues HTTP failure stops pagination after the failed page", async () => {
  const { calls, fetchImpl } = fakeRequests({ index: 3, status: 502 });
  await assert.rejects(verifyOnProduction({ ...options, fetchImpl }), /issues\?.*: HTTP 502/);
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[3].url).searchParams.get("offset"), "2");
});
