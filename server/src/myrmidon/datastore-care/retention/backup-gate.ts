// server/src/myrmidon/datastore-care/retention/backup-gate.ts
//
// myrmidon(1.6.5-DBC1): the backup precondition of the context compaction.
//
// The compaction rewrites rows, so it only runs when a fresh database backup
// exists: the newest `<prefix>-*.sql.gz` in the resolved backup dir must be
// younger than 24 hours. The dir resolution mirrors
// `packages/db/src/backup.ts` (config `database.backup.dir`, then
// `resolveDefaultBackupDir()`); the filename prefix mirrors `runDatabaseBackup`
// in `packages/db/src/backup-lib.ts` (default `paperclip`, overridable via the
// `MYRMIDON_DB_BACKUP_FILE_PREFIX` deployment knob the deploy repo sets).
// The gate fails closed: an unreadable or empty dir is "not fresh".

import fs from "node:fs";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipConfigPathForInstance,
} from "@paperclipai/shared/home-paths";

/** The gate asks for a backup younger than this. */
export const DATASTORE_CARE_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type PartialBackupConfig = {
  database?: {
    backup?: {
      dir?: string;
    };
  };
};

function readConfig(configPath: string): PartialBackupConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed ? (parsed as PartialBackupConfig) : null;
  } catch {
    return null;
  }
}

/** The directory the database backups land in (config, then instance default). */
export function resolveBackupDir(input: { homeDir?: string } = {}): string {
  const config = readConfig(resolvePaperclipConfigPathForInstance(input));
  const raw = config?.database?.backup?.dir;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.resolve(expandHomePrefix(raw.trim()));
  }
  return resolveDefaultBackupDir(input);
}

/** The filename prefix the backup run writes (`<prefix>-<timestamp>.sql.gz`). */
export function resolveBackupFilePrefix(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.MYRMIDON_DB_BACKUP_FILE_PREFIX?.trim() || "paperclip";
}

export interface BackupGateResult {
  /** True when a fresh enough backup file exists. */
  fresh: boolean;
  /** Newest matching backup mtime (ISO), or null when none exists/readable. */
  newestBackupAt: string | null;
  /** The directory the gate inspected. */
  backupDir: string;
}

/**
 * Check the gate against a backup dir: the newest `<prefix>-*.sql.gz` must be
 * younger than `maxAgeMs`.
 */
export function checkBackupGate(options: {
  backupDir: string;
  prefix?: string;
  now?: Date;
  maxAgeMs?: number;
}): BackupGateResult {
  const prefix = options.prefix ?? "paperclip";
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DATASTORE_CARE_BACKUP_MAX_AGE_MS;
  let newest: number | null = null;
  try {
    for (const name of fs.readdirSync(options.backupDir)) {
      if (!name.startsWith(`${prefix}-`) || !name.endsWith(".sql.gz")) continue;
      try {
        const mtime = fs.statSync(path.join(options.backupDir, name)).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        // A file that vanished between readdir and stat does not count.
      }
    }
  } catch {
    return { fresh: false, newestBackupAt: null, backupDir: options.backupDir };
  }
  if (newest === null) {
    return { fresh: false, newestBackupAt: null, backupDir: options.backupDir };
  }
  return {
    fresh: now.getTime() - newest < maxAgeMs,
    newestBackupAt: new Date(newest).toISOString(),
    backupDir: options.backupDir,
  };
}
