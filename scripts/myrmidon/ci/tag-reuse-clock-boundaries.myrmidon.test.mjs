import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide } from "./tag-ci-reuse.mjs";

const SHA = "c78a6c9fde4992a98e5e76d3fd556e33bb87935a";
const GRACE_MS = 90_000;
const TIMEOUT_MS = 600_000;
const RUN = {
  head_sha: SHA,
  path: ".github/workflows/myrmidon-ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
};

function boundaryClock(elapsed) {
  const times = [-elapsed, 0, elapsed];
  let index = 0;
  const sleeps = [];
  return {
    now: () => times[Math.min(index++, times.length - 1)],
    sleep: async (ms) => {
      sleeps.push(ms);
      assert.ok(sleeps.length <= 1, "decision must not loop on a zero fake-time step");
    },
    sleeps,
  };
}

async function decideAt(elapsed, state, limit) {
  const clock = boundaryClock(elapsed);
  let fetches = 0;
  const result = await decide({
    sha: SHA,
    fetchRuns: async () => {
      fetches += 1;
      if (state === "error") throw new Error("HTTP 502");
      if (state === "pending") return [{ ...RUN, status: "in_progress", conclusion: null }];
      return [];
    },
    ...clock,
    timeoutMs: limit,
    intervalMs: 0,
    graceMs: GRACE_MS,
  });
  return { result, fetches, sleeps: clock.sleeps };
}

describe("decide clock boundaries", () => {
  for (const elapsed of [GRACE_MS, TIMEOUT_MS]) {
    for (const [conclusion, mode, reason] of [
      ["success", "reuse", "the branch run of the same commit is green"],
      ["failure", "full", "the branch run of the same commit did not succeed"],
    ]) {
      it(`${conclusion} at ${elapsed}ms terminates immediately`, async () => {
        const clock = boundaryClock(elapsed);
        let fetches = 0;
        const result = await decide({
          sha: SHA,
          fetchRuns: async () => { fetches += 1; return [{ ...RUN, conclusion }]; },
          ...clock,
          graceMs: GRACE_MS,
          timeoutMs: TIMEOUT_MS,
        });
        assert.deepEqual(result, { mode, reason });
        assert.equal(fetches, 1);
        assert.equal(clock.sleeps.length, 0);
      });
    }
  }

  for (const elapsed of [GRACE_MS - 1, GRACE_MS, GRACE_MS + 1]) {
    it(`none at grace=${elapsed}ms uses the grace boundary`, async () => {
      const { result, fetches, sleeps } = await decideAt(elapsed, "none", TIMEOUT_MS);
      assert.deepEqual(result, {
        mode: "full",
        reason: "no branch run of this commit",
      });
      assert.equal(fetches, elapsed === GRACE_MS - 1 ? 2 : 1);
      assert.equal(sleeps.length, elapsed === GRACE_MS - 1 ? 1 : 0);
    });

    it(`error at grace=${elapsed}ms uses the grace boundary`, async () => {
      const { result, fetches, sleeps } = await decideAt(elapsed, "error", TIMEOUT_MS);
      assert.deepEqual(result, {
        mode: "full",
        reason: "the runs API kept failing",
      });
      assert.equal(fetches, elapsed === GRACE_MS - 1 ? 2 : 1);
      assert.equal(sleeps.length, elapsed === GRACE_MS - 1 ? 1 : 0);
    });
  }

  for (const elapsed of [TIMEOUT_MS - 1, TIMEOUT_MS, TIMEOUT_MS + 1]) {
    it(`pending at timeout=${elapsed}ms uses the timeout boundary`, async () => {
      const { result, fetches, sleeps } = await decideAt(elapsed, "pending", TIMEOUT_MS);
      assert.deepEqual(result, {
        mode: "full",
        reason: "timed out waiting for the branch run",
      });
      assert.equal(fetches, elapsed === TIMEOUT_MS - 1 ? 2 : 1);
      assert.equal(sleeps.length, elapsed === TIMEOUT_MS - 1 ? 1 : 0);
    });
  }
});
