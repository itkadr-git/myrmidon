import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import { BACKUP_RETENTION_PRESETS, DEFAULT_BACKUP_RETENTION_DAYS } from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

export const backupRetentionDaysSchema = z.number().refine(
  (v): v is (typeof BACKUP_RETENTION_PRESETS)[number] =>
    (BACKUP_RETENTION_PRESETS as readonly number[]).includes(v),
  { message: `Must be one of: ${BACKUP_RETENTION_PRESETS.join(", ")}` },
);

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetentionDays: backupRetentionDaysSchema.default(DEFAULT_BACKUP_RETENTION_DAYS),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
