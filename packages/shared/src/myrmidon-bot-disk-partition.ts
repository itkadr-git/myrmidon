import { z } from "zod";
import {
  WS_BOT_DISK_SETTING_DEFAULTS,
  wsDiskPressureLevelSchema,
  type WsDiskPressureLevel,
} from "./myrmidon-bot-workspace.js";

/**
 * Bot partition thresholds (myrmidon 1.6.5 BOT-DISK-H, part H10).
 *
 * The bot fleet's workspace partition (`/srv/myrmidon-xfs` on the production
 * host) is measured by dockergate (`GET /myrmidon/disk`, contract C5), NOT by
 * a `statfs` of the server's own data root: on 07.10.2026 the bot partition
 * filled to 100 % while the server's `/data` was fine, so a threshold read
 * from server physics never warned. H10 makes the host-disk signal measure
 * the bot partition's physics instead.
 *
 * Three thresholds live in `instance_settings.general.botDisk` (contract C7
 * key set `wsBotDiskSettingsSchema`; the contract schema is passthrough and
 * holds more keys of other parts — H10 owns exactly these three):
 *
 * - `partitionThresholdPercent` (default 85) — the warning level: the
 *   `host_disk_alert` attention card appears.
 * - `partitionRefuseOpenPercent` (default 90) — the desired-state `pressure`
 *   level becomes `hard`; consumers (`myr-ws open`, contract C2) refuse to
 *   open new copies, grace is 0.
 * - `partitionCriticalPercent` (default 95) — the card goes critical and the
 *   owner gets a message through the existing owner Telegram cards channel
 *   (telegram-notify outbox).
 *
 * Invariant: threshold < refuseOpen < critical (85 < 90 < 95 by default). A
 * stored row whose values break the ordering is ignored as a whole, the same
 * rule `hostDisk` follows — the sweep can never read thresholds it did not
 * validate.
 */

/** Environment variables — first-start defaults of the three thresholds. */
export const WS_BOT_DISK_PARTITION_ENV_KEYS = {
  partitionThresholdPercent: "MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT",
  partitionRefuseOpenPercent: "MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT",
  partitionCriticalPercent: "MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT",
} as const;

export const WS_BOT_DISK_PARTITION_KEYS = [
  "partitionThresholdPercent",
  "partitionRefuseOpenPercent",
  "partitionCriticalPercent",
] as const;

export type WsBotDiskPartitionKey = (typeof WS_BOT_DISK_PARTITION_KEYS)[number];

/** Where an effective threshold came from: stored settings, the environment, or the default. */
export type WsBotDiskPartitionSource = "settings" | "env" | "default";

/** A threshold is a whole percent between 50 and 99 (contract bounds are 50–100; 100 would never fire). */
const partitionPercentSchema = z.number().int().min(50).max(99);

/** The canonical stored shape of the H10 slice of `instance_settings.general.botDisk`. */
export const wsBotDiskPartitionSettingsSchema = z
  .object({
    partitionThresholdPercent: partitionPercentSchema,
    partitionRefuseOpenPercent: partitionPercentSchema,
    partitionCriticalPercent: partitionPercentSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!(value.partitionThresholdPercent < value.partitionRefuseOpenPercent
      && value.partitionRefuseOpenPercent < value.partitionCriticalPercent)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "partitionThresholdPercent < partitionRefuseOpenPercent < partitionCriticalPercent is required",
      });
    }
  });

/** Body of `PATCH /api/myrmidon/host-disk/partition`. */
export const patchWsBotDiskPartitionSettingsSchema = z
  .object({
    partitionThresholdPercent: partitionPercentSchema.optional(),
    partitionRefuseOpenPercent: partitionPercentSchema.optional(),
    partitionCriticalPercent: partitionPercentSchema.optional(),
  })
  .strict();

export type WsBotDiskPartitionSettings = z.infer<typeof wsBotDiskPartitionSettingsSchema>;
export type WsBotDiskPartitionSettingsPatch = z.infer<typeof patchWsBotDiskPartitionSettingsSchema>;

export interface ResolvedWsBotDiskPartitionSettings {
  settings: WsBotDiskPartitionSettings;
  sources: Record<WsBotDiskPartitionKey, WsBotDiskPartitionSource>;
}

/** An environment value as a threshold; a non-integer or out-of-range value is ignored. */
export function parseWsBotDiskPartitionValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  const parsed = partitionPercentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored H10 slice of `general.botDisk`, or null when the row holds
 * nothing usable (missing keys, out-of-range values, or a broken ordering).
 * The contract schema is passthrough: extra keys of other BOT-DISK-H parts
 * are ignored here, not rejected.
 */
