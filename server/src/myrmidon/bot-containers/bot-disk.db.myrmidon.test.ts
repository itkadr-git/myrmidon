// myrmidon(BOT-DISK-A): the bot disk settings against an embedded Postgres and
// the real instance settings service — a PATCH lands in
// `instance_settings.general.botDisk`, survives a fresh service read and every
// other general write, and an old row without the key still loads.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, instanceSettings } from "@paperclipai/db";
import { BOT_DISK_DEFAULT_IDLE_TTL_MS, BOT_DISK_UPDATED_ACTION } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { botDiskRoutes } from "./bot-disk-routes.js";
import { botDiskService, resolveBotDiskLifecycleConfig } from "./bot-disk-service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const URL = "/api/myrmidon/bot-disk";

describeEmbeddedPostgres("myrmidon(BOT-DISK-A) bot disk settings in the database", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-bot-disk-");
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
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
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
    scoped.use("/api", botDiskRoutes(db, botDiskService(db, { env: {} })));
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

  it("PATCH persists and survives a fresh service read and other general writes", async () => {
    const companyId = await seedCompany();

    await request(app(board(companyId, false))).patch(URL).send({ idleTtlMs: 2 * HOUR }).expect(403);
    expect((await instanceSettingsService(db).getGeneral()).botDisk).toBeUndefined();

    await request(app(board(companyId, true))).patch(URL).send({ idleTtlMs: 2 * HOUR }).expect(200);

    // A fresh service instance reads the row from the database.
    const general = await instanceSettingsService(db).getGeneral();
    expect(general.botDisk).toEqual({ enabled: true, idleTtlMs: 2 * HOUR });
    const fresh = await botDiskService(db, { env: {} }).read();
    expect(fresh).toEqual({
      settings: { enabled: true, idleTtlMs: 2 * HOUR },
      sources: { enabled: "settings", idleTtlMs: "settings" },
    });

    // An unrelated general write must not drop the key.
    await instanceSettingsService(db).updateGeneral({ keyboardShortcuts: true });
    expect((await instanceSettingsService(db).getGeneral()).botDisk).toEqual({
      enabled: true,
      idleTtlMs: 2 * HOUR,
    });

    // The sweep config the next tick uses.
    const config = await resolveBotDiskLifecycleConfig(
      instanceSettingsService(db) as unknown as { getGeneral(): Promise<{ botDisk?: unknown }> },
      {},
    );
    expect(config).toMatchObject({ enabled: true, idleTtlMs: 2 * HOUR });

    // The audit row.
    const audits = await db.select().from(activityLog).where(eq(activityLog.action, BOT_DISK_UPDATED_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ companyId, actorType: "user", actorId: "admin-user" });
  });

  it("an old row without the key still loads", async () => {
    const companyId = await seedCompany();
    // Create the row, then overwrite general with a pre-BOT-DISK-A shape.
    await instanceSettingsService(db).getGeneral();
    await db.update(instanceSettings).set({
      general: { keyboardShortcuts: true, hostDisk: { usageThresholdPercent: 70 } },
    });

    const general = await instanceSettingsService(db).getGeneral();
    expect(general.keyboardShortcuts).toBe(true);
    expect(general.hostDisk).toEqual({ usageThresholdPercent: 70 });
    expect(general.botDisk).toBeUndefined();

    const res = await request(app(board(companyId, false))).get(URL).expect(200);
    expect(res.body).toEqual({
      settings: { enabled: true, idleTtlMs: BOT_DISK_DEFAULT_IDLE_TTL_MS },
      sources: { enabled: "default", idleTtlMs: "default" },
    });
  });
});
