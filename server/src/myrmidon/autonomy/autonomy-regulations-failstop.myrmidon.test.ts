import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { knowledgeItems, knowledgeRevisions, type Db } from "@myrmidon/db";
import { createKnowledgeAutonomyRegulationsBackend, type AutonomyLogActivityFn } from "./knowledge-regulations.js";

vi.mock("../caste-sensitivity.js", () => ({
  resolveCasteSensitivity: async () => ({ sensitive: new Set<string>() }),
}));

const company = "company-1";
const id = "item-1";
const actor = { type: "board", id: "user-1" } as const;
const now = new Date("2026-01-02T03:04:05.000Z");
type Row = Record<string, unknown>;
type Failure = "callback" | "second" | "commit" | "audit";
type Operation = "create" | "update" | "approve" | "restore" | "delete";

function fixture(failure: Failure) {
  const error = new Error(failure);
  const trace: Array<{ event: string; table?: unknown; values?: Row; sql?: string; params?: unknown[] }> = [];
  const initialItem: Row = { id, nestId: company, companyId: company, kind: "rule", title: "Old", slug: "rules/engineer/old", roles: ["engineer"], status: "draft", currentRevisionNumber: 1, deliveredRevisionId: null, createdAt: now, updatedAt: now, createdByUserId: actor.id, supersededByItemId: null };
  const initialRevision: Row = { id: "revision-1", itemId: id, revisionNumber: 1, status: "draft", content: "old body", createdAt: now, createdByUserId: actor.id };
  let state = { items: [initialItem], revisions: [initialRevision] };
  let count = 0;
  let inTransaction = false;
  const predicate = (where: SQL) => {
    const result = new PgDialect().sqlToQuery(where);
    return { sql: result.sql, params: result.params };
  };
  const rows = (table: unknown) => table === knowledgeItems ? state.items : state.revisions;
  const write = (table: unknown, event: string, values: Row, where?: SQL) => {
    trace.push({ event, table, values, ...(where ? predicate(where) : {}) });
    if (failure === "callback" && inTransaction) throw error;
    count++;
    if (failure === "second" && count === 2) throw error;
    if (event === "insert") rows(table).push({ ...values });
    else if (event === "update") rows(table)[0] = { ...rows(table)[0], ...values };
    else state.items = [];
    return event === "delete" ? [] : [{ ...rows(table).at(-1) }];
  };
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: (where: SQL) => {
      trace.push({ event: "select", table, ...predicate(where) });
      return {
        limit: async () => [],
        for: async () => { if (failure === "callback") throw error; return rows(table).map((row) => ({ ...row })); },
        orderBy: async () => rows(table).map((row) => ({ ...row })),
      };
    } }) }),
    insert: (table: unknown) => ({ values: (values: Row) => {
      const run = () => write(table, "insert", values);
      return { returning: async () => run(), then: (resolve: (value: Row[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject) };
    } }),
    update: (table: unknown) => ({ set: (values: Row) => ({ where: (where: SQL) => ({ returning: async () => write(table, "update", values, where) }) }) }),
    delete: (table: unknown) => ({ where: async (where: SQL) => write(table, "delete", {}, where) }),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      trace.push({ event: "begin" });
      const snapshot = structuredClone(state);
      inTransaction = true;
      try {
        const result = await callback(db);
        trace.push({ event: "commit-attempt" });
        if (failure === "commit") throw error;
        trace.push({ event: "commit" });
        return result;
      } catch (cause) {
        state = snapshot;
        trace.push({ event: "rollback" });
        throw cause;
      } finally {
        inTransaction = false;
      }
    },
  };
  const audit: AutonomyLogActivityFn = async () => {
    trace.push({ event: "audit" });
    if (failure === "audit") throw error;
  };
  const backend = createKnowledgeAutonomyRegulationsBackend(db as unknown as Db, audit);
  const invoke = (op: Operation) => {
    switch (op) {
      case "create": return backend.create(company, actor, { role: "engineer", title: "New", bodyMarkdown: "new body" });
      case "update": return backend.update(company, actor, { id, title: "New", bodyMarkdown: "new body" });
      case "approve": return backend.approve(company, actor, id, "operator");
      case "restore": return backend.restore(company, actor, { id, toRevision: 1 }, "operator");
      case "delete": return backend.delete(company, actor, id, "board");
    }
  };
  return { error, trace, invoke, getState: () => state, initial: structuredClone(state) };
}

