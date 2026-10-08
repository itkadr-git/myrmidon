// OPE-5401 ч.B — cross-process CAS capture for plugin cron job launches.
//
// The race being closed: two scheduler ticks (or two scheduler processes)
// read the same due job list, then both dispatch it. With the DB-level
// compare-and-set (`UPDATE plugin_jobs SET status='running' WHERE id=? AND
// status<>'running' RETURNING`), only the caller that receives the row owns
// the run; the loser skips the launch — a skip, not an error.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  pluginJobs,
  pluginJobRuns,
  plugins,
} from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";
import {
  createPluginJobScheduler,
  type PluginJobScheduler,
} from "../services/plugin-job-scheduler.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin job cron-CAS tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin job cron launch CAS (OPE-5401 ч.B)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-cas-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `CAS ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.job-cas-test",
      packageName: "@paperclipai/plugin-job-cas-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.job-cas-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Job CAS Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  /** Seed one due `active` cron job (nextRunAt in the past). */
  async function seedDueJob(pluginId: string) {
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "cron-cas",
      schedule: "*/5 * * * *",
      status: "active",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    return jobId;
  }

  async function jobRow(jobId: string) {
    const rows = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
    return rows[0]!;
  }

  // -------------------------------------------------------------------------
  // Store-level CAS semantics
  // -------------------------------------------------------------------------

  it("captureJobForRun: first capture wins, second capture skips without error", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId);
    const store = pluginJobStore(db);

    // First CAS flips active -> running and returns the row.
    await expect(store.captureJobForRun(jobId)).resolves.toBe(true);
    expect((await jobRow(jobId)).status).toBe("running");

    // Second CAS finds the job already running: no row -> skip, NOT an error.
    await expect(store.captureJobForRun(jobId)).resolves.toBe(false);
    // Still running — the losing caller did not disturb the owner's capture.
    expect((await jobRow(jobId)).status).toBe("running");
  });

  it("releaseJobAfterRun: releases only the capture, never clobbers operator state", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId);
    const store = pluginJobStore(db);

    await store.captureJobForRun(jobId);
    await store.releaseJobAfterRun(jobId);
    expect((await jobRow(jobId)).status).toBe("active");

    // Operator paused the job while it was running: the finishing run must
    // NOT resurrect it to active.
    await store.captureJobForRun(jobId);
    await store.updateJobStatus(jobId, "paused");
    await store.releaseJobAfterRun(jobId);
    expect((await jobRow(jobId)).status).toBe("paused");

    // A job nobody captured is left untouched by release.
    await store.releaseJobAfterRun(jobId);
    expect((await jobRow(jobId)).status).toBe("paused");
  });

  it("reclaimStaleJobCaptures: only expired running captures return to active", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId);
    const store = pluginJobStore(db);

    await store.captureJobForRun(jobId);
    // A fresh capture is NOT reclaimed — a live run owns it.
    expect(await store.reclaimStaleJobCaptures(new Date(Date.now() - 1_000))).toBe(0);
    expect((await jobRow(jobId)).status).toBe("running");

    // Simulate the owning process dying: backdate the capture.
    await db
      .update(pluginJobs)
      .set({ updatedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(pluginJobs.id, jobId));

    expect(await store.reclaimStaleJobCaptures(new Date(Date.now() - 60_000))).toBe(1);
    expect((await jobRow(jobId)).status).toBe("active");

    // Idempotent: nothing left to reclaim.
    expect(await store.reclaimStaleJobCaptures(new Date(Date.now() - 60_000))).toBe(0);

    // Operator-paused jobs are never touched by reclaim.
    await store.updateJobStatus(jobId, "paused");
    expect(await store.reclaimStaleJobCaptures(new Date(Date.now() - 60_000))).toBe(0);
    expect((await jobRow(jobId)).status).toBe("paused");
  });

  // -------------------------------------------------------------------------
  // Scheduler-level race: two parallel ticks, one execution
  // -------------------------------------------------------------------------

  /**
   * Simulate two scheduler processes sharing one DB: two scheduler
   * instances, two worker stubs, one execution counter each. The stub
   * holds the job `running` for a real amount of time so the losing tick
   * provably hits the CAS while the capture is held.
   */
  it("two parallel ticks of one due job produce exactly one execution", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId);

    let executions = 0;
    const makeScheduler = (): PluginJobScheduler =>
      createPluginJobScheduler({
        db,
        jobStore: pluginJobStore(db),
        workerManager: {
          isRunning: () => true,
          call: async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 150));
          },
        } as unknown as PluginWorkerManager,
      });

    const first = makeScheduler();
    const second = makeScheduler();

    // Both ticks query the due list concurrently, then race to dispatch.
    await Promise.all([first.tick(), second.tick()]);

    // The acceptance criterion: exactly one worker invocation.
    expect(executions).toBe(1);

    // One run was recorded, the launch capture was released, and the
    // schedule pointer advanced exactly once (nextRunAt in the future).
    const runs = await db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");

    const row = await jobRow(jobId);
    expect(row.status).toBe("active");
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 1_000);

    first.stop();
    second.stop();
  });

  it("a tick over a job whose capture is held externally skips, not errors", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId);

    let executions = 0;
    const scheduler = createPluginJobScheduler({
      db,
      jobStore: pluginJobStore(db),
      workerManager: {
        isRunning: () => true,
        call: async () => {
          executions += 1;
        },
      } as unknown as PluginWorkerManager,
    });

    // Another process holds the capture (simulated crash-recovery window).
    await pluginJobStore(db).captureJobForRun(jobId);

    // tick() must resolve cleanly (no throw) and dispatch nothing.
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(executions).toBe(0);
    expect((await jobRow(jobId)).status).toBe("running");

    scheduler.stop();
  });
});
