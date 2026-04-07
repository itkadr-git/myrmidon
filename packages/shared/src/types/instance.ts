import type { FeedbackDataSharingPreference } from "./feedback.js";

export const BACKUP_RETENTION_PRESETS = [7, 14, 30] as const;
export type BackupRetentionDays = (typeof BACKUP_RETENTION_PRESETS)[number];
export const DEFAULT_BACKUP_RETENTION_DAYS: BackupRetentionDays = 7;

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetentionDays: BackupRetentionDays;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
