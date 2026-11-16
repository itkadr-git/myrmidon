import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchIssueOpenState } from "./host-clone-cache-gc.mjs";

const apiKey = "synthetic-test-key";
const identifier = "OPE/123 #?";

async function request(response, baseUrl = "https://board.invalid") {
  const calls = [];
  const result = await fetchIssueOpenState(identifier, {
    baseUrl,
    apiKey,
    fetchImpl: async (...args) => {
      calls.push(args);
      if (response instanceof Error) throw response;
      return response;
    },
  });
  assert.equal(calls.length, 1, "exactly one request, with no retries");
  assert.deepEqual(calls[0], [
    "https://board.invalid/api/issues/OPE%2F123%20%23%3F",
    { headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } },
  ]);
  return result;
}

const success = (body) => ({ ok: true, status: 200, json: async () => body });

describe("fetchIssueOpenState transport contract", () => {
  for (const status of ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"]) {
    it(`returns HTTP 200 status ${status}`, async () => {
      const result = await request(success({ status }));
      assert.equal(result.ok, true);
      assert.equal(result.status, status);
    });
  }

  for (const baseUrl of ["https://board.invalid", "https://board.invalid/", "https://board.invalid/api", "https://board.invalid/api/"]) {
    it(`normalizes ${baseUrl} and encodes the identifier`, async () => {
      assert.equal((await request(success({ status: "todo" }), baseUrl)).status, "todo");
    });
  }

  for (const status of [401, 403, 404, 429, 500]) {
    it(`fails closed on HTTP ${status} without retry`, async () => {
      assert.deepEqual(await request({ ok: false, status }), {
        ok: false, reason: "board-unavailable", statusCode: status,
      });
    });
  }

  it("fails closed on a network exception without retry", async () => {
    assert.deepEqual(await request(new Error("synthetic network error")), {
      ok: false, reason: "board-unavailable",
    });
  });

  it("fails closed on malformed JSON without retry", async () => {
    assert.deepEqual(await request({ ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } }), {
      ok: false, reason: "board-unavailable",
    });
  });

  it("fails closed when status is missing without retry", async () => {
    assert.deepEqual(await request(success({})), { ok: false, reason: "issue-not-found" });
  });
});
