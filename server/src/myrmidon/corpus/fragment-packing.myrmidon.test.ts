import { describe, expect, it } from "vitest";
import type { CorpusChunkHit } from "./contract.js";
import { packCitedFragments } from "./fragment-packing.js";

const hit = (id: string, text: string, score: number): CorpusChunkHit => ({
  chunkId: `chunk-${id}`,
  ordinal: Number(id),
  text,
  score,
  document: {
    id: `doc-${id}`,
    name: `guide-${id}.md`,
    datasetId: "docs",
    datasetName: "Documentation",
    url: `/corpus/documents/doc-${id}`,
  },
});

describe("packCitedFragments", () => {
  it("keeps the assembled context within the token budget", () => {
    const packed = packCitedFragments(
      [
        hit("1", "A relevant paragraph with enough words to consume budget.", 0.95),
        hit("2", "Another relevant paragraph that should fit when budget allows.", 0.9),
      ],
      { tokenBudget: 30 },
    );

    expect(Math.ceil(packed.text.length / 4)).toBeLessThanOrEqual(30);
    expect(packed.tokenCount).toBe(Math.ceil(packed.text.length / 4));
    expect(packed.fragments.length).toBeGreaterThan(0);
  });

  it("excludes low relevance hits and cites every selected source", () => {
    const packed = packCitedFragments(
      [hit("1", "high relevance", 0.8), hit("2", "not relevant", 0.2)],
      { tokenBudget: 100, minScore: 0.5 },
    );

    expect(packed.fragments).toHaveLength(1);
    expect(packed.fragments[0]?.source.id).toBe("doc-1");
    expect(packed.fragments[0]?.citation).toContain("doc-1");
    expect(packed.text).toContain("[Source:");
    expect(packed.text).not.toContain("not relevant");
  });

  it("does not split a fragment when the next citation would exceed budget", () => {
    const first = hit("1", "first", 1);
    const second = hit("2", "second", 0.99);
    const firstOnly = packCitedFragments([first], { tokenBudget: 100 });
    const packed = packCitedFragments([first, second], {
      tokenBudget: firstOnly.tokenCount + 1,
    });

    expect(packed.fragments.map((fragment) => fragment.chunkId)).toEqual(["chunk-1"]);
    expect(packed.text).not.toContain("second");
  });
});
