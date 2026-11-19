import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { chunkDocumentText, chunkId } from "./chunker.js";

function expectedId(documentId: string, ordinal: number, content: string): string {
  return createHash("sha256")
    .update(Buffer.from(documentId, "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(String(ordinal), "utf8"))
    .update(Buffer.from([0]))
    .update(Buffer.from(content, "utf8"))
    .digest("hex")
    .slice(0, 32);
}

describe("chunk identity domains", () => {
  const cases: Array<[string, string, number, string]> = [
    ["baseline", "doc", 0, "text"],
    ["different document", "doc2", 0, "text"],
    ["different ordinal", "doc", 1, "text"],
    ["different content", "doc", 0, "texts"],
    ["empty document", "", 0, "text"],
    ["empty content", "doc", 0, ""],
    ["multi-digit ordinal", "doc", 10, "text"],
    ["Unicode document", "\u0434\u043e\u043a", 0, "text"],
    ["Unicode content", "doc", 0, "\u043a\u043e\u0442 \ud83d\udc08"],
    ["composed accent", "doc", 0, "\u00e9"],
    ["decomposed accent", "doc", 0, "e\u0301"],
    ["NUL in document", "doc\u0000part", 0, "text"],
    ["NUL in content", "doc", 0, "text\u0000part"],
    ["large ordinal", "doc", 123456, "text"],
  ];

  it.each(cases)("hashes the exact preimage: %s", (_name, documentId, ordinal, content) => {
    const id = chunkId(documentId, ordinal, content);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toBe(expectedId(documentId, ordinal, content));
    expect(chunkId(documentId, ordinal, content)).toBe(id);
  });

  it("separates changes in each domain and exact Unicode bytes", () => {
    const base = chunkId("doc", 0, "text");
    expect(chunkId("doc2", 0, "text")).not.toBe(base);
    expect(chunkId("doc", 1, "text")).not.toBe(base);
    expect(chunkId("doc", 0, "texts")).not.toBe(base);
    expect(chunkId("doc", 0, "\u00e9")).not.toBe(chunkId("doc", 0, "e\u0301"));
  });

  it("assigns different IDs to identical content at different positions without mutating the request", () => {
    const request = { documentId: "doc", text: "same\nsame", chunking: { minChars: 1, maxChars: 4, overlapChars: 0 } };
    const before = structuredClone(request);
    const chunks = chunkDocumentText(request);
    expect(request).toEqual(before);
    expect(chunks.map(({ content, ordinal, startOffset, endOffset }) => ({ content, ordinal, startOffset, endOffset }))).toEqual([
      { content: "same", ordinal: 0, startOffset: 0, endOffset: 4 },
      { content: "same", ordinal: 1, startOffset: 5, endOffset: 9 },
    ]);
    expect(chunks.map(({ id }) => id)).toEqual([expectedId("doc", 0, "same"), expectedId("doc", 1, "same")]);
    expect(chunks[0].id).not.toBe(chunks[1].id);
  });

  it("normalizes line endings before computing IDs but preserves content byte changes", () => {
    const documentId = "doc";
    const lf = chunkDocumentText({ documentId, text: "alpha\nbeta" });
    const crlf = chunkDocumentText({ documentId, text: "alpha\r\nbeta" });
    const changed = chunkDocumentText({ documentId, text: "alpha\nbetA" });
    expect(lf).toHaveLength(1);
    expect(crlf).toEqual(lf);
    expect(lf[0].content).toBe("alpha\nbeta");
    expect(lf[0].id).toBe(expectedId(documentId, 0, "alpha\nbeta"));
    expect(changed).toHaveLength(1);
    expect(changed[0].content).toBe("alpha\nbetA");
    expect(changed[0].id).toBe(expectedId(documentId, 0, "alpha\nbetA"));
    expect(changed[0].id).not.toBe(lf[0].id);
  });
});
