// server/src/myrmidon/datastore-care/retention/backup-gate.ts
//
// myrmidon(1.6.5-DBC1): the backup precondition of the context compaction.
//
// The compaction rewrites rows, so it only runs when a fresh database backup
// exists: the newest matching backup file in the resolved backup dir must be
// younger than 24 hours. The dir resolution mirrors
// `packages/db/src/backup.ts` (config `database.backup.dir`, then
// `resolveDefaultBackupDir()`); the filename prefix mirrors `runDatabaseBackup`
// in `packages/db/src/backup-lib.ts` (default `paperclip`, overridable via the
// `MYRMIDON_DB_BACKUP_FILE_PREFIX` deployment knob the deploy repo sets).
// The gate fails closed: an unreadable or empty dir is "not fresh".
//
// myrmidon(1.6.5-F14): the gate accepts both the built-in board backup
// (`<prefix>-<timestamp>.sql.gz`, what `runDatabaseBackup` writes) and a
// host-side `pg_dump -Fc` dump (`*.dump`); when the prefix env knob is not
// set, any newest `*.sql.gz`/`*.dump` in the dir counts, because a deployment
// that switched its backup naming must not silently park the compaction.

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

/**
 * The filename prefix the backup run writes (`<prefix>-<timestamp>.sql.gz`).
 * myrmidon(1.6.5-F14B): unset keeps the built-in `"paperclip"` naming;
 * explicitly empty means "no naming contract" — the gate then accepts any
 * `*.sql.gz`/`*.dump` in the dir (see `checkBackupGate`).
 */
export function resolveBackupFilePrefix(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.MYRMIDON_DB_BACKUP_FILE_PREFIX;
  if (raw === undefined) return "paperclip";
  return raw.trim();
}

/** Backup filename extensions the gate accepts. */
export const BACKUP_GATE_ACCEPTED_EXTENSIONS = [".sql.gz", ".dump"] as const;

export interface BackupGateResult {
  /** True when a fresh enough backup file exists. */
  fresh: boolean;
  /** Newest matching backup mtime (ISO), or null when none exists/readable. */
  newestBackupAt: string | null;
  /** The directory the gate inspected. */
  backupDir: string;
  /** The filename prefix the gate matched against. */
  prefix: string;
  /** False when the dir could not be listed at all. */
  dirReadable: boolean;
  /** Base name of the newest matching backup file, when one exists. */
  newestBackupFile: string | null;
  /** Its size in bytes. */
  newestBackupSizeBytes: number | null;
  /**
   * Up to 5 backup-looking files (`*.sql.gz`/`*.dump`) that did NOT match the
   * prefix — the "wrong name in the right dir" diagnosis.
   */
  candidates: string[];
}

function isBackupName(name: string): boolean {
  return BACKUP_GATE_ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Check the gate against a backup dir: the newest matching backup must be
 * younger than `maxAgeMs`. A matching backup is `<prefix>-*` with an accepted
 * extension; when `prefix` is empty (the deployment sets no naming contract)
 * any `*.sql.gz`/`*.dump` in the dir counts, newest first.
 */
export function checkBackupGate(options: {
  backupDir: string;
  /** Empty string means "no naming contract — any accepted extension". */
  prefix?: string;
  now?: Date;
  maxAgeMs?: number;
}): BackupGateResult {
  const prefix = options.prefix ?? "paperclip";
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DATASTORE_CARE_BACKUP_MAX_AGE_MS;
  const base = {
    backupDir: options.backupDir,
    prefix,
    candidates: [] as string[],
  };
  let names: string[];
  try {
    names = fs.readdirSync(options.backupDir);
  } catch {
    return {
      ...base,
      fresh: false,
      newestBackupAt: null,
      dirReadable: false,
      newestBackupFile: null,
      newestBackupSizeBytes: null,
    };
  }
  let newest: { mtimeMs: number; name: string; sizeBytes: number } | null = null;
  for (const name of names) {
    if (!isBackupName(name)) continue;
    const matches = prefix.length === 0 || name.startsWith(`${prefix}-`);
    if (!matches) {
      if (base.candidates.length < 5) base.candidates.push(name);
      continue;
    }
    try {
      const stat = fs.statSync(path.join(options.backupDir, name));
      if (newest === null || stat.mtimeMs > newest.mtimeMs) {
        newest = { mtimeMs: stat.mtimeMs, name, sizeBytes: stat.size };
      }
    } catch {
      // A file that vanished between readdir and stat does not count.
    }
  }
  if (newest === null) {
    return {
      ...base,
      fresh: false,
      newestBackupAt: null,
      dirReadable: true,
      newestBackupFile: null,
      newestBackupSizeBytes: null,
    };
  }
  return {
    ...base,
    fresh: now.getTime() - newest.mtimeMs < maxAgeMs,
    newestBackupAt: new Date(newest.mtimeMs).toISOString(),
    dirReadable: true,
    newestBackupFile: newest.name,
    newestBackupSizeBytes: newest.sizeBytes,
  };
}
