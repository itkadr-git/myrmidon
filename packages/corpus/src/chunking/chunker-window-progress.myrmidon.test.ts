import { describe, expect, it } from "vitest";
import { chunkDocumentText } from "./chunker.js";

const documentId = "window-progress";
type Expected = [number, number, string][];

const cases: { text: string; overlap: number; expected: Expected }[] = [
  { text: "abc", overlap: 0, expected: [[0, 3, "abc"]] },
  { text: "abcd", overlap: 0, expected: [[0, 4, "abcd"]] },
  { text: "abcde", overlap: 0, expected: [[0, 4, "abcd"], [4, 5, "e"]] },
  { text: "abcdefgh", overlap: 0, expected: [[0, 4, "abcd"], [4, 8, "efgh"]] },
  { text: "abc", overlap: 1, expected: [[0, 3, "abc"]] },
  { text: "abcd", overlap: 1, expected: [[0, 4, "abcd"]] },
  { text: "abcde", overlap: 1, expected: [[0, 4, "abcd"], [3, 5, "de"]] },
  { text: "abcdefgh", overlap: 1, expected: [[0, 4, "abcd"], [3, 7, "defg"], [6, 8, "gh"]] },
  { text: "abc", overlap: 3, expected: [[0, 3, "abc"]] },
  { text: "abcd", overlap: 3, expected: [[0, 4, "abcd"]] },
  { text: "abcde", overlap: 3, expected: [[0, 4, "abcd"], [1, 5, "bcde"]] },
  { text: "abcdefgh", overlap: 3, expected: [[0, 4, "abcd"], [1, 5, "bcde"], [2, 6, "cdef"], [3, 7, "defg"], [4, 8, "efgh"]] },
  { text: "abcde\nx", overlap: 1, expected: [[0, 4, "abcd"], [3, 5, "de"], [6, 7, "x"]] },
  { text: "x\nabcde", overlap: 1, expected: [[0, 1, "x"], [2, 6, "abcd"], [5, 7, "de"]] },
  { text: "a\nb\nc", overlap: 1, expected: [[0, 3, "a\nb"], [2, 5, "b\nc"]] },
  { text: "a\nb\nc", overlap: 0, expected: [[0, 3, "a\nb"], [4, 5, "c"]] },
];

describe("chunk window progress", () => {
  it.each(cases)("preserves exact windows for $text, overlap $overlap", ({ text, overlap, expected }) => {
    const request = { documentId, text, chunking: { minChars: 1, maxChars: 4, overlapChars: overlap } };
    const snapshot = structuredClone(request);
    const chunks = chunkDocumentText(request);
    expect(request).toEqual(snapshot);
    expect(chunks.map(({ startOffset, endOffset, content }) => [startOffset, endOffset, content])).toEqual(expected);
    expect(chunks.map(({ ordinal }) => ordinal)).toEqual(expected.map((_, index) => index));
    expect(chunks.at(-1)?.endOffset).toBe(text.length);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startOffset).toBeGreaterThan(chunks[i - 1].startOffset);
    expect(chunkDocumentText(request)).toEqual(chunks);
  });

  it("makes bounded progress over deterministic small parameters", () => {
    for (let maxChars = 1; maxChars <= 6; maxChars++) {
      for (let overlapChars = 0; overlapChars < maxChars; overlapChars++) {
        for (let length = 1; length <= 2 * maxChars + 1; length++) {
          const text = "abcdefghijklm".slice(0, length);
          const chunks = chunkDocumentText({ documentId, text, chunking: { minChars: 1, maxChars, overlapChars } });
          expect(chunks.length).toBeGreaterThan(0);
          expect(chunks.length).toBeLessThanOrEqual(length);
          expect(chunks.at(-1)?.endOffset).toBe(length);
          chunks.forEach((chunk, index) => {
            expect(chunk.ordinal).toBe(index);
            expect(chunk.endOffset - chunk.startOffset).toBeLessThanOrEqual(maxChars);
            expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
            if (index) expect(chunk.startOffset).toBeGreaterThan(chunks[index - 1].startOffset);
          });
        }
      }
    }
  }, 5_000);
});
