// myrmidon(1.6.1-BOT-DISK-C): per-bot disk quota — settings, resolution and the
// rejection contract shared by the server, the board UI and the settings validator.
//
// Each bot's host-side volume (`MYRMIDON_BOT_VOLUME_ROOT/<botKey>`, botKey = the
// agent id) gets a size quota. The quota is a company-wide default with
// per-caste and per-agent overrides; `null` means "no quota" (enforcement off
// for that scope). When a bot is at or over 80% of its quota the sweep records
// an attention signal; when it is OVER the quota, creating a NEW execution
// worktree for that bot is refused before the directory is created, with the
// stable error code `BOT_DISK_QUOTA_EXCEEDED` in the message.
//
// The settings live in `instance_settings.general.botDiskQuota` (its own key,
// not a sub-key of part A's `general.botDisk`: part A's PATCH rewrites the whole
// `botDisk` object from its own merged settings, so a nested key would be lost
// on the next lifecycle change — first-merge-wins). A PATCH takes effect at the
// next sweep/admission check without a restart.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const BOT_DISK_QUOTA_SETTINGS_KEY = "botDiskQuota";

/** The stable rejection code an over-quota bot sees when a new clone is refused. */
export const BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE = "BOT_DISK_QUOTA_EXCEEDED";

const quotaMbSchema = z.number().int().min(1).max(100 * 1024 * 1024); // up to 100 TB

export const botDiskQuotaSettingsSchema = z
  .object({
    /** Company-wide default quota in MB; null = no quota (feature silent). */
    defaultQuotaMb: quotaMbSchema.nullable(),
    /** Per-caste (`agents.role`) overrides. */
    perCaste: z
      .array(z.object({ casteKey: z.string().min(1).max(120), quotaMb: quotaMbSchema }))
      .max(200)
      .default([]),
    /** Per-agent overrides (agent id); wins over the caste entry. */
    perAgent: z
      .array(z.object({ agentKey: z.string().uuid(), quotaMb: quotaMbSchema }))
      .max(2000)
      .default([]),
  })
  .strict();

export type BotDiskQuotaSettings = z.infer<typeof botDiskQuotaSettingsSchema>;

/** The lenient stored view of the general-settings row: partial and fail-open. */
export type StoredBotDiskQuotaSettings = z.infer<typeof storedBotDiskQuotaSettingsSchema>;

export const patchBotDiskQuotaSettingsSchema = botDiskQuotaSettingsSchema.partial();
export type BotDiskQuotaSettingsPatch = z.infer<typeof patchBotDiskQuotaSettingsSchema>;

/** A lenient view of the stored row: an unreadable object reads as "no quota". */
export const storedBotDiskQuotaSettingsSchema = botDiskQuotaSettingsSchema
  .partial()
  .optional()
  .catch(undefined);

/** The stored settings, or the implicit default (quotas off) when absent/corrupt. */
export function normalizeBotDiskQuotaSettings(raw: unknown): BotDiskQuotaSettings {
  const parsed = botDiskQuotaSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // A hand-edited row cannot half-apply: an unreadable object is the no-quota
  // default, so the feature never signals or rejects off corrupt data.
  return { defaultQuotaMb: null, perCaste: [], perAgent: [] };
}

/**
 * The effective quota of one bot, in MB, or null when the bot has no quota:
 * the per-agent entry when present, else the first matching per-caste entry,
 * else the company default.
 */
export function resolveBotDiskQuotaMb(
  settings: Pick<BotDiskQuotaSettings, "defaultQuotaMb" | "perCaste" | "perAgent">,
  agentId: string,
  casteKey: string | null | undefined,
): number | null {
  const agentEntry = settings.perAgent.find((entry) => entry.agentKey === agentId);
  if (agentEntry) return agentEntry.quotaMb;
  if (casteKey) {
    const casteEntry = settings.perCaste.find((entry) => entry.casteKey === casteKey);
    if (casteEntry) return casteEntry.quotaMb;
  }
  return settings.defaultQuotaMb;
}

/** The share of the quota from which the approaching signal is raised. */
export const BOT_DISK_QUOTA_APPROACHING_RATIO = 0.8;

/** True when `usageBytes` is at or over the approaching threshold of `quotaMb`. */
export function isBotApproachingQuota(usageBytes: number, quotaMb: number | null): boolean {
  if (quotaMb === null || quotaMb <= 0) return false;
  return usageBytes >= quotaMb * 1024 * 1024 * BOT_DISK_QUOTA_APPROACHING_RATIO;
}

/** True when `usageBytes` is over `quotaMb` (the rejection state). */
export function isBotOverQuota(usageBytes: number, quotaMb: number | null): boolean {
  if (quotaMb === null || quotaMb <= 0) return false;
  return usageBytes > quotaMb * 1024 * 1024;
}

/** The attention signal one over-threshold bot contributes to the feed. */
export interface BotDiskQuotaSignal {
  agentId: string;
  /** Stable per agent; the feed dedupes and dismisses on it. */
  dedupKey: string;
  overQuota: boolean;
  usageBytes: number;
  quotaMb: number;
  observedAtMs: number;
  /**
   * 1.6.5-BOT-DISK-H9c: `estimate` when the usage is the du walk (quotas are off
   * on the bot partition, or dockergate did not answer), absent/`physical` when
   * it is the xfs project figure.
   */
  usageSource?: "physical" | "estimate";
}

export function botDiskQuotaDedupKey(agentId: string): string {
  return `bot_disk_quota:${agentId}`;
}

/** The operator-facing sentence for one signal. */
export function botDiskQuotaWhyNow(
  signal: Pick<BotDiskQuotaSignal, "overQuota" | "usageBytes" | "quotaMb"> & Partial<Pick<BotDiskQuotaSignal, "usageSource">>,
): string {
  const usageMb = Math.round(signal.usageBytes / (1024 * 1024));
  const note = signal.usageSource === "estimate" ? " (estimate: the disk quota is not enforced on the partition)" : "";
  return signal.overQuota
    ? `Bot disk quota exceeded: ${usageMb} MB of ${signal.quotaMb} MB used${note}. New clones are refused until the bot volume shrinks.`
    : `Bot disk quota almost full: ${usageMb} MB of ${signal.quotaMb} MB used${note}.`;
}

/**
 * The message of the rejection the agent itself sees when a new worktree is
 * refused. The stable code first: an agent parses it, the sentence explains it.
 */
export function botDiskQuotaRejectionMessage(input: {
  agentName: string;
  usageBytes: number;
  quotaMb: number;
}): string {
  const usageMb = Math.round(input.usageBytes / (1024 * 1024));
  return (
    `${BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE}: ${input.agentName} has used ${usageMb} MB of its ${input.quotaMb} MB disk quota, ` +
    `so a new workspace clone is refused. Remove unneeded worktrees, build outputs and caches under your volume, then retry.`
  );
}
