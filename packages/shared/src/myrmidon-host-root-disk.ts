import { z } from "zod";

/**
 * Root-filesystem signal of the board host (myrmidon 1.6.8 OPE-12697,
 * DISK-ALERT).
 *
 * On 10.11.2026 the root filesystem of the board host (`vm-core`, `/`) filled
 * to 96 % (261 of 286 GB) and nothing signalled: the only disk watch was the
 * host-side script of the bot partition, and the `host_disk_alert` card
 * measures the server's own data volume and the bot partition — not the root
 * the docker daemon, its images and volumes, and the workspace checkouts
 * live on.
 *
 * This module owns the missing signal. dockergate (route A14,
 * `GET /myrmidon/disk`, contract C5) reports the root's statfs alongside the
 * bot partition (`root` field, read-only); the host-disk sweep feeds every
 * measurement into a threshold runtime that mirrors the bot-partition
 * mechanism (contract C7-style thresholds, the same card in the attention
 * feed, the same owner Telegram channel):
 *
 * - `rootThresholdPercent` (default 85) — the warning level: the
 *   `host_disk_alert` card appears with the fill level and the consumers the
 *   board can name (docker volumes, images, workspace checkouts).
 * - `rootCriticalPercent` (default 90) — the card goes critical (high-level
 *   alarm) and the owner gets a message through the existing Telegram
 *   outbox.
 *
 * Dedup contract: a signal repeats at most once per hour per level — the
 * runtime holds a per-level latch and re-arms only after the usage drops
 * below the warn threshold. The card itself follows the feed's dedup key
 * (refresh, not a new row).
 *
 * Thresholds live in `instance_settings.general.botDisk` next to the
 * bot-partition keys (contract C7 passthrough schema). Invariant:
 * `rootThresholdPercent` < `rootCriticalPercent` (85 < 90 by default). A
 * stored row that breaks the ordering loses only the root keys (the
 * bot-partition keys of other parts stay valid — this slice normalizes
 * separately from `wsBotDiskPartitionSettingsSchema`).
 */

/** Environment variables — first-start defaults of the two thresholds. */
export const WS_ROOT_DISK_ENV_KEYS = {
  rootThresholdPercent: "MYRMIDON_ROOT_DISK_THRESHOLD_PERCENT",
  rootCriticalPercent: "MYRMIDON_ROOT_DISK_CRITICAL_PERCENT",
} as const;

export const WS_ROOT_DISK_KEYS = ["rootThresholdPercent", "rootCriticalPercent"] as const;

export type WsRootDiskKey = (typeof WS_ROOT_DISK_KEYS)[number];

/** Where an effective threshold came from: stored settings, the environment, or the default. */
export type WsRootDiskSource = "settings" | "env" | "default";

/** A threshold is a whole percent between 50 and 99 (99 because 100 would never help). */
const rootPercentSchema = z.number().int().min(50).max(99);

/** The canonical stored shape of the OPE-12697 slice of `general.botDisk`. */
export const wsRootDiskSettingsSchema = z
  .object({
    rootThresholdPercent: rootPercentSchema,
    rootCriticalPercent: rootPercentSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rootThresholdPercent >= value.rootCriticalPercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rootThresholdPercent < rootCriticalPercent is required",
      });
    }
  });

/** Body of `PATCH /api/myrmidon/host-disk/root`. */
export const patchWsRootDiskSettingsSchema = z
  .object({
    rootThresholdPercent: rootPercentSchema.optional(),
    rootCriticalPercent: rootPercentSchema.optional(),
  })
  .strict();

export type WsRootDiskSettings = z.infer<typeof wsRootDiskSettingsSchema>;
export type WsRootDiskSettingsPatch = z.infer<typeof patchWsRootDiskSettingsSchema>;

/** Defaults: warn >85, alarm >90 (the OPE-12697 acceptance numbers). */
export const WS_ROOT_DISK_DEFAULTS: WsRootDiskSettings = {
  rootThresholdPercent: 85,
  rootCriticalPercent: 90,
};

