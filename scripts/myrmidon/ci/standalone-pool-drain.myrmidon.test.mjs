import assert from "node:assert/strict";
import test from "node:test";
import { runWithConcurrency } from "../../build-standalone-public-packages.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function failureOf(promise) {
  let failure;
  await assert.rejects(promise, (error) => { failure = error; return true; });
  return failure;
}

test("sorts failures by input index even when higher indexes reject first", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [deferred(), deferred(), deferred()];
  const arrived = [];
  const errors = [new Error("low"), new Error("middle"), new Error("high")];
  const run = runWithConcurrency([0, 1, 2], 3, async (index) => {
    started[index].resolve();
    await gates[index].promise;
    arrived.push(index);
    throw errors[index];
  });
  const failure = failureOf(run);
  await Promise.all(started.map(({ promise }) => promise));
  for (const index of [2, 1, 0]) {
    gates[index].resolve();
    await Promise.resolve();
  }
  const aggregate = await failure;
  assert.deepEqual(arrived, [2, 1, 0]);
  assert.deepEqual(aggregate.failures.map(({ index }) => index), [0, 1, 2]);
  assert.notDeepEqual(aggregate.failures.map(({ index }) => index), arrived);
});

test("preserves each error object identity", async () => {
  const errors = [new Error("same"), new Error("same")];
  const aggregate = await failureOf(runWithConcurrency([0, 1], 2, (index) => { throw errors[index]; }));
  assert.equal(aggregate.failures.length, 2);
  assert.strictEqual(aggregate.failures[0].error, errors[0]);
  assert.strictEqual(aggregate.failures[1].error, errors[1]);
  assert.notStrictEqual(aggregate.failures[0].error, aggregate.failures[1].error);
});

test("aggregates synchronous throws and asynchronous rejections", async () => {
  const sync = new Error("sync");
  const asyncError = new Error("async");
  const gate = deferred();
  const run = runWithConcurrency([0, 1], 2, (index) => {
    if (index === 0) throw sync;
    return gate.promise.then(() => { throw asyncError; });
  });
  const failure = failureOf(run);
  gate.resolve();
  const aggregate = await failure;
  assert.deepEqual(aggregate.failures.map(({ index }) => index), [0, 1]);
  assert.strictEqual(aggregate.failures[0].error, sync);
  assert.strictEqual(aggregate.failures[1].error, asyncError);
});

test("waits for a slow successful worker before rejecting", async () => {
  const gate = deferred();
  const started = deferred();
  const failed = deferred();
  let finished = false;
  let settled = false;
  const reason = new Error("failed");
  const run = runWithConcurrency([0, 1], 2, async (index) => {
    if (index === 0) { failed.resolve(); throw reason; }
    started.resolve();
    await gate.promise;
    finished = true;
    return "success";
  });
  const failure = failureOf(run.then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; }));
  await Promise.all([started.promise, failed.promise]);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(settled, false);
  gate.resolve();
  const aggregate = await failure;
  assert.equal(finished, true);
  assert.equal(settled, true);
  assert.strictEqual(aggregate.failures[0].error, reason);
});

test("executes every remaining item after multiple failures", async () => {
  const visited = [];
  const errors = [new Error("first"), new Error("second")];
  const aggregate = await failureOf(runWithConcurrency([0, 1, 2, 3, 4], 1, (index) => {
    visited.push(index);
    if (index < 2) throw errors[index];
    return index;
  }));
  assert.deepEqual(visited, [0, 1, 2, 3, 4]);
  assert.deepEqual(aggregate.failures.map(({ index }) => index), [0, 1]);
  assert.strictEqual(aggregate.failures[0].error, errors[0]);
  assert.strictEqual(aggregate.failures[1].error, errors[1]);
});

test("preserves a primitive rejection value without wrapping it", async () => {
  const aggregate = await failureOf(runWithConcurrency(["ok", "bad"], 2, (item) =>
    item === "bad" ? Promise.reject(0) : Promise.resolve("done")));
  assert.equal(aggregate.failures.length, 1);
  assert.equal(aggregate.failures[0].index, 1);
  assert.strictEqual(aggregate.failures[0].error, 0);
  assert.notStrictEqual(aggregate.failures[0].error, "0");
});

test("reports the exact failure count in the message", async () => {
  for (const count of [1, 3]) {
    const aggregate = await failureOf(runWithConcurrency(Array.from({ length: count }, (_, i) => i), 2, (i) => { throw new Error(String(i)); }));
    assert.equal(aggregate.failures.length, count);
    assert.equal(aggregate.message, `${count} standalone package build(s) failed`);
    assert.notEqual(aggregate.message, `${count + 1} standalone package build(s) failed`);
  }
});

test("a later successful invocation does not inherit earlier failures", async () => {
  const reason = new Error("earlier failure");
  const aggregate = await failureOf(runWithConcurrency(["bad"], 1, () => { throw reason; }));
  assert.strictEqual(aggregate.failures[0].error, reason);
  const result = await runWithConcurrency(["fresh"], 1, (item) => `${item}-success`);
  assert.deepEqual(result, ["fresh-success"]);
  assert.notDeepEqual(result, []);
});
