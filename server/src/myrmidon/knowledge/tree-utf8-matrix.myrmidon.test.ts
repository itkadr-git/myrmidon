import { describe, expect, it } from "vitest";
import { parseKnowledgeTree, serializeKnowledgeTree, type KnowledgeTreePage } from "./domain.js";

const page = (slug: string, content: string): KnowledgeTreePage => ({
  slug,
  kind: "note",
  title: slug,
  summary: null,
  folder: "",
  tags: [],
  roles: [],
  status: "draft",
  approvalRequired: false,
  approverKind: null,
  content,
});

const cases = [
  ["Cyrillic", "\u041f\u0440\u0438\u0432\u0435\u0442"],
  ["emoji", "\u{1f680}\u{1f469}\u200d\u{1f4bb}"],
  ["combining marks", "e\u0301 and n\u0303"],
  ["CRLF", "first\r\nsecond\r\n"],
  ["empty", ""],
  ["trailing newline", "last line\n"],
  ["no trailing newline", "last line"],
  ["body delimiters", "===\n--- item ---\ncontent_bytes: 1\n---\nend"],
] as const;

describe("canonical knowledge tree UTF-8 page boundaries", () => {
  it.each(cases)("preserves %s across pages and input permutations", (_label, content) => {
    const z = page("z-last", content);
    const a = page("a-first", "control: \u0416\u{1f680}\n");
    const doc = { nestId: "matrix-nest", pages: [z, a] };
    const before = structuredClone(doc);
    for (const entry of doc.pages) {
      Object.freeze(entry.tags);
      Object.freeze(entry.roles);
      Object.freeze(entry);
    }
    Object.freeze(doc.pages);
    Object.freeze(doc);

    const bytes = serializeKnowledgeTree(doc);
    const parsed = parseKnowledgeTree(bytes);
    expect(parsed).toEqual({ nestId: "matrix-nest", pages: [before.pages[1], before.pages[0]] });
    expect(parsed.pages[0]?.content).toBe("control: \u0416\u{1f680}\n");
    expect(parsed.pages[1]?.content).toBe(content);
    expect(serializeKnowledgeTree(parsed).equals(bytes)).toBe(true);
    expect(serializeKnowledgeTree({ nestId: doc.nestId, pages: [a, z] }).equals(bytes)).toBe(true);
    expect(doc).toEqual(before);
  });

  it("uses UTF-8 byte lengths rather than JavaScript string lengths", () => {
    const content = "\u0416\u{1f680}e\u0301";
    expect(content.length).toBe(5);
    expect(Buffer.byteLength(content, "utf8")).toBe(9);
    const bytes = serializeKnowledgeTree({ nestId: "n", pages: [page("z", content), page("a", "ok")] });
    expect(bytes.includes(Buffer.from("content_bytes: 9\n---\n", "utf8"))).toBe(true);
    expect(parseKnowledgeTree(bytes).pages.map((entry) => entry.content)).toEqual(["ok", content]);
  });
});
