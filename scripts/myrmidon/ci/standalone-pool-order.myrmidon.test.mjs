import test from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "../../build-standalone-public-packages.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("reverse completion preserves input result order", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const completed = [deferred(), deferred(), deferred()];
  const calls = [];
  const finishes = [];
  const pending = runWithConcurrency(["a", "b", "c"], 3, async (item, index) => {
    calls.push([item, index]);
    await gates[index].promise;
    finishes.push(index);
    completed[index].resolve();
    return item.toUpperCase();
  });
  assert.deepEqual(calls, [["a", 0], ["b", 1], ["c", 2]]);
  for (const index of [2, 1, 0]) {
    gates[index].resolve();
    await completed[index].promise;
  }
  assert.deepEqual(finishes, [2, 1, 0]);
  assert.deepEqual(await pending, ["A", "B", "C"]);
});

test("duplicate items retain distinct indices", async () => {
  const calls = [];
  const result = await runWithConcurrency(["same", "other", "same"], 2, (item, index) => {
    calls.push([item, index]);
    return `${item}:${index}`;
  });
  assert.deepEqual(calls, [["same", 0], ["other", 1], ["same", 2]]);
  assert.deepEqual(result, ["same:0", "other:1", "same:2"]);
});

test("worker receives original object identities and indices", async () => {
  const items = [{ id: 1 }, { id: 1 }, { id: 2 }];
  const calls = [];
  const result = await runWithConcurrency(items, 2, (item, index) => {
    calls.push([item, index]);
    return item;
  });
  assert.deepEqual(calls.map(([, index]) => index), [0, 1, 2]);
  for (let i = 0; i < items.length; i++) {
    assert.strictEqual(calls[i][0], items[i]);
    assert.strictEqual(result[i], items[i]);
  }
  assert.notStrictEqual(result[0], result[1]);
});

test("undefined results retain their position", async () => {
  const calls = [];
  const result = await runWithConcurrency(["left", "missing", "right"], 2, (item, index) => {
    calls.push([item, index]);
    return index === 1 ? undefined : item;
  });
  assert.deepEqual(calls, [["left", 0], ["missing", 1], ["right", 2]]);
  assert.deepEqual(result, ["left", undefined, "right"]);
  assert.equal(Object.hasOwn(result, 1), true);
});

test("empty input returns an empty result without calling worker", async () => {
  const calls = [];
  const result = await runWithConcurrency([], 2, (...args) => { calls.push(args); });
  assert.deepEqual(result, []);
  assert.deepEqual(calls, []);
});

test("input array and its objects remain unchanged", async () => {
  const first = { name: "first", nested: { value: 1 } };
  const second = { name: "second", nested: { value: 2 } };
  const items = [first, second];
  const calls = [];
  const result = await runWithConcurrency(items, 2, (item, index) => {
    calls.push([item.name, index]);
    return item.nested.value;
  });
  assert.deepEqual(calls, [["first", 0], ["second", 1]]);
  assert.deepEqual(result, [1, 2]);
  assert.deepEqual(items, [{ name: "first", nested: { value: 1 } }, { name: "second", nested: { value: 2 } }]);
  assert.strictEqual(items[0], first);
  assert.strictEqual(items[1], second);
});

test("parallel calls have independent cursors", async () => {
  const gateA = deferred();
  const gateB = deferred();
  const calls = [];
  const a = runWithConcurrency(["a0", "a1"], 1, async (item, index) => {
    calls.push(["a", item, index]);
    if (index === 0) await gateA.promise;
    return item.toUpperCase();
  });
  const b = runWithConcurrency(["b0", "b1", "b2"], 1, async (item, index) => {
    calls.push(["b", item, index]);
    if (index === 0) await gateB.promise;
    return item.toUpperCase();
  });
  assert.deepEqual(calls, [["a", "a0", 0], ["b", "b0", 0]]);
  gateB.resolve();
  assert.deepEqual(await b, ["B0", "B1", "B2"]);
  gateA.resolve();
  assert.deepEqual(await a, ["A0", "A1"]);
  assert.deepEqual(calls, [["a", "a0", 0], ["b", "b0", 0], ["b", "b1", 1], ["b", "b2", 2], ["a", "a1", 1]]);
});

test("successive calls do not inherit prior results", async () => {
  const calls = [];
  const worker = (item, index) => {
    calls.push([item, index]);
    return `${item}:${index}`;
  };
  const first = await runWithConcurrency(["old", "older", "oldest"], 2, worker);
  const second = await runWithConcurrency(["new"], 2, worker);
  assert.deepEqual(first, ["old:0", "older:1", "oldest:2"]);
  assert.deepEqual(second, ["new:0"]);
  assert.notStrictEqual(first, second);
  assert.deepEqual(calls, [["old", 0], ["older", 1], ["oldest", 2], ["new", 0]]);
});
