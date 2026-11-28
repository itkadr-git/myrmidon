import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./rrf.js";

function oracle(vector: readonly string[], text: readonly string[], kCandidates: number, k0: number) {
  const unique = (ids: readonly string[]) => [...new Set(ids)].slice(0, kCandidates);
  const v = unique(vector);
  const t = unique(text);
  return [...new Set([...v, ...t])].map((id) => {
    const vi = v.indexOf(id);
    const ti = t.indexOf(id);
    const vectorRank = vi < 0 ? null : vi + 1;
    const fullTextRank = ti < 0 ? null : ti + 1;
    return {
      id,
      vectorRank,
      fullTextRank,
      score: (vectorRank === null ? 0 : 1 / (k0 + vectorRank)) +
        (fullTextRank === null ? 0 : 1 / (k0 + fullTextRank)),
    };
  });
}

function repeated(ids: readonly string[]) {
  return ids.flatMap((id, index) => Array.from({ length: 8 + index * 3 }, () => id));
}

describe("RRF rank metamorphic properties", () => {
  for (const kCandidates of [1, 2, 5]) {
    for (const k0 of [1, 60]) {
      it(`matches the first-unique oracle at cap ${kCandidates} and k0 ${k0}`, () => {
        const vector = repeated(["shared", "v1", "v2", "v3", "v4", "v5", "v6"]);
        const text = repeated(["t1", "shared", "t2", "t3", "t4", "t5", "t6"]);
        const parameters = { kCandidates, k0 };
        const actual = reciprocalRankFusion(vector, text, parameters);
        const expected = oracle(vector, text, kCandidates, k0);
        expect(actual).toHaveLength(expected.length);
        expect(new Set(actual.map(({ id }) => id)).size).toBe(actual.length);
        for (const candidate of actual) {
          expect(candidate).toEqual(expected.find(({ id }) => id === candidate.id));
          expect(Number.isFinite(candidate.score)).toBe(true);
          expect(candidate.score).toBeGreaterThan(0);
        }
        for (let i = 1; i < actual.length; i++) {
          expect(actual[i - 1].score).toBeGreaterThanOrEqual(actual[i].score);
        }
      });

      it(`is invariant to duplicate insertion and post-cap tails at cap ${kCandidates} and k0 ${k0}`, () => {
        const vector = ["shared", "v1", "v2", "v3", "v4"];
        const text = ["t1", "shared", "t2", "t3", "t4"];
        const parameters = { kCandidates, k0 };
        const baseline = reciprocalRankFusion(vector, text, parameters);
        expect(reciprocalRankFusion(repeated(vector), repeated(text), parameters)).toEqual(baseline);
        expect(reciprocalRankFusion([...vector, "late-v", "late-shared"], [...text, "late-t", "late-shared"], parameters)).toEqual(baseline);
      });
    }
  }

  it("does not mutate frozen inputs or retain candidates across calls", () => {
    const vector = Object.freeze(["shared", "v", "shared"]);
    const text = Object.freeze(["t", "shared", "t"]);
    const beforeVector = [...vector];
    const beforeText = [...text];
    const parameters = { kCandidates: 2, k0: 60 };
    const first = reciprocalRankFusion(vector, text, parameters);
    expect(vector).toEqual(beforeVector);
    expect(text).toEqual(beforeText);
    expect(reciprocalRankFusion(["new"], [], parameters)).toEqual([
      { id: "new", score: 1 / 61, vectorRank: 1, fullTextRank: null },
    ]);
    expect(reciprocalRankFusion([], [], parameters)).toEqual([]);
    expect(reciprocalRankFusion(vector, text, parameters)).toEqual(first);
  });
});
