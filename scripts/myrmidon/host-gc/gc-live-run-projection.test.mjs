import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchIssueOpenState } from "./host-clone-cache-gc.mjs";

const project = (issue) => fetchIssueOpenState("OPE-test", {
  baseUrl: "http://board.invalid",
  apiKey: "synthetic-key",
  fetchImpl: async (url, options) => {
    assert.equal(url, "http://board.invalid/api/issues/OPE-test");
    assert.equal(options.headers.Authorization, "Bearer synthetic-key");
    return { ok: true, json: async () => issue };
  },
});

describe("fetchIssueOpenState live run projection", () => {
  const cases = [
    ["both missing", {}, null, []],
    ["both empty", { executionRunId: "", checkoutRunId: "" }, null, []],
    ["both null", { executionRunId: null, checkoutRunId: null }, null, []],
    ["different", { executionRunId: "run-b", checkoutRunId: "run-a" }, "run-b", ["run-b", "run-a"]],
    ["same", { executionRunId: "run-a", checkoutRunId: "run-a" }, "run-a", ["run-a"]],
    ["execution only", { executionRunId: "run-a" }, "run-a", ["run-a"]],
    ["checkout only", { checkoutRunId: "run-b" }, "run-b", ["run-b"]],
    ["empty execution", { executionRunId: "", checkoutRunId: "run-b" }, "run-b", ["run-b"]],
    ["empty checkout", { executionRunId: "run-a", checkoutRunId: "" }, "run-a", ["run-a"]],
    ["truthy non-string execution", { executionRunId: 42, checkoutRunId: "run-b" }, 42, ["run-b"]],
    ["truthy non-string checkout", { executionRunId: "run-a", checkoutRunId: true }, "run-a", ["run-a"]],
    ["non-strings", { executionRunId: 0, checkoutRunId: false }, null, []],
    ["objects", { executionRunId: { id: "run-a" }, checkoutRunId: ["run-b"] }, { id: "run-a" }, []],
  ];

  for (const [name, fields, liveRunId, liveRunIds] of cases) {
    it(`projects ${name}`, async () => {
      const issue = { status: "in_progress", ...fields };
      const original = structuredClone(issue);
      const result = await project(issue);
      assert.deepEqual(result, { ok: true, status: "in_progress", assigneeAgentId: null, liveRunId, liveRunIds });
      assert.deepEqual(issue, original);
    });
  }

  for (const [name, fields, expected] of [
    ["string", { assigneeAgentId: "agent-a" }, "agent-a"],
    ["empty", { assigneeAgentId: "" }, null],
    ["null", { assigneeAgentId: null }, null],
    ["missing", {}, null],
    ["non-string", { assigneeAgentId: 123 }, null],
  ]) {
    it(`normalizes ${name} assignee`, async () => {
      assert.equal((await project({ status: "todo", ...fields })).assigneeAgentId, expected);
    });
  }

  it("does not share projected arrays between repeated responses", async () => {
    const issue = { status: "in_review", executionRunId: "run-a", checkoutRunId: "run-b" };
    const original = structuredClone(issue);
    const first = await project(issue);
    first.liveRunIds.push("modified");
    const second = await project(issue);
    assert.notStrictEqual(first.liveRunIds, second.liveRunIds);
    assert.deepEqual(second.liveRunIds, ["run-a", "run-b"]);
    assert.deepEqual(issue, original);
  });
});
