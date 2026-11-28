import { describe, expect, it, vi } from "vitest";
import { resolvedRules, type RulesReadPort } from "./rules.js";
import type { KnowledgeItemDto, KnowledgeRevisionDto } from "./store.js";

const item: KnowledgeItemDto = {
  id: "item-1", companyId: "co-1", nestId: "co-1", kind: "rule",
  slug: "rules/engineer", title: "Engineer rules", summary: null,
  status: "published", folderPath: "", tags: [], roles: ["engineer"],
  approvalRequired: true, approverKind: "operator", deliveredRevisionId: "r1",
  currentRevisionNumber: 3, supersededByItemId: null,
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
};

function revision(id: string, revisionNumber: number, status: KnowledgeRevisionDto["status"]): KnowledgeRevisionDto {
  return {
    id, itemId: item.id, revisionNumber, status, lang: "ru", translationOf: null,
    title: null, summary: null, content: `content ${id}`, changeSummary: null,
    rolledBackFromRevisionId: null, approvedByKind: status === "approved" ? "owner" : null,
    approvedBy: status === "approved" ? "user-1" : null,
    approvedAt: status === "approved" ? "2026-10-10T00:00:00.000Z" : null,
    createdAt: "2026-10-10T00:00:00.000Z",
    sources: [{ kind: "decision", ref: `source-${id}`, note: null }],
  };
}

const r1 = revision("r1", 1, "approved");
const r2 = revision("r2", 2, "draft");
const r3 = revision("r3", 3, "approved");

function setup(deliveredRevisionId: string | null, revisions: KnowledgeRevisionDto[]) {
  const listItems = vi.fn<RulesReadPort["listItems"]>().mockResolvedValue([{ ...item, deliveredRevisionId }]);
  const listRevisions = vi.fn<RulesReadPort["listRevisions"]>().mockResolvedValue(revisions);
  return { listItems, listRevisions };
}

describe("delivered rule revision pointer", () => {
  it.each([
    ["oldest first", [r1, r2]],
    ["newest first", [r2, r1]],
  ])("returns r1 rather than the newer draft, %s", async (_order, revisions) => {
    const port = setup("r1", revisions);
    const rules = await resolvedRules(port, "engineer");
    expect(rules).toEqual([{
      pageId: item.slug, slug: item.slug, title: item.title, roles: ["engineer"],
      revisionNumber: 1, content: "content r1",
      sources: [{ kind: "decision", ref: "source-r1", note: null }],
    }]);
    expect(rules[0]?.content).not.toBe(r2.content);
    expect(port.listItems).toHaveBeenCalledExactlyOnceWith({ kind: "rule", status: "published" });
    expect(port.listRevisions).toHaveBeenCalledExactlyOnceWith(item.id);
  });

  it("delivers r3 after the pointer moves", async () => {
    const port = setup("r3", [r1, r2, r3]);
    const rules = await resolvedRules(port, "engineer");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      revisionNumber: 3, content: "content r3",
      sources: [{ kind: "decision", ref: "source-r3", note: null }],
    });
    expect(rules[0]?.content).not.toBe(r1.content);
    expect(port.listRevisions).toHaveBeenCalledExactlyOnceWith(item.id);
  });

  it("skips a null pointer without reading revisions", async () => {
    const port = setup(null, [r1, r2, r3]);
    expect(await resolvedRules(port, "engineer")).toEqual([]);
    expect(port.listItems).toHaveBeenCalledExactlyOnceWith({ kind: "rule", status: "published" });
    expect(port.listRevisions).not.toHaveBeenCalled();
  });

  it("skips a missing pointer even when approved revisions exist", async () => {
    const port = setup("missing", [r1, r2, r3]);
    expect(await resolvedRules(port, "engineer")).toEqual([]);
    expect(port.listRevisions).toHaveBeenCalledExactlyOnceWith(item.id);
  });
});
