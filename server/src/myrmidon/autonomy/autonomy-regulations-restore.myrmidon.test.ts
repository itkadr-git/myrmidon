import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { knowledgeItems, knowledgeRevisions, type Db } from "@myrmidon/db";
import { restoreKnowledgeAutonomyRegulation } from "./knowledge-regulations.js";

vi.mock("../caste-sensitivity.js", () => ({
  resolveCasteSensitivity: vi.fn(async () => ({ sensitive: new Set(["sensitive"]) })),
}));

const company = "company-1";
const itemId = "item-1";
const now = new Date("2026-01-02T03:04:05.000Z");
const actor = { type: "board", id: "user-1" } as const;
type Item = typeof knowledgeItems.$inferSelect;
type Revision = typeof knowledgeRevisions.$inferSelect;
const dialect = new PgDialect();
const query = (predicate: SQL) => dialect.sqlToQuery(predicate);

function fakeDb(role = "engineer") {
  const item = {
    id: itemId, nestId: company, companyId: company, kind: "rule", title: "A rule",
    roles: [role], slug: "rules/a", currentRevisionNumber: 3, deliveredRevisionId: "rev-3",
    status: "published", createdAt: now, updatedAt: now, createdByAgentId: "author-1",
    createdByUserId: null, supersededByItemId: null,
  } as Item;
  const revisions = [
    { id: "rev-1", itemId, revisionNumber: 1, content: "old body", status: "approved", createdAt: now, createdByAgentId: "author-1", createdByUserId: null },
    { id: "rev-3", itemId, revisionNumber: 3, content: "new body", status: "approved", createdAt: now, createdByAgentId: null, createdByUserId: "author-2" },
  ] as Revision[];
  const state = { item, revisions };
  const trace: string[] = [];
  const writes: { inserted?: Partial<Revision>; updated?: Partial<Item> } = {};
  const tx = {
    select: () => ({ from: (table: unknown) => ({ where: (predicate: SQL) => {
      if (table === knowledgeItems) {
        expect(query(predicate)).toEqual(query(and(eq(knowledgeItems.nestId, company), eq(knowledgeItems.id, itemId), eq(knowledgeItems.kind, "rule"))!));
        return { for: async (mode: string) => { expect(mode).toBe("update"); trace.push("select-item"); return [state.item]; } };
      }
      expect(table).toBe(knowledgeRevisions);
      expect(query(predicate)).toEqual(query(eq(knowledgeRevisions.itemId, itemId)));
      return { orderBy: async () => { trace.push("select-revisions"); return structuredClone(state.revisions); } };
    } }) }),
    insert: (table: unknown) => ({ values: (values: Revision) => ({ returning: async () => {
      expect(table).toBe(knowledgeRevisions); trace.push("insert"); writes.inserted = structuredClone(values);
      state.revisions.push(structuredClone(values)); return [values];
    } }) }),
    update: (table: unknown) => ({ set: (values: Partial<Item>) => ({ where: (predicate: SQL) => ({ returning: async () => {
      expect(table).toBe(knowledgeItems);
      expect(query(predicate)).toEqual(query(eq(knowledgeItems.id, itemId)));
      trace.push("update"); writes.updated = structuredClone(values);
      state.item = { ...state.item, ...values }; return [state.item];
    } }) }) }),
  };
  const db = { transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>) => {
    trace.push("begin"); const snapshot = structuredClone(state);
    try { const result = await fn(tx); trace.push("commit"); return result; }
    catch (error) { state.item = snapshot.item; state.revisions = snapshot.revisions; trace.push("rollback"); throw error; }
  } } as unknown as Db;
  const log = vi.fn(async () => { trace.push("log"); });
  return { db, state, trace, writes, log };
}

afterEach(() => vi.useRealTimers());

