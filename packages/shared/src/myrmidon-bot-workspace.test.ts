import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  MYR_WS_EXIT,
  MYR_WS_QUOTA_ERROR_PREFIX,
  RUN_WORKSPACE_FALLBACK_DIR,
  WS_BOT_DISK_SETTING_DEFAULTS,
  WS_CARD_KEYS,
  WS_DISK_REPORT_MAX_ACTIONS,
  WS_DISK_REPORT_MAX_BODY_BYTES,
  WS_DOCKERGATE_DENY,
  WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC,
  WS_GIT_BASE_LIMIT,
  WS_GIT_BASE_REFSPEC,
  WS_QUOTA_MAX_BYTES,
  WS_QUOTA_MIN_BYTES,
  runWorkspaceFieldSchema,
  wsBotDiskSettingsSchema,
  wsDesiredStateSchema,
  wsDiskApiResponseSchema,
  wsDiskQuotaPutRequestSchema,
  wsDiskQuotaPutResponseSchema,
  wsDiskReportResponseSchema,
  wsDiskReportSchema,
  wsDiskStateSchema,
  myrWsCloseResultSchema,
  myrWsErrorResultSchema,
  myrWsListResultSchema,
  myrWsMigrateResultSchema,
  myrWsOpenResultSchema,
  myrWsRestoreResultSchema,
  wsRegistrySchema,
} from "./myrmidon-bot-workspace.js";

/**
 * myrmidon(1.6.5-BOT-DISK-H0): every fixture of docs/myrmidon/bot-disk-contract
 * must parse under its schema — the fixtures are the stubs every BOT-DISK-H task
 * tests against, so a drift between a fixture and the contract fails here.
 */
const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../docs/myrmidon/bot-disk-contract",
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

const FIXTURE_SCHEMAS: ReadonlyArray<readonly [string, ZodType]> = [
  ["ws-registry.json", wsRegistrySchema],
  ["disk-state.json", wsDiskStateSchema],
  ["myr-ws-open.json", myrWsOpenResultSchema],
  ["myr-ws-list.json", myrWsListResultSchema],
  ["myr-ws-close.json", myrWsCloseResultSchema],
  ["myr-ws-restore.json", myrWsRestoreResultSchema],
  ["myr-ws-migrate.json", myrWsMigrateResultSchema],
  ["myr-ws-error.json", myrWsErrorResultSchema],
  ["desired-state.json", wsDesiredStateSchema],
  ["disk-report.json", wsDiskReportSchema],
  ["disk-report-response.json", wsDiskReportResponseSchema],
  ["dockergate-disk.json", wsDiskApiResponseSchema],
  ["dockergate-quota-put-request.json", wsDiskQuotaPutRequestSchema],
  ["dockergate-quota-put-response.json", wsDiskQuotaPutResponseSchema],
  ["run-workspace-field.json", runWorkspaceFieldSchema],
  ["botdisk-settings.json", wsBotDiskSettingsSchema],
];

describe("myrmidon(1.6.5-BOT-DISK-H0) contract fixtures", () => {
  it("has a schema for every fixture file", () => {
    const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(onDisk).toEqual(FIXTURE_SCHEMAS.map(([name]) => name).sort());
  });

  for (const [name, schema] of FIXTURE_SCHEMAS) {
    it(`${name} passes its schema`, () => {
      const parsed = schema.safeParse(fixture(name));
      if (!parsed.success) {
        throw new Error(`${name}: ${parsed.error.message}`);
      }
    });
  }

  it("myr-ws exit codes are the stable set of the contract", () => {
    expect(MYR_WS_EXIT).toEqual({
      ok: 0,
      usage: 2,
      quotaExceeded: 3,
      baseLimit: 4,
      network: 5,
      notFound: 6,
      unpushed: 7,
    });
    expect(MYR_WS_QUOTA_ERROR_PREFIX).toBe("BOT_DISK_QUOTA_EXCEEDED:");
  });

  it("layout constants match design section 1", () => {
    expect(WS_GIT_BASE_LIMIT).toBe(8);
    expect(WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC).toBe(900);
    expect(WS_GIT_BASE_REFSPEC).toBe("+refs/heads/*:refs/remotes/origin/*");
    expect(RUN_WORKSPACE_FALLBACK_DIR).toBe("/scratch");
  });

  it("quota bounds and deny codes match contract C5", () => {
    expect(WS_QUOTA_MIN_BYTES).toBe(64 * 1024 * 1024);
    expect(WS_QUOTA_MAX_BYTES).toBe(1024 * 1024 * 1024 * 1024);
    expect(WS_DOCKERGATE_DENY.quotaUnavailable).toBe("quota_unavailable");
  });

  it("settings defaults match contract C7", () => {
    expect(WS_BOT_DISK_SETTING_DEFAULTS.partitionThresholdPercent).toBe(85);
    expect(WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent).toBe(90);
    expect(WS_BOT_DISK_SETTING_DEFAULTS.partitionCriticalPercent).toBe(95);
    expect(WS_CARD_KEYS.reflink).toBe("bot_disk_lifecycle/reflink");
  });

  it("a quota-refusal error fixture carries the stable prefix", () => {
    const err = myrWsErrorResultSchema.parse(fixture("myr-ws-error.json"));
    expect(err.exitCode).toBe(MYR_WS_EXIT.quotaExceeded);
    expect(err.error.startsWith(MYR_WS_QUOTA_ERROR_PREFIX)).toBe(true);
  });

  it("report caps are the documented ones", () => {
    expect(WS_DISK_REPORT_MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(WS_DISK_REPORT_MAX_ACTIONS).toBe(200);
  });
});
