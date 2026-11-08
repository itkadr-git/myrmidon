import { z } from "zod";
import {
  maintenanceWindowCronExpressionSchema,
  isValidTimezone,
} from "../myrmidon-auto-update-window-cron.js";

export const maintenanceWindowSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    cron: maintenanceWindowCronExpressionSchema,
    durationMinutes: z.number().int().min(5).max(1440).default(120),
    timezone: z
      .string()
      .trim()
      .min(1)
      .refine(isValidTimezone, { message: "Invalid IANA timezone" })
      .default("UTC"),
  })
  .strict();

export const putMaintenanceWindowSettingsSchema = maintenanceWindowSettingsSchema;
export type MaintenanceWindowSettings = z.infer<
  typeof maintenanceWindowSettingsSchema
>;
