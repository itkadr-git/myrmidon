import { describe, expect, it } from "vitest";

import {
  CORPUS_EMBEDDING_DIMENSIONS,
  EmbeddingVectorError,
  assertEmbeddingVector,
  cosineSimilarity,
  isL2Normalized,
  l2Normalize,
  toPgVectorLiteral,
} from "./vector.js";

function unitVector(dimensions = CORPUS_EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
}

describe("corpus embedding vectors", () => {
  it("accepts a vector with the configured number of finite components", () => {
    expect(assertEmbeddingVector(unitVector())).toHaveLength(CORPUS_EMBEDDING_DIMENSIONS);
  });

  it("rejects a vector of the wrong length", () => {
    expect(() => assertEmbeddingVector([1, 2, 3])).toThrow(EmbeddingVectorError);
    expect(() => assertEmbeddingVector(unitVector(8), 1024)).toThrow(/1024/);
  });

  it("rejects non-finite components and an empty vector", () => {
    const withNaN = unitVector(4);
    withNaN[2] = Number.NaN;
    expect(() => assertEmbeddingVector(withNaN, 4)).toThrow(/finite/);
    expect(() => assertEmbeddingVector([], 4)).toThrow(/empty/);
  });

  it("normalizes to unit length and is idempotent", () => {
    const normalized = l2Normalize([3, 4, 0, 0]);
    expect(normalized[0]).toBeCloseTo(0.6, 10);
    expect(normalized[1]).toBeCloseTo(0.8, 10);
    expect(isL2Normalized(normalized)).toBe(true);
    expect(l2Normalize(normalized)).toEqual(normalized);
  });

  it("refuses to normalize a zero vector", () => {
    expect(() => l2Normalize([0, 0, 0])).toThrow(EmbeddingVectorError);
  });

  it("writes the literal pgvector expects", () => {
    expect(toPgVectorLiteral([0.5, -1, 2])).toBe("[0.5,-1,2]");
    expect(toPgVectorLiteral([1e21])).toBe("[1e+21]");
    expect(() => toPgVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/finite/);
  });

  it("computes cosine similarity of normalized vectors", () => {
    const first = l2Normalize([1, 1, 0, 0]);
    const second = l2Normalize([1, 0, 0, 0]);
    expect(cosineSimilarity(first, second)).toBeCloseTo(Math.SQRT1_2, 10);
    expect(cosineSimilarity(first, first)).toBeCloseTo(1, 10);
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(EmbeddingVectorError);
  });
});