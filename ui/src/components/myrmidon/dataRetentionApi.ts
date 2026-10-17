// Data retention (myrmidon 1.6.5-DB-RETENTION):
// GET/PATCH /api/myrmidon/data-retention.
//
// GET reports the retention windows in force for the three grown tables
// (heartbeat runs, the activity log, the access audit log), where each value
// came from, and the state of the last cleanup sweep: when it ran, whether it
// is waiting for a fresh backup, and how many rows it deleted and how many
// bytes it freed per table group and in total. PATCH saves a partial of the
// three windows to the instance settings; the value applies immediately,
// without restarting the server. `0` means "keep forever".
import { api } from "@/api/client";

export type DataRetentionLimitSource = "settings" | "default";

export type DataRetentionTableGroup = "runs" | "activity" | "access";

/** The three whole-day windows the panel edits. */
export interface DataRetentionSettings {
  heartbeatRunsDays: number;
  activityLogDays: number;
  accessAuditDays: number;
}

/** Sweep counters for one table group. */
export interface DataRetentionTableStatus {
  deletedTotal: number;
  lastDeleted: number;
  lastFreedBytes: number;
}

/** What a PATCH may carry: any of the windows plus the backup-gate mode. */
export type DataRetentionPatch = Partial<DataRetentionSettings> & {
  /** myrmidon(1.6.5-F14B): the machine is backed up outside; the gate does not wait for a local dump. */
  externalMachineBackup?: boolean;
};

export interface DataRetentionView {
  settings: DataRetentionSettings;
  /** myrmidon(1.6.5-F14B): absent on an older server, read as false. */
  externalMachineBackup?: boolean;
  sources: Record<keyof DataRetentionSettings, DataRetentionLimitSource>;
  status: {
    lastRunAt: string | null;
    waitingForBackup: boolean;
    backupCheckedAt: string | null;
    freedBytesTotal: number;
    perTable: Record<DataRetentionTableGroup, DataRetentionTableStatus>;
  };
}

export const dataRetentionQueryKey = ["myrmidon", "data-retention"] as const;

export const dataRetentionApi = {
  get: () => api.get<DataRetentionView>("/myrmidon/data-retention"),
  update: (patch: DataRetentionPatch) =>
    api.patch<DataRetentionView>("/myrmidon/data-retention", patch),
};