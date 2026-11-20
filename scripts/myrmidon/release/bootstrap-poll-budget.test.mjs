import assert from "node:assert/strict";
import test from "node:test";

import { waitForPackageVisible } from "../../bootstrap-npm-package.mjs";

const packageName = "@myrmidon/poll-budget-test";
const intervalMs = 137;
const visible = { exists: true };

async function runPoll({ states, attempts, consecutive }) {
  const events = [];
  let index = 0;
  const result = await waitForPackageVisible(packageName, {
    attempts,
    consecutive,
    intervalMs,
    inspect: (name) => {
      events.push(["inspect", name]);
      assert.ok(index < states.length, "unexpected inspection");
      const state = states[index++];
      if (state instanceof Error) throw state;
      return state;
    },
    sleep: async (ms) => { events.push(["sleep", ms]); },
  });
  return { result, events };
}

const inspect = ["inspect", packageName];
const sleep = ["sleep", intervalMs];

test("succeeds on the final allowed inspection", async () => {
  assert.deepEqual(await runPoll({ states: [{ exists: false }, visible, visible], attempts: 3, consecutive: 2 }), {
    result: true, events: [inspect, sleep, inspect, sleep, inspect],
  });
});

test("zero attempts makes no calls", async () => {
  assert.deepEqual(await runPoll({ states: [], attempts: 0, consecutive: 1 }), { result: false, events: [] });
});

test("insufficient budget returns false even when all observations are visible", async () => {
  assert.deepEqual(await runPoll({ states: [visible, visible], attempts: 2, consecutive: 3 }), {
    result: false, events: [inspect, sleep, inspect],
  });
});

test("one sighting succeeds immediately without sleeping or another inspection", async () => {
  assert.deepEqual(await runPoll({ states: [visible], attempts: 5, consecutive: 1 }), {
    result: true, events: [inspect],
  });
});

for (const [name, miss] of [["missing", { exists: false }], ["null", null], ["exception", new Error("transient")]]) {
  test(`${name} resets consecutive sightings`, async () => {
    assert.deepEqual(await runPoll({ states: [visible, miss, visible, visible], attempts: 6, consecutive: 2 }), {
      result: true, events: [inspect, sleep, inspect, sleep, inspect, sleep, inspect],
    });
  });
}
