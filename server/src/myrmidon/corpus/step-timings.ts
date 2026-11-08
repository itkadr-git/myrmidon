// server/src/myrmidon/corpus/step-timings.ts
//
// OPE-12272 (second hot-path change): the step timings of a corpus search are written on the debug
// log, which a production board does not keep on. A sample of them is written on the info log
// instead: one search in N, so the split of a slow search (settings, dataset names, embedding, index,
// document names) can be read from the production log without debug and without a line per search.

/** Every N-th search writes its step timings on the info log; the others write them on debug. */
export const CORPUS_STEP_TIMINGS_SAMPLE_ENV = "MYRMIDON_CORPUS_STEP_TIMINGS_SAMPLE";
export const DEFAULT_STEP_TIMINGS_SAMPLE = 20;

/** A sample above this is a typo: one line per million searches is no sample. */
const MAX_STEP_TIMINGS_SAMPLE = 1_000_000;

/**
 * The N of "one search in N". Unset, empty, non-numeric, fractional or negative reads as the
 * default; `0` is an explicit "never on info" (the timings stay on debug); `1` is every search;
 * a value above one million reads as one million.
 */
export function readStepTimingsSample(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return DEFAULT_STEP_TIMINGS_SAMPLE;
  return Math.min(Number(text), MAX_STEP_TIMINGS_SAMPLE);
}

export interface StepTimingsSampler {
  /** True for every `sample`-th call (the `sample`-th, the 2 * `sample`-th, ...); false when `sample` is 0. */
  next(sample: number): boolean;
}

/** One counter per kind of line, so a kind that is written often does not starve another. */
export function createStepTimingsSampler(): StepTimingsSampler {
  let calls = 0;
  return {
    next(sample) {
      if (!Number.isInteger(sample) || sample <= 0) return false;
      calls += 1;
      return calls % sample === 0;
    },
  };
}
