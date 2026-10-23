// myrmidon(1.6.6 REMOTE-SITES-T4): the database half of the site failover against an embedded Postgres:
// the atomic claim of a bot's move, the compare-and-swap of a site's status, the bots a store lists for
// a site, and the atomic claim of a run of a lost site.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, myrmidonFleetMoves, myrmidonFleetSites } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { fleetMoveStore } from "./fleet-move-store.js";
import { FleetMoveClaimConflict } from "./fleet-move-service.js";
import { siteHealthStore } from "./site-health-store.js";
import { claimRunForSiteLost, SITE_LOST_CONTEXT_KEY } from "../site-lost-claim.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("site failover against a database", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-site-failover-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(myrmidonFleetMoves);
    await db.delete(myrmidonFleetSites);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase() });
    return companyId;
  }

  async function seedBot(companyId: string, container: Record<string, unknown>, over: { adapterType?: string; status?: string } = {}) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `bot-${id.slice(0, 4)}`,
      role: "engineer",
      status: over.status ?? "idle",
      adapterType: over.adapterType ?? "hermes_gateway",
      adapterConfig: { container },
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedSite(companyId: string, name: string, status = "active") {
    const [row] = await db
      .insert(myrmidonFleetSites)
      .values({ companyId, name, url: `https://${name}.example.test`, status })
      .returning();
    return row!;
  }

  describe("the claim of a bot's move", () => {
    it("of two simultaneous creates for one bot the database lets exactly one through", async () => {
      const companyId = await seedCompany();
      const store = fleetMoveStore(db);
      const botKey = randomUUID();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => store.createMove({ companyId, botKey, srcSite: "myr-vm1", dstSite: "local", source: "replica" })),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(4);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(FleetMoveClaimConflict);
      expect(await db.select().from(myrmidonFleetMoves)).toHaveLength(1);
    });

    it("the slot opens again when the move is done or failed, and another bot is never blocked", async () => {
      const companyId = await seedCompany();
      const store = fleetMoveStore(db);
      const botKey = randomUUID();
      const first = await store.createMove({ companyId, botKey, srcSite: "myr-vm1", dstSite: "local" });
      await expect(store.createMove({ companyId, botKey, srcSite: "myr-vm1", dstSite: "local" })).rejects.toBeInstanceOf(FleetMoveClaimConflict);

      await store.createMove({ companyId, botKey: randomUUID(), srcSite: "myr-vm1", dstSite: "local" });
      await store.updateMove(first.id, { phase: "failed", error: "boom" });
      const second = await store.createMove({ companyId, botKey, srcSite: "myr-vm1", dstSite: "local", source: "replica" });
      expect(second.source).toBe("replica");
      expect((await store.getMove(first.id))?.source).toBe("live");

      await store.updateMove(second.id, { phase: "done", completedAt: new Date() });
      await store.createMove({ companyId, botKey, srcSite: "local", dstSite: "myr-vm1" });
    });
  });

  describe("site health store", () => {
    it("lists active and draining sites only and persists the monitor's state with lastSeenAt", async () => {
      const companyId = await seedCompany();
      const up = await seedSite(companyId, "up");
      await seedSite(companyId, "drained", "draining");
      await seedSite(companyId, "held", "quarantined");
      await seedSite(companyId, "off", "disabled");
      const store = siteHealthStore(db);

      expect((await store.listSites()).map((s) => s.name).sort()).toEqual(["drained", "up"]);

      const seen = new Date("2026-10-23T08:00:00.000Z");
      const health = { snapshot: { state: "healthy", missCount: 0 }, autoDrained: false, state: "healthy", recoveryPasses: 1, reconciled: false, updatedAt: seen.toISOString() };
      await store.saveHealth(up.id, health, seen);
      const [row] = await db.select().from(myrmidonFleetSites).where(eq(myrmidonFleetSites.id, up.id));
      expect(row?.health).toEqual(health);
      expect(row?.lastSeenAt?.toISOString()).toBe(seen.toISOString());

      await store.saveHealth(up.id, { ...health, state: "unreachable" }, null);
      const [after] = await db.select().from(myrmidonFleetSites).where(eq(myrmidonFleetSites.id, up.id));
      expect(after?.lastSeenAt?.toISOString()).toBe(seen.toISOString());
    });

    it("a status change is a compare-and-swap: of two writers racing to drain, one wins; a quarantine is not overwritten", async () => {
      const companyId = await seedCompany();
      const site = await seedSite(companyId, "up");
      const store = siteHealthStore(db);

      const wins = await Promise.all([store.setStatus(site.id, ["active"], "draining"), store.setStatus(site.id, ["active"], "draining")]);
      expect(wins.filter(Boolean)).toHaveLength(1);

      expect(await store.setStatus(site.id, ["active", "draining"], "quarantined")).toBe(true);
      expect(await store.setStatus(site.id, ["draining"], "active")).toBe(false);
      const [row] = await db.select().from(myrmidonFleetSites).where(eq(myrmidonFleetSites.id, site.id));
      expect(row?.status).toBe("quarantined");
    });

    it("lists the bots whose card names the site, with the pinned flag, and ignores disabled, terminated and other-host bots", async () => {
      const companyId = await seedCompany();
      const free = await seedBot(companyId, { enabled: true, host: "myr-vm1" });
      const pinned = await seedBot(companyId, { enabled: true, host: "myr-vm1", hostPinned: true });
      await seedBot(companyId, { enabled: false, host: "myr-vm1" });
      await seedBot(companyId, { enabled: true, host: "myr-vm1" }, { status: "terminated" });
      await seedBot(companyId, { enabled: true, host: "other" });
      await seedBot(companyId, { enabled: true });
      await seedBot(companyId, { enabled: true, host: "myr-vm1" }, { adapterType: "process" });
      const otherCompany = await seedCompany();
      await seedBot(otherCompany, { enabled: true, host: "myr-vm1" });

      const bots = await siteHealthStore(db).listBotsOnSite(companyId, "myr-vm1");
      expect(bots.map((b) => [b.botKey, b.pinned]).sort()).toEqual([[free, false], [pinned, true]].sort());
    });

    it("lists the bots a replica failover moved off the site, but not one that was moved back", async () => {
      const companyId = await seedCompany();
      const away = await seedBot(companyId, { enabled: true });
      const back = await seedBot(companyId, { enabled: true, host: "myr-vm1" });
      const liveMoved = await seedBot(companyId, { enabled: true });
      const moves = fleetMoveStore(db);
      for (const [botKey, source] of [[away, "replica"], [back, "replica"], [liveMoved, "live"]] as const) {
        const move = await moves.createMove({ companyId, botKey, srcSite: "myr-vm1", dstSite: "local", source });
        await moves.updateMove(move.id, { phase: "done", completedAt: new Date() });
      }

      expect(await siteHealthStore(db).listFailedOverBots(companyId, "myr-vm1")).toEqual([away]);
    });
  });

  describe("the claim of a run of a lost site", () => {
    async function seedRun(over: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const companyId = await seedCompany();
      const agentId = await seedBot(companyId, { enabled: true, host: "myr-vm1" });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        externalRunId: "gw-1",
        controllerBootId: randomUUID(),
        controllerLeaseExpiresAt: new Date(Date.now() - 120_000),
        contextSnapshot: { issueId: "i-1" },
        ...over,
      });
      return { companyId, runId };
    }
    const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

    it("of two simultaneous claims exactly one wins, writes the marker and takes a fresh lease", async () => {
      const { companyId, runId } = await seedRun();
      const claims = await Promise.all([
        claimRunForSiteLost(db, { id: runId, companyId }, "myr-vm1"),
        claimRunForSiteLost(db, { id: runId, companyId }, "myr-vm1"),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);

      const run = await readRun(runId);
      expect(run.contextSnapshot).toMatchObject({ issueId: "i-1", [SITE_LOST_CONTEXT_KEY]: { site: "myr-vm1" } });
      expect(run.controllerLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      // Once claimed, nobody claims it again, not even after its fresh lease runs out.
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(heartbeatRuns.id, runId));
      expect(await claimRunForSiteLost(db, { id: runId, companyId }, "myr-vm1")).toBe(false);
    });

    it("a run whose controller lease is still live is not taken", async () => {
      const { companyId, runId } = await seedRun({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
      expect(await claimRunForSiteLost(db, { id: runId, companyId }, "myr-vm1")).toBe(false);
      expect((await readRun(runId)).contextSnapshot).toEqual({ issueId: "i-1" });
    });

    it("a run the gateway reattach sweep holds is not taken", async () => {
      const { companyId, runId } = await seedRun({ contextSnapshot: { issueId: "i-1", reattachGatewayRunId: "gw-1" } });
      expect(await claimRunForSiteLost(db, { id: runId, companyId }, "myr-vm1")).toBe(false);
    });

    it("a run that is no longer running is not taken, and a run without a lease is", async () => {
      const finished = await seedRun({ status: "failed" });
      expect(await claimRunForSiteLost(db, { id: finished.runId, companyId: finished.companyId }, "myr-vm1")).toBe(false);
      const leaseless = await seedRun({ controllerLeaseExpiresAt: null, controllerBootId: null });
      expect(await claimRunForSiteLost(db, { id: leaseless.runId, companyId: leaseless.companyId }, "myr-vm1")).toBe(true);
    });
  });
});
