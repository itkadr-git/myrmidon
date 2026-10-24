// server/src/myrmidon/bot-containers/fleet-memory-sync.myrmidon.test.ts
//
// myrmidon(1.6.6 C-MEM): the memory sync service, its nightly lane and the forced sync before a move.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitoredSite } from "./site-health-store.js";
import {
  createFleetMemorySyncService,
  forcedSyncBeforeMove,
  lastScheduledAt,
  startFleetMemorySyncLane,
  FLEET_MEMORY_REPLICA_BANK,
} from "./fleet-memory-sync.js";
import { archiveOf, memoryJournal, replicaBank } from "./fleet-memory-sync-fixtures.js";

const COMPANY = "company-1";

function site(over: Partial<MonitoredSite> = {}): MonitoredSite {
  return {
    id: "site-1",
    companyId: COMPANY,
    name: "myr-vm1",
    url: "https://10.10.0.110:9100",
    status: "active",
    labels: {},
    health: { snapshot: { missCount: 0 }, autoDrained: false, state: "healthy", recoveryPasses: 0, reconciled: true, updatedAt: "2026-10-24T00:00:00Z" },
    ...over,
  };
}

const BOT = { companyId: COMPANY, botKey: "work-qa", site: "myr-vm1", pinned: false };

describe("fleet memory sync service", () => {
  it("exports the site bank, merges it into the replica bank and journals an ok attempt", async () => {
    const journal = memoryJournal();
    const bank = replicaBank();
    const importArchive = vi.fn(bank.importArchive);
    const service = createFleetMemorySyncService({
      store: journal,
      exportArchive: async () => archiveOf({ "doc-1": "a", "doc-2": "b" }),
      importArchive,
    });

    const done = await service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "nightly" });

    expect(done.outcome).toBe("ok");
    expect(importArchive).toHaveBeenCalledWith(FLEET_MEMORY_REPLICA_BANK, expect.any(Buffer));
    expect([...bank.documents.keys()]).toEqual(["doc-1", "doc-2"]);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0]).toMatchObject({
      siteName: "myr-vm1",
      kind: "nightly",
      status: "ok",
      targetBank: FLEET_MEMORY_REPLICA_BANK,
      botKey: "work-qa",
      documentsImported: 2,
      documentsSkipped: 0,
      error: null,
    });
    expect(journal.rows[0]!.archiveBytes).toBeGreaterThan(0);
    expect(journal.rows[0]!.finishedAt).toBeInstanceOf(Date);
  });

  it("journals a failed attempt and does not throw when the site cannot be reached", async () => {
    const journal = memoryJournal();
    const bank = replicaBank();
    const importArchive = vi.fn(bank.importArchive);
    const service = createFleetMemorySyncService({
      store: journal,
      exportArchive: async () => {
        throw new Error("connect ETIMEDOUT 10.10.0.110:9100");
      },
      importArchive,
    });

    const done = await service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "nightly" });

    expect(done.outcome).toBe("failed");
    expect(importArchive).not.toHaveBeenCalled();
    expect(journal.rows[0]).toMatchObject({ status: "failed", error: "connect ETIMEDOUT 10.10.0.110:9100" });
  });

  it("treats an empty archive and a failing import as failures, keeping what the replica already had", async () => {
    const journal = memoryJournal();
    const bank = replicaBank();
    await bank.importArchive("x", archiveOf({ "doc-1": "a" }));
    let mode: "empty" | "import-fails" = "empty";
    const service = createFleetMemorySyncService({
      store: journal,
      exportArchive: async () => (mode === "empty" ? Buffer.alloc(0) : archiveOf({ "doc-2": "b" })),
      importArchive: async () => {
        throw new Error("memory import operation failed: out of space");
      },
    });

    expect((await service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "manual" })).outcome).toBe("failed");
    mode = "import-fails";
    expect((await service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "manual" })).outcome).toBe("failed");

    expect(journal.rows.map((r) => [r.status, r.error])).toEqual([
      ["failed", "the site exported an empty archive"],
      ["failed", "memory import operation failed: out of space"],
    ]);
    expect([...bank.documents.keys()]).toEqual(["doc-1"]);
  });

  it("answers busy and runs nothing while another attempt holds the site", async () => {
    const journal = memoryJournal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const exportArchive = vi.fn(async () => {
      await gate;
      return archiveOf({ "doc-1": "a" });
    });
    const service = createFleetMemorySyncService({ store: journal, exportArchive, importArchive: replicaBank().importArchive });

    const first = service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "nightly" });
    await vi.waitFor(() => expect(journal.rows).toHaveLength(1));
    const second = await service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "forced" });
    expect(second).toEqual({ outcome: "busy" });
    release();
    expect((await first).outcome).toBe("ok");
    expect(exportArchive).toHaveBeenCalledTimes(1);
    expect(journal.rows).toHaveLength(1);
  });

  it("closes an attempt abandoned by a dead process and starts a new one", async () => {
    const journal = memoryJournal();
    let clock = new Date("2026-10-24T20:00:00Z");
    const service = createFleetMemorySyncService({
      store: journal,
      exportArchive: async () => archiveOf({ "doc-1": "a" }),
      importArchive: replicaBank().importArchive,
      now: () => clock,
      staleAfterMs: 60 * 60_000,
    });
    await journal.begin({ companyId: COMPANY, siteName: "myr-vm1", kind: "nightly", targetBank: "b", staleAfterMs: 1, now: clock });
    clock = new Date("2026-10-24T22:00:00Z");

    expect((await service.syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "nightly" })).outcome).toBe("ok");

    expect(journal.rows.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(journal.rows[0]!.error).toMatch(/abandoned/);
  });
});

