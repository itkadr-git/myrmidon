// server/src/myrmidon/data-retention/backup-gate.ts
//
// myrmidon(1.6.5-DB-RETENTION): the backup gate of the retention sweep.
//
// Before the first destructive pass of a sweep (and re-checked on every
// pass), the sweep verifies a fresh database backup exists: the newest
// `*.sql.gz`/`*.dump` in the resolved backup dir is younger than 24 hours.
// The dir resolution mirrors `packages/db/src/backup.ts` (config
// `database.backup.dir`, then `resolveDefaultBackupDir()`). Same contract as
// the context compaction gate (`datastore-care/retention/backup-gate.ts`):
// when the `MYRMIDON_DB_BACKUP_FILE_PREFIX` deployment knob is unset or empty any accepted extension counts; a non-empty value narrows
// the match to `<prefix>-*`.
//
// myrmidon(1.6.5-F14B): "external machine backup" mode. With the instance
// setting `general.datastoreCare.retention.externalMachineBackup` the machine
// is backed up as a whole on another host and no local dump is produced, so
// the gate passes without looking for a local file.

import fs from "node:fs";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipConfigPathForInstance,
} from "@paperclipai/shared/home-paths";

/** The gate asks for a backup younger than this. */
export const DATA_RETENTION_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * The directory the database backups land in: the instance config's
 * `database.backup.dir` when set, otherwise the instance default
 * (`<instance-root>/data/backups`). The same resolution
 * `packages/db/src/backup.ts` applies.
 */
export function resolveDataRetentionBackupDir(input: { homeDir?: string } = {}): string {
  const config = readConfig(resolvePaperclipConfigPathForInstance(input));
  const raw = config?.database?.backup?.dir;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.resolve(expandHomePrefix(raw.trim()));
  }
  return resolveDefaultBackupDir(input);
}

/** Backup filename extensions the gate accepts. */
export const DATA_RETENTION_BACKUP_ACCEPTED_EXTENSIONS = [".sql.gz", ".dump"] as const;

/**
 * The filename prefix narrowing the match (`<prefix>-*`); unset or empty
 * means "no naming contract" — any accepted extension counts.
 */
export function resolveDataRetentionBackupPrefix(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.MYRMIDON_DB_BACKUP_FILE_PREFIX?.trim() ?? "";
}

export interface DataRetentionBackupGateResult {
  /** True when a fresh enough backup file exists. */
  fresh: boolean;
  /** Newest matching backup mtime (ISO), or null when none exists/readable. */
  newestBackupAt: string | null;
  /** The directory the gate inspected. */
  backupDir: string;
}

/**
 * Check the gate against a backup dir: the newest matching `*.sql.gz`/`*.dump`
 * (`<prefix>-*` when a prefix is given) must be younger than `maxAgeMs`. A
 * missing/unreadable dir or an empty one is "not fresh" — the gate fails
 * closed. With `externalMachineBackup` the gate is fresh without a local file.
 */
export function checkDataRetentionBackupGate(options: {
  backupDir: string;
  /** Empty (the default) means "any accepted extension". */
  prefix?: string;
  /** The instance setting "the machine is backed up outside". */
  externalMachineBackup?: boolean;
  now?: Date;
  maxAgeMs?: number;
}): DataRetentionBackupGateResult {
  const prefix = options.prefix ?? "";
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DATA_RETENTION_BACKUP_MAX_AGE_MS;
  if (options.externalMachineBackup === true) {
    return { fresh: true, newestBackupAt: null, backupDir: options.backupDir };
  }
  let newest: number | null = null;
  try {
    for (const name of fs.readdirSync(options.backupDir)) {
      if (!DATA_RETENTION_BACKUP_ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      if (prefix.length > 0 && !name.startsWith(`${prefix}-`)) continue;
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
