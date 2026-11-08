// server/src/myrmidon/datastore-care/settings.ts
//
// myrmidon(DBC-4): settings of the datastore-care module.
//
// The module collects one snapshot per hour and keeps snapshots and audit
// reports for 90 days — both are the acceptance criteria of DBC-4, so the
// defaults ARE the behaviour and the environment only tunes it:
//
//   MYRMIDON_DATASTORE_CARE_ENABLED         (default on;  "0"/"false" = off)
//   MYRMIDON_DATASTORE_CARE_INTERVAL_SEC    (default 3600; clamped 60..86400)
//   MYRMIDON_DATASTORE_CARE_RETENTION_DAYS  (default 90;   clamped 1..3650)
//   MYRMIDON_DATASTORE_CARE_TOP_QUERIES     (default 25;   clamped 1..100)
//   MYRMIDON_DATASTORE_CARE_BACKUP_DIR      (default: the instance backup dir)
//   MYRMIDON_DATASTORE_CARE_OPTIONAL_METRICS (default on; pgvector/FTS when the
//                                            extension is present)
//
// Fail-safe direction: a typo in a boolean must never silently switch the fix
// off (CONVENTIONS), so only the explicit off words disable the module; any
// unrecognized value keeps it enabled and is reported as a warning.

import { resolveDefaultBackupDir } from "../../home-paths.js";

/** Kill switch of the hourly collection. */
export const DATASTORE_CARE_ENABLED_ENV = "MYRMIDON_DATASTORE_CARE_ENABLED";
/** Seconds between two collections of the same target (default hourly). */
export const DATASTORE_CARE_INTERVAL_SEC_ENV = "MYRMIDON_DATASTORE_CARE_INTERVAL_SEC";
/** Days a snapshot or an audit report is kept (default 90). */
export const DATASTORE_CARE_RETENTION_DAYS_ENV = "MYRMIDON_DATASTORE_CARE_RETENTION_DAYS";
/** How many top queries the report prints (default 25). */
export const DATASTORE_CARE_TOP_QUERIES_ENV = "MYRMIDON_DATASTORE_CARE_TOP_QUERIES";
/** Directory holding the board's database backups. */
export const DATASTORE_CARE_BACKUP_DIR_ENV = "MYRMIDON_DATASTORE_CARE_BACKUP_DIR";
/** Toggle of the extension-gated metrics (pgvector, full-text search). */
export const DATASTORE_CARE_OPTIONAL_METRICS_ENV = "MYRMIDON_DATASTORE_CARE_OPTIONAL_METRICS";

/** One hour, the collection interval of the project. */
export const DEFAULT_INTERVAL_SEC = 3600;
/** The retention the project asks for, in days. */
export const DEFAULT_RETENTION_DAYS = 90;
/** Top queries the audit report prints. */
export const DEFAULT_TOP_QUERIES = 25;

/** Everything the module needs to know before it starts. */
export interface DatastoreCareSettings {
  /** Whether the hourly collection runs at all. */
  enabled: boolean;
  intervalSec: number;
  intervalMs: number;
  /** Snapshot and audit-report retention, in days and milliseconds. */
  retentionDays: number;
  retentionMs: number;
  topQueries: number;
  /** Directory whose newest file answers the "backup freshness" criterion. */
  backupDir: string;
  /** Whether pgvector/FTS metrics are collected when their extension is there. */
  optionalMetrics: boolean;
  /** Where each value came from, for the status endpoint and the report. */
  sources: {
    enabled: "env" | "default";
    intervalSec: "env" | "default";
    retentionDays: "env" | "default";
    topQueries: "env" | "default";
    backupDir: "env" | "default";
    optionalMetrics: "env" | "default";
  };
  /** Human-readable notes: a typo that was ignored, a clamped number. */
  warnings: string[];
}

const OFF_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

/** Cheap read of the kill switch for the routes: no warnings, no filesystem. */
export function isDatastoreCareEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseBool(env[DATASTORE_CARE_ENABLED_ENV]).value;
}

