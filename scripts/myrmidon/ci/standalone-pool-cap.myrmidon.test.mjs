import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { resolveConcurrency, runWithConcurrency } from "../../build-standalone-public-packages.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function exercisePool(limit, expectedPeak) {
  const items = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];
  const original = [...items];
  const gates = items.map(() => deferred());
  const starts = [];
  let active = 0;
  let peak = 0;
  const run = runWithConcurrency(items, limit, async (item, index) => {
    starts.push(index);
    assert.strictEqual(item, items[index]);
    active += 1;
    peak = Math.max(peak, active);
    await gates[index].promise;
    active -= 1;
    return item;
  });

  try {
    await nextTurn();
    assert.deepEqual(starts, original.slice(0, expectedPeak).map((item) => item.id));
    assert.equal(active, expectedPeak);
    assert.equal(peak, expectedPeak);
    for (let index = 0; index < items.length; index += 1) {
      gates[index].resolve();
      await nextTurn();
      assert.deepEqual(starts, original.slice(0, Math.min(items.length, expectedPeak + index + 1)).map((item) => item.id));
    }
    const results = await run;
    assert.equal(active, 0);
    assert.equal(peak, expectedPeak);
    assert.deepEqual(items, original);
    results.forEach((result, index) => assert.strictEqual(result, original[index]));
    assert.equal(results.length, original.length);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await run;
  }
}

test("pool runs one item at a time at limit 1", async () => {
  await exercisePool(1, 1);
});

test("pool starts no more workers than items when limit is larger", async () => {
  await exercisePool(9, 4);
});

test("pool waits for a slot at limit 2", async () => {
  await exercisePool(2, 2);
});

test("pool preserves result identity and input order when work finishes out of order", async () => {
  const items = [{ id: 0 }, { id: 1 }, { id: 2 }];
  const original = [...items];
  const values = [{ value: 0 }, { value: 1 }, { value: 2 }];
  const gates = items.map(() => deferred());
  const starts = [];
  const completions = [];
  const run = runWithConcurrency(items, 2, async (item, index) => {
    starts.push(index);
    assert.strictEqual(item, original[index]);
    await gates[index].promise;
    completions.push(index);
    return values[index];
  });
  let settled = false;
  run.then(() => { settled = true; }, () => { settled = true; });

  try {
    await nextTurn();
    assert.deepEqual(starts, [0, 1]);
    gates[1].resolve();
    await nextTurn();
    assert.deepEqual(completions, [1]);
    assert.deepEqual(starts, [0, 1, 2]);
    gates[2].resolve();
    await nextTurn();
    assert.deepEqual(completions, [1, 2]);
    assert.equal(settled, false, "run must remain pending while worker 0 is blocked");
    gates[0].resolve();
    const results = await run;
    assert.deepEqual(completions, [1, 2, 0]);
    assert.equal(starts.length, items.length);
    assert.equal(results.length, values.length);
    for (let index = 0; index < values.length; index += 1) {
      assert.strictEqual(results[index], values[index]);
      assert.strictEqual(items[index], original[index]);
    }
    assert.equal(items.length, original.length);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await run;
  }
});

test("pool clamps zero limit to one worker", async () => {
  await exercisePool(0, 1);
});

test("pool clamps negative limit to one worker", async () => {
  await exercisePool(-3, 1);
});

test("empty pool does not invoke the worker", async () => {
  let calls = 0;
  const items = [];
  const results = await runWithConcurrency(items, 2, () => { calls += 1; });
  assert.deepEqual(results, []);
  assert.deepEqual(items, []);
  assert.equal(calls, 0);
});

function withOverride(value, callback) {
  const key = "STANDALONE_BUILD_CONCURRENCY";
  const previous = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    callback();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

for (const [value, count, expected] of [["1", 5, 1], ["2", 5, 2], ["20", 5, 5]]) {
  test(`override ${value} with ${count} packages returns ${expected}`, () => {
    withOverride(value, () => assert.equal(resolveConcurrency(count), expected));
  });
}

for (const [label, value] of [["unset", undefined], ["empty", ""], ["zero", "0"], ["non-numeric", "invalid"]]) {
  test(`${label} override falls back within package bounds`, () => {
    withOverride(value, () => {
      const result = resolveConcurrency(7);
      assert.ok(Number.isInteger(result));
      assert.ok(result >= 1 && result <= 7);
      assert.equal(resolveConcurrency(1), 1);
    });
  });
}

test("zero packages always resolves to one", () => {
  for (const value of [undefined, "", "0", "2"]) {
    withOverride(value, () => assert.equal(resolveConcurrency(0), 1));
  }
});
