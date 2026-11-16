import { describe, expect, it, vi } from "vitest";
import { resolvedRules, rolesMatchCaste, type RulesReadPort } from "./rules.js";
import type { KnowledgeItemDto, KnowledgeRevisionDto } from "./store.js";

function item(slug: string, roles: string[]): KnowledgeItemDto {
  return {
    id: `item-${slug}`, companyId: "co-1", nestId: "co-1", kind: "rule",
    slug, title: slug, summary: null, status: "published", folderPath: "",
    tags: [], roles, approvalRequired: true, approverKind: "operator",
    deliveredRevisionId: `rev-${slug}`, currentRevisionNumber: 1,
    supersededByItemId: null, createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
}

function revision(entry: KnowledgeItemDto): KnowledgeRevisionDto {
  return {
    id: `rev-${entry.slug}`, itemId: entry.id, revisionNumber: 1, status: "approved",
    lang: "ru", translationOf: null, title: null, summary: null,
    content: `content-${entry.slug}`, changeSummary: null, rolledBackFromRevisionId: null,
    approvedByKind: "owner", approvedBy: "user-1", approvedAt: "2026-10-10T00:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z", sources: [],
  };
}

describe("delivery caste ordering", () => {
  it("sorts addressed and mixed rules before wildcard-only rules regardless of input order", async () => {
    const items = [
      item("wild-z", ["*"]), item("engineer-z", ["engineer"]),
      item("other", ["smm"]), item("mixed", ["engineer", "*"]),
      item("wild-a", ["*"]), item("empty", []), item("engineer-a", ["engineer"]),
      item("case", ["Engineer"]), item("prefix", ["engineer-senior"]),
    ];
    const expectedSlugs = ["engineer-a", "engineer-z", "mixed", "wild-a", "wild-z"];
    const expected = expectedSlugs.map((slug) => {
      const entry = items.find((candidate) => candidate.slug === slug)!;
      return { pageId: slug, slug, title: slug, roles: entry.roles, revisionNumber: 1, sources: [], content: `content-${slug}` };
    });
    const resolve = async (input: KnowledgeItemDto[]) => {
      const listItems = vi.fn(async () => input);
      const listRevisions = vi.fn(async (id: string) => items.filter((entry) => entry.id === id).map(revision));
      const read: RulesReadPort = { listItems, listRevisions };
      const result = await resolvedRules(read, "engineer");
      expect(listItems).toHaveBeenCalledExactlyOnceWith({ kind: "rule", status: "published" });
      expect(listRevisions.mock.calls).toEqual(expectedSlugs.map((slug) => [`item-${slug}`]));
      expect(listRevisions).toHaveBeenCalledTimes(5);
      return result;
    };
    const forward = await resolve(items);
    const reverse = await resolve([...items].reverse());
    expect(forward).toEqual(expected);
    expect(reverse).toEqual(expected);
    expect(reverse).toEqual(forward);
    expect(forward.filter((entry) => entry.slug === "mixed")).toHaveLength(1);
  });

  it("matches roles exactly and recognizes the wildcard without fuzzy or case-insensitive matching", () => {
    expect(rolesMatchCaste(["engineer"], "engineer")).toBe(true);
    expect(rolesMatchCaste(["*"], "engineer")).toBe(true);
    expect(rolesMatchCaste(["engineer", "*"], "engineer")).toBe(true);
    expect(rolesMatchCaste(["Engineer"], "engineer")).toBe(false);
    expect(rolesMatchCaste(["engineer-senior"], "engineer")).toBe(false);
    expect(rolesMatchCaste(["engineer"], "engineer-senior")).toBe(false);
    expect(rolesMatchCaste(["smm"], "engineer")).toBe(false);
    expect(rolesMatchCaste([], "engineer")).toBe(false);
  });
});
