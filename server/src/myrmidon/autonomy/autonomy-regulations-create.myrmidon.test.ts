import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { knowledgeItems, knowledgeRevisions, type Db } from "@myrmidon/db";
import { createKnowledgeAutonomyRegulation } from "./knowledge-regulations.js";

vi.mock("../caste-sensitivity.js", () => ({
  resolveCasteSensitivity: vi.fn(async () => ({ sensitive: new Set(["smm"]) })),
}));

const company = "company-1";
const clock = new Date("2026-01-02T03:04:05.000Z");
type Row = Record<string, unknown>;

function fakeDb(existing: string[] = [], failRevision = false) {
  const trace: string[] = [];
  const predicates: { sql: string; params: unknown[] }[] = [];
  const items: Row[] = [];
  const revisions: Row[] = [];
  const db = {
    select: () => ({ from: (table: unknown) => {
      expect(table).toBe(knowledgeItems);
      return { where: (predicate: SQL) => ({ limit: async (limit: number) => {
        expect(limit).toBe(1);
        const query = new PgDialect().sqlToQuery(predicate);
        predicates.push({ sql: query.sql, params: query.params });
        trace.push("select");
        return existing.includes(String(query.params[1])) ? [{ id: "existing" }] : [];
      } }) };
    } }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      trace.push("begin");
      const itemCount = items.length;
      const revisionCount = revisions.length;
      try {
        await fn({ insert: (table: unknown) => ({ values: async (row: Row) => {
          if (table === knowledgeItems) { trace.push("item"); items.push(row); }
          else if (table === knowledgeRevisions) {
            trace.push("revision");
            if (failRevision) throw new Error("revision failed");
            revisions.push(row);
          } else throw new Error("unexpected table");
        } }) });
        trace.push("commit");
      } catch (error) {
        items.length = itemCount;
        revisions.length = revisionCount;
        trace.push("rollback");
        throw error;
      }
    },
  };
  return { db: db as unknown as Db, items, revisions, predicates, trace };
}

afterEach(() => vi.useRealTimers());

describe("createKnowledgeAutonomyRegulation", () => {
  it("probes scoped collisions and persists the next slug atomically before logging", async () => {
    vi.useFakeTimers(); vi.setSystemTime(clock);
    const base = "rules/smm/my-rule";
    const fake = fakeDb([base, `${base}-2`]);
    const actor = { type: "agent" as const, id: "agent-1" };
    const log = vi.fn(async () => { fake.trace.push("log"); });
    const result = await createKnowledgeAutonomyRegulation(fake.db, company, actor,
      { role: "smm", title: "  My RULE  ", bodyMarkdown: "body" }, log);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected created regulation");
    expect(result.value).toMatchObject({ wikiPageId: `${base}-3`, status: "draft", revision: 1, createdBy: actor, bodyMarkdown: "body" });
    expect(fake.predicates.map((p) => p.params)).toEqual([[company, base], [company, `${base}-2`], [company, `${base}-3`]]);
    for (const predicate of fake.predicates) {
      expect(predicate.sql).toMatch(/"nest_id"\s*=\s*\$1/);
      expect(predicate.sql).toMatch(/"slug"\s*=\s*\$2/);
    }
    expect(fake.trace).toEqual(["select", "select", "select", "begin", "item", "revision", "commit", "log"]);
    expect(fake.items).toHaveLength(1); expect(fake.revisions).toHaveLength(1);
    expect(fake.items[0]).toMatchObject({ id: result.value.id, companyId: company, nestId: company, kind: "rule", slug: `${base}-3`, folderPath: "rules/smm", roles: ["smm"], title: "  My RULE  ", status: "draft", approverKind: "owner", approvalRequired: true, deliveredRevisionId: null, currentRevisionNumber: 1, createdByAgentId: actor.id, createdByUserId: null, createdAt: clock, updatedAt: clock });
    expect(fake.revisions[0]).toMatchObject({ companyId: company, nestId: company, itemId: result.value.id, revisionNumber: 1, status: "draft", content: "body", changeSummary: "created", createdByAgentId: actor.id, createdByUserId: null, createdAt: clock });
    expect(fake.revisions[0].id).toEqual(expect.any(String));
    expect(fake.revisions[0].id).not.toBe(result.value.id);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ companyId: company, actorType: "agent", actorId: actor.id, entityId: result.value.id, entityType: "autonomy_regulation" }));
  });

  it.each([
    [{ type: "board" as const, id: "user-1" }, "user", null, "user-1"],
    [{ type: "system" as const, id: "system" }, "system", null, null],
  ])("maps %s actor and empty ASCII slugs", async (actor, actorType, agentId, userId) => {
    vi.useFakeTimers(); vi.setSystemTime(clock);
    const fake = fakeDb();
    const log = vi.fn(async () => { fake.trace.push("log"); });
    const result = await createKnowledgeAutonomyRegulation(fake.db, company, actor,
      { role: "  !!!  ", title: "  ЖЖ  ", bodyMarkdown: "text" }, log);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected created regulation");
    expect(result.value).toMatchObject({ wikiPageId: "rules/rule/rule", createdBy: actor, updatedBy: actor, revisions: [{ author: actor, at: clock.toISOString() }] });
    for (const row of [fake.items[0], fake.revisions[0]]) expect(row).toMatchObject({ companyId: company, nestId: company, createdByAgentId: agentId, createdByUserId: userId });
    expect(fake.items[0]).toMatchObject({ roles: ["  !!!  "], approverKind: "operator" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ actorType, actorId: actor.id }));
    expect(fake.trace).toEqual(["select", "begin", "item", "revision", "commit", "log"]);
  });

  it("rolls back the item and does not log if the revision insert fails", async () => {
    const fake = fakeDb([], true);
    const log = vi.fn();
    await expect(createKnowledgeAutonomyRegulation(fake.db, company, { type: "system", id: "system" },
      { role: "engineer", title: "test", bodyMarkdown: "body" }, log)).rejects.toThrow("revision failed");
    expect(fake.items).toEqual([]); expect(fake.revisions).toEqual([]);
    expect(fake.trace).toEqual(["select", "begin", "item", "revision", "rollback"]);
    expect(log).not.toHaveBeenCalled();
  });
});
