import { z } from "zod";

/**
 * Shared mount configuration for instances (myrmidon 1.6.1, BOT-DISK D).
 */
export interface SharedMountSettings {
  /** Whether shared mount feature is enabled for this instance */
  enabled: boolean;
  /** Host path for the shared directory (defaults to MYRMIDON_BOT_VOLUME_ROOT/shared) */
  hostPath?: string;
  /** Whether bots can write to the shared directory */
  writable?: boolean;
  /** Allowlist of bot IDs that can access the shared directory */
  allowedBots?: string[];
}

/**
 * The settings-side validator: `general.sharedMount` in instance settings.
 * Absent means "the shared mount is disabled" (deny by default).
 */
export const sharedMountSettingsSchema = z
  .object({
    enabled: z.boolean(),
    // Reject ambiguous and dangerous bind sources before they reach the driver.
    hostPath: z.string().refine((value) =>
      value.startsWith("/") && value !== "/" && !/[,:\\\x00-\x1f\x7f]/.test(value) &&
      !value.includes("//") && !value.endsWith("/") &&
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
      "must be a normalized absolute directory path without control characters, ':' or ','",
    ).optional(),
    writable: z.boolean().optional(),
    allowedBots: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SharedMountSettingsPatch = z.infer<typeof sharedMountSettingsSchema>;