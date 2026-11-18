import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { runMeasurement } from "./measure-board-start.mjs";

function harness(json) {
  const children = [];
  const probes = [];
  const lines = [];
  const result = runMeasurement(
    { cwd: "/unused", cmd: "unused", runs: 3, port: 3199, timeoutSec: 10, envPairs: [], json },
    {
      spawnImpl: () => {
        const child = new EventEmitter();
        children.push(child);
        return child;
      },
      fetchImpl: async () => {
        probes.push(children.length);
        return { status: 200 };
      },
      log: { log: (line) => lines.push(line) },
    },
  );
  return { children, probes, lines, result };
}

test("three measurements wait for each child close and mark only the first cold", async () => {
  const h = harness(true);
  for (let i = 1; i <= 3; i += 1) {
    await nextTurn();
    await nextTurn();
    assert.equal(h.children.length, i);
    assert.deepEqual(h.probes, Array.from({ length: i }, (_, index) => index + 1));
    await nextTurn();
    assert.equal(h.children.length, i, "readiness must not start the next child before close");
    h.children[i - 1].emit("close", 0, null);
  }
  const result = await h.result;
  assert.equal(h.children.length, 3);
  assert.deepEqual(result.runs.map(({ index, cold }) => ({ index, cold })), [
    { index: 1, cold: true }, { index: 2, cold: false }, { index: 3, cold: false },
  ]);
  for (const { elapsedMs } of result.runs) {
    assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
  }
  assert.deepEqual(h.lines, []);
});

test("failure before the second readiness rejects without starting a third run", async () => {
  const h = harness(false);
  await nextTurn();
  assert.deepEqual(h.probes, [1]);
  h.children[0].emit("close", 0, null);
  await nextTurn();
  assert.equal(h.children.length, 2);
  h.children[1].emit("close", 7, null);
  await assert.rejects(h.result, /run 2 failed:.*exit code 7/);
  await nextTurn();
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.probes, [1]);
  assert.equal(h.lines.length, 3);
  assert.equal(h.lines[0], "run 1/3: starting...");
  assert.match(h.lines[1], /^run 1\/3: \d+\.\d{3} s$/);
  assert.equal(h.lines[2], "run 2/3: starting...");
});

test("non-JSON progress reports exactly the started and completed successful runs", async () => {
  const h = harness(false);
  for (let i = 1; i <= 3; i += 1) {
    await nextTurn();
    await nextTurn();
    assert.equal(h.children.length, i);
    assert.equal(h.lines.length, i * 2 - 1);
    assert.equal(h.lines.at(-1), `run ${i}/3: starting...`);
    h.children[i - 1].emit("close", 0, null);
  }
  await h.result;
  assert.equal(h.lines.length, 6);
  for (let i = 1; i <= 3; i += 1) {
    assert.match(h.lines[i * 2 - 1], new RegExp(`^run ${i}/3: \\d+\\.\\d{3} s$`));
  }
});
