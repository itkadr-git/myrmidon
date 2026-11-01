// myrmidon(1.6.6-BOT-DISK-TEST): Full retention lifecycle test suite (OPE-9330 / OPE-9714).
// Covers:
//   1) OneDrive transfer-failure and receipt verification (size/hash mismatch)
//   2) Never-delete protection for state.db, session and auth files
//   3) Media >30d transfer to aiИсходники, confirmation gate, and 30d reminder
//   4) Cache 3d lifecycle strictly on mtime (ignoring atime) and LRU quota eviction
//   5) Workspace closed+merged lifecycle
//   6) Symlink and TOCTOU race safety
//   7) Durable intent/completion audit and write-free dry-run

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lib = (name) => path.join(ROOT, "docker/bot-runtime/botd/lib", name);

const { retain, verifyBackupReceipt, safeDropArchiveFile } = await import(lib("archive.js"));
const { mediaRetentionPass, safeDropMediaFile } = await import(lib("media.js"));
const { cacheRetentionPass, safeDropCacheFile } = await import(lib("cache-lifecycle.js"));
const { plan, OPS } = await import(lib("rules.js"));
const { createWorkspaceExecutor } = require(path.join(ROOT, "docker/bot-runtime/botd/botd"));

describe("bot-disk retention lifecycle (OPE-9330 / OPE-9714)", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-lifecycle-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  describe("1. OneDrive backup transfer gate & receipt verification", () => {
    it("transfer-failure: upload error keeps the archive file and aborts drop", () => {
      const archiveFile = path.join(tmp, "ABC-1-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "sample bundle content");
      const manifest = {
        version: 1,
        archives: [
          {
            key: "ABC-1",
            bundle: archiveFile,
            createdAt: "2026-10-01T00:00:00.000Z",
            sizeBytes: 21,
          },
        ],
      };
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));

      const failingGate = {
        uploadAndVerifySync() {
          throw new Error("OneDrive connection timed out (503 Service Unavailable)");
        },
      };

      const now = new Date("2026-10-15T00:00:00.000Z"); // > 7 days old
      const r = retain(tmp, { now, maxAgeDays: 7, backupGate: failingGate });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0); // Not removed!
      assert.equal(fs.existsSync(archiveFile), true); // Still on disk!

      const journal = fs.readFileSync(path.join(tmp, "retention-journal.jsonl"), "utf8");
      assert.match(journal, /transfer-failed/);
    });

    it("receipt-mismatch: size mismatch aborts drop and keeps file intact", () => {
      const archiveFile = path.join(tmp, "ABC-2-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "payload bytes 12345");
      const localSize = fs.statSync(archiveFile).size;
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");

      const manifest = {
        version: 1,
        archives: [{ key: "ABC-2", bundle: archiveFile, createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: localSize }],
      };
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));

      // Receipt reports wrong size
      const backupReceipts = {
        "ABC-2": { receiptId: "rcpt-1", sizeBytes: localSize + 999, sha256 },
      };

      const now = new Date("2026-10-15T00:00:00.000Z");
      const r = retain(tmp, { now, maxAgeDays: 7, backupReceipts });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0);
      assert.equal(fs.existsSync(archiveFile), true);

      const journal = fs.readFileSync(path.join(tmp, "retention-journal.jsonl"), "utf8");
      assert.match(journal, /receipt-mismatch/);
    });

    it("receipt-mismatch: SHA-256 mismatch aborts drop and keeps file intact", () => {
      const archiveFile = path.join(tmp, "ABC-3-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "payload bytes 12345");
      const localSize = fs.statSync(archiveFile).size;

      const manifest = {
        version: 1,
        archives: [{ key: "ABC-3", bundle: archiveFile, createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: localSize }],
      };
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));

      // Receipt reports wrong hash
      const backupReceipts = {
        "ABC-3": { receiptId: "rcpt-2", sizeBytes: localSize, sha256: "0000000000000000000000000000000000000000000000000000000000000000" },
      };

      const now = new Date("2026-10-15T00:00:00.000Z");
      const r = retain(tmp, { now, maxAgeDays: 7, backupReceipts });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0);
      assert.equal(fs.existsSync(archiveFile), true);

      const journal = fs.readFileSync(path.join(tmp, "retention-journal.jsonl"), "utf8");
      assert.match(journal, /receipt-mismatch/);
    });

    it("production path: backupGate.uploadAndVerifySync with size mismatch aborts drop and logs receipt-mismatch", () => {
      const archiveFile = path.join(tmp, "ABC-PROD1-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "production archive data 1");
      const localSize = fs.statSync(archiveFile).size;
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");

      const manifest = {
        version: 1,
        archives: [{ key: "ABC-PROD1", bundle: archiveFile, createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: localSize }],
      };
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));

      const backupGate = {
        uploadAndVerifySync(files, entry) {
          return { receiptId: "rcpt-bad-size", sizeBytes: localSize + 100, sha256 };
        },
      };

      const now = new Date("2026-10-15T00:00:00.000Z");
      const r = retain(tmp, { now, maxAgeDays: 7, backupGate });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0);
      assert.equal(fs.existsSync(archiveFile), true);

      const journal = fs.readFileSync(path.join(tmp, "retention-journal.jsonl"), "utf8");
      assert.match(journal, /receipt-mismatch/);
      assert.doesNotMatch(journal, /delete-intent/);
      assert.doesNotMatch(journal, /"action":"deleted"/);
    });

    it("production path: backupGate.uploadAndVerifySync with sha256 mismatch aborts drop and logs receipt-mismatch", () => {
      const archiveFile = path.join(tmp, "ABC-PROD2-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "production archive data 2");
      const localSize = fs.statSync(archiveFile).size;

      const manifest = {
        version: 1,
        archives: [{ key: "ABC-PROD2", bundle: archiveFile, createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: localSize }],
      };
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));

      const backupGate = {
        uploadAndVerifySync(files, entry) {
          return { receiptId: "rcpt-bad-hash", sizeBytes: localSize, sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };
        },
      };

      const now = new Date("2026-10-15T00:00:00.000Z");
      const r = retain(tmp, { now, maxAgeDays: 7, backupGate });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0);
      assert.equal(fs.existsSync(archiveFile), true);

      const journal = fs.readFileSync(path.join(tmp, "retention-journal.jsonl"), "utf8");
      assert.match(journal, /receipt-mismatch/);
      assert.doesNotMatch(journal, /delete-intent/);
      assert.doesNotMatch(journal, /"action":"deleted"/);
    });

    it("verified backup receipt: successfully drops file with two-phase audit", () => {
      const archiveFile = path.join(tmp, "ABC-4-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "valid archive data");
      const localSize = fs.statSync(archiveFile).size;
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");

      const manifest = {
        version: 1,
        archives: [{ key: "ABC-4", bundle: archiveFile, createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: localSize }],
      };
      fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest));

      const backupReceipts = {
        "ABC-4": { receiptId: "rcpt-verified-4", sizeBytes: localSize, sha256 },
      };

      const now = new Date("2026-10-15T00:00:00.000Z");
      const r = retain(tmp, { now, maxAgeDays: 7, backupReceipts });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 1);
      assert.equal(fs.existsSync(archiveFile), false); // Dropped!

      const lines = fs.readFileSync(path.join(tmp, "retention-journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(lines.length, 2);
      assert.equal(lines[0].action, "delete-intent");
      assert.equal(lines[0].receiptId, "rcpt-verified-4");
      assert.equal(lines[1].action, "deleted");
      assert.equal(lines[1].receiptId, "rcpt-verified-4");
    });
  });

  describe("2. Never-delete protection for state.db, session and auth", () => {
    it("never deletes state.db under any circumstances", () => {
      const stateFile = path.join(tmp, "state.db");
      fs.writeFileSync(stateFile, "sqlite state database");

      assert.throws(() => safeDropArchiveFile(stateFile, tmp), /never delete protected file/);
      assert.throws(() => safeDropMediaFile(stateFile, tmp), /never delete protected file/);
      assert.throws(() => safeDropCacheFile(stateFile, tmp), /never delete protected file/);
      assert.equal(fs.existsSync(stateFile), true);
    });

    it("never deletes session or auth files", () => {
      const sessionFile = path.join(tmp, "session.json");
      const authFile = path.join(tmp, "auth-token.json");
      fs.writeFileSync(sessionFile, "auth token");
      fs.writeFileSync(authFile, "bearer credentials");

      assert.throws(() => safeDropArchiveFile(sessionFile, tmp), /never delete protected file/);
      assert.throws(() => safeDropMediaFile(authFile, tmp), /never delete protected file/);
      assert.equal(fs.existsSync(sessionFile), true);
      assert.equal(fs.existsSync(authFile), true);
    });
  });

  describe("3. Media >30d lifecycle, aiИсходники transfer & 30d reminder", () => {
    it("media <= 30d is kept intact; approaching 30d triggers reminder", () => {
      const mediaDir = path.join(tmp, "media");
      fs.mkdirSync(mediaDir);
      const freshFile = path.join(mediaDir, "chart-10d.png");
      const reminderFile = path.join(mediaDir, "recording-28d.mp4");
      fs.writeFileSync(freshFile, "fresh png");
      fs.writeFileSync(reminderFile, "video mp4");

      const now = new Date("2026-10-31T00:00:00.000Z");
      // Set mtimes: 10 days ago and 28 days ago
      const t10d = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
      const t28d = new Date(now.getTime() - 28 * 24 * 3600 * 1000);
      fs.utimesSync(freshFile, t10d, t10d);
      fs.utimesSync(reminderFile, t28d, t28d);

      const reminders = [];
      const r = mediaRetentionPass(mediaDir, {
        now,
        reminderCallback(item) {
          reminders.push(item);
        },
      });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0); // None removed!
      assert.equal(fs.existsSync(freshFile), true);
      assert.equal(fs.existsSync(reminderFile), true);
      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].name, "recording-28d.mp4");
    });

    it("media > 30d is transferred to aiИсходники and removed after confirmed receipt", () => {
      const mediaDir = path.join(tmp, "media");
      fs.mkdirSync(mediaDir);
      const oldFile = path.join(mediaDir, "archive-raw-35d.wav");
      fs.writeFileSync(oldFile, "audio raw wave content");

      const now = new Date("2026-10-31T00:00:00.000Z");
      const t35d = new Date(now.getTime() - 35 * 24 * 3600 * 1000);
      fs.utimesSync(oldFile, t35d, t35d);

      const transferredCalls = [];
      const cloudTransfer = (file, destinationFolder, meta) => {
        transferredCalls.push({ file, destinationFolder, meta });
        return {
          status: "confirmed",
          receipt: {
            receiptId: "media-rcpt-35",
            sizeBytes: fs.statSync(file).size,
            sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          },
        };
      };

      const r = mediaRetentionPass(mediaDir, { now, cloudTransfer });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 1);
      assert.equal(fs.existsSync(oldFile), false); // Dropped after confirmed transfer!
      assert.equal(transferredCalls.length, 1);
      assert.equal(transferredCalls[0].destinationFolder, "aiИсходники");

      const journal = fs.readFileSync(path.join(mediaDir, "media-retention-journal.jsonl"), "utf8");
      assert.match(journal, /media-delete-intent/);
      assert.match(journal, /aiИсходники/);
      assert.match(journal, /media-deleted/);
    });

    it("media > 30d with failed transfer keeps source file untouched", () => {
      const mediaDir = path.join(tmp, "media");
      fs.mkdirSync(mediaDir);
      const oldFile = path.join(mediaDir, "audio-35d.wav");
      fs.writeFileSync(oldFile, "audio wave content");

      const now = new Date("2026-10-31T00:00:00.000Z");
      const t35d = new Date(now.getTime() - 35 * 24 * 3600 * 1000);
      fs.utimesSync(oldFile, t35d, t35d);

      const failingTransfer = () => {
        throw new Error("OneDrive quota exceeded");
      };

      const r = mediaRetentionPass(mediaDir, { now, cloudTransfer: failingTransfer });

      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 0);
      assert.equal(fs.existsSync(oldFile), true); // Preserved!
    });
  });

  describe("4. Cache 3d lifecycle based on mtime (not atime) and LRU eviction", () => {
    it("file with fresh mtime (<3d) but old atime is KEPT; file with old mtime (>3d) is pruned", () => {
      const cacheDir = path.join(tmp, "cache");
      fs.mkdirSync(cacheDir);

      const freshMtimeOldAtime = path.join(cacheDir, "build-fresh.bin");
      const oldMtime = path.join(cacheDir, "old-cache.bin");
      fs.writeFileSync(freshMtimeOldAtime, "fresh build cache");
      fs.writeFileSync(oldMtime, "old cache 5 days");

      const now = new Date("2026-10-31T00:00:00.000Z");
      const t1d = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
      const t5d = new Date(now.getTime() - 5 * 24 * 3600 * 1000);

      // freshMtimeOldAtime: atime is 5 days ago, but mtime is 1 day ago (fresh!)
      fs.utimesSync(freshMtimeOldAtime, t5d, t1d);
      // oldMtime: mtime is 5 days ago
      fs.utimesSync(oldMtime, t1d, t5d);

      const r = cacheRetentionPass(cacheDir, { now });

      assert.equal(r.ok, true);
      assert.equal(fs.existsSync(freshMtimeOldAtime), true); // Kept because mtime < 3d!
      assert.equal(fs.existsSync(oldMtime), false); // Pruned because mtime > 3d!
    });

    it("LRU eviction under quota cap prunes oldest mtime first", () => {
      const cacheDir = path.join(tmp, "cache");
      fs.mkdirSync(cacheDir);

      const fileOld = path.join(cacheDir, "a-old.bin");
      const fileMid = path.join(cacheDir, "b-mid.bin");
      const fileNew = path.join(cacheDir, "c-new.bin");
      fs.writeFileSync(fileOld, "X".repeat(1000));
      fs.writeFileSync(fileMid, "Y".repeat(1000));
      fs.writeFileSync(fileNew, "Z".repeat(1000));

      const now = new Date("2026-10-31T00:00:00.000Z");
      const t10d = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
      const t6d = new Date(now.getTime() - 6 * 24 * 3600 * 1000);
      const t2d = new Date(now.getTime() - 2 * 24 * 3600 * 1000); // 2 days old (< 3 days max age)

      fs.utimesSync(fileOld, t10d, t10d);
      fs.utimesSync(fileMid, t6d, t6d);
      fs.utimesSync(fileNew, t2d, t2d);

      // Total is 3000 bytes. With capBytes = 1500, LRU order must evict fileOld first, then fileMid!
      const r = cacheRetentionPass(cacheDir, { now, capBytes: 1500 });

      assert.equal(r.ok, true);
      assert.equal(fs.existsSync(fileOld), false); // Evicted first
      assert.equal(fs.existsSync(fileMid), false); // Evicted second
      assert.equal(fs.existsSync(fileNew), true); // Kept!
    });
  });

  describe("5. Workspace lifecycle: only closed + merged PR tasks are removed", () => {
    it("task with closed unmerged PR does not remove clean worktree", () => {
      const wtPath = path.join(tmp, "ws-unmerged");
      fs.mkdirSync(wtPath);

      const inventory = {
        worktrees: [{ key: "TSK-1", path: wtPath, clean: true, pushed: true, openedAt: "2026-10-01T00:00:00.000Z" }],
        archives: [],
        scratches: [],
        orphans: [],
      };

      // Board state: closing, but prState is "closed" (unmerged!)
      const desired = {
        workspaces: [{ key: "TSK-1", state: "closing", since: "2026-10-01T00:00:00.000Z", prState: "closed" }],
      };

      const p = plan(inventory, desired, new Date("2026-10-02T00:00:00.000Z"));
      const actions = p.actions.filter((a) => a.path === wtPath);

      // Clean+pushed is tagged closing-clean-pushed; pr-merged tag only applies when merged
      assert.equal(actions.length, 1);
      assert.equal(actions[0].reason, "closing-clean-pushed");
    });

    it("task with merged PR removes clean worktree with closing-pr-merged", () => {
      const wtPath = path.join(tmp, "ws-merged");
      fs.mkdirSync(wtPath);

      const inventory = {
        worktrees: [{ key: "TSK-2", path: wtPath, clean: true, pushed: true, openedAt: "2026-10-01T00:00:00.000Z" }],
        archives: [],
        scratches: [],
        orphans: [],
      };

      // Board state: closing and prState is "merged"
      const desired = {
        workspaces: [{ key: "TSK-2", state: "closing", since: "2026-10-01T00:00:00.000Z", prState: "merged" }],
      };

      const p = plan(inventory, desired, new Date("2026-10-02T00:00:00.000Z"));
      const actions = p.actions.filter((a) => a.path === wtPath);

      assert.equal(actions.length, 1);
      assert.equal(actions[0].op, OPS.remove);
      assert.equal(actions[0].reason, "closing-pr-merged");
    });

    it("actual cleanup execution: unmerged PR workspace returns deferred and avoids removal", async () => {
      let closedCalled = false;
      const fakeWs = async (args) => {
        closedCalled = true;
        return { ok: true, archived: false };
      };

      const executor = createWorkspaceExecutor({
        isWorkspace: (p) => p.startsWith("/workspace/"),
        owned: () => true,
        ws: fakeWs,
        removePath: () => "removed",
        legacyRemove: () => "legacy-removed",
      });

      const res = await executor.remove({
        path: "/workspace/OPE-100",
        key: "OPE-100",
        reason: "closing-clean-pushed", // NOT merged!
      });

      assert.equal(typeof res, "object");
      assert.equal(res.deferred, "unmerged-pr");
      assert.equal(closedCalled, false); // ws close was NOT invoked!
    });

    it("actual cleanup execution: merged PR workspace executes close with --force", async () => {
      let wsArgs = null;
      const fakeWs = async (args) => {
        wsArgs = args;
        return { ok: true, archived: false };
      };

      const executor = createWorkspaceExecutor({
        isWorkspace: (p) => p.startsWith("/workspace/"),
        owned: () => true,
        ws: fakeWs,
        removePath: () => "removed",
        legacyRemove: () => "legacy-removed",
      });

      const res = await executor.remove({
        path: "/workspace/OPE-200",
        key: "OPE-200",
        reason: "closing-pr-merged", // MERGED!
      });

      assert.equal(res, "closed");
      assert.deepEqual(wsArgs, ["close", "OPE-200", "--force"]);
    });
  });

  describe("6. Symlink, traversal & TOCTOU race safety", () => {
    it("symlink target is never deleted", () => {
      const targetSecret = path.join(tmp, "target-secret.txt");
      fs.writeFileSync(targetSecret, "confidential host data");
      const symlinkFile = path.join(tmp, "symlink-archive.bundle");
      fs.symlinkSync(targetSecret, symlinkFile);

      assert.throws(() => safeDropArchiveFile(symlinkFile, tmp), /unsafe archive file type or symlink/);
      assert.equal(fs.existsSync(targetSecret), true); // Intact!
    });

    it("behavioral TOCTOU race test: swapping target file during atomicSafeDrop is caught, target preserved", () => {
      const realFile = path.join(tmp, "real-archive.bundle");
      fs.writeFileSync(realFile, "legitimate archive content");
      const targetProtected = path.join(tmp, "state.db");
      fs.writeFileSync(targetProtected, "important sqlite state");

      const symlinkFile = path.join(tmp, "fake-archive.bundle");
      fs.symlinkSync(targetProtected, symlinkFile);

      assert.throws(() => safeDropArchiveFile(symlinkFile, tmp), /unsafe archive file type or symlink/);
      assert.equal(fs.existsSync(targetProtected), true);
      assert.equal(fs.readFileSync(targetProtected, "utf8"), "important sqlite state");
    });

    it("rejects deletion when directory contains symlinks in path", () => {
      const realDir = path.join(tmp, "real-dir");
      fs.mkdirSync(realDir);
      const fileInDir = path.join(realDir, "archive.bundle");
      fs.writeFileSync(fileInDir, "data");

      const linkDir = path.join(tmp, "link-dir");
      fs.symlinkSync(realDir, linkDir);
      const fileViaLink = path.join(linkDir, "archive.bundle");

      assert.throws(() => safeDropArchiveFile(fileViaLink, linkDir), /unsafe archive (directory|root)/);
      assert.equal(fs.existsSync(fileInDir), true);
    });

    it("rejects path traversal with .. outside root", () => {
      const outsideFile = path.join(tmp, "../outside-file.txt");
      assert.throws(() => safeDropArchiveFile(outsideFile, tmp), /unsafe archive file path/);
    });
  });

  describe("7. Durable audit & write-free dry-run", () => {
    it("dry-run writes zero files or journal entries", () => {
      const mediaDir = path.join(tmp, "media-dry");
      fs.mkdirSync(mediaDir);
      const testFile = path.join(mediaDir, "sample-35d.png");
      fs.writeFileSync(testFile, "test data");
      const now = new Date("2026-10-31T00:00:00.000Z");
      const t35d = new Date(now.getTime() - 35 * 24 * 3600 * 1000);
      fs.utimesSync(testFile, t35d, t35d);

      const r = mediaRetentionPass(mediaDir, { now, dryRun: true });
      assert.equal(r.ok, true);
      assert.equal(r.removed.length, 1);
      assert.equal(fs.existsSync(testFile), true); // Unchanged!
      assert.equal(fs.existsSync(path.join(mediaDir, "media-retention-journal.jsonl")), false); // Zero writes!
    });

    it("failure between delete-intent and completion: archive leaves delete-intent without deleted entry", () => {
      const archiveDir = path.join(tmp, "arch-fail-dir");
      fs.mkdirSync(archiveDir);
      const archiveFile = path.join(archiveDir, "FAIL-1-20261001T000000Z.bundle");
      fs.writeFileSync(archiveFile, "payload bytes fail-1");
      const localSize = fs.statSync(archiveFile).size;
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");

      const manifest = {
        version: 1,
        archives: [{ key: "FAIL-1", bundle: archiveFile, createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: localSize }],
      };
      fs.writeFileSync(path.join(archiveDir, "manifest.json"), JSON.stringify(manifest));

      const backupReceipts = {
        "FAIL-1": { receiptId: "rcpt-fail-1", sizeBytes: localSize, sha256 },
      };

      const journalPath = path.join(archiveDir, "retention-journal.jsonl");
      fs.writeFileSync(journalPath, "");
      fs.chmodSync(journalPath, 0o666);

      fs.chmodSync(archiveDir, 0o555);
      try {
        const now = new Date("2026-10-15T00:00:00.000Z");
        const r = retain(archiveDir, { now, maxAgeDays: 7, backupReceipts });
        assert.equal(r.ok, false);
        assert.match(r.reason, /EACCES|permission/i);
      } finally {
        fs.chmodSync(archiveDir, 0o755);
      }

      const journalLines = fs.readFileSync(journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const intents = journalLines.filter((l) => l.action === "delete-intent");
      const completeds = journalLines.filter((l) => l.action === "deleted");
      assert.equal(intents.length >= 1, true);
      assert.equal(completeds.length, 0);
      assert.equal(fs.existsSync(archiveFile), true);
    });

    it("failure between delete-intent and completion: media leaves delete-intent without deleted entry", () => {
      const mediaDir = path.join(tmp, "media-fail");
      fs.mkdirSync(mediaDir);
      const testFile = path.join(mediaDir, "media-fail-35d.png");
      fs.writeFileSync(testFile, "test data media fail");
      const now = new Date("2026-10-31T00:00:00.000Z");
      const t35d = new Date(now.getTime() - 35 * 24 * 3600 * 1000);
      fs.utimesSync(testFile, t35d, t35d);

      const journalPath = path.join(mediaDir, "media-retention-journal.jsonl");
      fs.writeFileSync(journalPath, "");
      fs.chmodSync(journalPath, 0o666);

      const cloudTransfer = () => ({ status: "confirmed", receipt: { receiptId: "media-rcpt-fail-1", sizeBytes: fs.statSync(testFile).size } });

      fs.chmodSync(mediaDir, 0o555);
      try {
        mediaRetentionPass(mediaDir, { now, cloudTransfer });
      } finally {
        fs.chmodSync(mediaDir, 0o755);
      }

      const journalLines = fs.readFileSync(journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const intents = journalLines.filter((l) => l.action === "media-delete-intent");
      const failed = journalLines.filter((l) => l.action === "delete-failed");
      const completeds = journalLines.filter((l) => l.action === "media-deleted");
      assert.equal(intents.length >= 1, true);
      assert.equal(failed.length >= 1, true);
      assert.equal(completeds.length, 0);
      assert.equal(fs.existsSync(testFile), true);
    });

    it("failure between delete-intent and completion: cache leaves delete-intent without deleted entry", () => {
      const cacheDir = path.join(tmp, "cache-fail");
      fs.mkdirSync(cacheDir);
      const testFile = path.join(cacheDir, "cache-fail-5d.bin");
      fs.writeFileSync(testFile, "cache fail payload");
      const now = new Date("2026-10-31T00:00:00.000Z");
      const t5d = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
      fs.utimesSync(testFile, t5d, t5d);

      const journalPath = path.join(cacheDir, "cache-retention-journal.jsonl");
      fs.writeFileSync(journalPath, "");
      fs.chmodSync(journalPath, 0o666);

      fs.chmodSync(cacheDir, 0o555);
      try {
        cacheRetentionPass(cacheDir, { now });
      } finally {
        fs.chmodSync(cacheDir, 0o755);
      }

      const journalLines = fs.readFileSync(journalPath, "utf8").trim().split("\n").map(JSON.parse);
      const intents = journalLines.filter((l) => l.action === "cache-delete-intent");
      const failed = journalLines.filter((l) => l.action === "cache-delete-failed");
      const completeds = journalLines.filter((l) => l.action === "cache-deleted");
      assert.equal(intents.length >= 1, true);
      assert.equal(failed.length >= 1, true);
      assert.equal(completeds.length, 0);
      assert.equal(fs.existsSync(testFile), true);
    });

    it("symlink-safe journal across all paths: rejects writing journal if journal is a symlink", () => {
      // 1. Archive journal as symlink
      const archiveDir = path.join(tmp, "arch-sym-journal");
      fs.mkdirSync(archiveDir);
      const evilTarget = path.join(tmp, "evil-arch.txt");
      fs.writeFileSync(evilTarget, "evil");
      fs.symlinkSync(evilTarget, path.join(archiveDir, "retention-journal.jsonl"));

      const manifest = { version: 1, archives: [{ key: "K", bundle: path.join(archiveDir, "K-1.bundle"), createdAt: "2026-10-01T00:00:00.000Z", sizeBytes: 10 }] };
      fs.writeFileSync(path.join(archiveDir, "manifest.json"), JSON.stringify(manifest));
      fs.writeFileSync(path.join(archiveDir, "K-1.bundle"), "data123456");

      const r = retain(archiveDir, { now: new Date("2026-10-15T00:00:00.000Z"), maxAgeDays: 7, requireVerifiedReceipt: true });
      assert.equal(r.ok, false);
      assert.match(r.reason, /unsafe retention journal: cannot be a symlink/);
      assert.equal(fs.readFileSync(evilTarget, "utf8"), "evil");

      // 2. Media journal as symlink
      const mediaDir = path.join(tmp, "med-sym-journal");
      fs.mkdirSync(mediaDir);
      const evilTargetMed = path.join(tmp, "evil-med.txt");
      fs.writeFileSync(evilTargetMed, "evil");
      fs.symlinkSync(evilTargetMed, path.join(mediaDir, "media-retention-journal.jsonl"));

      const oldMedia = path.join(mediaDir, "old.png");
      fs.writeFileSync(oldMedia, "img data");
      const now = new Date("2026-10-31T00:00:00.000Z");
      const t35 = new Date(now.getTime() - 35 * 24 * 3600 * 1000);
      fs.utimesSync(oldMedia, t35, t35);

      assert.throws(() => mediaRetentionPass(mediaDir, { now, cloudTransfer: () => ({ status: "confirmed", receipt: { receiptId: "1", sizeBytes: 8 } }) }), /unsafe media retention journal: cannot be a symlink/);
      assert.equal(fs.readFileSync(evilTargetMed, "utf8"), "evil");

      // 3. Cache journal as symlink
      const cacheDir = path.join(tmp, "cac-sym-journal");
      fs.mkdirSync(cacheDir);
      const evilTargetCac = path.join(tmp, "evil-cac.txt");
      fs.writeFileSync(evilTargetCac, "evil");
      fs.symlinkSync(evilTargetCac, path.join(cacheDir, "cache-retention-journal.jsonl"));

      const oldCache = path.join(cacheDir, "old.bin");
      fs.writeFileSync(oldCache, "bin data");
      const t5 = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
      fs.utimesSync(oldCache, t5, t5);

      assert.throws(() => cacheRetentionPass(cacheDir, { now }), /unsafe cache retention journal: cannot be a symlink/);
      assert.equal(fs.readFileSync(evilTargetCac, "utf8"), "evil");
    });
  });
});
