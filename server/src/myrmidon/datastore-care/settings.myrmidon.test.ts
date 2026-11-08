// myrmidon(DBC-4): tests for the datastore-care settings.
//
// The defaults ARE the acceptance criteria (hourly collection, 90-day
// retention, top-25 queries), so they are asserted explicitly, and so is the
// fail-safe direction of the kill switch: a typo must not switch the module off.
//
// Neutral data only: example.com, 192.0.2.0/24.

import { describe, expect, it } from "vitest";

import {
  DATASTORE_CARE_BACKUP_DIR_ENV,
  DATASTORE_CARE_ENABLED_ENV,
  DATASTORE_CARE_INTERVAL_SEC_ENV,
  DATASTORE_CARE_OPTIONAL_METRICS_ENV,
  DATASTORE_CARE_RETENTION_DAYS_ENV,
  DATASTORE_CARE_TOP_QUERIES_ENV,
  DEFAULT_INTERVAL_SEC,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TOP_QUERIES,
  isDatastoreCareEnabled,
  readDatastoreCareSettings,
} from "./settings.js";

const EMPTY = {} as NodeJS.ProcessEnv;

describe("myrmidon(DBC-4) datastore-care settings", () => {
  it("defaults to the acceptance numbers: hourly, 90 days, top 25", () => {
    const settings = readDatastoreCareSettings(EMPTY);
    expect(settings.enabled).toBe(true);
    expect(settings.intervalSec).toBe(DEFAULT_INTERVAL_SEC);
    expect(settings.intervalSec).toBe(3600);
    expect(settings.intervalMs).toBe(3_600_000);
    expect(settings.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(settings.retentionMs).toBe(90 * 24 * 60 * 60 * 1000);
    expect(settings.topQueries).toBe(DEFAULT_TOP_QUERIES);
    expect(settings.topQueries).toBe(25);
    expect(settings.optionalMetrics).toBe(true);
    expect(settings.sources).toEqual({
      enabled: "default",
      intervalSec: "default",
      retentionDays: "default",
      topQueries: "default",
      backupDir: "default",
      optionalMetrics: "default",
    });
    expect(settings.warnings).toEqual([]);
    expect(settings.backupDir).toBeTruthy();
  });

  it("reads every knob from the environment", () => {
    const settings = readDatastoreCareSettings({
      [DATASTORE_CARE_ENABLED_ENV]: "0",
      [DATASTORE_CARE_INTERVAL_SEC_ENV]: "300",
      [DATASTORE_CARE_RETENTION_DAYS_ENV]: "30",
      [DATASTORE_CARE_TOP_QUERIES_ENV]: "5",
      [DATASTORE_CARE_BACKUP_DIR_ENV]: "/srv/backups/board",
      [DATASTORE_CARE_OPTIONAL_METRICS_ENV]: "off",
    } as NodeJS.ProcessEnv);
    expect(settings.enabled).toBe(false);
    expect(settings.intervalMs).toBe(300_000);
    expect(settings.retentionDays).toBe(30);
    expect(settings.topQueries).toBe(5);
    expect(settings.backupDir).toBe("/srv/backups/board");
    expect(settings.optionalMetrics).toBe(false);
    expect(settings.sources.intervalSec).toBe("env");
    expect(settings.sources.backupDir).toBe("env");
  });

  it("keeps the module enabled when the flag is a typo, and says so", () => {
    const settings = readDatastoreCareSettings({
      [DATASTORE_CARE_ENABLED_ENV]: "enable",
    } as NodeJS.ProcessEnv);
    expect(settings.enabled).toBe(true);
    expect(settings.warnings.join("\n")).toContain(DATASTORE_CARE_ENABLED_ENV);
    expect(isDatastoreCareEnabled({ [DATASTORE_CARE_ENABLED_ENV]: "enable" })).toBe(true);
  });

  it("clamps an out-of-range interval instead of trusting it", () => {
    const tooFast = readDatastoreCareSettings({
      [DATASTORE_CARE_INTERVAL_SEC_ENV]: "5",
    } as NodeJS.ProcessEnv);
    expect(tooFast.intervalSec).toBe(60);
    expect(tooFast.warnings.join("\n")).toContain("outside");

    const tooSlow = readDatastoreCareSettings({
      [DATASTORE_CARE_INTERVAL_SEC_ENV]: "999999",
    } as NodeJS.ProcessEnv);
    expect(tooSlow.intervalSec).toBe(86_400);

    const notANumber = readDatastoreCareSettings({
      [DATASTORE_CARE_INTERVAL_SEC_ENV]: "hourly",
    } as NodeJS.ProcessEnv);
    expect(notANumber.intervalSec).toBe(DEFAULT_INTERVAL_SEC);
    expect(notANumber.warnings.join("\n")).toContain("not a number");
  });

  it("reads the kill switch with the known truthy and off spellings", () => {
    expect(isDatastoreCareEnabled(EMPTY)).toBe(true);
    expect(isDatastoreCareEnabled({ [DATASTORE_CARE_ENABLED_ENV]: "1" })).toBe(true);
    expect(isDatastoreCareEnabled({ [DATASTORE_CARE_ENABLED_ENV]: "true" })).toBe(true);
    expect(isDatastoreCareEnabled({ [DATASTORE_CARE_ENABLED_ENV]: "yes" })).toBe(true);
    expect(isDatastoreCareEnabled({ [DATASTORE_CARE_ENABLED_ENV]: "on" })).toBe(true);
    for (const off of ["0", "false", "off", "no", "disabled", "FALSE", " Off "]) {
      expect(isDatastoreCareEnabled({ [DATASTORE_CARE_ENABLED_ENV]: off })).toBe(false);
    }
  });
});