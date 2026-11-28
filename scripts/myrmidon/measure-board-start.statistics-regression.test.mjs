import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResult, parseArgs, summarize } from "./measure-board-start.mjs";

describe("measure-board-start statistics regressions", () => {
  it("computes exact min, median, and max without mutating unsorted odd samples", () => {
    const runs = Object.freeze([
      Object.freeze({ elapsedMs: 425.75 }),
      Object.freeze({ elapsedMs: 100.25 }),
      Object.freeze({ elapsedMs: 300.5 }),
    ]);
    const before = runs.map((run) => ({ ...run }));

    assert.deepEqual(summarize(runs), {
      min: 100.25,
      median: 300.5,
      max: 425.75,
    });
    assert.deepEqual(runs, before);
  });

  it("averages the middle values for even samples without reordering the input", () => {
    const runs = Object.freeze([
      Object.freeze({ elapsedMs: 900.125 }),
      Object.freeze({ elapsedMs: 100.875 }),
      Object.freeze({ elapsedMs: 500.25 }),
      Object.freeze({ elapsedMs: 300.625 }),
    ]);
    const before = runs.map((run) => ({ ...run }));

    assert.deepEqual(summarize(runs), {
      min: 100.875,
      median: 400.4375,
      max: 900.125,
    });
    assert.deepEqual(runs, before);
  });

  it("returns the zero summary for empty input and the value for a singleton", () => {
    assert.deepEqual(summarize([]), { min: 0, median: 0, max: 0 });
    assert.deepEqual(summarize([Object.freeze({ elapsedMs: 1234.567 })]), {
      min: 1234.567,
      median: 1234.567,
      max: 1234.567,
    });
  });

  it("builds rounded seconds while preserving run cold flags and only env names", () => {
    const opts = parseArgs([
      "--cwd", "/synthetic/fixture",
      "--cmd", "node synthetic-server.mjs",
      "--port", "4567",
      "--timeout-sec", "12",
      "--env", "SECRET_TOKEN=SECRET_SENTINEL",
      "--env", "FEATURE_FLAG=enabled",
      "--json",
    ]);
    const runs = Object.freeze([
      Object.freeze({ index: 1, firstHttp200Ms: 1000, elapsedMs: 1234.5678, cold: true }),
      Object.freeze({ index: 2, firstHttp200Ms: 2000, elapsedMs: 2500.5, cold: false }),
    ]);
    const summary = Object.freeze({ min: 1234.5678, median: 1867.5339, max: 2500.5 });

    const result = buildResult(opts, runs, summary);

    assert.deepEqual(result.runs, [
      { run: 1, firstHttp200Seconds: 1, seconds: 1.235, cold: true },
      { run: 2, firstHttp200Seconds: 2, seconds: 2.501, cold: false },
    ]);
    assert.deepEqual(result.summary, {
      minSeconds: 1.235,
      medianSeconds: 1.868,
      maxSeconds: 2.501,
      firstHttp200MinSeconds: 1,
      firstHttp200MedianSeconds: 1.5,
      firstHttp200MaxSeconds: 2,
    });
    assert.deepEqual(result.envKeys, ["SECRET_TOKEN", "FEATURE_FLAG"]);
    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes("SECRET_TOKEN"));
    assert.ok(serialized.includes("FEATURE_FLAG"));
    assert.ok(!serialized.includes("SECRET_SENTINEL"));
    assert.ok(!serialized.includes("enabled"));
  });
});
