import { describe, expect, it } from "vitest";
import type { CorpusChunkHit } from "./contract.js";
import {
  estimateFragmentTokens,
  isPackedContextValid,
  packCitedFragments,
  validatePackedFragments,
} from "./fragment-packing.js";

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
      { tokenBudget: 40 },
    );

    expect(packed.tokenCount).toBeLessThanOrEqual(40);
    expect(estimateFragmentTokens(packed.text)).toBe(packed.tokenCount);
    expect(packed.fragments.length).toBeGreaterThan(0);
    expect(validatePackedFragments(packed, 40)).toBe(true);
  });

  it("safely bounds non-Latin text (Cyrillic and CJK) without token undercounting", () => {
    const cyrillic = hit(
      "ru",
      "Оплата по договору производится в полном объеме в течение тридцати рабочих дней.",
      0.95,
    );
    const cjk = hit("zh", "知识库文档内容检索与片段重排算法验证。", 0.92);

    const cyrillicTokens = estimateFragmentTokens(`[Source: guide-ru.md (doc-ru, chunk chunk-ru)]\n${cyrillic.text}`);
    // Naive ceil(length / 4) undercounts Cyrillic substantially; estimateFragmentTokens provides a safe bound
    expect(cyrillicTokens).toBeGreaterThan(Math.ceil(cyrillic.text.length / 4));

    const packed = packCitedFragments([cyrillic, cjk], { tokenBudget: cyrillicTokens });
    expect(packed.fragments).toHaveLength(1);
    expect(packed.fragments[0]?.chunkId).toBe("chunk-ru");
    expect(packed.tokenCount).toBeLessThanOrEqual(cyrillicTokens);
    expect(validatePackedFragments(packed, cyrillicTokens)).toBe(true);
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
    expect(validatePackedFragments(packed, 100)).toBe(true);
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
    expect(packed.tokenCount).toBe(firstOnly.tokenCount);
    expect(validatePackedFragments(packed, firstOnly.tokenCount + 1)).toBe(true);
  });

  it("returns false if budget exceeded or citation absent", () => {
    const valid = packCitedFragments([hit("1", "valid content", 0.9)], { tokenBudget: 50 });
    expect(isPackedContextValid(valid, 50)).toBe(true);

    // False if budget exceeded
    expect(isPackedContextValid(valid, valid.tokenCount - 1)).toBe(false);

    // False if reported token count artificially lowered but text exceeds budget
    const spoofedCount = { ...valid, tokenCount: 5 };
    expect(isPackedContextValid(spoofedCount, 10)).toBe(false);

    // False if citation absent or empty
    const missingCitation = {
      ...valid,
      fragments: [{ ...valid.fragments[0]!, citation: "" }],
    };
    expect(isPackedContextValid(missingCitation, 50)).toBe(false);

    // False if citation does not reference document
    const detachedCitation = {
      ...valid,
      fragments: [{ ...valid.fragments[0]!, citation: "[Source: unrelated]" }],
    };
    expect(isPackedContextValid(detachedCitation, 50)).toBe(false);
  });

  it("respects a custom token estimator when provided", () => {
    const customEstimator = (text: string) => text.split(/\s+/).length * 10;
    const packed = packCitedFragments([hit("1", "word word word", 0.9)], {
      tokenBudget: 1000,
      estimateTokens: customEstimator,
    });
    expect(packed.tokenCount).toBe(customEstimator(packed.text));
    expect(validatePackedFragments(packed, 1000, { estimateTokens: customEstimator })).toBe(true);
  });
});
