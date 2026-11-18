import assert from "node:assert/strict";
import test from "node:test";
import { waitForCloudArtifacts } from "./cloud-readiness.mjs";

const sha = "a".repeat(40);

function fixture(overrides = {}) {
  const calls = { fetch: 0, provenance: 0, sleep: 0 };
  const sentinel = new Error("unexpected readiness request sentinel");
  const options = {
    fetchImpl: async () => { calls.fetch += 1; throw sentinel; },
    verifyProvenance: () => { calls.provenance += 1; },
    sleep: async () => { calls.sleep += 1; },
    now: () => 0,
    timeoutMs: 100,
    intervalMs: 10,
    log: () => {},
    ...overrides,
  };
  return { calls, sentinel, options, original: { ...options } };
}

test("invalid SHA is rejected before requests, verification or sleep", async () => {
  for (const invalid of [undefined, null, "", "master", "a".repeat(7), "A".repeat(40), "g".repeat(40), "a".repeat(41)]) {
    const { calls, options, original } = fixture();
    await assert.rejects(waitForCloudArtifacts(invalid, options), /full immutable commit SHA/);
    assert.deepEqual(calls, { fetch: 0, provenance: 0, sleep: 0 });
    assert.deepEqual(options, original);
  }
});

test("invalid timeout and interval are rejected before requests, verification or sleep", async () => {
  for (const key of ["timeoutMs", "intervalMs"]) {
    for (const value of [0, -1, NaN, Infinity, -Infinity, "1", null]) {
      const { calls, options, original } = fixture({ [key]: value });
      await assert.rejects(waitForCloudArtifacts(sha, options), /positive finite timeout and poll interval/, `${key}: ${String(value)}`);
      assert.deepEqual(calls, { fetch: 0, provenance: 0, sleep: 0 });
      assert.deepEqual(options, original);
    }
  }
});

test("positive fractional timeout and interval reach the injected request", async () => {
  for (const overrides of [{ timeoutMs: 0.5 }, { intervalMs: 0.5 }, { timeoutMs: 0.5, intervalMs: 0.25 }]) {
    const { calls, sentinel, options, original } = fixture(overrides);
    await assert.rejects(waitForCloudArtifacts(sha, options), (error) => error === sentinel);
    assert.ok(calls.fetch > 0);
    assert.equal(calls.provenance, 0);
    assert.equal(calls.sleep, 0);
    assert.deepEqual(options, original);
  }
});
