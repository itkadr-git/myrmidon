import { afterEach, describe, expect, it, vi } from "vitest";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { knowledgeItems, knowledgeRevisions, type Db } from "@myrmidon/db";
import { updateKnowledgeAutonomyRegulation } from "./knowledge-regulations.js";

type Item = typeof knowledgeItems.$inferSelect;
type Revision = typeof knowledgeRevisions.$inferSelect;
type NewRevision = typeof knowledgeRevisions.$inferInsert;
const company = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const delivered = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-01-02T03:04:05.000Z");
const actor = { type: "agent", id: "editor" } as const;
const dialect = new PgDialect();

function fixture(currentRevisionNumber = 1) {
  const item: Item = {
    id, companyId: company, nestId: company, kind: "rule", slug: "rules/test", title: "Original",
    summary: null, status: "published", folderPath: "rules", tags: [], roles: ["engineer"],
    approvalRequired: true, approverKind: "owner", deliveredRevisionId: delivered,
    currentRevisionNumber, supersededByItemId: null, createdByAgentId: "author", createdByUserId: null,
    createdAt: now, updatedAt: now,
  };
  const revision = (revisionNumber: number, content: string): Revision => ({
    id: revisionNumber === 1 ? delivered : "44444444-4444-4444-8444-444444444444",
    companyId: company, nestId: company, itemId: id, revisionNumber, content, status: "approved",
    lang: "en", translationOf: null, title: null, summary: null, changeSummary: null,
    rolledBackFromRevisionId: null, approvalId: null, approvedByKind: null, approvedBy: null,
    approvedAt: now, createdByAgentId: "author", createdByUserId: null, createdAt: now,
  });
  return { item, revisions: [revision(1, "pointer body"), revision(2, "latest body")] };
}

function fakeDb(currentRevisionNumber = 1) {
  const state = fixture(currentRevisionNumber);
  const trace: string[] = [];
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  let inserted: NewRevision | undefined;
  let updated: Partial<Item> | undefined;
  const tx = {
    select: () => ({ from: (table: unknown) => ({ where: (predicate: SQL) => {
      predicates.push(dialect.sqlToQuery(predicate));
      if (table === knowledgeItems) return { for: async (mode: string) => {
        trace.push(`lock:${mode}`);
        const params = predicates.at(-1)?.params ?? [];
        return params.includes(state.item.id) && params.includes(state.item.nestId) && params.includes(state.item.kind) ? [structuredClone(state.item)] : [];
      } };
      if (table !== knowledgeRevisions) throw new Error("unexpected select table");
      return { orderBy: async () => { trace.push("read revisions"); return structuredClone(state.revisions); } };
    } }) }),
    insert: (table: unknown) => {
      if (table !== knowledgeRevisions) throw new Error("unexpected insert table");
      return { values: (values: NewRevision) => ({ returning: async () => {
        trace.push("insert revision"); inserted = structuredClone(values);
        const row = { ...fixture().revisions[0], ...values } as Revision;
        state.revisions.push(row); return [structuredClone(row)];
      } }) };
    },
    update: (table: unknown) => {
      if (table !== knowledgeItems) throw new Error("unexpected update table");
      return { set: (values: Partial<Item>) => ({ where: (predicate: SQL) => ({ returning: async () => {
        predicates.push(dialect.sqlToQuery(predicate)); trace.push("update item"); updated = structuredClone(values);
        Object.assign(state.item, values); return [structuredClone(state.item)];
      } }) }) };
    },
  };
  const db = { transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>): Promise<T> => {
    trace.push("begin"); const snapshot = structuredClone(state);
    try { const result = await fn(tx); trace.push("commit"); return result; }
    catch (error) { Object.assign(state, snapshot); trace.push("rollback"); throw error; }
  } } as unknown as Db;
  return { db, state, trace, predicates, writes: () => ({ inserted, updated }) };
}

afterEach(() => vi.useRealTimers());

describe("updateKnowledgeAutonomyRegulation", () => {
  it("rejects an unknown id without writes or activity", async () => {
    const f = fakeDb(); const log = vi.fn();
    const result = await updateKnowledgeAutonomyRegulation(f.db, company, actor, { id: "missing" }, log);
    expect(result).toEqual({ ok: false, failure: { kind: "regulation_not_found", regulationId: "missing" } });
    expect(f.trace).toEqual(["begin", "lock:update", "commit"]);
    expect(f.writes()).toEqual({ inserted: undefined, updated: undefined }); expect(log).not.toHaveBeenCalled();
  });

  it("uses the current pointer even when a later revision is present", async () => {
    const f = fakeDb(1);
    const result = await updateKnowledgeAutonomyRegulation(f.db, company, actor, { id, title: "Renamed" });
    expect(result.ok).toBe(true);
    expect(f.writes().inserted).toMatchObject({ content: "pointer body", revisionNumber: 2 });
  });

  it.each([
    ["title-only uses current pointer", 2, { title: "Renamed" }, "Renamed", "latest body", 3],
    ["content-only preserves title", 2, { bodyMarkdown: "Changed" }, "Original", "Changed", 3],
    ["empty content is preserved", 2, { bodyMarkdown: "" }, "Original", "", 3],
    ["missing pointer falls back to last revision", 0, { title: "Fallback" }, "Fallback", "latest body", 3],
  ])("%s", async (_name, pointer, input, title, content, next) => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const f = fakeDb(pointer); const before = structuredClone(f.state.revisions); const log = vi.fn();
    const result = await updateKnowledgeAutonomyRegulation(f.db, company, actor, { id, ...input }, log);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected regulation");
    expect(result.value).toMatchObject({ id, title, bodyMarkdown: content, revision: next, status: "draft" });
    expect(f.trace).toEqual(["begin", "lock:update", "read revisions", "insert revision", "update item", "commit"]);
    expect(f.state.revisions.slice(0, 2)).toEqual(before);
    expect(f.state.revisions).toHaveLength(3);
    expect(f.writes().inserted).toMatchObject({ companyId: company, nestId: company, itemId: id, revisionNumber: next, status: "draft", content, changeSummary: "edited", createdByAgentId: "editor", createdByUserId: null, createdAt: now });
    expect(f.writes().updated).toEqual({ title, currentRevisionNumber: next, updatedAt: now });
    expect(f.state.item.deliveredRevisionId).toBe(delivered);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ companyId: company, actorType: "agent", actorId: "editor", entityId: id }));
    const [scope, revisions, update] = f.predicates;
    expect(scope.sql).toBe('("knowledge_items"."nest_id" = $1 and "knowledge_items"."id" = $2 and "knowledge_items"."kind" = $3)');
    expect(scope.params).toEqual([company, id, "rule"]);
    expect(revisions.sql).toBe('"knowledge_revisions"."item_id" = $1'); expect(revisions.params).toEqual([id]);
    expect(update.sql).toBe('"knowledge_items"."id" = $1'); expect(update.params).toEqual([id]);
  });
});
