// server/src/myrmidon/data-retention/service.myrmidon.test.ts
//
// myrmidon(1.6.5-DB-RETENTION): the DataRetentionView contract over an
// embedded Postgres — GET reports the settings with their per-key source and
// the persisted sweep state; PATCH validates, merges, logs and returns the
// fresh view; authz: GET is board-readable, PATCH is instance-admin only.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, instanceSettings } from "@paperclipai/db";
import { DATA_RETENTION_UPDATED_ACTION } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { dataRetentionRoutes } from "./routes.js";
import { dataRetentionService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const URL = "/api/myrmidon/data-retention";

describeEmbeddedPostgres("myrmidon(1.6.5-DB-RETENTION) data retention routes", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-data-retention-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: "COMB",
    });
    return companyId;
  }

  function app(actor: Record<string, unknown>) {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    const settings = instanceSettingsService(db);
    const service = dataRetentionService({
      settings,
      listCompanyIds: () => settings.listCompanyIds(),
      logActivity: (entry) => logActivity(db, entry),
    });
    scoped.use("/api", dataRetentionRoutes(db, service));
    scoped.use(errorHandler);
    return scoped;
  }

  function board(companyId: string, isInstanceAdmin: boolean) {
    return {
      type: "board",
      source: "session",
      userId: isInstanceAdmin ? "admin-user" : "member-user",
      isInstanceAdmin,
      companyIds: [companyId],
    };
  }

  it("GET reports the defaults with source=default when nothing is stored", async () => {
    const companyId = await seedCompany();
    const res = await request(app(board(companyId, false))).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      heartbeatRunsDays: 90,
      activityLogDays: 90,
      accessAuditDays: 90,
    });
    expect(res.body.sources).toEqual({
      heartbeatRunsDays: "default",
      activityLogDays: "default",
      accessAuditDays: "default",
    });
    expect(res.body.status).toEqual({
      lastRunAt: null,
      waitingForBackup: false,
      backupCheckedAt: null,
      freedBytesTotal: 0,
      perTable: {
        runs: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        activity: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        access: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
      },
    });
  });

  it("PATCH stores a partial update, logs the change per company and returns the view", async () => {
    const companyId = await seedCompany();
    const res = await request(app(board(companyId, true)))
      .patch(URL)
      .send({ heartbeatRunsDays: 30 });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      heartbeatRunsDays: 30,
      activityLogDays: 90,
      accessAuditDays: 90,
    });
    expect(res.body.sources.heartbeatRunsDays).toBe("settings");

    const stored = await instanceSettingsService(db).getGeneral();
    expect((stored as Record<string, any>).dataRetention).toMatchObject({
      heartbeatRunsDays: 30,
      activityLogDays: 90,
      accessAuditDays: 90,
    });

    const logRows = await db.select().from(activityLog);
    const updates = logRows.filter((row) => row.action === DATA_RETENTION_UPDATED_ACTION);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.companyId).toBe(companyId);
  });

  it("PATCH rejects non-integer, negative and unknown values", async () => {
    const companyId = await seedCompany();
    const scoped = app(board(companyId, true));
    for (const body of [
      { heartbeatRunsDays: 30.5 },
      { activityLogDays: -1 },
      { accessAuditDays: "30" },
      { heartbeatRunsDays: 30, unknownKey: 1 },
    ]) {
      const res = await request(scoped).patch(URL).send(body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
    }
    // a retention of 0 is valid and means "keep forever"
    const ok = await request(scoped).patch(URL).send({ accessAuditDays: 0 });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.accessAuditDays).toBe(0);
  });

  it("PATCH is instance-admin only; GET is board-readable", async () => {
    const companyId = await seedCompany();
    const member = await request(app(board(companyId, false)))
      .patch(URL)
      .send({ heartbeatRunsDays: 30 });
    expect(member.status).toBe(403);
    const read = await request(app(board(companyId, false))).get(URL);
    expect(read.status).toBe(200);
  });
});