export interface ResolvedWsRootDiskSettings {
  settings: WsRootDiskSettings;
  sources: Record<WsRootDiskKey, WsRootDiskSource>;
}

/** An environment value as a threshold; a non-integer or out-of-range value is ignored. */
export function parseWsRootDiskValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  const parsed = rootPercentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored OPE-12697 slice of `general.botDisk`, or null when the row holds
 * nothing usable for the root keys (missing keys, out-of-range values, or a
 * broken ordering). The contract schema is passthrough: extra keys of other
 * parts are ignored here, not rejected — a stored row that mixes valid
 * bot-partition keys with invalid root keys yields null only for the root
 * slice, never invalidates the whole row.
 */
export function normalizeWsRootDiskSettings(raw: unknown): WsRootDiskSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const slice = {
    rootThresholdPercent: (raw as Record<string, unknown>).rootThresholdPercent,
    rootCriticalPercent: (raw as Record<string, unknown>).rootCriticalPercent,
  };
  const parsed = wsRootDiskSettingsSchema.safeParse(slice);
  return parsed.success ? parsed.data : null;
}

/**
 * Effective thresholds: stored settings win, then the environment (first
 * start), then the built-in defaults. Resolution is per key, the same shape
 * `resolveWsBotDiskPartitionSettings` returns: the stored row is consulted
 * only as a whole valid slice — an invalid slice never produces a half
 * applied row.
 */
export function resolveWsRootDiskSettings(args: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedWsRootDiskSettings {
  const fromStored = normalizeWsRootDiskSettings(args.stored);
  const env = args.env ?? {};
  const settings: WsRootDiskSettings = { ...WS_ROOT_DISK_DEFAULTS };
  const sources: Record<WsRootDiskKey, WsRootDiskSource> = {
    rootThresholdPercent: "default",
    rootCriticalPercent: "default",
  };
  if (fromStored) {
    return {
      settings: { ...fromStored },
      sources: {
        rootThresholdPercent: "settings",
        rootCriticalPercent: "settings",
      },
    };
  }
  const envWarn = parseWsRootDiskValue(env[WS_ROOT_DISK_ENV_KEYS.rootThresholdPercent]);
  const envCrit = parseWsRootDiskValue(env[WS_ROOT_DISK_ENV_KEYS.rootCriticalPercent]);
  if (envWarn !== null) {
    const candidate = { ...settings, rootThresholdPercent: envWarn };
    if (candidate.rootThresholdPercent < candidate.rootCriticalPercent) {
      settings.rootThresholdPercent = envWarn;
      sources.rootThresholdPercent = "env";
    }
  }
  if (envCrit !== null) {
    const candidate = { ...settings, rootCriticalPercent: envCrit };
    if (candidate.rootThresholdPercent < candidate.rootCriticalPercent) {
      settings.rootCriticalPercent = envCrit;
      sources.rootCriticalPercent = "env";
    }
  }
  return { settings, sources };
}

/** Alert level at a fill level: none/warn/critical at the exact boundaries. */
export function rootDiskAlertLevel(
  usedPercent: number,
  settings: WsRootDiskSettings,
): "none" | "warn" | "critical" {
  if (usedPercent > settings.rootCriticalPercent) return "critical";
  if (usedPercent > settings.rootThresholdPercent) return "warn";
  return "none";
}

/**
 * The root statfs of the A14 answer (contract C5 field `root`): the same
 * shape as the bot partition, plus nothing. Optional and nullable in the
 * answer schema — dockergate built before OPE-12697 answers without it, and
 * a root that cannot be statfs'ed stays absent instead of failing the bot
 * partition answer.
 */
export const wsRootDiskPartitionSchema = z.object({
  mount: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  usedPercent: z.number().min(0).max(100),
});
export type WsRootDiskPartition = z.infer<typeof wsRootDiskPartitionSchema>;
