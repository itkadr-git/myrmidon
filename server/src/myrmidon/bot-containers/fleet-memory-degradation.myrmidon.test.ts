// server/src/myrmidon/bot-containers/fleet-memory-degradation.myrmidon.test.ts
//
// myrmidon(1.6.6 C-MEM): the degradation scenario of the site memory. The link between the site
// and the board breaks for five minutes and comes back:
//   - the bots of the site keep recalling and retaining on the site's own hindsight-work, and the
//     board's hindsight is not asked for anything while they do;
//   - the sync attempts during the outage fail, are journaled, and leave the replica as it was;
//   - after the link is back the lane catches up on its next tick, the replica holds every
//     document of the site, and no document is in it twice, however often the archive is imported.

import { afterEach, describe, expect, it } from "vitest";
import type { MonitoredSite } from "./site-health-store.js";
import { createFleetMemorySyncService, startFleetMemorySyncLane } from "./fleet-memory-sync.js";
import { memoryJournal } from "./fleet-memory-sync-fixtures.js";

const COMPANY = "company-1";
const MINUTE = 60_000;

/** The hindsight-work of the site: documents by id; recall reads, retain upserts by document id. */
function siteMemory() {
  const documents = new Map<string, string>();
  const requests = { recall: 0, retain: 0 };
  return {
    documents,
    requests,
    recall(query: string): string[] {
      requests.recall += 1;
      return [...documents.values()].filter((text) => text.includes(query));
    },
    retain(documentId: string, text: string): void {
      requests.retain += 1;
      documents.set(documentId, text);
    },
    exportArchive(): Buffer {
      return Buffer.from(JSON.stringify(Object.fromEntries(documents)));
    },
  };
}

/** The board's hindsight (fleet-work-replica): merge import, skip on a known document id. */
function boardMemory(opts: { breakAfter?: () => number | null } = {}) {
  const documents = new Map<string, string>();
  const requests = { import: 0, recall: 0, retain: 0 };
  return {
    documents,
    requests,
    async importArchive(_bank: string, archive: Buffer) {
      requests.import += 1;
      const incoming = Object.entries(JSON.parse(archive.toString("utf8")) as Record<string, string>);
      const stopAfter = opts.breakAfter?.() ?? null;
      let imported = 0;
      let skipped = 0;
      for (const [id, text] of incoming) {
        if (stopAfter !== null && imported >= stopAfter) throw new Error("memory import operation failed: connection to the database lost");
        if (documents.has(id)) skipped += 1;
        else {
          documents.set(id, text);
          imported += 1;
        }
      }
      return { imported, skipped };
    },
  };
}

function site(): MonitoredSite {
  return {
    id: "site-1",
    companyId: COMPANY,
    name: "myr-vm1",
    url: "https://192.0.2.10:9100",
    status: "active",
    labels: {},
    health: { snapshot: { missCount: 0 }, autoDrained: false, state: "healthy", recoveryPasses: 0, reconciled: true, updatedAt: "2026-10-24T00:00:00Z" },
  };
}