describe("lastScheduledAt", () => {
  it("is today's moment once it has passed and yesterday's before it", () => {
    expect(lastScheduledAt(new Date("2026-10-24T21:30:00Z"), 20).toISOString()).toBe("2026-10-24T20:00:00.000Z");
    expect(lastScheduledAt(new Date("2026-10-24T05:00:00Z"), 20).toISOString()).toBe("2026-10-23T20:00:00.000Z");
    expect(lastScheduledAt(new Date("2026-10-24T20:00:00Z"), 20).toISOString()).toBe("2026-10-24T20:00:00.000Z");
  });
});

describe("fleet memory sync lane", () => {
  const lanes: Array<{ stop(): void }> = [];
  afterEach(() => {
    for (const lane of lanes.splice(0)) lane.stop();
  });

  function setup(opts: { exportArchive?: () => Promise<Buffer>; sites?: MonitoredSite[]; bots?: typeof BOT[] } = {}) {
    const journal = memoryJournal();
    const bank = replicaBank();
    let clock = new Date("2026-10-24T21:00:00Z");
    const exportArchive = vi.fn(opts.exportArchive ?? (async () => archiveOf({ "doc-1": "a" })));
    const service = createFleetMemorySyncService({ store: journal, exportArchive, importArchive: bank.importArchive, now: () => clock });
    const lane = startFleetMemorySyncLane({
      service,
      store: journal,
      listSites: async () => opts.sites ?? [site()],
      listBots: async () => opts.bots ?? [BOT],
      hourUtc: 20,
      intervalMs: 3_600_000,
      now: () => clock,
    });
    lanes.push(lane);
    return { lane, journal, bank, exportArchive, setClock: (d: string) => (clock = new Date(d)) };
  }

  it("syncs a due site once per night and leaves it alone until the next schedule", async () => {
    const t = setup();

    expect(await t.lane.tick()).toEqual({ synced: ["myr-vm1"], failed: [], skippedSites: [] });
    t.setClock("2026-10-24T23:00:00Z");
    expect(await t.lane.tick()).toEqual({ synced: [], failed: [], skippedSites: ["myr-vm1"] });
    expect(t.exportArchive).toHaveBeenCalledTimes(1);

    t.setClock("2026-10-25T20:30:00Z");
    expect((await t.lane.tick()).synced).toEqual(["myr-vm1"]);
    expect(t.journal.rows.map((r) => [r.kind, r.status])).toEqual([["nightly", "ok"], ["nightly", "ok"]]);
  });

  it("does not sync before the night's schedule when an earlier sync is already newer than the last one due", async () => {
    const t = setup();
    t.setClock("2026-10-24T05:00:00Z");
    expect((await t.lane.tick()).synced).toEqual(["myr-vm1"]); // nothing ever synced: due since 23.10 20:00
    t.setClock("2026-10-24T19:00:00Z");
    expect((await t.lane.tick()).skippedSites).toEqual(["myr-vm1"]);
  });

  it("retries a failed attempt on the next tick (the catch-up) and then stops", async () => {
    let up = false;
    const t = setup({
      exportArchive: async () => {
        if (!up) throw new Error("link is down");
        return archiveOf({ "doc-1": "a" });
      },
    });

    expect((await t.lane.tick()).failed).toEqual(["myr-vm1"]);
    t.setClock("2026-10-24T21:15:00Z");
    expect((await t.lane.tick()).failed).toEqual(["myr-vm1"]);
    up = true;
    t.setClock("2026-10-24T21:30:00Z");
    expect((await t.lane.tick()).synced).toEqual(["myr-vm1"]);
    t.setClock("2026-10-24T21:45:00Z");
    expect((await t.lane.tick()).synced).toEqual([]);
    expect(t.journal.rows.map((r) => r.status)).toEqual(["failed", "failed", "ok"]);
  });

  it("skips a site that missed a probe and a site without bots", async () => {
    const down = site({ health: { snapshot: { missCount: 2 }, autoDrained: false, state: "suspect", recoveryPasses: 0, reconciled: true, updatedAt: "2026-10-24T00:00:00Z" } });
    const t = setup({ sites: [down, site({ id: "site-2", name: "myr-vm2" })], bots: [] });

    expect(await t.lane.tick()).toEqual({ synced: [], failed: [], skippedSites: ["myr-vm1", "myr-vm2"] });
    expect(t.exportArchive).not.toHaveBeenCalled();
    expect(t.journal.rows).toHaveLength(0);
  });
});

describe("forced sync before a move", () => {
  it("runs a forced attempt tied to the move", async () => {
    const journal = memoryJournal();
    const service = createFleetMemorySyncService({ store: journal, exportArchive: async () => archiveOf({ "doc-1": "a" }), importArchive: replicaBank().importArchive });

    const done = await forcedSyncBeforeMove(service, { companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", moveId: "5b2f6f1e-0f0e-4a0e-8f0e-111111111111" });

    expect(done.outcome).toBe("ok");
    expect(journal.rows[0]).toMatchObject({ kind: "forced", moveId: "5b2f6f1e-0f0e-4a0e-8f0e-111111111111", status: "ok" });
  });

  it("lets the move go on after the timeout", async () => {
    const journal = memoryJournal();
    const service = createFleetMemorySyncService({ store: journal, exportArchive: () => new Promise<Buffer>(() => {}), importArchive: replicaBank().importArchive });

    const done = await forcedSyncBeforeMove(service, { companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", moveId: "m" }, { timeoutMs: 20 });

    expect(done).toEqual({ outcome: "timeout" });
  });
});
