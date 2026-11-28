import assert from "node:assert/strict";
import test from "node:test";
import { selectCloudCache } from "../../select-cloud-cache.mjs";

const image = "ghcr.io/example/cloud";
const commits = ["a", "b", "c"].map((letter) => letter.repeat(40));
const refs = [...commits.map((sha) => `${image}:buildcache-cloud-${sha}`), `${image}:buildcache-cloud`];
const failed = (ref) => `Could not inspect cloud cache ${ref}; trying the next ancestor.`;
const used = (ref) => `Using cloud cache: ${ref}`;
const cold = "No cloud cache is available; this build will populate one.";

const scenarios = [
  { name: "sync first hit stops all later lookups", results: [true], source: 0, logs: [used(refs[0])] },
  { name: "sync miss then ancestor hit", results: [false, true], source: 1, logs: [used(refs[1])] },
  { name: "sync exception then older ancestor hit", results: ["throw", false, true], source: 2, logs: [failed(refs[0]), used(refs[2])] },
  { name: "rejection then ancestor hit", results: ["reject", true], source: 1, logs: [failed(refs[0]), used(refs[1])] },
  { name: "misses and mixed errors reach legacy", results: [false, "throw", "reject", true], source: 3, logs: [failed(refs[1]), failed(refs[2]), used(refs[3])] },
  { name: "all synchronous misses produce one cold build", results: [false, false, false, false], source: null, logs: [cold] },
  { name: "all asynchronous misses produce one cold build", results: ["asyncFalse", "asyncFalse", "asyncFalse", "asyncFalse"], source: null, logs: [cold] },
  { name: "each error belongs to its own ref before cold build", results: ["throw", "reject", false, "reject"], source: null, logs: [failed(refs[0]), failed(refs[1]), failed(refs[3]), cold] },
  { name: "async hit stops before legacy", results: ["asyncFalse", "asyncFalse", "asyncTrue"], source: 2, logs: [used(refs[2])] },
];

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const calls = [];
    const logs = [];
    const source = await selectCloudCache(image, commits, {
      exists(ref) {
        const result = scenario.results[calls.length];
        calls.push(ref);
        if (result === "throw") throw new Error(`sync ${ref}`);
        if (result === "reject") return Promise.reject(new Error(`async ${ref}`));
        if (result === "asyncFalse") return Promise.resolve(false);
        if (result === "asyncTrue") return Promise.resolve(true);
        return result;
      },
      log: (message) => logs.push(message),
    });
    assert.equal(source, scenario.source === null ? "" : `type=registry,ref=${refs[scenario.source]}`);
    assert.deepEqual(calls, refs.slice(0, scenario.results.length));
    assert.deepEqual(logs, scenario.logs);
  });
}

test("pending lookups run one at a time and stop on the first hit", async () => {
  const calls = [];
  const logs = [];
  const pending = [];
  let active = 0;
  let maxActive = 0;
  const selection = selectCloudCache(image, commits, {
    exists(ref) {
      calls.push(ref);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => pending.push((value) => { active -= 1; resolve(value); }));
    },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(calls, [refs[0]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [refs[0]]);
  pending[0](false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, refs.slice(0, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, refs.slice(0, 2));
  pending[1](true);
  assert.equal(await selection, `type=registry,ref=${refs[1]}`);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.deepEqual(calls, refs.slice(0, 2));
  assert.deepEqual(logs, [used(refs[1])]);
});
