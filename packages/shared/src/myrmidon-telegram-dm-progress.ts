import { z } from "zod";

/**
 * Live progress steps in the bridged Telegram DM status message
 * (myrmidon DM-PROGRESS).
 *
 * While a run works, the single editable status message in the bridged
 * Telegram DM shows what the agent is doing right now — "читаю презентацию",
 * "правлю слайды 4, 9", "проверяю результат" — and the last few finished
 * steps, instead of only "queued" / "working" / the final answer. Two knobs,
 * stored in `instance_settings.general.telegramDmProgress` and changed from
 * Instance → General without a restart:
 *
 * - `enabled` — show live steps in the status message. Turning it on also
 *   turns the status message itself on for bridged DMs (the steps have no
 *   other place to live).
 * - `intervalSec` — the minimum spacing between two progress edits of the
 *   same message (15–300 s, default 45). A change of the step KIND (reading →
 *   editing → checking) may edit sooner, but never more often than every
 *   few seconds.
 *
 * Precedence per field: the environment variable is a forced override
 * (`MYRMIDON_TELEGRAM_DM_PROGRESS`, `MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC`),
 * then the stored settings value, then the built-in default. The default of
 * `enabled` follows `MYRMIDON_TELEGRAM_DM_STATUS`: an instance that already
 * turned the status message on keeps getting steps in it without saving
 * anything, and an instance that never did keeps the vendor silence.
 */

/** Forced on/off override of the live steps. */
export const TELEGRAM_DM_PROGRESS_ENV = "MYRMIDON_TELEGRAM_DM_PROGRESS";
/** Forced override of the minimum spacing between progress edits, seconds. */
export const TELEGRAM_DM_PROGRESS_INTERVAL_ENV = "MYRMIDON_TELEGRAM_DM_PROGRESS_INTERVAL_SEC";
/** The existing status-message switch the `enabled` default follows. */
export const TELEGRAM_DM_PROGRESS_STATUS_ENV = "MYRMIDON_TELEGRAM_DM_STATUS";

/** The stored key inside `instance_settings.general`. */
export const TELEGRAM_DM_PROGRESS_SETTINGS_KEY = "telegramDmProgress";

export const TELEGRAM_DM_PROGRESS_DEFAULT_INTERVAL_SEC = 45;
export const TELEGRAM_DM_PROGRESS_MIN_INTERVAL_SEC = 15;
export const TELEGRAM_DM_PROGRESS_MAX_INTERVAL_SEC = 300;

const intervalSecSchema = z
  .number()
  .int()
  .min(TELEGRAM_DM_PROGRESS_MIN_INTERVAL_SEC)
  .max(TELEGRAM_DM_PROGRESS_MAX_INTERVAL_SEC);

/** The canonical stored shape of `general.telegramDmProgress`. */
export const telegramDmProgressSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalSec: intervalSecSchema.optional(),
  })
  .strict();

export type TelegramDmProgressSettings = z.infer<typeof telegramDmProgressSettingsSchema>;

/** Body of `PATCH /api/myrmidon/telegram-dm-progress`. */
export const patchTelegramDmProgressSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalSec: intervalSecSchema.optional(),
  })
  .strict();

export type TelegramDmProgressPatch = z.infer<typeof patchTelegramDmProgressSchema>;

/** Where an effective value came from. */
export type TelegramDmProgressSource = "settings" | "env" | "default";

export interface ResolvedTelegramDmProgress {
  enabled: boolean;
  enabledSource: TelegramDmProgressSource;
  intervalSec: number;
  intervalSource: TelegramDmProgressSource;
}

/** An on/off environment value; anything unreadable reads as unset (null). */
export function parseTelegramDmProgressFlag(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return null;
}

/**
 * An interval environment value in seconds, clamped into the allowed bounds;
 * a blank or non-integer value reads as unset (null).
 */
export function parseTelegramDmProgressInterval(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(
    TELEGRAM_DM_PROGRESS_MAX_INTERVAL_SEC,
    Math.max(TELEGRAM_DM_PROGRESS_MIN_INTERVAL_SEC, parsed),
  );
}

/** The stored settings value, or null when the row holds nothing usable. */
export function normalizeTelegramDmProgressSettings(raw: unknown): TelegramDmProgressSettings | null {
  const parsed = telegramDmProgressSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Effective settings and where each value came from. */
export function resolveTelegramDmProgress(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedTelegramDmProgress {
  const env = options.env ?? {};
  const stored = normalizeTelegramDmProgressSettings(options.stored);

  let enabled: boolean;
  let enabledSource: TelegramDmProgressSource;
  const enabledFromEnv = parseTelegramDmProgressFlag(env[TELEGRAM_DM_PROGRESS_ENV]);
  if (enabledFromEnv !== null) {
    enabled = enabledFromEnv;
    enabledSource = "env";
  } else if (stored?.enabled !== undefined) {
    enabled = stored.enabled;
    enabledSource = "settings";
  } else {
    enabled = parseTelegramDmProgressFlag(env[TELEGRAM_DM_PROGRESS_STATUS_ENV]) === true;
    enabledSource = "default";
  }

  let intervalSec: number;
  let intervalSource: TelegramDmProgressSource;
  const intervalFromEnv = parseTelegramDmProgressInterval(env[TELEGRAM_DM_PROGRESS_INTERVAL_ENV]);
  if (intervalFromEnv !== null) {
    intervalSec = intervalFromEnv;
    intervalSource = "env";
  } else if (stored?.intervalSec !== undefined) {
    intervalSec = stored.intervalSec;
    intervalSource = "settings";
  } else {
    intervalSec = TELEGRAM_DM_PROGRESS_DEFAULT_INTERVAL_SEC;
    intervalSource = "default";
  }

  return { enabled, enabledSource, intervalSec, intervalSource };
}

/** Merge a patch over the stored value; only the given fields change. */
export function mergeTelegramDmProgressSettings(
  stored: unknown,
  patch: TelegramDmProgressPatch,
): TelegramDmProgressSettings {
  const current = normalizeTelegramDmProgressSettings(stored) ?? {};
  return {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.intervalSec !== undefined ? { intervalSec: patch.intervalSec } : {}),
  };
}