export function normalizeWsBotDiskPartitionSettings(raw: unknown): WsBotDiskPartitionSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const slice = {
    partitionThresholdPercent: (raw as Record<string, unknown>).partitionThresholdPercent,
    partitionRefuseOpenPercent: (raw as Record<string, unknown>).partitionRefuseOpenPercent,
    partitionCriticalPercent: (raw as Record<string, unknown>).partitionCriticalPercent,
  };
  const parsed = wsBotDiskPartitionSettingsSchema.safeParse(slice);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective thresholds and where each came from. Precedence mirrors the
 * `hostDisk` contract: a VALID stored row wins as a whole; otherwise each key
 * falls back to its environment variable, then to the C7 default. An env
 * value that would break the ordering against the other resolved values is
 * ignored for that key (the default takes over) — the sweep never sees an
 * unordered triple.
 */
export function resolveWsBotDiskPartitionSettings(
  options: {
    stored?: unknown;
    env?: Record<string, string | undefined>;
  } = {},
): ResolvedWsBotDiskPartitionSettings {
  const env = options.env ?? {};
  const stored = normalizeWsBotDiskPartitionSettings(options.stored);
  if (stored) {
    return {
      settings: stored,
      sources: {
        partitionThresholdPercent: "settings",
        partitionRefuseOpenPercent: "settings",
        partitionCriticalPercent: "settings",
      },
    };
  }
  const resolved: Record<WsBotDiskPartitionKey, number> = {
    partitionThresholdPercent: WS_BOT_DISK_SETTING_DEFAULTS.partitionThresholdPercent,
    partitionRefuseOpenPercent: WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent,
    partitionCriticalPercent: WS_BOT_DISK_SETTING_DEFAULTS.partitionCriticalPercent,
  };
  const sources: Record<WsBotDiskPartitionKey, WsBotDiskPartitionSource> = {
    partitionThresholdPercent: "default",
    partitionRefuseOpenPercent: "default",
    partitionCriticalPercent: "default",
  };
  const envValues: Partial<Record<WsBotDiskPartitionKey, number>> = {};
  for (const key of WS_BOT_DISK_PARTITION_KEYS) {
    const parsed = parseWsBotDiskPartitionValue(env[WS_BOT_DISK_PARTITION_ENV_KEYS[key]]);
    if (parsed !== null) envValues[key] = parsed;
  }
  for (const key of WS_BOT_DISK_PARTITION_KEYS) {
    const candidate = envValues[key];
    if (candidate === null || candidate === undefined) continue;
    const next = { ...resolved, [key]: candidate };
    if (next.partitionThresholdPercent < next.partitionRefuseOpenPercent
      && next.partitionRefuseOpenPercent < next.partitionCriticalPercent) {
      resolved[key] = candidate;
      sources[key] = "env";
    }
  }
  return { settings: resolved, sources };
}

/** A patch over the effective values, the shape that gets stored (merged with the other `botDisk` keys by the service). */
export function mergeWsBotDiskPartitionSettings(
  base: WsBotDiskPartitionSettings,
  patch: WsBotDiskPartitionSettingsPatch,
): WsBotDiskPartitionSettings {
  const next = {
    partitionThresholdPercent:
      patch.partitionThresholdPercent === undefined
        ? base.partitionThresholdPercent
        : patch.partitionThresholdPercent,
    partitionRefuseOpenPercent:
      patch.partitionRefuseOpenPercent === undefined
        ? base.partitionRefuseOpenPercent
        : patch.partitionRefuseOpenPercent,
    partitionCriticalPercent:
      patch.partitionCriticalPercent === undefined
        ? base.partitionCriticalPercent
        : patch.partitionCriticalPercent,
  };
  // The patch is validated by the route's zod schema; a caller that bypasses
  // it with an unordered triple gets the base back — never a stored row the
  // resolver would later ignore.
  return wsBotDiskPartitionSettingsSchema.safeParse(next).success ? next : base;
}

/**
 * Pressure level of the bot partition for the desired state (contract C3,
 * `pressure.level`): `none` below the refuse-open threshold, `hard` at or
 * above it (open refuses, grace 0). The soft level exists for the per-bot
 * quota pressure of other BOT-DISK-H parts; the partition alone never
 * produces `soft`.
 */
export function partitionPressureLevel(
  usedPercent: number,
  settings: WsBotDiskPartitionSettings,
): WsDiskPressureLevel {
  return usedPercent >= settings.partitionRefuseOpenPercent ? "hard" : "none";
}

/** The attention-card level of a measurement: below threshold — no card; at/above — warn; at/above critical — critical. */
export type WsBotDiskPartitionAlertLevel = "none" | "warn" | "critical";

export function partitionAlertLevel(
  usedPercent: number,
  settings: WsBotDiskPartitionSettings,
): WsBotDiskPartitionAlertLevel {
  if (usedPercent >= settings.partitionCriticalPercent) return "critical";
  if (usedPercent >= settings.partitionThresholdPercent) return "warn";
  return "none";
}

// The contract enum is imported and re-used, never re-declared — a drift
// between the card logic and `wsDesiredStateSchema` is a compile error here.
export { wsDiskPressureLevelSchema };
