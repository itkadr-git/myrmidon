import assert from "node:assert/strict";
import { it } from "node:test";
import { buildResult } from "./measure-board-start.mjs";

it("serializes fractional run times and the supplied summary without mutation or env values", () => {
  const opts = Object.freeze({
    cmd: "node fixture.mjs --mode=sample",
    cwd: "/fixture/work dir",
    port: 4567,
    timeoutSec: 12,
    envPairs: Object.freeze(["EMPTY=", "TOKEN=value-sentinel=second-sentinel"]),
  });
  const runs = Object.freeze([
    Object.freeze({ index: 7, elapsedMs: 1234.5678, cold: true }),
    Object.freeze({ index: 3, elapsedMs: 2345.6789, cold: false }),
    Object.freeze({ index: 9, elapsedMs: 3456.7891, cold: false }),
  ]);
  // Deliberately different from the samples, so recomputing the summary fails.
  const summary = Object.freeze({ min: 4567.1234, median: 5678.4567, max: 6789.9876 });
  const before = structuredClone({ opts, runs, summary });

  const json = JSON.stringify(buildResult(opts, runs, summary));
  assert.deepEqual(JSON.parse(json), {
    cmd: "node fixture.mjs --mode=sample",
    cwd: "/fixture/work dir",
    port: 4567,
    timeoutSec: 12,
    envKeys: ["EMPTY", "TOKEN"],
    runs: [
      { run: 7, seconds: 1.235, cold: true },
      { run: 3, seconds: 2.346, cold: false },
      { run: 9, seconds: 3.457, cold: false },
    ],
    summary: { minSeconds: 4.567, medianSeconds: 5.678, maxSeconds: 6.79 },
  });
  assert.ok(!json.includes("value-sentinel"));
  assert.ok(!json.includes("second-sentinel"));
  assert.deepEqual({ opts, runs, summary }, before);
});
