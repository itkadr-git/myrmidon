import { describe, expect, it, vi } from "vitest";
import type { RulesReadPort } from "../knowledge/rules.js";
import type { KnowledgeItemDto, KnowledgeRevisionDto } from "../knowledge/store.js";
import { createKnowledgeRegulationResolver } from "./delivery.js";

describe("company-bound knowledge regulation delivery", () => {
  it("rejects a foreign company before reading, including after a local delivery", async () => {
    const item: KnowledgeItemDto = {
      id: "item-engineer", companyId: "company-a", nestId: "company-a",
      kind: "rule", slug: "rules/engineer", title: "Engineering", summary: null,
      status: "published", folderPath: "", tags: [], roles: ["engineer"],
      approvalRequired: true, approverKind: "operator", deliveredRevisionId: "rev-1",
      currentRevisionNumber: 1, supersededByItemId: null,
      createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
    };
    const revision: KnowledgeRevisionDto = {
      id: "rev-1", itemId: item.id, revisionNumber: 1, status: "approved", lang: "ru",
      translationOf: null, title: null, summary: null, content: "Run checks",
      changeSummary: null, rolledBackFromRevisionId: null, approvedByKind: "owner",
      approvedBy: "user-1", approvedAt: "2026-10-10T00:00:00.000Z",
      createdAt: "2026-10-10T00:00:00.000Z", sources: [],
    };
    const listItems = vi.fn<RulesReadPort["listItems"]>(async (filter) =>
      [item].filter((entry) => (!filter?.kind || entry.kind === filter.kind) && (!filter?.status || entry.status === filter.status)),
    );
    const listRevisions = vi.fn<RulesReadPort["listRevisions"]>(async (id) =>
      id === item.id ? [revision] : [],
    );
    const resolver = createKnowledgeRegulationResolver({ companyId: "company-a", listItems, listRevisions });

    expect(await resolver.resolved("company-b", "engineer")).toEqual([]);
    expect(listItems).toHaveBeenCalledTimes(0);
    expect(listRevisions).toHaveBeenCalledTimes(0);

    expect(await resolver.resolved("company-a", "engineer")).toEqual([{
      pageId: "rules/engineer", slug: "rules/engineer", title: "Engineering",
      content: "Run checks", version: 1, roles: ["engineer"], sources: [],
    }]);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ kind: "rule", status: "published" });
    expect(listRevisions).toHaveBeenCalledTimes(1);
    expect(listRevisions).toHaveBeenCalledWith(item.id);

    expect(await resolver.resolved("company-b", "engineer")).toEqual([]);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listRevisions).toHaveBeenCalledTimes(1);
  });
});
