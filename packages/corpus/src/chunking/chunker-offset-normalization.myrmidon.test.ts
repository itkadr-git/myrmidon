import { describe, expect, it } from "vitest";

import { chunkDocumentText } from "./chunker.js";

const documentId = "offset-normalization";

const cases = [
  { name: "spaces", text: "  alpha  ", expected: [{ content: "alpha", startOffset: 2, endOffset: 7 }] },
  { name: "tabs", text: "\talpha\t", expected: [{ content: "alpha", startOffset: 1, endOffset: 6 }] },
  { name: "vertical tab and form feed", text: "\v\fA\f\v", expected: [{ content: "A", startOffset: 2, endOffset: 3 }] },
  { name: "LF lines", text: " a \n b ", expected: [{ content: "a \n b", startOffset: 1, endOffset: 6 }] },
  { name: "CRLF lines", text: " a \r\n b ", expected: [{ content: "a \n b", startOffset: 1, endOffset: 6 }] },
  { name: "CR lines", text: " a \r b ", expected: [{ content: "a \n b", startOffset: 1, endOffset: 6 }] },
  { name: "mixed line endings", text: "a\r\nb\rc\nd", expected: [{ content: "a\nb\nc\nd", startOffset: 0, endOffset: 7 }] },
  { name: "blank lines", text: "\r\n \r\n a\r\n\r\nb \r\n", expected: [{ content: "a\n\nb", startOffset: 4, endOffset: 8 }] },
  { name: "Cyrillic", text: " \u041f\u0440\u0438\u0432\u0435\u0442 \r\n \u043c\u0438\u0440 ", expected: [{ content: "\u041f\u0440\u0438\u0432\u0435\u0442 \n \u043c\u0438\u0440", startOffset: 1, endOffset: 13 }] },
  { name: "emoji uses UTF-16 offsets", text: " \ud83d\ude00\r\n x ", expected: [{ content: "\ud83d\ude00\n x", startOffset: 1, endOffset: 6 }] },
  { name: "NBSP is not ASCII trim", text: " \u00a0x\u00a0 ", expected: [{ content: "\u00a0x\u00a0", startOffset: 1, endOffset: 4 }] },
  { name: "NBSP alone is content", text: "\t\u00a0\r\n", expected: [{ content: "\u00a0", startOffset: 1, endOffset: 2 }] },
  { name: "only ASCII whitespace", text: " \t\r\n\v\f\r", expected: [] },
];

describe("chunk offsets after normalization", () => {
  it.each(cases)("returns literal normalized offsets for $name", ({ text, expected }) => {
    const chunks = chunkDocumentText({ documentId, text });
    expect(chunks.map(({ content, startOffset, endOffset }) => ({ content, startOffset, endOffset }))).toEqual(expected);
  });

  it("keeps offsets for separate windows after mixed line endings", () => {
    const chunks = chunkDocumentText({ documentId, text: " a\r\nb\rc\nd ", chunking: { minChars: 1, maxChars: 3, overlapChars: 0 } });
    expect(chunks.map(({ content, startOffset, endOffset }) => ({ content, startOffset, endOffset }))).toEqual([
      { content: "a", startOffset: 1, endOffset: 2 },
      { content: "b", startOffset: 3, endOffset: 4 },
      { content: "c", startOffset: 5, endOffset: 6 },
      { content: "d", startOffset: 7, endOffset: 8 },
    ]);
  });

  it("does not mutate a frozen request and returns the same result twice", () => {
    const chunking = Object.freeze({ minChars: 1, maxChars: 3, overlapChars: 0 });
    const request = Object.freeze({ documentId, text: " a\r\nb\rc\nd ", chunking });
    const first = chunkDocumentText(request);
    expect(chunkDocumentText(request)).toEqual(first);
    expect(request).toEqual({ documentId, text: " a\r\nb\rc\nd ", chunking: { minChars: 1, maxChars: 3, overlapChars: 0 } });
  });
});
