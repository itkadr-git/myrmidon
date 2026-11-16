import assert from "node:assert/strict";
import test from "node:test";
import { createActionsReader } from "./cloud-source-verification.mjs";

test("Retry-After cannot schedule a retry beyond the deadline", async () => {
  let clock = 0;
  let calls = 0;
  const waits = [];
  const api = createActionsReader({
    token: "fixture", now: () => clock, deadlineAt: () => 50, backoffMs: 10,
    log: () => {}, sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429, headers: { get: () => "5" } };
    },
  });
  await assert.rejects(api("/fixture"), /HTTP 429/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(clock, 0);
});
