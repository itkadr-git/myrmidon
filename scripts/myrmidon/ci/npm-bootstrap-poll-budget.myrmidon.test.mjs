import assert from "node:assert/strict";
import test from "node:test";

import { waitForPackageVisible } from "../../bootstrap-npm-package.mjs";

const name = "@myrmidon/poll-budget";
const hit = { exists: true };
const miss = { exists: false };

function spies(states) {
  const calls = [];
  return {
    calls,
    inspect(packageName) {
      calls.push(["inspect", packageName]);
      assert.ok(states.length, "unexpected inspection");
      const state = states.shift();
      if (state instanceof Error) throw state;
      return state;
    },
    async sleep(ms) {
      calls.push(["sleep", ms]);
    },
  };
}

function expectedCalls(count, intervalMs) {
  return Array.from({ length: count }, (_, i) =>
    i === 0 ? [["inspect", name]] : [["sleep", intervalMs], ["inspect", name]],
  ).flat();
}

test("zero attempts performs no inspection or sleep", async () => {
  const spy = spies([]);
  assert.equal(await waitForPackageVisible(name, { ...spy, attempts: 0 }), false);
  assert.deepEqual(spy.calls, []);
});

test("one attempt and one sighting succeeds without sleeping", async () => {
  const spy = spies([hit]);
  assert.equal(await waitForPackageVisible(name, { ...spy, attempts: 1, consecutive: 1 }), true);
  assert.deepEqual(spy.calls, [["inspect", name]]);
});

test("success on the final permitted attempt uses the exact interval", async () => {
  const spy = spies([miss, hit, hit]);
  assert.equal(await waitForPackageVisible(name, { ...spy, attempts: 3, consecutive: 2, intervalMs: 73 }), true);
  assert.deepEqual(spy.calls, expectedCalls(3, 73));
});

for (const [label, interruption] of [["exception", new Error("registry error")], ["null", null], ["exists false", miss]]) {
  test(`${label} interrupts a sighting streak`, async () => {
    const spy = spies([hit, interruption, hit]);
    assert.equal(await waitForPackageVisible(name, { ...spy, attempts: 3, consecutive: 2, intervalMs: 19 }), false);
    assert.deepEqual(spy.calls, expectedCalls(3, 19));
  });
}

test("alternating visibility exhausts the budget without success", async () => {
  const spy = spies([hit, miss, hit, miss, hit]);
  assert.equal(await waitForPackageVisible(name, { ...spy, attempts: 5, consecutive: 2, intervalMs: 11 }), false);
  assert.deepEqual(spy.calls, expectedCalls(5, 11));
});

test("success stops further inspections and sleeps", async () => {
  const spy = spies([hit, hit, miss]);
  assert.equal(await waitForPackageVisible(name, { ...spy, attempts: 5, consecutive: 2, intervalMs: 29 }), true);
  assert.deepEqual(spy.calls, expectedCalls(2, 29));
});

test("sleep rejection propagates without another inspection", async () => {
  const spy = spies([miss, hit]);
  const failure = new Error("sleep failed");
  const sleep = async (ms) => {
    spy.calls.push(["sleep", ms]);
    throw failure;
  };
  await assert.rejects(waitForPackageVisible(name, { ...spy, sleep, attempts: 2, intervalMs: 41 }), (error) => error === failure);
  assert.deepEqual(spy.calls, [["inspect", name], ["sleep", 41]]);
});
