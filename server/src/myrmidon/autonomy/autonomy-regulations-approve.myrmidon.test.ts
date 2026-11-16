import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { knowledgeItems, knowledgeRevisions, type Db } from "@myrmidon/db";
import { approveKnowledgeAutonomyRegulation } from "./knowledge-regulations.js";

vi.mock("../caste-sensitivity.js", () => ({ resolveCasteSensitivity: vi.fn() }));
import { resolveCasteSensitivity } from "../caste-sensitivity.js";

const company = "company-1";
const id = "item-1";
const now = new Date("2026-01-02T03:04:05.000Z");
const actor = { type: "board", id: "owner-1" } as const;
type Item = typeof knowledgeItems.$inferSelect;
type Revision = typeof knowledgeRevisions.$inferSelect;
const dialect = new PgDialect();
const query = (predicate: SQL) => dialect.sqlToQuery(predicate);

function fixture(role = "engineer", stored = "owner") {
  const item = {
    id, nestId: company, kind: "rule", roles: [role], approverKind: stored,
    title: "Rule", slug: "rules/example", currentRevisionNumber: 2,
    deliveredRevisionId: "rev-1", status: "draft", createdAt: now, updatedAt: now,
    createdByAgentId: null, createdByUserId: "author", supersededByItemId: null,
  } as Item;
  const revisions = [1, 2].map((n) => ({
    id: `rev-${n}`, itemId: id, revisionNumber: n, status: n === 1 ? "approved" : "draft",
    content: `body-${n}`, createdAt: now, createdByAgentId: n === 1 ? "agent-1" : null,
    createdByUserId: n === 2 ? "author" : null, approvedAt: n === 1 ? now : null,
    approvedBy: n === 1 ? "previous" : null,
  } as Revision));
  return { item, revisions };
}

