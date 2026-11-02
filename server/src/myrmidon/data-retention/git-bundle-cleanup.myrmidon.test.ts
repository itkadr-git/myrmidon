import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assets, companies, createDb, issueAttachments, issues } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readDataRetentionLastRun, readDataRetentionSettings, writeDataRetentionLastRun } from "./settings.js";
import { createClosedTaskGitBundleCleanup } from "./git-bundle-cleanup.js";
import { createDataRetentionSweep } from "./sweep.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-01T00:00:00.000Z");

describeDb("closed-task git-bundle retention cleanup", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-bundle-retention-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  afterEach(async () => {
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(companies);
  });

  async function seed(input: { status?: string; ageDays: number; filename?: string; contentType?: string }) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const assetId = randomUUID();
    const attachmentId = randomUUID();
    const objectKey = `${companyId}/issues/${issueId}/workspace.bundle`;
    await db.insert(companies).values({ id: companyId, name: "test", issuePrefix: `T${companyId.slice(0, 3)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "fixture", status: input.status ?? "done", completedAt: new Date(NOW.getTime() - input.ageDays * DAY) });
    await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey, contentType: input.contentType ?? "application/octet-stream", byteSize: 16, sha256: "a".repeat(64), originalFilename: input.filename ?? "workspace.bundle" });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId, issueId, assetId });
    return { companyId, issueId, assetId, attachmentId, objectKey };
  }

  function makeStorage(deleteObject: (companyId: string, objectKey: string) => Promise<void>) {
    return { provider: "local_disk" as const, putFile: vi.fn(), getObject: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn(deleteObject) };
  }

  function makeSweep(cleanup: () => Promise<unknown>) {
    const settings = instanceSettingsService(db);
    return createDataRetentionSweep({
      db,
      resolveSettings: () => readDataRetentionSettings(settings),
      readLastRun: () => readDataRetentionLastRun(settings),
      writeLastRun: (value) => writeDataRetentionLastRun(settings, value),
      checkBackup: async () => ({ fresh: true, checkedAt: NOW }),
      logWaitingForBackup: async () => undefined,
      logThrottled: async () => undefined,
      gitBundleCleanup: cleanup,
      minPassIntervalMs: 0,
      now: () => NOW,
    });
  }

  it("uses the two-day terminal cutoff and deletes storage before DB rows", async () => {
    const old = await seed({ ageDays: 3 });
    const young = await seed({ ageDays: 1 });
    const open = await seed({ ageDays: 4, status: "in_progress" });
    const storage = makeStorage(async (companyId, key) => {
      expect([companyId, key]).toEqual([old.companyId, old.objectKey]);
      expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, old.attachmentId))).toHaveLength(1);
    });
    const cleanup = createClosedTaskGitBundleCleanup({ db, storage, now: () => NOW });
    await makeSweep(cleanup).sweep();
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, old.attachmentId))).toHaveLength(0);
    expect(await db.select().from(assets).where(eq(assets.id, old.assetId))).toHaveLength(0);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, young.attachmentId))).toHaveLength(1);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, open.attachmentId))).toHaveLength(1);
  });

  it("retains rows after storage failure, retries, then becomes idempotent", async () => {
    const fixture = await seed({ ageDays: 3 });
    let attempts = 0;
    const storage = makeStorage(async () => { attempts += 1; if (attempts === 1) throw new Error("provider unavailable"); });
    const cleanup = createClosedTaskGitBundleCleanup({ db, storage, now: () => NOW });
    expect(await cleanup()).toEqual({ deleted: 0, failed: 1 });
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, fixture.attachmentId))).toHaveLength(1);
    expect(await cleanup()).toEqual({ deleted: 1, failed: 0 });
    expect(await cleanup()).toEqual({ deleted: 0, failed: 0 });
    expect(attempts).toBe(2);
  });

  it("is invoked by the retention sweep", async () => {
    const fixture = await seed({ ageDays: 3 });
    const storage = makeStorage(async () => undefined);
    const cleanup = createClosedTaskGitBundleCleanup({ db, storage, now: () => NOW });
    await makeSweep(cleanup).sweep();
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, fixture.attachmentId))).toHaveLength(0);
  });

  it("matches bundle attachment filenames and rejects unrelated metadata", async () => {
    const fixture = await seed({ ageDays: 4, filename: "runner-123.bundle", contentType: "application/octet-stream" });
    const storage = makeStorage(async () => undefined);
    expect(await createClosedTaskGitBundleCleanup({ db, storage, now: () => NOW })()).toEqual({ deleted: 1, failed: 0 });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, fixture.attachmentId))).toHaveLength(0);

    const unrelated = await seed({ ageDays: 4, filename: "archive.zip", contentType: "application/zip" });
    expect(await createClosedTaskGitBundleCleanup({ db, storage, now: () => NOW })()).toEqual({ deleted: 0, failed: 0 });
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, unrelated.attachmentId))).toHaveLength(1);
  });
});
