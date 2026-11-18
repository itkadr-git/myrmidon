import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchAgentDecommissionState } from "./host-clone-cache-gc.mjs";

const id = "agent-123";
const baseUrl = "https://board.invalid/root/";
const apiKey = "synthetic-test-key";
const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

async function check(fetchImpl, agentId = id, url = baseUrl) {
  let calls = 0;
  const result = await fetchAgentDecommissionState(agentId, {
    baseUrl: url,
    apiKey,
    fetchImpl: async (...args) => {
      calls += 1;
      return fetchImpl(...args);
    },
  });
  return { result, calls };
}

describe("decommission board lookup", () => {
  const states = [
    ["terminated hermes takes precedence", { status: "terminated", adapterType: "hermes_gateway" }, "terminated"],
    ["terminated other adapter", { status: "terminated", adapterType: "other" }, "terminated"],
    ["running hermes takes precedence", { status: "running", adapterType: "hermes_gateway" }, "hermes_gateway"],
    ["idle hermes", { status: "idle", adapterType: "hermes_gateway" }, "hermes_gateway"],
    ["running other adapter", { status: "running", adapterType: "other" }, "running"],
    ["idle other adapter", { status: "idle", adapterType: "other" }, "left_hermes_gateway"],
  ];
  for (const [name, body, state] of states) {
    it(name, async () => {
      const { result, calls } = await check(async () => response(200, body));
      assert.deepEqual(result, { ok: true, state });
      assert.equal(calls, 1);
    });
  }

  it("uses one encoded endpoint request with synthetic authorization", async () => {
    const { result, calls } = await check(async (url, options) => {
      assert.equal(url, `https://board.invalid/root/api/agents/${encodeURIComponent(id)}`);
      assert.deepEqual(options.headers, { Accept: "application/json", Authorization: `Bearer ${apiKey}` });
      return response(404, null);
    });
    assert.deepEqual(result, { ok: true, state: "deleted" });
    assert.equal(calls, 1);
  });

  it("does not duplicate the api suffix", async () => {
    const { result, calls } = await check(async (url) => {
      assert.equal(url, `https://board.invalid/api/agents/${encodeURIComponent(id)}`);
      return response(404, null);
    }, id, "https://board.invalid/api");
    assert.deepEqual(result, { ok: true, state: "deleted" });
    assert.equal(calls, 1);
  });

  for (const status of [401, 403, 429, 500]) {
    it(`fails closed on HTTP ${status} without retry`, async () => {
      const { result, calls } = await check(async () => response(status, null));
      assert.deepEqual(result, { ok: false, reason: status === 401 || status === 403 ? "board-forbidden" : "board-unavailable", statusCode: status });
      assert.equal(calls, 1);
    });
  }

  for (const [name, body] of [
    ["null", null], ["array", []], ["string", "bad"],
    ["missing status", { adapterType: "other" }],
    ["non-string status", { status: 42, adapterType: "other" }],
    ["missing adapter", { status: "idle" }],
    ["non-string adapter", { status: "idle", adapterType: null }],
    ["empty status", { status: "", adapterType: "other" }],
    ["unknown status", { status: "not-a-status", adapterType: "other" }],
    ["empty adapter", { status: "idle", adapterType: "" }],
  ]) {
    it(`rejects malformed body: ${name}`, async () => {
      const { result, calls } = await check(async () => response(200, body));
      assert.deepEqual(result, { ok: false, reason: "board-unavailable" });
      assert.equal(calls, 1);
    });
  }

  for (const [name, fetchImpl] of [
    ["network failure", async () => { throw new Error("offline"); }],
    ["parse failure", async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("bad JSON"); } })],
  ]) {
    it(`fails closed on ${name} without retry`, async () => {
      const { result, calls } = await check(fetchImpl);
      assert.deepEqual(result, { ok: false, reason: "board-unavailable" });
      assert.equal(calls, 1);
    });
  }

  for (const agentId of ["", "../agent", "agent/name", "Agent", "a b", "a".repeat(64)]) {
    it(`rejects invalid agent ID ${JSON.stringify(agentId)} without fetch`, async () => {
      const { result, calls } = await check(async () => { throw new Error("unexpected fetch"); }, agentId);
      assert.deepEqual(result, { ok: false, reason: "bad-agent-id" });
      assert.equal(calls, 0);
    });
  }
});
