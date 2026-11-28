import { describe, expect, it } from "vitest";
import { mapFrontmatter, parseFrontmatter } from "./frontmatter.js";

describe("frontmatter boundaries", () => {
  it.each([
    ["LF with dash close", "\n", "---  "],
    ["LF with dot close", "\n", "...\t"],
    ["CRLF with dash close", "\r\n", "---  "],
    ["CRLF with dot close", "\r\n", "...\t"],
  ])("parses %s", (_name, eol, close) => {
    const raw = ["--- \t", "title: Page", close, "Body"].join(eol);
    expect(parseFrontmatter(raw)).toEqual({
      hasFrontmatter: true, data: { title: "Page" }, keys: ["title"], malformedLines: 0, body: "Body",
    });
  });

  it("keeps a multiline body and its final newline", () => {
    expect(parseFrontmatter("---\nname: Page\n---\n# Heading\nbody\n")).toEqual({
      hasFrontmatter: true, data: { name: "Page" }, keys: ["name"], malformedLines: 0, body: "# Heading\nbody\n",
    });
  });

  it("accepts an empty block", () => {
    expect(parseFrontmatter("---\n---\nbody")).toEqual({
      hasFrontmatter: true, data: {}, keys: [], malformedLines: 0, body: "body",
    });
  });

  it("keeps all text after the opener when the block is not closed", () => {
    expect(parseFrontmatter("---\ntitle: Page\nnot a pair\nbody")).toEqual({
      hasFrontmatter: true, data: { title: "Page" }, keys: ["title"], malformedLines: 2,
      body: "title: Page\nnot a pair\nbody",
    });
  });

  it("does not parse a delimiter that is not the first line", () => {
    const raw = "Intro\r\n---\r\ntitle: Page\r\n---\r\nBody\r\n";
    expect(parseFrontmatter(raw)).toEqual({
      hasFrontmatter: false, data: {}, keys: [], malformedLines: 0, body: raw,
    });
  });

  it("counts malformed lines but not comments or blanks and preserves first key order", () => {
    const raw = ["---", "first: old", "# comment", "", "second: value", "bad line", "  # indented comment", "first: new", "invalid key: x", "---", "body"].join("\n");
    expect(parseFrontmatter(raw)).toEqual({
      hasFrontmatter: true, data: { first: "new", second: "value" }, keys: ["first", "second"], malformedLines: 2, body: "body",
    });
  });

  it("preserves scalar types, quoting, and both list forms", () => {
    const raw = ["---", "nil: null", "tilde: ~", "yes: true", "no: false", "number: -42", 'quoted: "42"', "single: 'it''s'", 'double: "first\\nsecond"', 'inline: [alpha, "beta", 3]', "block:", "  - one", "  - -2", "  - false", "---", "body"].join("\n");
    expect(parseFrontmatter(raw)).toEqual({
      hasFrontmatter: true,
      data: { nil: null, tilde: null, yes: true, no: false, number: -42, quoted: "42", single: "it's", double: "first\nsecond", inline: ["alpha", "beta", "3"], block: ["one", -2, false] },
      keys: ["nil", "tilde", "yes", "no", "number", "quoted", "single", "double", "inline", "block"],
      malformedLines: 0, body: "body",
    });
  });
});

describe("mapFrontmatter boundaries", () => {
  it("prefers the primary fields when all aliases are present", () => {
    expect(mapFrontmatter({ title: "Title", name: "Name", summary: "Summary", description: "Description", excerpt: "Excerpt", tags: ["tag"], keywords: ["keyword"], sources: ["source"], source_refs: ["snake"], sourceRefs: ["camel"] })).toEqual({
      title: "Title", summary: "Summary", tags: ["tag"], sources: ["source"],
    });
  });

  it("uses aliases in order when the preferred fields are absent", () => {
    expect(mapFrontmatter({ name: " Name ", description: " Description ", excerpt: "Excerpt", keywords: "one, two", source_refs: "first, second", sourceRefs: "later" })).toEqual({
      title: "Name", summary: "Description", tags: ["one", "two"], sources: ["first", "second"],
    });
    expect(mapFrontmatter({ excerpt: "Excerpt", sourceRefs: ["camel"] })).toEqual({
      title: null, summary: "Excerpt", tags: [], sources: ["camel"],
    });
  });

  it("returns empty fields when missing", () => {
    expect(mapFrontmatter({})).toEqual({ title: null, summary: null, tags: [], sources: [] });
  });

  it("selects the first nonempty string from nested arrays", () => {
    expect(mapFrontmatter({ title: [null, [" ", " Title ", "ignored"]], summary: [[false, " Summary "]], tags: [[null, " first ", "ignored"], ["second"], 4], sources: [[" ", [" ref "]], false, "another"] })).toEqual({
      title: "Title", summary: "Summary", tags: ["first", "second"], sources: ["ref", "another"],
    });
  });
});