function fakeDb(initial = fixture()) {
  let state = structuredClone(initial);
  const trace: string[] = [];
  const writes: Array<{ table: string; values: Record<string, unknown>; predicate: ReturnType<typeof query> }> = [];
  const tx = {
    select: () => ({ from: (table: unknown) => ({ where: (predicate: SQL) => {
      if (table === knowledgeItems) {
        expect(query(predicate)).toEqual(query(and(eq(knowledgeItems.nestId, company), eq(knowledgeItems.id, id), eq(knowledgeItems.kind, "rule"))!));
        return { for: async (mode: string) => { expect(mode).toBe("update"); trace.push("select-item-lock"); return state.item ? [structuredClone(state.item)] : []; } };
      }
      expect(table).toBe(knowledgeRevisions);
      expect(query(predicate)).toEqual(query(eq(knowledgeRevisions.itemId, id)));
      return { orderBy: async (column: unknown) => { expect(column).toBe(knowledgeRevisions.revisionNumber); trace.push("select-revisions"); return structuredClone(state.revisions); } };
    } }) }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: (predicate: SQL) => ({ returning: async () => {
      const isRevision = table === knowledgeRevisions;
      expect(isRevision || table === knowledgeItems).toBe(true);
      const target = isRevision ? state.revisions.find((r) => r.id === "rev-2") : state.item;
      expect(target).toBeDefined();
      expect(query(predicate)).toEqual(query(isRevision ? eq(knowledgeRevisions.id, "rev-2") : eq(knowledgeItems.id, id)));
      const name = isRevision ? "revision" : "item";
      trace.push(`update-${name}`);
      writes.push({ table: name, values, predicate: query(predicate) });
      Object.assign(target!, values);
      return [structuredClone(target)];
    } }) }) }),
  };
  const db = { transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
    const snapshot = structuredClone(state);
    trace.push("begin");
    try { const result = await fn(tx); trace.push("commit"); return result; }
    catch (error) { state = snapshot; trace.push("rollback"); throw error; }
  } } as unknown as Db;
  return { db, trace, writes, state: () => state };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("approveKnowledgeAutonomyRegulation", () => {
  it.each([
    { role: "sensitive", stored: "operator", presented: "operator", required: "owner" },
    { role: "sensitive", stored: "operator", presented: null, required: "owner" },
    { role: "engineer", stored: "owner", presented: null, required: "operator" },
  ])("rejects $presented for $role regardless of stored $stored", async ({ role, stored, presented, required }) => {
    vi.mocked(resolveCasteSensitivity).mockResolvedValue({ sensitive: new Set(["sensitive"]) });
    const fake = fakeDb(fixture(role, stored));
    const before = structuredClone(fake.state());
    const log = vi.fn();
    const result = await approveKnowledgeAutonomyRegulation(fake.db, company, actor, id, presented, log);
    expect(result).toEqual({ ok: false, failure: { kind: "approver_kind_mismatch", regulationId: id, required, presented } });
    expect(resolveCasteSensitivity).toHaveBeenCalledWith(fake.db, company);
    expect(fake.state()).toEqual(before);
    expect(fake.writes).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(fake.trace).toEqual(["begin", "select-item-lock", "commit"]);
  });

  it.each([
    { role: "sensitive", presented: "owner", stored: "operator" },
    { role: "engineer", presented: "operator", stored: "owner" },
    { role: "engineer", presented: "owner", stored: "owner" },
  ])("publishes current revision for $presented on $role", async ({ role, presented, stored }) => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.mocked(resolveCasteSensitivity).mockResolvedValue({ sensitive: new Set(["sensitive"]) });
    const initial = fixture(role, stored);
    const fake = fakeDb(initial);
    const log = vi.fn(async () => { fake.trace.push("log"); });
    const result = await approveKnowledgeAutonomyRegulation(fake.db, company, actor, id, presented, log);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected approval");
    expect(result.value).toMatchObject({ id, role, title: "Rule", bodyMarkdown: "body-2", status: "approved", revision: 2,
      createdBy: { type: "board", id: "author" }, updatedBy: { type: "board", id: "author" },
      revisions: [{ revision: 1, bodyMarkdown: "body-1", author: { type: "agent", id: "agent-1" } }, { revision: 2, bodyMarkdown: "body-2", status: "approved" }] });
    expect(fake.state().revisions[0]).toEqual(initial.revisions[0]);
    expect(fake.state().revisions[1]).toEqual({ ...initial.revisions[1], status: "approved", approvedAt: now, approvedBy: actor.id });
    expect(fake.state().item).toEqual({ ...initial.item, status: "published", deliveredRevisionId: "rev-2", updatedAt: now });
    expect(fake.writes.map(({ table, values }) => ({ table, values }))).toEqual([
      { table: "revision", values: { status: "approved", approvedAt: now, approvedBy: actor.id } },
      { table: "item", values: { status: "published", deliveredRevisionId: "rev-2", updatedAt: now } },
    ]);
    expect(fake.trace).toEqual(["begin", "select-item-lock", "select-revisions", "update-revision", "update-item", "commit", "log"]);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ companyId: company, actorType: "user", actorId: actor.id, entityId: id, entityType: "autonomy_regulation", action: expect.stringMatching(/regulation_approved$/) }));
  });

  it.each(["missing-item", "missing-current", "already-approved"])("fails closed for %s", async (scenario) => {
    vi.mocked(resolveCasteSensitivity).mockResolvedValue({ sensitive: new Set() });
    const initial = fixture();
    if (scenario === "missing-item") initial.item = null as unknown as Item;
    if (scenario === "missing-current") initial.revisions = initial.revisions.slice(0, 1);
    if (scenario === "already-approved") initial.revisions[1] = { ...initial.revisions[1]!, status: "approved" };
    const fake = fakeDb(initial);
    const before = structuredClone(fake.state());
    const log = vi.fn();
    const result = await approveKnowledgeAutonomyRegulation(fake.db, company, actor, id, "owner", log);
    expect(result).toEqual({ ok: false, failure: { kind: scenario === "already-approved" ? "already_approved" : "regulation_not_found", regulationId: id } });
    expect(fake.state()).toEqual(before);
    expect(fake.writes).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(fake.trace).toEqual(scenario === "missing-item" ? ["begin", "select-item-lock", "commit"] : ["begin", "select-item-lock", "select-revisions", "commit"]);
  });

  it("propagates caste directory failures before starting a transaction", async () => {
    vi.mocked(resolveCasteSensitivity).mockRejectedValue(new Error("directory unavailable"));
    const fake = fakeDb(); const before = structuredClone(fake.state()); const log = vi.fn();
    await expect(approveKnowledgeAutonomyRegulation(fake.db, company, actor, id, "owner", log)).rejects.toThrow("directory unavailable");
    expect(fake.trace).toEqual([]); expect(fake.writes).toEqual([]); expect(fake.state()).toEqual(before); expect(log).not.toHaveBeenCalled();
  });
});
