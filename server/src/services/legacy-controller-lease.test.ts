import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { hasLiveLegacyController, LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS, LEGACY_CONTROLLER_LEASE_MS, legacyControllerBootId, legacyControllerClaim,
  renewLegacyControllerLease, revokeExpiredLegacyController, watchLegacyControllerLease } from "./legacy-controller-lease.js";

describe("legacy controller confirmation deadline", () => {
  const localDeadlineMs = 100;
  const confirmAt = localDeadlineMs + LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS;

  it.each([
    { state: "live owner", aborts: false },
    { state: "different owner", aborts: true },
    { state: "terminal run", aborts: true },
  ])("checks the committed $state before the renewal response arrives", async ({ state, aborts }) => {
    vi.useFakeTimers();
    const run = {
      id: randomUUID(), companyId: randomUUID(), runtimeMode: "legacy",
      status: "running", controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + localDeadlineMs),
    } as typeof heartbeatRuns.$inferSelect;
    const row = { ...run };
    type RenewalRows = { id: string }[];
    let resolve: ((rows: RenewalRows | PromiseLike<RenewalRows>) => void) | undefined;
    let reject: ((reason?: unknown) => void) | undefined;
    const promise = new Promise<RenewalRows>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    if (!resolve || !reject) throw new Error("Renewal response was not initialized");
    const response = { promise, resolve, reject };
    const returning = vi.fn(() => response.promise);
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
      select: () => ({ from: () => ({ where: async () => [{ ...row }] }) }),
    } as unknown as ReturnType<typeof createDb>;
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await vi.advanceTimersByTimeAsync(localDeadlineMs);
      expect(returning).toHaveBeenCalledTimes(1);

      // Commit the write while its response is still withheld from the watcher.
      row.controllerLeaseExpiresAt = new Date(Date.now() + LEGACY_CONTROLLER_LEASE_MS);
      if (state === "different owner") row.controllerBootId = randomUUID();
      if (state === "terminal run") row.status = "succeeded";

      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS + 1);
      expect(controller.signal.aborted).toBe(aborts);
      if (aborts) expect(controller.signal.reason).toMatchObject({ name: "ControllerLeaseLost" });

      response.resolve([{ id: run.id }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(controller.signal.aborted).toBe(aborts);
    } finally {
      watch.stop();
      response.resolve([{ id: run.id }]);
      vi.useRealTimers();
    }
  });

  it("stops within a second confirm window when the database read does not settle", async () => {
    vi.useFakeTimers();
    const run = {
      id: randomUUID(), companyId: randomUUID(), runtimeMode: "legacy",
      status: "running", controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + localDeadlineMs),
    } as typeof heartbeatRuns.$inferSelect;
    const never = new Promise(() => {});
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: () => never }) }) }),
      select: () => ({ from: () => ({ where: () => never }) }),
    } as unknown as ReturnType<typeof createDb>;
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await vi.advanceTimersByTimeAsync(confirmAt + 1);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS);
      expect(controller.signal.reason).toMatchObject({ name: "ControllerLeaseLost" });
    } finally {
      watch.stop();
      vi.useRealTimers();
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable legacy controller ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-controller-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Controller test", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "claude_local", status: "idle" });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", ...legacyControllerClaim("legacy") })
      .where(eq(heartbeatRuns.id, queued.id)).returning();
    return run;
  }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, id));
  }
  it("commits ownership with the queued claim before provisioning or logs exist", async () => {
    const run = await seed();
    expect(run).toMatchObject({ status: "running", controllerBootId: legacyControllerBootId, executionStage: "preparing", processPid: null });
    expect(await hasLiveLegacyController(db, run)).toBe(true);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("another deployment's startup reaper preserves an unexpired controller", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
    expect(saved.errorCode).toBeNull();
  });
  it.each([false, true])("shutdown preserves a foreign controller (expired: %s)", async expired => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    if (expired) await expire(run.id);
    const result = await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    expect(result.interruptedRunIds).toEqual([]);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
  });
  it("a current controller renews and records the dispatch boundary", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(true);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.executionStage).toBe("dispatching");
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  // myrmidon(OPE-12578): expiry alone is not a takeover; revocation replaces the boot id.
  it("an expired controller that nobody revoked renews (own event-loop stall)", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(true);
    expect(await hasLiveLegacyController(db, run)).toBe(true);
  });
  it("a revoked controller cannot renew or dispatch", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(false);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(controller.signal.aborted).toBe(true);
    } finally { watch.stop(); }
  });
  it("a deadline that fires late after a stall asks the database and keeps the run", async () => {
    const run = await seed();
    await expire(run.id);
    const controller = new AbortController();
    // The local deadline is already behind, as after a long event-loop stall.
    const watch = watchLegacyControllerLease(db, { ...run, controllerLeaseExpiresAt: new Date(Date.now() - 1_000) }, controller);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(controller.signal.aborted).toBe(false);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(saved.controllerBootId).toBe(legacyControllerBootId);
      expect(saved.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    } finally { watch.stop(); }
  });
  it("a failed background renewal is retried instead of aborting the run", async () => {
    const run = await seed();
    const failingDb = { update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.reject(new Error("pool timeout")) }) }) }) } as unknown as typeof db;
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(failingDb, { ...run, controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }, controller);
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(controller.signal.aborted).toBe(false);
    } finally { watch.stop(); vi.useRealTimers(); }
  });
  it("only one competing recovery revokes the observed expired owner", async () => {
    const run = await seed();
    await expire(run.id);
    const attempts = await Promise.all([revokeExpiredLegacyController(db, run), revokeExpiredLegacyController(db, run)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
  });
  it("a crash after revocation permits a later recovery claim", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await hasLiveLegacyController(db, claimed)).toBe(true);
    expect(await revokeExpiredLegacyController(db, claimed)).toBe(false);
    await expire(run.id);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await revokeExpiredLegacyController(db, saved)).toBe(true);
  });
  it("rejects foreign company renewal and revocation", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, { ...run, companyId: randomUUID() })).toBe(false);
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, { ...run, companyId: randomUUID() })).toBe(false);
  });
  it("never turns a terminal run back into owned execution", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("rejects dispatch within the bounded lease confirmation windows when the database hangs", async () => {
    const run = await seed();
    const never = new Promise(() => {});
    const hungDb = {
      update: () => ({ set: () => ({ where: () => ({ returning: () => never }) }) }),
      select: () => ({ from: () => ({ where: () => never }) }),
    } as unknown as typeof db;
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(hungDb, { ...run, controllerLeaseExpiresAt: new Date(Date.now() + 100) }, controller);
    try {
      const checked = expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      await vi.advanceTimersByTimeAsync(100 + 2 * LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS);
      await checked;
      expect(controller.signal.aborted).toBe(true);
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("leaves native controller ownership to the native coordinator", () => {
    expect(legacyControllerClaim("native")).toEqual({});
  });

  // myrmidon(OPE-12484): the abort reason must identify the lease as the
  // cancellation source, so the terminal writer can attribute the run and the
  // activity entry instead of recording a board_cancelled placeholder.
  it("aborts with a ControllerLeaseLost reason the terminal writer can attribute", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(Error);
      expect((controller.signal.reason as Error).name).toBe("ControllerLeaseLost");
      expect((controller.signal.reason as Error).message).toMatch(/lease lost/i);
    } finally { watch.stop(); }
  });
});
