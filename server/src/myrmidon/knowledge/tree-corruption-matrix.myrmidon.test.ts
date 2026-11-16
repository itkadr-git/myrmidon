import { describe, expect, it } from "vitest";
import {
  KnowledgeDomainError,
  parseKnowledgeTree,
  serializeKnowledgeTree,
  type KnowledgeTreePage,
} from "./domain.js";

const page: KnowledgeTreePage = {
  slug: "first",
  kind: "note",
  title: "First",
  summary: null,
  folder: "",
  tags: [],
  roles: [],
  status: "draft",
  approvalRequired: false,
  approverKind: null,
  content: "Body",
};
const doc = { nestId: "nest", pages: [page] };
const valid = serializeKnowledgeTree(doc).toString("utf8");

function replaceOnce(input: string, before: string, after: string): string {
  expect(input.split(before)).toHaveLength(2);
  return input.replace(before, after);
}

function expectInvalidTree(input: string): void {
  let caught: unknown;
  try {
    parseKnowledgeTree(Buffer.from(input, "utf8"));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KnowledgeDomainError);
  expect(caught).toMatchObject({ code: "invalid_tree", status: 400 });
}

describe("knowledge tree corruption matrix", () => {
  it("parses the original serialized package", () => {
    expect(parseKnowledgeTree(Buffer.from(valid, "utf8"))).toEqual(doc);
  });

  const corruptions: Array<[string, (input: string) => string]> = [
    ["magic", (s) => replaceOnce(s, "=== myrmidon knowledge tree v1 ===", "=== damaged knowledge tree v1 ===")],
    ["page separator", (s) => replaceOnce(s, "--- item ---", "--- damaged ---")],
    ["metadata without colon-space", (s) => replaceOnce(s, "title: First", "title:First")],
    ["truncated metadata", (s) => s.slice(0, s.indexOf("content_bytes: ") + "content_bytes: ".length)],
    ["missing content_bytes", (s) => replaceOnce(s, "content_bytes: 4\n", "")],
    ["negative content_bytes", (s) => replaceOnce(s, "content_bytes: 4", "content_bytes: -1")],
    ["nonnumeric content_bytes", (s) => replaceOnce(s, "content_bytes: 4", "content_bytes: nope")],
    ["content_bytes beyond remaining bytes", (s) => replaceOnce(s, "content_bytes: 4", "content_bytes: 5")],
    ["unknown kind", (s) => replaceOnce(s, "kind: note", "kind: unknown")],
    ["unknown status", (s) => replaceOnce(s, "status: draft", "status: unknown")],
  ];

  it.each(corruptions)("rejects %s with invalid_tree and HTTP 400", (_name, corrupt) => {
    expectInvalidTree(corrupt(valid));
  });

  it("rejects the whole package when the second page is corrupt", () => {
    const second = { ...page, slug: "second", title: "Second" };
    const twoPages = { nestId: "nest", pages: [page, second] };
    const serialized = serializeKnowledgeTree(twoPages).toString("utf8");
    expect(parseKnowledgeTree(Buffer.from(serialized, "utf8"))).toEqual(twoPages);
    expectInvalidTree(replaceOnce(serialized, "title: Second", "title:Second"));
  });
});
