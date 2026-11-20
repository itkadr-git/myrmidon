import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeSettings, type Db } from "@myrmidon/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { logActivity } from "../../services/activity-log.js";
import { createKnowledgeSettingsService } from "./settings.js";

vi.mock("../../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const companyId = "company-one";
const otherCompanyId = "company-two";
const now = new Date("2026-11-16T12:00:00.000Z");
const actor = { actorType: "agent" as const, actorId: "agent-one", agentId: "agent-one", runId: "run-one" };
const reviewers = [{ section: "private", reviewerKind: "user" as const, reviewerId: "reviewer-secret" }];
const existing = {
  companyId,
  maxItems: 50,
  maxRevisionBytes: 4096,
  autoAcceptEnabled: false,
  autoAcceptMinConfidence: "0.75",
  schedule: "0 3 * * *",
  sectionReviewers: reviewers,
};
const env = {
  MYRMIDON_KNOWLEDGE_MAX_ITEMS: "700",
  MYRMIDON_KNOWLEDGE_MAX_REVISION_BYTES: "8192",
  MYRMIDON_KNOWLEDGE_AUTO_ACCEPT: "true",
};

function makeDb(hasRow = true) {
  const rows = new Map<string, Record<string, unknown>>([
    ...(hasRow ? [[companyId, { ...existing }] as const] : []),
    [otherCompanyId, { ...existing, companyId: otherCompanyId, maxItems: 999 }],
  ]);
  const originalOther = { ...rows.get(otherCompanyId) };
  const where = vi.fn((condition: SQL) => {
    const query = new PgDialect().sqlToQuery(condition);
    return { limit: vi.fn(async (limit: number) => {
      expect(limit).toBe(1);
      expect(query.sql).toContain('"company_id"');
      expect(query.params).toEqual([companyId]);
      const row = rows.get(String(query.params[0]));
      return row ? [row] : [];
    }) };
  });
  const onConflictDoUpdate = vi.fn(async (conflict: { target: unknown; set: Record<string, unknown> }) => {
    expect(conflict.target).toBe(knowledgeSettings.companyId);
    const values = insertValues.mock.calls[0]?.[0];
    expect(values).toBeDefined();
    if (!values) throw new Error("missing insert values");
    rows.set(String(values.companyId), values);
  });
  const insertValues = vi.fn((values: Record<string, unknown>) => ({ onConflictDoUpdate }));
  const db = {
    select: vi.fn(() => ({ from: vi.fn((table: unknown) => {
      expect(table).toBe(knowledgeSettings);
      return { where };
    }) })),
    insert: vi.fn((table: unknown) => {
      expect(table).toBe(knowledgeSettings);
      return { values: insertValues };
    }),
  };
  return { db: db as unknown as Db, rows, originalOther, where, insertValues, onConflictDoUpdate };
}

function expectWrite(store: ReturnType<typeof makeDb>, fields: Record<string, unknown>) {
  expect(store.insertValues).toHaveBeenCalledTimes(1);
  expect(store.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  expect(store.insertValues).toHaveBeenCalledWith({ companyId, ...fields, updatedAt: now });
  expect(store.onConflictDoUpdate).toHaveBeenCalledWith({
    target: knowledgeSettings.companyId,
    set: { ...fields, updatedAt: now },
  });
  expect(store.rows.get(otherCompanyId)).toEqual(store.originalOther);
}

function expectAudit(db: Db, fields: string[]) {
  expect(logActivity).toHaveBeenCalledTimes(1);
  expect(logActivity).toHaveBeenCalledWith(db, {
    companyId, ...actor, action: "knowledge.settings_updated", entityType: "knowledge_settings",
    entityId: companyId, details: { fields },
  });
}

describe("knowledge settings persistence", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it("preserves all adjacent stored fields and their UI provenance for a one-field patch", async () => {
    const store = makeDb();
    const view = await createKnowledgeSettingsService(store.db, env).update(companyId, { maxItems: "125" }, actor);
    expectWrite(store, {
      maxItems: 125, maxRevisionBytes: 4096, autoAcceptEnabled: false,
      autoAcceptMinConfidence: "0.75", schedule: "0 3 * * *", sectionReviewers: reviewers,
    });
    expect(view).toEqual({
      maxItems: { value: 125, source: "ui" },
      maxRevisionBytes: { value: 4096, source: "ui" },
      autoAcceptEnabled: { value: false, source: "ui" },
      autoAcceptMinConfidence: { value: "0.75", source: "ui" },
      schedule: { value: "0 3 * * *", source: "ui" },
      sectionReviewers: { value: reviewers, source: "ui" },
    });
    expectAudit(store.db, ["maxItems"]);
  });

  it("clears reviewers explicitly without logging their contents", async () => {
    const store = makeDb();
    const view = await createKnowledgeSettingsService(store.db, env).update(companyId, { sectionReviewers: [] }, actor);
    expectWrite(store, {
      maxItems: 50, maxRevisionBytes: 4096, autoAcceptEnabled: false,
      autoAcceptMinConfidence: "0.75", schedule: "0 3 * * *", sectionReviewers: [],
    });
    expect(view.sectionReviewers).toEqual({ value: [], source: "default" });
    expectAudit(store.db, ["sectionReviewers"]);
  });

  it("does not materialize environment values when inserting a partial row", async () => {
    const store = makeDb(false);
    const service = createKnowledgeSettingsService(store.db, env);
    const view = await service.update(companyId, { maxItems: "125" }, actor);
    expectWrite(store, {
      maxItems: 125, maxRevisionBytes: null, autoAcceptEnabled: null,
      autoAcceptMinConfidence: null, schedule: null, sectionReviewers: [],
    });
    const expected = {
      maxItems: { value: 125, source: "ui" },
      maxRevisionBytes: { value: 8192, source: "env" },
      autoAcceptEnabled: { value: true, source: "env" },
      autoAcceptMinConfidence: { value: "0.9", source: "default" },
      schedule: { value: "0 0 0 0 0", source: "default" },
      sectionReviewers: { value: [], source: "default" },
    };
    expect(view).toEqual(expected);
    expect(await service.read(companyId)).toEqual(expected);
    expectAudit(store.db, ["maxItems"]);
  });

  it("rejects an invalid patch before reading, writing, or auditing", async () => {
    const store = makeDb();
    await expect(createKnowledgeSettingsService(store.db, env).update(companyId, { maxItems: "0" }, actor)).rejects.toThrow();
    expect(store.where).not.toHaveBeenCalled();
    expect(store.insertValues).not.toHaveBeenCalled();
    expect(store.onConflictDoUpdate).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});
