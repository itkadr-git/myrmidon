import { describe, expect, it, vi } from "vitest";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { knowledgeItems, type Db } from "@myrmidon/db";
import { deleteKnowledgeAutonomyRegulation } from "./knowledge-regulations.js";

vi.mock("../caste-sensitivity.js", () => ({
  resolveCasteSensitivity: vi.fn(async () => ({ sensitive: new Set(["smm"]) })),
}));

const companyId = "company-1";
const regulationId = "rule-1";
const actor = { type: "board" as const, id: "owner-1" };
type Item = { id: string; roles: string[]; status: string; deliveredRevisionId: string | null };
const draft: Item = { id: regulationId, roles: ["smm"], status: "draft", deliveredRevisionId: null };
const dialect = new PgDialect();

function fakeDb(initial: Item | null, failDelete = false) {
  let item = initial && { ...initial };
  const calls: string[] = [];
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    select: () => ({ from: (table: unknown) => {
      expect(table).toBe(knowledgeItems);
      calls.push("select");
      return { where: (predicate: SQL) => {
        predicates.push(dialect.sqlToQuery(predicate));
        calls.push("where");
        return { for: async (mode: string) => {
          calls.push(`lock:${mode}`);
          return item ? [{ ...item }] : [];
        } };
      } };
    } }),
    delete: (table: unknown) => {
      expect(table).toBe(knowledgeItems);
      calls.push("delete");
      return { where: async (predicate: SQL) => {
        predicates.push(dialect.sqlToQuery(predicate));
        calls.push("delete:where");
        if (failDelete) throw new Error("delete failed");
        item = null;
      } };
    },
  };
  const db = { transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => {
    const snapshot = item && { ...item };
    calls.push("begin");
    try {
      const result = await fn(tx);
      calls.push("commit");
      return result;
    } catch (error) {
      item = snapshot;
      calls.push("rollback");
      throw error;
    }
  } } as unknown as Db;
  const log = vi.fn(async () => { calls.push("audit"); });
  return { db, calls, predicates, log, getItem: () => item };
}

describe("knowledge autonomy regulation withdrawal", () => {
  it("deletes an undelivered draft without an approver and audits after commit", async () => {
    const f = fakeDb(draft);
    expect(await deleteKnowledgeAutonomyRegulation(f.db, companyId, actor, regulationId, null, f.log)).toEqual({ ok: true, value: { id: regulationId } });
    expect(f.getItem()).toBeNull();
    expect(f.calls).toEqual(["begin", "select", "where", "lock:update", "delete", "delete:where", "commit", "audit"]);
    expect(f.log).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ companyId, actorType: "user", actorId: actor.id, entityId: regulationId, action: expect.stringMatching(/regulation_deleted$/), details: { summary: "Regulation deleted.", action: "regulation_deleted", regulationId } }));
    expect(f.predicates[0].sql).toBe('("knowledge_items"."nest_id" = $1 and "knowledge_items"."id" = $2 and "knowledge_items"."kind" = $3)');
    expect(f.predicates[0].params).toEqual([companyId, regulationId, "rule"]);
    expect(f.predicates[1].sql).toBe('"knowledge_items"."id" = $1');
    expect(f.predicates[1].params).toEqual([regulationId]);
  });

  it.each([
    ["published without delivery", { ...draft, status: "published" }],
    ["draft with delivery", { ...draft, deliveredRevisionId: "revision-1" }],
  ])("requires owner for sensitive %s", async (_label, item) => {
    for (const presented of ["operator", null]) {
      const f = fakeDb(item);
      expect(await deleteKnowledgeAutonomyRegulation(f.db, companyId, actor, regulationId, presented, f.log)).toEqual({ ok: false, failure: { kind: "approver_kind_mismatch", regulationId, required: "owner", presented } });
      expect(f.getItem()).toEqual(item);
      expect(f.calls).toEqual(["begin", "select", "where", "lock:update", "commit"]);
      expect(f.log).not.toHaveBeenCalled();
    }
    const f = fakeDb(item);
    expect(await deleteKnowledgeAutonomyRegulation(f.db, companyId, actor, regulationId, "owner", f.log)).toEqual({ ok: true, value: { id: regulationId } });
    expect(f.getItem()).toBeNull();
    expect(f.log).toHaveBeenCalledOnce();
  });

  it("returns not found without deleting or auditing", async () => {
    const f = fakeDb(null);
    expect(await deleteKnowledgeAutonomyRegulation(f.db, companyId, actor, regulationId, "owner", f.log)).toEqual({ ok: false, failure: { kind: "regulation_not_found", regulationId } });
    expect(f.calls).toEqual(["begin", "select", "where", "lock:update", "commit"]);
    expect(f.log).not.toHaveBeenCalled();
  });

  it("rolls back a delete error and does not audit success", async () => {
    const f = fakeDb(draft, true);
    await expect(deleteKnowledgeAutonomyRegulation(f.db, companyId, actor, regulationId, null, f.log)).rejects.toThrow("delete failed");
    expect(f.getItem()).toEqual(draft);
    expect(f.calls).toEqual(["begin", "select", "where", "lock:update", "delete", "delete:where", "rollback"]);
    expect(f.log).not.toHaveBeenCalled();
  });
});
