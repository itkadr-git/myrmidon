// server/src/myrmidon/datastore-care/retention/service.ts
//
// myrmidon(1.6.5-DBC1): the sweep-tick executor of the run-context retention.
//
// One pass per call, cheap when idle: the whole pass is gated so a tick with
// nothing to do costs one settings read.
//
// Gate order on every pass:
//   1. Maintenance gate — while an instance maintenance window is open, the
//      pass does nothing (the rule the bot-disk sweep follows on the same
//      tick); routine board work yields to the window.
//   2. Settings — `general.datastoreCare.retention.heartbeatRunContextDays`
//      (env PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS, then 7); 0
//      disables the compaction. Re-read per pass, so a PATCH applies
//      without a restart.
//   3. Backup precondition — the newest fresh `<prefix>-*.sql.gz` backup
//      must exist; when it does not, the pass rewrites nothing and logs one
//      throttled `datastore.retention_waiting_for_backup` line (the compact
//      is a row rewrite and must be restorable from a backup).
//
// When the pass compacts rows it writes one
// `datastore.retention_applied` activity line per company carrying the
// compacted row count and the freed bytes, and persists the pass state under
// `general.datastoreCare.retention.contextLastRun`, so the panel and a restart see
// the same numbers.

import { logger } from "../../../middleware/logger.js";
import type { Db } from "@paperclipai/db";
import {
  DATASTORE_RETENTION_APPLIED_ACTION,
  DATASTORE_RETENTION_WAITING_FOR_BACKUP_ACTION,
  emptyDatastoreCareRetentionLastRun,
  normalizeDatastoreCareRetentionLastRun,
  type DatastoreCareRetentionLastRun,
} from "@paperclipai/shared";
import { instanceSettingsService, logActivity } from "../../../services/index.js";
import { isInstanceUnderMaintenance } from "../../maintenance/gate.js";
import {
  checkBackupGate,
  resolveBackupDir,
  resolveBackupFilePrefix,
} from "./backup-gate.js";
import { compactContextPass } from "./compact.js";
import {
  readRetentionLastRun,
  readRetentionSettings,
  writeRetentionLastRun,
} from "./settings.js";

/** The "waiting for backup" activity line is written at most once per this window. */
export const DATASTORE_RETENTION_WAITING_LOG_INTERVAL_MS = 60 * 60 * 1000;

export interface DatastoreCareRetentionRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Test hook: override the backup dir resolution. */
  backupDir?: string;
  now?: () => Date;
}

export interface DatastoreCareRetentionPassResult {
  ran: boolean;
  reason: "maintenance" | "disabled" | "waiting-for-backup" | "compacted" | "nothing-to-compact" | "error";
  compacted: number;
  freedBytes: number;
}

export interface DatastoreCareRetentionRuntime {
  /** Run one gated pass. Concurrent calls join the pass already running. */
  runOnce(): Promise<DatastoreCareRetentionPassResult>;
}

