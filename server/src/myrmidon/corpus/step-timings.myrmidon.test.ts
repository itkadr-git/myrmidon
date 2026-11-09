// server/src/myrmidon/corpus/step-timings.myrmidon.test.ts
//
// OPE-12272 (second hot-path change): one search in N writes its step timings on the info log.

import { describe, expect, it } from "vitest";
import {
  CORPUS_STEP_TIMINGS_SAMPLE_ENV,
  DEFAULT_STEP_TIMINGS_SAMPLE,
  createStepTimingsSampler,
  readStepTimingsSample,
} from "./step-timings.js";

describe("readStepTimingsSample", () => {
  it("defaults to every 20th search", () => {
    expect(CORPUS_STEP_TIMINGS_SAMPLE_ENV).toBe("MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE");
    expect(DEFAULT_STEP_TIMINGS_SAMPLE).toBe(20);
    for (const raw of [undefined, "", "  "]) expect(readStepTimingsSample(raw)).toBe(20);
  });

  it("reads a whole number, 1 for every search and 0 for none", () => {
    expect(readStepTimingsSample("1")).toBe(1);
    expect(readStepTimingsSample(" 5 ")).toBe(5);
    expect(readStepTimingsSample("0")).toBe(0);
  });

  it("reads a typo as the default, and caps a huge value", () => {
    for (const raw of ["abc", "-3", "2.5", "1e3", "10x"]) expect(readStepTimingsSample(raw), raw).toBe(20);
    expect(readStepTimingsSample("99999999999")).toBe(1_000_000);
  });
});

describe("step timings sampler", () => {
  const picks = (sample: number, calls: number) => {
    const sampler = createStepTimingsSampler();
    const hits: number[] = [];
    for (let call = 1; call <= calls; call += 1) if (sampler.next(sample)) hits.push(call);
    return hits;
  };

  it("picks every N-th call", () => {
    expect(picks(20, 100)).toEqual([20, 40, 60, 80, 100]);
    expect(picks(3, 10)).toEqual([3, 6, 9]);
  });

  it("picks every call when N is 1, and none when N is 0", () => {
    expect(picks(1, 4)).toEqual([1, 2, 3, 4]);
    expect(picks(0, 50)).toEqual([]);
  });

  it("keeps one counter per sampler", () => {
    const first = createStepTimingsSampler();
    const second = createStepTimingsSampler();
    expect([first.next(2), first.next(2)]).toEqual([false, true]);
    expect([second.next(2), second.next(2)]).toEqual([false, true]);
  });
});
