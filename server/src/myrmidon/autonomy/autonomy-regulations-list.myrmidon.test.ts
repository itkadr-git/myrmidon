import { describe, expect, it } from "vitest";
import { knowledgeItems, knowledgeRevisions, type Db } from "@myrmidon/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { listKnowledgeAutonomyRegulations } from "./knowledge-regulations.js";

type Item = typeof knowledgeItems.$inferSelect;
type Revision = typeof knowledgeRevisions.$inferSelect;
const dialect = new PgDialect();
const date = new Date("2026-01-02T03:04:05.000Z");
const company = "company-1";

function item(id: string, changes: Partial<Item> = {}): Item {
  return { id, title: `Title ${id}`, roles: ["engineer"], currentRevisionNumber: 1,
    createdAt: date, updatedAt: date, createdByAgentId: null, createdByUserId: null,
    supersededByItemId: null, slug: `rules/${id}`, ...changes } as Item;
}
function revision(itemId: string, revisionNumber: number, changes: Partial<Revision> = {}): Revision {
  return { itemId, revisionNumber, content: `${itemId}-${revisionNumber}`, status: "draft",
    createdByAgentId: null, createdByUserId: null, createdAt: date, ...changes } as Revision;
}

function fakeDb(items: Item[], revisions: Revision[]) {
  const calls: { table: unknown; query: ReturnType<PgDialect["sqlToQuery"]> }[] = [];
  const order: unknown[] = [];
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: (predicate: SQL) => {
      calls.push({ table, query: dialect.sqlToQuery(predicate) });
      if (table === knowledgeItems) return Promise.resolve(items);
      if (table !== knowledgeRevisions) throw new Error("Unexpected table");
      return { orderBy: async (column: unknown) => { order.push(column); return revisions; } };
    } }) }),
  };
  return { db: db as unknown as Db, calls, order };
}

describe("listKnowledgeAutonomyRegulations", () => {
  it("selects each current revision, preserving interleaved history and projection fields", async () => {
    const a = item("a", { currentRevisionNumber: 2, createdByAgentId: "creator", supersededByItemId: "next" });
    const b = item("b", { currentRevisionNumber: 1, createdByUserId: "board-creator", roles: [] });
    const fake = fakeDb([a, b], [
      revision("a", 1, { createdByUserId: "board" }),
      revision("b", 1, { status: "approved", createdByAgentId: "agent" }),
      revision("a", 2, { status: "approved", createdAt: "2026-02-03T00:00:00Z" as unknown as Date }),
      revision("b", 2),
    ]);
    const result = await listKnowledgeAutonomyRegulations(fake.db, company);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "a", title: "Title a", role: "engineer", bodyMarkdown: "a-2", status: "approved", revision: 2,
      createdAt: date.toISOString(), updatedAt: date.toISOString(), createdBy: { type: "agent", id: "creator" },
      updatedBy: { type: "system", id: "system" }, supersededBy: "next", wikiPageId: "rules/a",
      revisions: [
        { revision: 1, bodyMarkdown: "a-1", status: "draft", author: { type: "board", id: "board" }, at: date.toISOString() },
        { revision: 2, bodyMarkdown: "a-2", status: "approved", author: { type: "system", id: "system" }, at: "2026-02-03T00:00:00Z" },
      ] });
    expect(result[1]).toMatchObject({ id: "b", role: "*", bodyMarkdown: "b-1", status: "approved", revision: 1,
      createdBy: { type: "board", id: "board-creator" }, updatedBy: { type: "agent", id: "agent" },
      revisions: [{ revision: 1, bodyMarkdown: "b-1" }, { revision: 2, bodyMarkdown: "b-2", status: "draft" }] });
    expect(fake.calls.map((call) => call.table)).toEqual([knowledgeItems, knowledgeRevisions]);
    expect(fake.calls[0].query.sql).toMatch(/^\("[^"]+"\."nest_id"\s*=\s*\$1\s+and\s+"[^"]+"\."kind"\s*=\s*\$2\)$/i);
    expect(fake.calls[0].query.params).toEqual([company, "rule"]);
    expect(fake.calls[1].query.sql).toMatch(/"item_id"\s+in\s*\(\$1,\s*\$2\)/i);
    expect(fake.calls[1].query.params).toEqual(["a", "b"]);
    expect(fake.order).toEqual([knowledgeRevisions.revisionNumber]);
  });

  it("falls back to the last revision and handles an item without revisions", async () => {
    const fake = fakeDb([item("a", { currentRevisionNumber: 0 }), item("empty")], [revision("a", 1), revision("a", 3)]);
    const result = await listKnowledgeAutonomyRegulations(fake.db, company);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ bodyMarkdown: "a-3", revision: 3, status: "draft" });
    expect(result[1]).toMatchObject({ id: "empty", bodyMarkdown: "", revision: 1, status: "draft", revisions: [], updatedBy: { type: "system", id: "system" } });
  });

  it("does not query revisions for an empty item list", async () => {
    const fake = fakeDb([], []);
    expect(await listKnowledgeAutonomyRegulations(fake.db, company)).toEqual([]);
    expect(fake.calls.map((call) => call.table)).toEqual([knowledgeItems]);
    expect(fake.calls[0].query.params).toEqual([company, "rule"]);
  });
});
