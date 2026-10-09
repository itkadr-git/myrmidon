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
    // The retention pass writes a `datastore.retention_*` activity line that
    // references the test company; clear it before deleting companies or the
    // FK activity_log_company_id_companies_id_fk rejects the delete.
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
      expect(gate.prefix).toBe("paperclip");
      expect(gate.newestBackupAt).toBe(staleTime.toISOString());
      expect(gate.newestBackupFile).toBe("paperclip-2026-10-01T00-00-00.sql.gz");
      expect(gate.newestBackupSizeBytes).toBe(fs.statSync(stale).size);
      expect(gate.dirReadable).toBe(true);
      expect(gate.candidates).toEqual([]);
    } finally {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  });
});
