import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterClosedTaskClones } from "./host-clone-cache-gc.mjs";

const baseUrl = "http://board.invalid";
const apiKey = "synthetic-test-key";
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function mockBoard(entries, calls) {
  return async (url) => {
    calls.push(url);
    assert.ok(Object.hasOwn(entries, url), `unexpected request: ${url}`);
    const entry = entries[url];
    if (entry === "offline") throw new Error("offline");
    return entry;
  };
}

describe("filterClosedTaskClones regression contract", () => {
  it("partitions multiple clones by board status without mutating them", async () => {
    const statuses = ["todo", "done", "in_progress", "cancelled", "in_review", "blocked", "backlog"];
    const clones = statuses.map((status, i) => ({
      name: `OPE-${i + 1}@agent-${i}`,
      path: `/synthetic/clone-${i}`,
      extra: { marker: status },
    }));
    const original = structuredClone(clones);
    const calls = [];
    const entries = Object.fromEntries(statuses.map((status, i) => [
      `${baseUrl}/api/issues/OPE-${i + 1}`,
      response(200, { status }),
    ]));
    const result = await filterClosedTaskClones(clones, { baseUrl, apiKey, fetchImpl: mockBoard(entries, calls) });
    assert.deepEqual(result.candidates, [
      { ...original[1], identifier: "OPE-2", issueStatus: "done" },
      { ...original[3], identifier: "OPE-4", issueStatus: "cancelled" },
    ]);
    assert.deepEqual(result.skipped, [0, 2, 4, 5, 6].map((i) => ({
      ...original[i], identifier: `OPE-${i + 1}`, status: statuses[i], reason: "issue-status",
    })));
    assert.deepEqual(clones, original);
    assert.deepEqual(calls, statuses.map((_, i) => `${baseUrl}/api/issues/OPE-${i + 1}`));
  });

  it("fails closed for 404, offline, and missing status", async () => {
    const clones = ["OPE-11", "OPE-12", "OPE-13"].map((name) => ({ name, path: `/synthetic/${name}` }));
    const calls = [];
    const entries = {
      [`${baseUrl}/api/issues/OPE-11`]: response(404, {}),
      [`${baseUrl}/api/issues/OPE-12`]: "offline",
      [`${baseUrl}/api/issues/OPE-13`]: response(200, {}),
    };
    const result = await filterClosedTaskClones(clones, { baseUrl, apiKey, fetchImpl: mockBoard(entries, calls) });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.skipped, clones.map((clone, i) => ({
      ...clone, identifier: clone.name, reason: i === 2 ? "issue-not-found" : "board-unavailable",
    })));
    assert.deepEqual(calls, Object.keys(entries));
  });

  it("evaluates each invocation independently", async () => {
    const clones = [{ name: "OPE-21@agent", path: "/synthetic/clone" }];
    let status = "done";
    let calls = 0;
    const options = { baseUrl, apiKey, fetchImpl: async () => { calls++; return response(200, { status }); } };
    const first = await filterClosedTaskClones(clones, options);
    status = "in_review";
    const second = await filterClosedTaskClones(clones, options);
    assert.deepEqual(first, { candidates: [{ ...clones[0], identifier: "OPE-21", issueStatus: "done" }], skipped: [] });
    assert.deepEqual(second, { candidates: [], skipped: [{ ...clones[0], identifier: "OPE-21", status: "in_review", reason: "issue-status" }] });
    assert.equal(calls, 2);
  });

  it("does not fetch for empty input", async () => {
    let calls = 0;
    const result = await filterClosedTaskClones([], { baseUrl, apiKey, fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); } });
    assert.deepEqual(result, { candidates: [], skipped: [] });
    assert.equal(calls, 0);
  });
});
