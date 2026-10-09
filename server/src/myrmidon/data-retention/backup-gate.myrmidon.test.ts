// server/src/myrmidon/data-retention/backup-gate.myrmidon.test.ts
//
// myrmidon(1.6.5-F14B): the backup gate of the row-deletion sweep follows the
// same contract as the context compaction gate: an unset or
// empty prefix accepts any fresh `*.sql.gz`/`*.dump`; the "external machine
// backup" setting passes the gate without a local file. No database.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDataRetentionBackupGate,
  resolveDataRetentionBackupPrefix,
} from "./backup-gate.js";

function withDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f14b-dr-gate-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("myrmidon(1.6.5-F14B) data-retention backup gate", () => {
  it("the prefix knob: unset or empty means no naming contract", () => {
    expect(resolveDataRetentionBackupPrefix({})).toBe("");
    expect(resolveDataRetentionBackupPrefix({ MYRMIDON_DB_BACKUP_FILE_PREFIX: "  " })).toBe("");
    expect(resolveDataRetentionBackupPrefix({ MYRMIDON_DB_BACKUP_FILE_PREFIX: "mine" })).toBe("mine");
  });

  it("unset prefix: a fresh board.dump and a fresh foreign-named .sql.gz both lift the gate", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "board.dump"), "x");
      expect(checkDataRetentionBackupGate({ backupDir: dir }).fresh).toBe(true);
    });
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "whatever-1.sql.gz"), "x");
      expect(checkDataRetentionBackupGate({ backupDir: dir }).fresh).toBe(true);
    });
  });

  it("a set prefix narrows the match; other extensions never count", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "other-1.sql.gz"), "x");
      fs.writeFileSync(path.join(dir, "paperclip-1.txt"), "x");
      expect(checkDataRetentionBackupGate({ backupDir: dir, prefix: "paperclip" }).fresh).toBe(false);
      expect(checkDataRetentionBackupGate({ backupDir: dir }).fresh).toBe(true);
      fs.writeFileSync(path.join(dir, "paperclip-2.dump"), "x");
      expect(checkDataRetentionBackupGate({ backupDir: dir, prefix: "paperclip" }).fresh).toBe(true);
    });
  });

  it("a stale dump does not lift the gate; an empty or missing dir fails closed", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "board.dump"), "x");
      const stale = new Date(Date.now() + 25 * 60 * 60 * 1000);
      expect(checkDataRetentionBackupGate({ backupDir: dir, now: stale }).fresh).toBe(false);
      expect(checkDataRetentionBackupGate({ backupDir: path.join(dir, "nope") }).fresh).toBe(false);
    });
  });

  it("external machine backup: fresh without any local file, dir not needed", () => {
    withDir((dir) => {
      expect(checkDataRetentionBackupGate({ backupDir: dir }).fresh).toBe(false);
      const external = checkDataRetentionBackupGate({ backupDir: dir, externalMachineBackup: true });
      expect(external.fresh).toBe(true);
      expect(external.newestBackupAt).toBeNull();
      expect(
        checkDataRetentionBackupGate({
          backupDir: path.join(dir, "nope"),
          externalMachineBackup: true,
        }).fresh,
      ).toBe(true);
      expect(
        checkDataRetentionBackupGate({ backupDir: dir, externalMachineBackup: false }).fresh,
      ).toBe(false);
    });
  });
});
