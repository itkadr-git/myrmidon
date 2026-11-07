import { z } from "zod";
import {
  maintenanceWindowCronExpressionSchema,
  isValidTimezone,
} from "../myrmidon-auto-update-window-cron.js";

export const minuteSchema = z
  .number()
  .int({ message: "minute must be an integer" })
  .min(0, { message: "minute must be between 0 and 1439" })
  .max(1439, { message: "minute must be between 0 and 1439" });

export const weekdaySchema = z
  .number()
  .int({ message: "day must be an integer" })
  .min(0, { message: "day of week must be between 0 and 6" })
  .max(6, { message: "day of week must be between 0 and 6" });

export const percentageSchema = z
  .number()
  .min(0, { message: "percentage must be between 0 and 100" })
  .max(100, { message: "percentage must be between 0 and 100" });

export const integerPercentageSchema = z
  .number()
  .int({ message: "percentage must be an integer" })
  .min(0, { message: "percentage must be between 0 and 100" })
  .max(100, { message: "percentage must be between 0 and 100" });

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, { message: "timezone must not be empty" })
  .refine(isValidTimezone, { message: "Invalid IANA timezone" });

export const maintenanceWindowBoundsSchema = z
  .object({
    enabled: z.boolean().default(true),
    days: z
      .array(weekdaySchema)
      .max(7, { message: "days cannot contain more than 7 days" })
      .default([0, 1, 2, 3, 4, 5, 6]),
    fromMinute: minuteSchema.default(0),
    toMinute: minuteSchema.default(1439),
    durationMinutes: z
      .number()
      .int({ message: "durationMinutes must be an integer" })
      .min(5, { message: "durationMinutes must be between 5 and 1440" })
      .max(1440, { message: "durationMinutes must be between 5 and 1440" })
      .optional(),
    cron: maintenanceWindowCronExpressionSchema.optional(),
    timezone: timezoneSchema.default("UTC"),
  })
  .superRefine((val, ctx) => {
    if (
      val.days.length > 0 &&
      val.fromMinute === val.toMinute &&
      val.durationMinutes === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interval"],
        message:
          "Maintenance window fromMinute and toMinute cannot be equal without durationMinutes",
      });
    }
  });

export const canarySettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    sharePercent: integerPercentageSchema.optional(),
    percentage: percentageSchema.optional(),
    minBots: z
      .number()
      .int({ message: "minBots must be an integer" })
      .min(0, { message: "minBots must be non-negative" })
      .max(1000)
      .default(1),
    maxBots: z
      .number()
      .int({ message: "maxBots must be an integer" })
      .min(0, { message: "maxBots must be non-negative" })
      .max(1000)
      .default(5),
    stepDurationMinutes: z
      .number()
      .int({ message: "stepDurationMinutes must be an integer" })
      .min(0, { message: "stepDurationMinutes must be non-negative" })
      .max(1440, { message: "stepDurationMinutes must not exceed 1440" })
      .optional(),
    healthSettleSec: z
      .number()
      .int({ message: "healthSettleSec must be an integer" })
      .min(0, { message: "healthSettleSec must be non-negative" })
      .max(86400, { message: "healthSettleSec must not exceed 86400" })
      .default(300),
  })
  .superRefine((val, ctx) => {
    if (val.maxBots < val.minBots) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxBots"],
        message: "maxBots must be greater than or equal to minBots",
      });
    }
  });

export const autoRollbackSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  failureThresholdPercent: percentageSchema.default(10),
  unhealthyPercent: percentageSchema.optional(),
  healthTimeoutMinutes: z
    .number()
    .int({ message: "healthTimeoutMinutes must be an integer" })
    .min(1, { message: "healthTimeoutMinutes must be at least 1 minute" })
    .max(1440, { message: "healthTimeoutMinutes must not exceed 1440 minutes" })
    .default(15),
  healthTimeoutSec: z
    .number()
    .int({ message: "healthTimeoutSec must be an integer" })
    .min(1, { message: "healthTimeoutSec must be between 1 and 86400" })
    .max(86400, { message: "healthTimeoutSec must be between 1 and 86400" })
    .optional(),
  evaluationWindowMinutes: z
    .number()
    .int({ message: "evaluationWindowMinutes must be an integer" })
    .min(1, { message: "evaluationWindowMinutes must be between 1 and 1440" })
    .max(1440, { message: "evaluationWindowMinutes must be between 1 and 1440" })
    .optional(),
});

export const updateSettingsSchema = z.object({
  mode: z.enum(["manual", "auto", "auto_release"]).default("manual"),
  window: maintenanceWindowBoundsSchema.optional(),
  canary: canarySettingsSchema.optional(),
  autoRollback: autoRollbackSettingsSchema.optional(),
  rollback: autoRollbackSettingsSchema.optional(),
  // Flat aliases for backwards compatibility or single-field updates
  cron: maintenanceWindowCronExpressionSchema.optional(),
  durationMinutes: z.number().int().min(5).max(1440).optional(),
  timezone: timezoneSchema.optional(),
  canaryPercentage: percentageSchema.optional(),
  rollbackThresholdPercent: percentageSchema.optional(),
});

export const putUpdateSettingsSchema = updateSettingsSchema;
export const patchUpdateSettingsSchema = updateSettingsSchema.partial();
export const autoUpdateSettingsSchema = updateSettingsSchema;
export const putAutoUpdateSettingsSchema = updateSettingsSchema;

export type MaintenanceWindowBounds = z.infer<
  typeof maintenanceWindowBoundsSchema
>;
export type CanarySettings = z.infer<typeof canarySettingsSchema>;
export type AutoRollbackSettings = z.infer<typeof autoRollbackSettingsSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type PatchUpdateSettings = z.infer<typeof patchUpdateSettingsSchema>;
export type AutoUpdateSettings = UpdateSettings;