afterEach(() => vi.useRealTimers());

describe("regulation facade transaction fail-stop", () => {
  const operations: Operation[] = ["create", "update", "approve", "restore", "delete"];
  for (const op of operations) {
    for (const failure of ["callback", "commit", "audit"] as const) {
      it(`${op} propagates ${failure} failure without retry or premature audit`, async () => {
        vi.useFakeTimers(); vi.setSystemTime(now);
        const f = fixture(failure);
        await expect(f.invoke(op)).rejects.toBe(f.error);
        const events = f.trace.map((entry) => entry.event);
        expect(events.filter((event) => event === "begin")).toHaveLength(1);
        if (failure === "audit") {
          expect(events.slice(-2)).toEqual(["commit", "audit"]);
          expect(f.getState()).not.toEqual(f.initial);
        } else {
          expect(events).not.toContain("audit");
          expect(events.at(-1)).toBe("rollback");
          expect(f.getState()).toEqual(f.initial);
        }
        if (failure !== "callback") {
          const writes = f.trace.filter((entry) => ["insert", "update", "delete"].includes(entry.event));
          expect(writes).toHaveLength(op === "delete" ? 1 : 2);
          if (op === "create") expect(writes[0]?.values).toMatchObject({ companyId: company, nestId: company, kind: "rule", title: "New", roles: ["engineer"] });
          if (op === "update") expect(writes[0]?.values).toMatchObject({ itemId: id, content: "new body", revisionNumber: 2 });
          if (op === "approve") expect(writes[0]?.values).toMatchObject({ status: "approved", approvedBy: actor.id });
          if (op === "restore") expect(writes[0]?.values).toMatchObject({ itemId: id, content: "old body", rolledBackFromRevisionId: "revision-1" });
          if (op === "create") expect(writes[1]?.values).toMatchObject({ itemId: writes[0]?.values?.id, content: "new body", revisionNumber: 1 });
          if (op === "update") expect(writes[1]?.values).toMatchObject({ title: "New", currentRevisionNumber: 2, updatedAt: now });
          if (op === "approve") expect(writes[1]?.values).toMatchObject({ deliveredRevisionId: "revision-1", status: "published", updatedAt: now });
          if (op === "restore") expect(writes[1]?.values).toMatchObject({ deliveredRevisionId: writes[0]?.values?.id, currentRevisionNumber: 2, status: "published" });
          if (op !== "create") {
            const scope = f.trace.find((entry) => entry.event === "select" && entry.table === knowledgeItems);
            expect(scope?.sql).toContain('"nest_id"');
            expect(scope?.sql).toContain('"kind"');
            expect(scope?.params).toEqual([company, id, "rule"]);
          }
        }
      });
    }
    if (op !== "delete") it(`${op} rolls back when its second write rejects`, async () => {
      vi.useFakeTimers(); vi.setSystemTime(now);
      const f = fixture("second");
      await expect(f.invoke(op)).rejects.toBe(f.error);
      expect(f.trace.filter((entry) => ["insert", "update", "delete"].includes(entry.event))).toHaveLength(2);
      expect(f.trace.filter((entry) => entry.event === "begin")).toHaveLength(1);
      expect(f.trace.map((entry) => entry.event)).not.toContain("audit");
      expect(f.trace.at(-1)?.event).toBe("rollback");
      expect(f.getState()).toEqual(f.initial);
    });
  }
});
