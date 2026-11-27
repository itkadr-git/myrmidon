export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
  // myrmidon(BACKUP-KEEP-LAST): "keep only the last verified backup" mode;
  // when true, tiered pruning is skipped and all previous <prefix>-* files are
  // deleted after the new dump passes verification. Kept as a local copy of the
  // shared type (packages/shared/src/types/instance.ts): the db package does not
  // depend on @myrmidon/shared, so the flag is mirrored here instead.
  keepLastOnly?: boolean;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
  /**
   * @deprecated Migration-journal schemas are included with the normal backup
   * scope. This option is kept for compatibility and no longer changes backup
   * engine selection.
   */
  includeMigrationJournal?: boolean;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: "auto" | "pg_dump" | "javascript";
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
  /**
   * myrmidon(SHARED-PG-BACKUP): non-fatal diagnostics of the run, e.g. the
   * pg_dump client major-version mismatch that made an "auto" engine fall
   * back to the JavaScript dump path. Absent when the run was clean.
   */
  warnings?: string[];
};

export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  connectTimeoutSeconds?: number;
};

/**
 * myrmidon(OPE-4832): a freshly written dump failed keep-last verification.
 * The engine `auto` must NOT retry such a run on JavaScript: verification is
 * raised after the pg_dump path already aborted its writer, so a fallback
 * would write into a closed file and mask the real error (and a dump the
 * utility itself reports as broken is exactly the case where "previous
 * backups kept, run failed loudly" is the documented contract).
 */
export class BackupVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupVerificationError";
  }
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * myrmidon(SHARED-PG-BACKUP): the configured `pg_dump` client is older than
 * the database server's major version. pg_dump refuses to dump a newer
 * server ("server version X is newer than client version Y"), so a dump with
 * such a client dies mid-run with an unclear utility error. The engine
 * detects the mismatch before spawning the real dump: engine "pg_dump" fails
 * loudly with this error and the fix, engine "auto" warns and falls back to
 * the JavaScript dump path, which speaks SQL through postgres.js and works
 * against any server the board can connect to (a shared PostgreSQL 18 with
 * the host's older client tools included).
 */
export class BackupClientVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupClientVersionError";
  }
}

// myrmidon(SHARED-PG-BACKUP): the major version of a Postgres version string
// — the server's `SELECT version()` ("PostgreSQL 18.1 ...") or a utility's
// --version output ("pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-0.pgdg...)").
// The major is the leading number of a real `major.minor` version token;
// unrelated output (no version shape) -> null.
export function parsePgMajorVersion(text: string): number | null {
  // myrmidon(SHARED-PG-BACKUP): accept only real version shapes (major.minor
  // or the longer "18.1 (build)" spellings). A bare `\d+` scan mis-reads the
  // first digit in any unrelated output as the major — e.g. a stub client
  // that answers `--version` with its dump body ("SELECT 1;") read as major
  // 1 and made the compatibility gate throw in CI.
  const match = /(\d+)(?:\.\d+)+/.exec(text);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  // myrmidon(SHARED-PG-BACKUP): non-fatal diagnostics (e.g. the pg_dump
  // client major-version fallback) belong in every consumer's log line.
  const warnings = (result.warnings ?? []).map((warning) => `; warning: ${warning}`).join("");
  return `${result.backupFile} (${size}${pruned}${warnings})`;
}
