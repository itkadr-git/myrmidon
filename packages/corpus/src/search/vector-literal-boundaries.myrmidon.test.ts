import { describe, expect, it } from "vitest";

import { assertEmbeddingVector, EmbeddingVectorError, toPgVectorLiteral } from "./vector.js";

describe("pgvector literal numeric boundaries", () => {
  it.each([
    { vector: [0], literal: "[0]" },
    { vector: [-0], literal: "[0]" },
    { vector: [42], literal: "[42]" },
    { vector: [-42], literal: "[-42]" },
    { vector: [1.25], literal: "[1.25]" },
    { vector: [-1.5], literal: "[-1.5]" },
    { vector: [0.000001], literal: "[0.000001]" },
    { vector: [-0.000001], literal: "[-0.000001]" },
    { vector: [0.00000001], literal: "[0.00000001]" },
    { vector: [-0.00000001], literal: "[-0.00000001]" },
    { vector: [0.000000001], literal: "[0.0]" },
    { vector: [-0.000000001], literal: "[-0.0]" },
    { vector: [1.234567891], literal: "[1.23456789]" },
    { vector: [1.234567899], literal: "[1.2345679]" },
    { vector: [-1.234567899], literal: "[-1.2345679]" },
    { vector: [1e21], literal: "[1e+21]" },
    { vector: [1.2, -0], literal: "[1.2,0]" },
    { vector: [0.125, -2, 1e21, 0.00000001], literal: "[0.125,-2,1e+21,0.00000001]" },
  ])("serializes $vector as $literal without changing it", ({ vector, literal }) => {
    const frozen = Object.freeze(vector);
    const before = [...frozen];
    expect(toPgVectorLiteral(frozen)).toBe(literal);
    expect(frozen).toEqual(before);
  });

  it.each([
    { vector: [], code: "empty" },
    { vector: [Number.NaN], code: "value" },
    { vector: [1, Number.POSITIVE_INFINITY], code: "value" },
    { vector: [Number.NEGATIVE_INFINITY], code: "value" },
  ])("rejects $vector with code $code", ({ vector, code }) => {
    try {
      toPgVectorLiteral(vector);
      expect.fail("expected EmbeddingVectorError");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingVectorError);
      expect(error).toMatchObject({ code });
    }
  });

  it.each([
    { vector: [1], literal: "[1]" },
    { vector: [1, 2], literal: "[1,2]" },
    { vector: [1, 2, 3, 4], literal: "[1,2,3,4]" },
  ])("serializes width $vector.length independently of the dimension guard", ({ vector, literal }) => {
    expect(() => assertEmbeddingVector(vector, 1024)).toThrow(EmbeddingVectorError);
    try {
      assertEmbeddingVector(vector, 1024);
      expect.fail("expected dimension error");
    } catch (error) {
      expect(error).toMatchObject({ code: "dimension" });
    }
    expect(toPgVectorLiteral(vector)).toBe(literal);
  });
});
