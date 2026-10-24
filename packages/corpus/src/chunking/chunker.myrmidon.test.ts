import { describe, expect, it } from "vitest";

import { chunkDocumentText, chunkId } from "./chunker.js";
import { DEFAULT_CHUNKING_OPTIONS, resolveChunkingOptions, type TextChunk } from "./types.js";

const documentId = "11111111-2222-3333-4444-555555555555";

/** Document made of `count` lines of exactly `length` characters. */
function documentOfLines(count: number, length: number, fill = "x"): string {
  return Array.from({ length: count }, () => fill.repeat(length)).join("\n");
}

function expectLineBoundaries(text: string, chunks: readonly TextChunk[]): void {
  for (const chunk of chunks) {
    expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
    expect(chunk.content).not.toMatch(/^\s|\s$/);
    if (chunk.startOffset > 0) expect(text[chunk.startOffset - 1]).toBe("\n");
    if (chunk.endOffset < text.length) expect(text[chunk.endOffset]).toBe("\n");
  }
}

describe("corpus document chunker", () => {
  it("keeps the pilot window as the default", () => {
    expect(resolveChunkingOptions()).toEqual({ minChars: 300, maxChars: 1500, overlapChars: 150 });
    expect(DEFAULT_CHUNKING_OPTIONS.maxChars).toBe(1500);
  });

  it("splits a long document into windows that fit maxChars and share text", () => {
    const text = documentOfLines(10, 200);
    const chunks = chunkDocumentText({ documentId, text });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[chunks.length - 1].endOffset).toBe(text.length);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(1500);
    for (let index = 1; index < chunks.length; index += 1) {
      expect(chunks[index].ordinal).toBe(index);
      expect(chunks[index].startOffset).toBeGreaterThan(chunks[index - 1].startOffset);
      expect(chunks[index].startOffset).toBeLessThan(chunks[index - 1].endOffset);
    }
    expectLineBoundaries(text, chunks);
  });

  it("keeps every window but the last at or above minChars", () => {
    const text = documentOfLines(20, 90);
    const chunks = chunkDocumentText({ documentId, text });
    for (const chunk of chunks.slice(0, -1)) expect(chunk.content.length).toBeGreaterThanOrEqual(300);
  });

  it("puts boundaries on line breaks for ragged lines", () => {
    // Every line fits in a window, so no window may start or end inside a line.
    const text = ["short line", "another line of text", "a third line, longer than the rest", "x".repeat(200)]
      .join("\n")
      .repeat(4);
    const chunks = chunkDocumentText({ documentId, text, chunking: { maxChars: 320, minChars: 100, overlapChars: 50 } });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(320);
    expectLineBoundaries(text, chunks);
  });

  it("is idempotent: the same document always yields the same ids and offsets", () => {
    const text = documentOfLines(12, 150);
    const first = chunkDocumentText({ documentId, text });
    const second = chunkDocumentText({ documentId, text });
    expect(second).toEqual(first);
    for (const chunk of first) {
      expect(chunk.id).toBe(chunkId(documentId, chunk.ordinal, chunk.content));
    }
    const other = chunkDocumentText({ documentId: "another-document", text });
    expect(other.map((chunk) => chunk.id)).not.toEqual(first.map((chunk) => chunk.id));
    expect(other.map((chunk) => chunk.content)).toEqual(first.map((chunk) => chunk.content));
  });

  it("splits a single line that does not fit into a window", () => {
    const text = "y".repeat(4_000);
    const chunks = chunkDocumentText({ documentId, text, chunking: { maxChars: 1_500, minChars: 300, overlapChars: 150 } });
    expect(chunks.length).toBe(3);
    expect(chunks.map((chunk) => chunk.content.length)).toEqual([1_500, 1_500, 1_300]);
    expect(chunks[1].startOffset).toBe(1_350);
    expect(chunks[2].startOffset).toBe(2_700);
    expect(chunks[chunks.length - 1].endOffset).toBe(text.length);
  });

  it("returns no chunks for text without content", () => {
    expect(chunkDocumentText({ documentId, text: "" })).toEqual([]);
    expect(chunkDocumentText({ documentId, text: "  \n\n\t\n " })).toEqual([]);
  });

  it("normalizes CRLF line endings and keeps offsets inside the normalized text", () => {
    const text = "first line\r\n" + "b".repeat(400) + "\r\nlast line";
    const normalized = text.replace(/\r\n/g, "\n");
    const chunks = chunkDocumentText({ documentId, text, chunking: { maxChars: 500, minChars: 100, overlapChars: 50 } });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.content).not.toContain("\r");
    expectLineBoundaries(normalized, chunks);
  });

  it("rejects chunking options outside the contract", () => {
    expect(() => resolveChunkingOptions({ minChars: 2_000, maxChars: 1_500 })).toThrow(RangeError);
    expect(() => resolveChunkingOptions({ overlapChars: 1_500, maxChars: 1_500 })).toThrow(RangeError);
    expect(() => resolveChunkingOptions({ maxChars: 0 })).toThrow(RangeError);
  });
});