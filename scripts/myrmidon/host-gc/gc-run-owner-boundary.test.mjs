import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchRunAgentId, isReviewerAgent } from "./host-clone-cache-gc.mjs";

const apiKey = "synthetic-test-key";
const unavailable = { ok: false, reason: "board-unavailable" };

async function exercise(response, expected, { baseUrl = "https://board.invalid", runId = "run" } = {}) {
  const calls = [];
  const result = await fetchRunAgentId(runId, {
    baseUrl,
    apiKey,
    fetchImpl: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
  });
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1, "one request, no retries");
  return calls[0];
}

const jsonResponse = (value) => ({ ok: true, json: async () => value });

describe("run owner boundary", () => {
  for (const baseUrl of ["https://board.invalid", "https://board.invalid/api", "https://board.invalid/api/"]) {
    for (const [runId, encoded] of [
      ["run space", "run%20space"],
      ["run/child", "run%2Fchild"],
      ["\u96ea?x=1&y#z", "%E9%9B%AA%3Fx%3D1%26y%23z"],
    ]) {
      it(`encodes ${JSON.stringify(runId)} as one segment with base ${baseUrl}`, async () => {
        const [url, options] = await exercise(jsonResponse({ agentId: "owner-1" }), { ok: true, agentId: "owner-1" }, { baseUrl, runId });
        assert.equal(url, `https://board.invalid/api/heartbeat-runs/${encoded}`);
        assert.deepEqual(options.headers, { Accept: "application/json", Authorization: `Bearer ${apiKey}` });
      });
    }
  }

  for (const [label, body] of [["missing", {}], ["null", { agentId: null }], ["numeric", { agentId: 42 }]]) {
    it(`rejects ${label} agentId`, async () => {
      await exercise(jsonResponse(body), { ok: false, reason: "board-invalid-run" });
    });
  }

  for (const status of [403, 404, 429, 503]) {
    it(`returns the exact HTTP ${status} reason without retrying`, async () => {
      await exercise({ ok: false, status, json: () => { throw new Error("must not parse error response"); } }, { ok: false, reason: `board-http-${status}` });
    });
  }

  it("fails closed on invalid JSON", async () => {
    await exercise({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }, unavailable);
  });
  it("fails closed on network errors without retrying", async () => {
    await exercise(new Error("network failure"), unavailable);
  });
  it("fails closed when fetch is not a function", async () => {
    assert.deepEqual(await fetchRunAgentId("run", { baseUrl: "https://board.invalid", apiKey, fetchImpl: null }), unavailable);
  });
});

describe("reviewer identity boundary", () => {
  for (const [label, agent, expected] of [
    ["missing agent", null, false],
    ["not ok", { ok: false, id: "id", role: "reviewer" }, false],
    ["missing id", { ok: true, role: "reviewer" }, false],
    ["empty id", { ok: true, id: "", name: "adm-review-1" }, false],
    ["reviewer role", { ok: true, id: "id", role: "reviewer", name: "worker" }, true],
    ["reviewer name", { ok: true, id: "id", role: "engineer", name: "adm-dev-review-10" }, true],
    ["similar review suffix", { ok: true, id: "id", name: "adm-review" }, false],
    ["similar reviewer name", { ok: true, id: "id", name: "adm-reviewer-10" }, false],
    ["similar prefix", { ok: true, id: "id", name: "review-10" }, false],
    ["ordinary agent", { ok: true, id: "id", name: "adm-dev-eng-23" }, false],
  ]) {
    it(label, () => assert.equal(isReviewerAgent(agent), expected));
  }
});
