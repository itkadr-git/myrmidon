// server/src/myrmidon/datastore-care/retention/service.db.myrmidon.test.ts
//
// myrmidon(1.6.5-F14B): the gate verdict must be observable in the persisted
// state. Against an embedded Postgres the pass with a stale backup rewrites
// nothing, marks itself as waiting (`waitingForBackup: true`) and writes the
// full gate report into `general.datastoreCare.retention.contextLastRun.backupGate`
// with honest field names — including the case where the trap field
// `backupCheckedAt` (which holds the newest backup's mtime, not the check
// time) would otherwise be the only clue.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { instanceSettingsService } from "../../../services/index.js";
import { createDatastoreCareRetentionRuntime } from "./service.js";

// Review (F14B): the runtime must hand the RESOLVED batches ceiling to the
// compaction pass. Spy on the pass so the wiring is observable without
// seeding a full backlog; the real pass is covered by compact.db tests.
vi.mock("./compact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compact.js")>();
  return {
    ...actual,
    compactContextPass: vi.fn(async () => ({
      compacted: 0,
      freedBytes: 0,
      timedOut: false,
      perCompany: [],
    })),
  };
});
import { compactContextPass } from "./compact.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("myrmidon(1.6.5-F14B) retention pass gate report in settings", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-f14b-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    // The waiting pass writes a throttled activity row per company; clear the
    // dependent rows before the company (same teardown order as the
    // data-retention service test).
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stale backup: nothing compacts, waitingForBackup=true, backupGate carries the honest verdict", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-gate",
      issuePrefix: "GATE",
    });

    // A backup-shaped dir with one file older than the 24 h window: the gate
    // fails on freshness, and the persisted report must show exactly that.
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "f14b-backups-"));
    try {
      const stale = path.join(backupDir, "paperclip-2026-10-01T00-00-00.sql.gz");
      fs.writeFileSync(stale, "backup-bytes");
      const staleTime = new Date(Date.now() - 25 * DAY_MS);
      fs.utimesSync(stale, staleTime, staleTime);

      const runtime = createDatastoreCareRetentionRuntime(db, {
        env: {},
        backupDir,
        now: () => new Date(),
      });
      const result = await runtime.runOnce();

      expect(result.ran).toBe(false);
      expect(result.reason).toBe("waiting-for-backup");
      expect(result.compacted).toBe(0);

      const general = (await instanceSettingsService(db).getGeneral()) as unknown as Record<
        string,
        any
      >;
      const lastRun = general.datastoreCare?.retention?.contextLastRun;
      expect(lastRun, "contextLastRun persisted").toBeTruthy();
      expect(lastRun.waitingForBackup).toBe(true);
      // The trap field: it stores the newest backup's mtime, NOT the check
      // time — the gate report below carries the honest names.
      expect(lastRun.backupCheckedAt).toBe(staleTime.toISOString());

      const gate = lastRun.backupGate;
      expect(gate, "backupGate filled on every failed check").toBeTruthy();
      expect(gate.backupDir).toBe(backupDir);
      // unset prefix knob: no naming contract (the review contract)
      expect(gate.prefix).toBe("");
      expect(gate.newestBackupAt).toBe(staleTime.toISOString());
      expect(gate.newestBackupFile).toBe("paperclip-2026-10-01T00-00-00.sql.gz");
      expect(gate.newestBackupSizeBytes).toBe(fs.statSync(stale).size);
      expect(gate.dirReadable).toBe(true);
      expect(gate.candidates).toEqual([]);
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("a fresh backup passes the gate and the resolved batches ceiling reaches the compaction pass", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-pass",
      issuePrefix: "PASS",
    });

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "f14b-pass-"));
    try {
      // A backup written right now: the gate lifts and the pass proceeds.
      const fresh = path.join(backupDir, "paperclip-2026-10-09T06-00-00.sql.gz");
      fs.writeFileSync(fresh, "backup-bytes");

      const runtime = createDatastoreCareRetentionRuntime(db, {
        env: { MYRMIDON_CONTEXT_COMPACT_MAX_BATCHES: "2" },
        backupDir,
        now: () => new Date(),
      });
      const passSpy = vi.mocked(compactContextPass);
      passSpy.mockClear();
      const result = await runtime.runOnce();
      expect(result.reason).toBe("nothing-to-compact");

      // Review (F14B): service.ts must hand the RESOLVED ceiling (here: the
      // env knob = 2) to compactContextPass, not a hardcoded constant.
      expect(passSpy).toHaveBeenCalledTimes(1);
      const [deps, input] = passSpy.mock.calls[0]!;
      expect(deps.maxBatches).toBe(2);
      expect(input.companyIds).toContain(companyId);
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });
  it("external machine backup: an empty backup dir does not park the pass, the report says why", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-external",
      issuePrefix: "EXT",
    });
    await instanceSettingsService(db).updateGeneral({
      datastoreCare: { retention: { externalMachineBackup: true } },
    } as never);

    // No local dump at all: without the setting this pass would wait forever.
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "f14b-external-"));
    try {
      const runtime = createDatastoreCareRetentionRuntime(db, {
        env: {},
        backupDir,
        now: () => new Date(),
      });
      const passSpy = vi.mocked(compactContextPass);
      passSpy.mockClear();
      const result = await runtime.runOnce();
      expect(result.reason).toBe("nothing-to-compact");
      expect(passSpy).toHaveBeenCalledTimes(1);

      const general = (await instanceSettingsService(db).getGeneral()) as unknown as Record<
        string,
        any
      >;
      const lastRun = general.datastoreCare?.retention?.contextLastRun;
      expect(lastRun.waitingForBackup).toBe(false);
      expect(lastRun.backupGate.externalMachineBackup).toBe(true);
      // the mode itself survives the pass-state write
      expect(general.datastoreCare?.retention?.externalMachineBackup).toBe(true);
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
      await instanceSettingsService(db).updateGeneral({
        datastoreCare: { retention: {} },
      } as never);
    }
  });
});