describe("site memory under a broken link", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  function setup(boardOpts: Parameters<typeof boardMemory>[0] = {}) {
    const local = siteMemory();
    const board = boardMemory(boardOpts);
    const journal = memoryJournal();
    const state = { now: new Date("2026-10-24T20:00:00Z"), linkUp: true };
    const service = createFleetMemorySyncService({
      store: journal,
      now: () => state.now,
      exportArchive: async () => {
        if (!state.linkUp) throw new Error("connect ETIMEDOUT 192.0.2.10:9100");
        return local.exportArchive();
      },
      importArchive: board.importArchive,
    });
    const lane = startFleetMemorySyncLane({
      service,
      store: journal,
      listSites: async () => [site()],
      listBots: async () => [{ companyId: COMPANY, botKey: "work-qa", site: "myr-vm1", pinned: false }],
      hourUtc: 20,
      intervalMs: 24 * 60 * MINUTE,
      now: () => state.now,
    });
    stops.push(lane.stop);
    const advance = (minutes: number) => (state.now = new Date(state.now.getTime() + minutes * MINUTE));
    return { local, board, journal, state, lane, advance };
  }

  it("keeps recalling and retaining on the site for five minutes without the link, then catches up without duplicates", async () => {
    const t = setup();
    t.local.retain("doc-1", "decision about the grill feed");
    t.local.retain("doc-2", "supplier phone number");

    // Before the break: the night's sync copies both documents.
    expect(await t.lane.tick()).toMatchObject({ synced: ["myr-vm1"] });
    expect([...t.board.documents.keys()]).toEqual(["doc-1", "doc-2"]);

    // The link breaks for five minutes (the board and the site cannot talk).
    t.state.linkUp = false;
    t.advance(1);
    const boardAskedBefore = { ...t.board.requests };

    // The bots work on the site's own memory: recall answers, retain lands locally.
    expect(t.local.recall("grill")).toEqual(["decision about the grill feed"]);
    t.local.retain("doc-3", "written during the outage");
    expect(t.local.recall("outage")).toEqual(["written during the outage"]);
    expect(t.board.requests).toEqual(boardAskedBefore); // 0 requests to the board's hindsight

    // The lane does not sync a site that already synced this night, so the outage is invisible to it;
    // a manual attempt during the outage fails, is journaled, and the replica is untouched.
    const manual = await createFleetMemorySyncService({
      store: t.journal,
      now: () => t.state.now,
      exportArchive: async () => {
        throw new Error("connect ETIMEDOUT 192.0.2.10:9100");
      },
      importArchive: t.board.importArchive,
    }).syncSite({ companyId: COMPANY, siteName: "myr-vm1", botKey: "work-qa", kind: "manual" });
    expect(manual.outcome).toBe("failed");
    expect(t.board.documents.has("doc-3")).toBe(false);

    t.advance(5);
    t.state.linkUp = true;

    // The next night the lane syncs again: doc-3 arrives, doc-1 and doc-2 are skipped, nothing doubles.
    t.advance(24 * 60);
    expect(await t.lane.tick()).toMatchObject({ synced: ["myr-vm1"] });
    expect([...t.board.documents.keys()].sort()).toEqual(["doc-1", "doc-2", "doc-3"]);

    const last = t.journal.rows.filter((r) => r.status === "ok").at(-1)!;
    expect(last).toMatchObject({ documentsImported: 1, documentsSkipped: 2 });
    expect(t.journal.rows.map((r) => [r.kind, r.status])).toEqual([
      ["nightly", "ok"],
      ["manual", "failed"],
      ["nightly", "ok"],
    ]);
    expect(t.journal.rows[1]!.error).toMatch(/ETIMEDOUT/);
  });

  it("retries every tick while the link is down and stops at the first success", async () => {
    const t = setup();
    t.local.retain("doc-1", "first");
    t.state.linkUp = false;

    // Five minutes of outage inside the night's window: every tick fails, nothing reaches the replica.
    for (let i = 0; i < 3; i += 1) {
      expect(await t.lane.tick()).toEqual({ synced: [], failed: ["myr-vm1"], skippedSites: [] });
      t.local.retain(`during-${i}`, "kept locally");
      t.advance(2);
    }
    expect(t.board.documents.size).toBe(0);
    expect(t.board.requests.import).toBe(0);

    t.state.linkUp = true;
    expect(await t.lane.tick()).toEqual({ synced: ["myr-vm1"], failed: [], skippedSites: [] });
    t.advance(2);
    expect(await t.lane.tick()).toEqual({ synced: [], failed: [], skippedSites: ["myr-vm1"] });

    expect([...t.board.documents.keys()].sort()).toEqual(["doc-1", "during-0", "during-1", "during-2"]);
    expect(t.journal.rows.map((r) => r.status)).toEqual(["failed", "failed", "failed", "ok"]);
  });

  it("does not duplicate documents when an import broke off half way and is repeated", async () => {
    let breakAfter: number | null = 2;
    const t = setup({ breakAfter: () => breakAfter });
    for (let i = 1; i <= 5; i += 1) t.local.retain(`doc-${i}`, `text ${i}`);

    expect(await t.lane.tick()).toMatchObject({ failed: ["myr-vm1"] });
    expect(t.board.documents.size).toBe(2); // the import applied two documents and then lost the database

    breakAfter = null;
    t.advance(15);
    expect(await t.lane.tick()).toMatchObject({ synced: ["myr-vm1"] });

    expect([...t.board.documents.keys()].sort()).toEqual(["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"]);
    expect(t.journal.rows.map((r) => [r.status, r.documentsImported, r.documentsSkipped])).toEqual([
      ["failed", null, null],
      ["ok", 3, 2],
    ]);
  });

  it("imports the same archive any number of times into the same replica", async () => {
    const t = setup();
    t.local.retain("doc-1", "a");
    const archive = t.local.exportArchive();
    await t.board.importArchive("fleet-work-replica", archive);
    const again = await t.board.importArchive("fleet-work-replica", archive);

    expect(again).toEqual({ imported: 0, skipped: 1 });
    expect(t.board.documents.size).toBe(1);
  });
});