export function createDatastoreCareRetentionRuntime(
  db: Db,
  options: DatastoreCareRetentionRuntimeOptions = {},
): DatastoreCareRetentionRuntime {
  const env = options.env ?? process.env;
  const settings = instanceSettingsService(db);
  const now = options.now ?? (() => new Date());
  let inFlight: Promise<DatastoreCareRetentionPassResult> | null = null;
  let lastWaitingLoggedAt = 0;

  async function pass(): Promise<DatastoreCareRetentionPassResult> {
    // 1. The maintenance gate: no board-storage rewrites while a window covers
    // the instance.
    if (await isInstanceUnderMaintenance(db)) {
      return { ran: false, reason: "maintenance", compacted: 0, freedBytes: 0 };
    }

    // 2. Settings, re-read every pass.
    const resolved = await readRetentionSettings(settings, env);
    if (resolved.heartbeatRunContextDays === 0) {
      return { ran: false, reason: "disabled", compacted: 0, freedBytes: 0 };
    }

    // 3. The backup precondition.
    const backupDir = options.backupDir ?? resolveBackupDir();
    const prefix = resolveBackupFilePrefix(env);
    const checkedAt = now();
    // myrmidon(1.6.5-F14B): with the "external machine backup" setting the
    // gate does not wait for a local dump.
    const gate = checkBackupGate({
      backupDir,
      prefix,
      externalMachineBackup: resolved.externalMachineBackup,
      now: checkedAt,
    });
    const gateState: DatastoreCareRetentionLastRun["backupGate"] = {
      backupDir: gate.backupDir,
      prefix: gate.prefix,
      newestBackupAt: gate.newestBackupAt,
      newestBackupFile: gate.newestBackupFile,
      newestBackupSizeBytes: gate.newestBackupSizeBytes,
      dirReadable: gate.dirReadable,
      candidates: gate.candidates,
      ...(gate.externalMachineBackup ? { externalMachineBackup: true } : {}),
    };
    const previous = normalizeDatastoreCareRetentionLastRun(
      await readRetentionLastRun(settings).catch(() => emptyDatastoreCareRetentionLastRun()),
    );
    if (!gate.fresh) {
      if (checkedAt.getTime() - lastWaitingLoggedAt >= DATASTORE_RETENTION_WAITING_LOG_INTERVAL_MS) {
        lastWaitingLoggedAt = checkedAt.getTime();
        // The refusal reason must be visible: the dir the gate looked in, the
        // prefix it matched, and what backup-looking files it saw instead.
        logger.warn(
          {
            backupDir: gate.backupDir,
            prefix: gate.prefix,
            dirReadable: gate.dirReadable,
            newestBackupAt: gate.newestBackupAt,
            candidates: gate.candidates,
          },
          "datastore care: retention waits for a fresh backup",
        );
        try {
          const companyIds = await settings.listCompanyIds();
          for (const companyId of companyIds.slice(0, 1)) {
            await logActivity(db, {
              companyId,
              actorType: "system",
              actorId: "myrmidon-datastore-care",
              action: DATASTORE_RETENTION_WAITING_FOR_BACKUP_ACTION,
              entityType: "datastore",
              entityId: companyId,
              details: {
                checkedAt: checkedAt.toISOString(),
                backupDir: gate.backupDir,
                prefix: gate.prefix,
                dirReadable: gate.dirReadable,
                newestBackupAt: gate.newestBackupAt,
                candidates: gate.candidates,
                heartbeatRunContextDays: resolved.heartbeatRunContextDays,
              },
            });
          }
        } catch (err) {
          logger.warn({ err }, "datastore care: waiting-for-backup activity line failed");
        }
      }
      await writeRetentionLastRun(
        settings,
        {
          ...previous,
          lastRunAt: checkedAt.toISOString(),
          waitingForBackup: true,
          backupCheckedAt: gate.newestBackupAt,
          backupGate: gateState,
        } satisfies DatastoreCareRetentionLastRun,
      ).catch((err) =>
        logger.warn({ err }, "datastore care: waiting state persist failed"),
      );
      return { ran: false, reason: "waiting-for-backup", compacted: 0, freedBytes: 0 };
    }

    // The accepted backup goes to the journal: path, file, size, date.
    logger.info(
      {
        externalMachineBackup: gate.externalMachineBackup,
        backupDir: gate.backupDir,
        backupFile: gate.newestBackupFile,
        backupSizeBytes: gate.newestBackupSizeBytes,
        backupCheckedAt: gate.newestBackupAt,
        prefix: gate.prefix,
      },
      "datastore care: backup gate passed",
    );

    // The compaction itself: terminal runs older than the window, batched.
    const cutoff = new Date(
      checkedAt.getTime() - resolved.heartbeatRunContextDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const companyIds = await settings.listCompanyIds();
    const result = await compactContextPass(
      // myrmidon(1.6.5-F14B): the per-pass ceiling comes from the resolved
      // settings block (instance setting > env > default 10), read fresh
      // every pass so a PATCH applies without a restart.
      { db, maxBatches: resolved.contextCompactMaxBatches },
      { companyIds, cutoff, compactedAt: checkedAt.toISOString() },
    );

    const lastRun: DatastoreCareRetentionLastRun = {
      lastRunAt: checkedAt.toISOString(),
      waitingForBackup: false,
      backupCheckedAt: gate.newestBackupAt,
      backupGate: gateState,
      lastCompacted: result.compacted,
      lastFreedBytes: result.freedBytes,
      compactedTotal: previous.compactedTotal + result.compacted,
      freedBytesTotal: previous.freedBytesTotal + result.freedBytes,
    };
    await writeRetentionLastRun(settings, lastRun);

    if (result.compacted > 0) {
      // One `datastore.retention_applied` line per company that had work,
      // carrying its row count and freed bytes (the acceptance record).
      for (const company of result.perCompany) {
        try {
          await logActivity(db, {
            companyId: company.companyId,
            actorType: "system",
            actorId: "myrmidon-datastore-care",
            action: DATASTORE_RETENTION_APPLIED_ACTION,
            entityType: "datastore",
            entityId: "heartbeat_runs.context_snapshot",
            details: {
              ranAt: checkedAt.toISOString(),
              compactedRows: company.compacted,
              freedBytes: company.freedBytes,
              heartbeatRunContextDays: resolved.heartbeatRunContextDays,
              statementTimeoutYield: result.timedOut,
            },
          });
        } catch (err) {
          logger.warn({ err }, "datastore care: retention_applied activity line failed");
        }
      }
    }

    return {
      ran: true,
      reason: result.compacted > 0 ? "compacted" : "nothing-to-compact",
      compacted: result.compacted,
      freedBytes: result.freedBytes,
    };
  }

  return {
    runOnce(): Promise<DatastoreCareRetentionPassResult> {
      if (!inFlight) {
        inFlight = pass()
          .catch((err) => {
            logger.error({ err }, "datastore care retention pass failed");
            return { ran: false, reason: "error" as const, compacted: 0, freedBytes: 0 };
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}