describe("restore knowledge autonomy regulation", () => {
  it("returns not found for an unknown scoped item", async () => {
    const fake = fakeDb();
    // A mismatching company/id must not be accepted by the fake's scope assertion.
    const emptyDb = { transaction: async (fn: (tx: unknown) => unknown) => fn({ select: () => ({ from: () => ({ where: (predicate: SQL) => {
      expect(query(predicate)).toEqual(query(and(eq(knowledgeItems.nestId, company), eq(knowledgeItems.id, "missing"), eq(knowledgeItems.kind, "rule"))!));
      return { for: async () => [] };
    } }) }) }) } as unknown as Db;
    const result = await restoreKnowledgeAutonomyRegulation(emptyDb, company, actor, { id: "missing", toRevision: 1 }, "operator", fake.log);
    expect(result).toEqual({ ok: false, failure: { kind: "regulation_not_found", regulationId: "missing" } });
    expect(fake.log).not.toHaveBeenCalled();
  });

  it("rejects an unknown source revision without writes or logging", async () => {
    const f = fakeDb();
    const result = await restoreKnowledgeAutonomyRegulation(f.db, company, actor, { id: itemId, toRevision: 2 }, "operator", f.log);
    expect(result).toEqual({ ok: false, failure: { kind: "revision_not_found", regulationId: itemId, revision: 2 } });
    expect(f.trace).toEqual(["begin", "select-item", "select-revisions", "commit"]);
    expect(f.writes).toEqual({});
  });

  it("refuses an operator restoring a sensitive role", async () => {
    const f = fakeDb("sensitive");
    const result = await restoreKnowledgeAutonomyRegulation(f.db, company, actor, { id: itemId, toRevision: 1 }, "operator", f.log);
    expect(result).toEqual({ ok: false, failure: { kind: "approver_kind_mismatch", regulationId: itemId, required: "owner", presented: "operator" } });
    expect(f.trace).toEqual(["begin", "select-item", "commit"]);
    expect(f.writes).toEqual({});
  });

  it.each([{ type: "board", id: "user-1" }, { type: "agent", id: "agent-1" }, { type: "system", id: "system" }] as const)("appends and publishes a restored revision with $type provenance", async (who) => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const f = fakeDb(); const original = structuredClone(f.state.revisions);
    const result = await restoreKnowledgeAutonomyRegulation(f.db, company, who, { id: itemId, toRevision: 1 }, "operator", f.log);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("restore failed");
    const inserted = f.writes.inserted;
    expect(inserted).toEqual(expect.objectContaining({ companyId: company, nestId: company, itemId, revisionNumber: 4, status: "approved", content: "old body", rolledBackFromRevisionId: "rev-1", approvedBy: who.id, approvedAt: now, createdAt: now, createdByAgentId: who.type === "agent" ? who.id : null, createdByUserId: who.type === "board" ? who.id : null }));
    expect(inserted?.id).toBeTruthy(); expect(["rev-1", "rev-3"]).not.toContain(inserted?.id);
    expect(f.state.revisions.slice(0, 2)).toEqual(original);
    expect(f.state.revisions).toHaveLength(3);
    expect(f.writes.updated).toEqual({ currentRevisionNumber: 4, deliveredRevisionId: inserted?.id, status: "published", updatedAt: now });
    expect(result.value).toEqual(expect.objectContaining({ id: itemId, revision: 4, status: "approved", bodyMarkdown: "old body", updatedBy: who }));
    expect(result.value.revisions).toHaveLength(3);
    expect(result.value.revisions[0]).toEqual(expect.objectContaining({ revision: 1, bodyMarkdown: "old body", author: { type: "agent", id: "author-1" } }));
    expect(result.value.revisions[2]).toEqual(expect.objectContaining({ revision: 4, bodyMarkdown: "old body", author: who }));
    expect(f.trace).toEqual(["begin", "select-item", "select-revisions", "insert", "update", "commit", "log"]);
    expect(f.log).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ companyId: company, actorType: who.type === "board" ? "user" : who.type, actorId: who.id, entityId: itemId, entityType: "autonomy_regulation", details: expect.objectContaining({ action: "regulation_rolled_back", regulationId: itemId }) }));
  });
});
