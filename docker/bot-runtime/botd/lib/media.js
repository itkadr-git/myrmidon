// myrmidon(1.6.6-BOT-DISK-MEDIA): Media retention lifecycle (OPE-9330 / OPE-9714).
// Media files >30d are transferred to OneDrive folder "aiИсходники" with verified
// confirmation before local removal. Files <=30d are kept intact.
// Never delete state.db or session/auth files.
// TOCTOU race safety and durable audit.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicSafeDrop } from "./archive.js";

export const MEDIA_RETENTION_DAYS = 30;
export const MEDIA_TARGET_FOLDER = "aiИсходники";
const DAY_MS = 24 * 60 * 60 * 1000;

export function safeDropMediaFile(file, mediaRoot) {
  return atomicSafeDrop(file, mediaRoot, "media");
}

function mediaAudit(mediaRoot, record) {
  const root = path.resolve(mediaRoot);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
    throw new Error("unsafe media root: root cannot be a symlink");
  }
  const journalPath = path.join(root, "media-retention-journal.jsonl");
  if (fs.existsSync(journalPath) && fs.lstatSync(journalPath).isSymbolicLink()) {
    throw new Error("unsafe media retention journal: cannot be a symlink");
  }
  const fd = fs.openSync(journalPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("unsafe media retention journal");
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function mediaRetentionPass(mediaRoot, opts = {}) {
  const now = opts.now || new Date();
  const maxAgeMs = (opts.maxAgeDays ?? MEDIA_RETENTION_DAYS) * DAY_MS;
  const targetFolder = opts.targetFolder || MEDIA_TARGET_FOLDER;

  if (!fs.existsSync(mediaRoot)) {
    return { ok: true, transferred: [], removed: [], kept: [] };
  }

  const rootSt = fs.lstatSync(mediaRoot);
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) {
    throw new Error("unsafe media root directory");
  }

  const entries = fs.readdirSync(mediaRoot, { withFileTypes: true });
  const transferred = [];
  const removed = [];
  const kept = [];

  for (const entry of entries) {
    const fullPath = path.join(mediaRoot, entry.name);
    // Never touch symlinks or directories
    if (entry.isSymbolicLink() || entry.isDirectory()) continue;
    if (entry.name.endsWith("-journal.jsonl")) continue;

    // Never delete protected files
    if (/(^|[/\\])(state\.db|session|auth|credential)/i.test(entry.name)) {
      kept.push({ name: entry.name, reason: "protected" });
      continue;
    }

    const st = fs.lstatSync(fullPath);
    if (!st.isFile()) continue;

    const ageMs = now.getTime() - st.mtimeMs;
    if (ageMs <= maxAgeMs) {
      // Kept: fresh media
      if (typeof opts.reminderCallback === "function" && ageMs >= (MEDIA_RETENTION_DAYS - 5) * DAY_MS) {
        opts.reminderCallback({ file: fullPath, name: entry.name, ageDays: Math.floor(ageMs / DAY_MS) });
      }
      kept.push({ name: entry.name, ageDays: Math.floor(ageMs / DAY_MS), reason: "within_retention" });
      continue;
    }

    // Media file is strictly > 30 days old: eligible for transfer and deletion
    if (opts.dryRun) {
      removed.push({ name: entry.name, sizeBytes: st.size, reason: "dry_run_expired" });
      continue;
    }

    // Real run: requires cloud transfer with verified confirmation
    if (typeof opts.cloudTransfer !== "function") {
      mediaAudit(mediaRoot, { at: now.toISOString(), action: "transfer-skipped", file: entry.name, reason: "cloudTransfer gate not configured" });
      kept.push({ name: entry.name, reason: "untransferred_unverified" });
      continue;
    }

    let confirmation;
    try {
      confirmation = opts.cloudTransfer(fullPath, targetFolder, { sizeBytes: st.size });
    } catch (err) {
      mediaAudit(mediaRoot, { at: now.toISOString(), action: "transfer-failed", file: entry.name, reason: err.message });
      kept.push({ name: entry.name, reason: "transfer_error" });
      continue;
    }

    if (!confirmation || confirmation.status !== "confirmed") {
      mediaAudit(mediaRoot, { at: now.toISOString(), action: "confirmation-missing", file: entry.name, reason: "transfer unconfirmed" });
      kept.push({ name: entry.name, reason: "unconfirmed" });
      continue;
    }

    // Independent verification of confirmation receipt if size or hash provided
    if (confirmation.receipt) {
      const expSize = confirmation.receipt.sizeBytes ?? confirmation.receipt.size;
      if (typeof expSize === "number" && expSize !== st.size) {
        mediaAudit(mediaRoot, { at: now.toISOString(), action: "receipt-mismatch", file: entry.name, reason: "size mismatch" });
        kept.push({ name: entry.name, reason: "receipt_size_mismatch" });
        continue;
      }
      if (confirmation.receipt.sha256) {
        const localHash = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
        if (confirmation.receipt.sha256.toLowerCase() !== localHash.toLowerCase()) {
          mediaAudit(mediaRoot, { at: now.toISOString(), action: "receipt-mismatch", file: entry.name, reason: "sha256 mismatch" });
          kept.push({ name: entry.name, reason: "receipt_hash_mismatch" });
          continue;
        }
      }
    }

    // Verified transfer complete: drop source with two-phase audit
    mediaAudit(mediaRoot, {
      at: now.toISOString(),
      action: "media-delete-intent",
      file: entry.name,
      destination: targetFolder,
      receiptId: confirmation.receipt?.receiptId || null,
    });

    try {
      safeDropMediaFile(fullPath, mediaRoot);
      transferred.push({ name: entry.name, destination: targetFolder, sizeBytes: st.size });
      removed.push({ name: entry.name, sizeBytes: st.size, reason: "transferred_and_pruned" });
      mediaAudit(mediaRoot, {
        at: now.toISOString(),
        action: "media-deleted",
        file: entry.name,
        destination: targetFolder,
        receiptId: confirmation.receipt?.receiptId || null,
      });
    } catch (err) {
      mediaAudit(mediaRoot, { at: now.toISOString(), action: "delete-failed", file: entry.name, reason: err.message });
      kept.push({ name: entry.name, reason: "delete_error" });
    }
  }

  return { ok: true, transferred, removed, kept };
}
