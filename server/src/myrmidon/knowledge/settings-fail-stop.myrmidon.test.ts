import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeSettings, type Db } from "@myrmidon/db";
import { resolveKnowledgeSettings } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { logActivity } from "../../services/activity-log.js";
import { createKnowledgeSettingsService, type KnowledgeSettingsService } from "./settings.js";
import { myrmidonKnowledgeSettingsRoutes } from "./settings-routes.js";

vi.mock("../../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const companyId = "22222222-2222-4222-8222-222222222222";
const actor = { actorType: "user" as const, actorId: "user-1" };
const patch = { maxItems: "250" };
const path = `/api/myrmidon/companies/${companyId}/knowledge/settings`;

function stubDb() {
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const db = { select, insert } as unknown as Db;
  return { db, select, from, where, limit, insert, values, onConflictDoUpdate };
}

function assertRead(db: ReturnType<typeof stubDb>) {
  expect(db.select).toHaveBeenCalledTimes(1);
  expect(db.select).toHaveBeenCalledWith();
  expect(db.from).toHaveBeenCalledExactlyOnceWith(knowledgeSettings);
  expect(db.where).toHaveBeenCalledTimes(1);
  expect(db.limit).toHaveBeenCalledExactlyOnceWith(1);
}

function assertUpsert(db: ReturnType<typeof stubDb>) {
  expect(db.insert).toHaveBeenCalledExactlyOnceWith(knowledgeSettings);
  expect(db.values).toHaveBeenCalledExactlyOnceWith({
    companyId, maxItems: 250, maxRevisionBytes: null, autoAcceptEnabled: null,
    autoAcceptMinConfidence: null, schedule: null, sectionReviewers: [], updatedAt: expect.any(Date),
  });
  expect(db.onConflictDoUpdate).toHaveBeenCalledExactlyOnceWith({
    target: knowledgeSettings.companyId,
    set: {
      maxItems: 250, maxRevisionBytes: null, autoAcceptEnabled: null,
      autoAcceptMinConfidence: null, schedule: null, sectionReviewers: [], updatedAt: expect.any(Date),
    },
  });
  expect(db.limit.mock.invocationCallOrder[0]).toBeLessThan(db.insert.mock.invocationCallOrder[0]);
}

function assertAudit(db: ReturnType<typeof stubDb>) {
  expect(logActivity).toHaveBeenCalledExactlyOnceWith(db.db, {
    companyId, actorType: "user", actorId: "user-1", agentId: null, runId: null,
    action: "knowledge.settings_updated", entityType: "knowledge_settings", entityId: companyId,
    details: { fields: ["maxItems"] },
  });
  expect(db.onConflictDoUpdate.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(logActivity).mock.invocationCallOrder[0]);
}

describe("knowledge settings fail-stop service", () => {
  beforeEach(() => vi.mocked(logActivity).mockReset());

  it("rejects bounded fields before reading, writing, or auditing", async () => {
    const db = stubDb();
    const service = createKnowledgeSettingsService(db.db, {});
    await expect(service.update(companyId, { maxItems: "0", autoAcceptMinConfidence: "2" }, actor))
      .rejects.toMatchObject({ status: 400, details: { fields: ["maxItems", "autoAcceptMinConfidence"] } });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("propagates a failed select without writing or auditing", async () => {
    const db = stubDb();
    const failure = new Error("select failed");
    db.limit.mockRejectedValueOnce(failure);
    await expect(createKnowledgeSettingsService(db.db, {}).update(companyId, patch, actor)).rejects.toBe(failure);
    assertRead(db);
    expect(db.insert).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("propagates a failed upsert without auditing", async () => {
    const db = stubDb();
    const failure = new Error("upsert failed");
    db.onConflictDoUpdate.mockRejectedValueOnce(failure);
    await expect(createKnowledgeSettingsService(db.db, {}).update(companyId, patch, actor)).rejects.toBe(failure);
    assertRead(db);
    assertUpsert(db);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("propagates audit failure after the successful upsert", async () => {
    const db = stubDb();
    const failure = new Error("audit failed");
    vi.mocked(logActivity).mockRejectedValueOnce(failure);
    await expect(createKnowledgeSettingsService(db.db, {}).update(companyId, patch, actor)).rejects.toBe(failure);
    assertRead(db);
    assertUpsert(db);
    assertAudit(db);
  });

  it("returns the resolved view only after a successful upsert and audit", async () => {
    const db = stubDb();
    const view = await createKnowledgeSettingsService(db.db, {}).update(companyId, patch, actor);
    expect(view).toEqual(resolveKnowledgeSettings({ maxItems: 250 }, {}));
    expect(view.maxItems).toEqual({ value: 250, source: "ui" });
    assertRead(db);
    assertUpsert(db);
    assertAudit(db);
  });
});

describe("knowledge settings fail-stop HTTP routes", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeApp(service: KnowledgeSettingsService) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "user-1", isInstanceAdmin: true,
        companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "admin" }] };
      next();
    });
    app.use("/api", myrmidonKnowledgeSettingsRoutes(null as unknown as Db, {}, service));
    app.use(errorHandler);
    return app;
  }

  it.each(["read", "update"] as const)("handles a rejected %s and accepts the next request", async (method) => {
    const view = resolveKnowledgeSettings({ maxItems: 250 }, {});
    const read = vi.fn<KnowledgeSettingsService["read"]>().mockResolvedValue(view);
    const update = vi.fn<KnowledgeSettingsService["update"]>().mockResolvedValue(view);
    const failure = new Error(`${method} failed`);
    if (method === "read") read.mockRejectedValueOnce(failure);
    else update.mockRejectedValueOnce(failure);
    const app = makeApp({ read, update });
    const send = () => method === "read" ? request(app).get(path) : request(app).patch(path).send(patch);
    const failed = await send();
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Internal server error" });
    const succeeded = await send();
    expect(succeeded.status).toBe(200);
    expect(succeeded.body).toEqual(view);
    if (method === "read") {
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenNthCalledWith(1, companyId);
      expect(read).toHaveBeenNthCalledWith(2, companyId);
      expect(update).not.toHaveBeenCalled();
    } else {
      expect(update).toHaveBeenCalledTimes(2);
      const expectedActor = { actorType: "user", actorId: "user-1", agentId: null, runId: null };
      expect(update).toHaveBeenNthCalledWith(1, companyId, patch, expectedActor);
      expect(update).toHaveBeenNthCalledWith(2, companyId, patch, expectedActor);
      expect(read).not.toHaveBeenCalled();
    }
  });
});