function parseBool(raw: string | undefined): { value: boolean; recognized: boolean } {
  if (raw === undefined || raw.trim() === "") return { value: true, recognized: true };
  const normalized = raw.trim().toLowerCase();
  if (OFF_VALUES.has(normalized)) return { value: false, recognized: true };
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") {
    return { value: true, recognized: true };
  }
  return { value: true, recognized: false };
}

function parseNumber(
  raw: string | undefined,
  label: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): { value: number; source: "env" | "default" } {
  if (raw === undefined || raw.trim() === "") return { value: fallback, source: "default" };
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    warnings.push(`${label}: "${raw}" is not a number, using ${fallback}`);
    return { value: fallback, source: "default" };
  }
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) {
    const clamped = Math.min(Math.max(rounded, min), max);
    warnings.push(`${label}: ${rounded} is outside ${min}..${max}, using ${clamped}`);
    return { value: clamped, source: "env" };
  }
  return { value: rounded, source: "env" };
}

/**
 * Reads the module settings from the environment.
 *
 * `backupDir` defaults to the instance backup directory (the same one the
 * board's backup command writes to), so the "backup freshness" criterion is
 * meaningful on the production instance without any configuration.
 */
export function readDatastoreCareSettings(
  env: NodeJS.ProcessEnv = process.env,
): DatastoreCareSettings {
  const warnings: string[] = [];

  const enabledRaw = parseBool(env[DATASTORE_CARE_ENABLED_ENV]);
  if (!enabledRaw.recognized) {
    warnings.push(
      `${DATASTORE_CARE_ENABLED_ENV}: "${env[DATASTORE_CARE_ENABLED_ENV]}" is not a boolean, keeping the module enabled`,
    );
  }

  const interval = parseNumber(
    env[DATASTORE_CARE_INTERVAL_SEC_ENV],
    DATASTORE_CARE_INTERVAL_SEC_ENV,
    DEFAULT_INTERVAL_SEC,
    60,
    86_400,
    warnings,
  );
  const retention = parseNumber(
    env[DATASTORE_CARE_RETENTION_DAYS_ENV],
    DATASTORE_CARE_RETENTION_DAYS_ENV,
    DEFAULT_RETENTION_DAYS,
    1,
    3650,
    warnings,
  );
  const topQueries = parseNumber(
    env[DATASTORE_CARE_TOP_QUERIES_ENV],
    DATASTORE_CARE_TOP_QUERIES_ENV,
    DEFAULT_TOP_QUERIES,
    1,
    100,
    warnings,
  );

  const optionalRaw = parseBool(env[DATASTORE_CARE_OPTIONAL_METRICS_ENV]);
  if (!optionalRaw.recognized) {
    warnings.push(
      `${DATASTORE_CARE_OPTIONAL_METRICS_ENV}: "${env[DATASTORE_CARE_OPTIONAL_METRICS_ENV]}" is not a boolean, keeping the optional metrics on`,
    );
  }

  const backupDirEnv = env[DATASTORE_CARE_BACKUP_DIR_ENV]?.trim();
  let backupDir: string;
  let backupDirSource: "env" | "default";
  if (backupDirEnv) {
    backupDir = backupDirEnv;
    backupDirSource = "env";
  } else {
    backupDir = resolveDefaultBackupDir();
    backupDirSource = "default";
  }

  return {
    enabled: enabledRaw.value,
    intervalSec: interval.value,
    intervalMs: interval.value * 1000,
    retentionDays: retention.value,
    retentionMs: retention.value * 24 * 60 * 60 * 1000,
    topQueries: topQueries.value,
    backupDir,
    optionalMetrics: optionalRaw.value,
    sources: {
      enabled: env[DATASTORE_CARE_ENABLED_ENV] === undefined ? "default" : "env",
      intervalSec: interval.source,
      retentionDays: retention.source,
      topQueries: topQueries.source,
      backupDir: backupDirSource,
      optionalMetrics: env[DATASTORE_CARE_OPTIONAL_METRICS_ENV] === undefined ? "default" : "env",
    },
    warnings,
  };
}