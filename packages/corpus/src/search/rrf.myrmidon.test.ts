import { describe, expect, it } from "vitest";

import {
  DEFAULT_FUSION_PARAMETERS,
  reciprocalRankFusion,
  assertFusionParameters,
} from "./rrf.js";

const parameters = { k0: 60, kCandidates: 100 };

describe("reciprocal rank fusion", () => {
  it("uses the pilot parameters by default", () => {
    expect(DEFAULT_FUSION_PARAMETERS).toEqual({ k0: 60, kCandidates: 100 });
  });

  it("scores a candidate found by both rankings above one found by a single ranking", () => {
    const fused = reciprocalRankFusion(["shared", "vector-only"], ["shared", "text-only"], parameters);
    expect(fused.map((candidate) => candidate.id)).toEqual(["shared", "vector-only", "text-only"]);
    expect(fused[0].score).toBeCloseTo(2 / 61, 12);
    expect(fused[0]).toMatchObject({ vectorRank: 1, fullTextRank: 1 });
    expect(fused[1]).toMatchObject({ vectorRank: 2, fullTextRank: null });
    expect(fused[2]).toMatchObject({ vectorRank: null, fullTextRank: 2 });
  });

  it("weights the head of a ranking more than its tail", () => {
    const fused = reciprocalRankFusion(["a", "b", "c"], [], parameters);
    const scores = new Map(fused.map((candidate) => [candidate.id, candidate.score]));
    expect(scores.get("a")).toBeGreaterThan(scores.get("b") ?? 0);
    expect(scores.get("b")).toBeGreaterThan(scores.get("c") ?? 0);
  });

  it("keeps the best rank of a duplicated id inside one ranking", () => {
    const fused = reciprocalRankFusion(["dup", "x", "dup"], [], parameters);
    expect(fused.find((candidate) => candidate.id === "dup")).toMatchObject({
      vectorRank: 1,
      score: 1 / 61,
    });
    expect(fused).toHaveLength(2);
  });

  it("only merges the first kCandidates rows of each ranking", () => {
    const vectorIds = Array.from({ length: 10 }, (_, index) => `v${index}`);
    const textIds = Array.from({ length: 10 }, (_, index) => `t${index}`);
    const fused = reciprocalRankFusion(vectorIds, textIds, { k0: 60, kCandidates: 3 });
    expect(fused.map((candidate) => candidate.id).sort()).toEqual(["t0", "t1", "t2", "v0", "v1", "v2"]);
  });

  it("orders equal scores deterministically, preferring the vector ranking", () => {
    // A tie on the fused score is broken by the best rank in each ranking: the vector ranking is
    // the primary signal of the index, then the full-text ranking, then the id.
    const vectorFirst = reciprocalRankFusion(["b"], ["a"], parameters);
    const textFirst = reciprocalRankFusion(["a"], ["b"], parameters);
    expect(vectorFirst.map((candidate) => candidate.id)).toEqual(["b", "a"]);
    expect(textFirst.map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list when both rankings are empty", () => {
    expect(reciprocalRankFusion([], [], parameters)).toEqual([]);
  });

  it("rejects fusion parameters outside the contract", () => {
    expect(() => assertFusionParameters({ k0: 0, kCandidates: 100 })).toThrow(RangeError);
    expect(() => assertFusionParameters({ k0: 60, kCandidates: 0 })).toThrow(RangeError);
    expect(() => reciprocalRankFusion([], [], { k0: 1.5, kCandidates: 10 })).toThrow(RangeError);
  });
});