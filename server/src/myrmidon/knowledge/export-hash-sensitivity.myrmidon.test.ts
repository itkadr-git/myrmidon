import { describe, expect, it } from "vitest";
import type { KnowledgeTreeDoc, KnowledgeTreePage } from "./domain.js";
import { buildKnowledgeGitTree, knowledgeExportCommitMessage } from "./git-export.js";

const page = (overrides: Partial<KnowledgeTreePage> = {}): KnowledgeTreePage => ({
  slug: "ops/runbook",
  title: "Runbook",
  summary: null,
  kind: "wiki",
  folder: "ops",
  tags: ["oncall"],
  roles: [],
  status: "published",
  approvalRequired: false,
  approverKind: null,
  content: "Step one.\n",
  ...overrides,
});

const publicPage = page();
const otherPage = page({ slug: "ops/other", title: "Other", content: "Other body.\n" });
const lifePage = page({ slug: "directions/life/note", folder: "directions/life", title: "Private", content: "Private body.\n" });
const doc = (pages: KnowledgeTreePage[], nestId = "nest-1"): KnowledgeTreeDoc => ({ nestId, pages });

describe("knowledge export hash sensitivity", () => {
  const baseline = doc([publicPage, otherPage, lifePage]);

  it.each([
    ["page order", doc([lifePage, otherPage, publicPage]), 1],
    ["excluded life content", doc([publicPage, otherPage, { ...lifePage, title: "Changed private title", content: "Changed private body.\n", slug: "directions/life/another" }]), 1],
    ["an additional life page", doc([publicPage, otherPage, lifePage, page({ slug: "life/second", folder: "life" })]), 2],
    ["removing the life page", doc([publicPage, otherPage]), 0],
  ])("preserves hash and files for %s", (_label, input, excluded) => {
    const original = buildKnowledgeGitTree(baseline);
    const changed = buildKnowledgeGitTree(input);
    expect(original.pageCount).toBe(2);
    expect(original.excludedLifePages).toBe(1);
    expect(changed.contentHash).toBe(original.contentHash);
    expect(changed.files).toEqual(original.files);
    expect(changed.pageCount).toBe(2);
    expect(changed.excludedLifePages).toBe(excluded);
  });

  it.each([
    ["nest ID", doc([publicPage, otherPage, lifePage], "nest-2")],
    ["public title", doc([{ ...publicPage, title: "Revised" }, otherPage, lifePage])],
    ["public body", doc([{ ...publicPage, content: "Revised body.\n" }, otherPage, lifePage])],
    ["public slug", doc([{ ...publicPage, slug: "ops/revised" }, otherPage, lifePage])],
  ])("changes the hash for %s", (_label, input) => {
    const original = buildKnowledgeGitTree(baseline);
    const changed = buildKnowledgeGitTree(input);
    expect(changed.contentHash).not.toBe(original.contentHash);
    expect(changed.files).not.toEqual(original.files);
    expect(changed.pageCount).toBe(2);
    expect(changed.excludedLifePages).toBe(1);
  });

  it.each([
    ["empty", doc([]), 0],
    ["populated", baseline, 2],
  ])("records the computed hash and exact page count for %s", (_label, input, count) => {
    const tree = buildKnowledgeGitTree(input);
    const readme = tree.files.find((file) => file.path === "README.md");
    expect(tree.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.pageCount).toBe(count);
    expect(readme).toBeDefined();
    expect(readme?.content.split("\n").filter((line) => line.startsWith("content: "))).toEqual([`content: ${tree.contentHash}`]);
    expect(readme?.content.split("\n").filter((line) => line.startsWith("pages: "))).toEqual([`pages: ${count}`]);
    expect(knowledgeExportCommitMessage(tree)).toBe(`myrmidon(KNOWLEDGE-2.0 L-8): export ${count} pages ${tree.contentHash.slice(0, 12)}`);
  });

  it("produces only a stable README for an empty tree", () => {
    const first = buildKnowledgeGitTree(doc([]));
    const second = buildKnowledgeGitTree(doc([]));
    expect(first.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(first.pageCount).toBe(0);
    expect(first.excludedLifePages).toBe(0);
    expect(second).toEqual(first);
  });
});
