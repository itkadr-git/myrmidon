// myrmidon(1.6-TG-NOTIFY): the shared JSON contract of the telegramNotify
// settings area. The umbrella task fixes this shape; part A owns the store,
// routes and changelog, part C (this file's `errors` block) consumes it.
//
// Contract notes (fixed by the task, do not rename fields):
//   settings.errors = { enabled, chatId, topicId, minSeverity, maxPerHour }
//   minSeverity: "error" | "warning" — the error channel's own threshold
//   vocabulary, mapped onto attention severities by the server module.
//   maxPerHour: a positive integer rate limit; over the limit, messages are
//   DROPPED, never queued. All defaults are OFF.

import { z } from "zod";

/** Severity threshold vocabulary of the errors channel. */
export const TELEGRAM_NOTIFY_SEVERITIES = ["error", "warning"] as const;
export type TelegramNotifySeverity = (typeof TELEGRAM_NOTIFY_SEVERITIES)[number];

export const DEFAULT_TELEGRAM_NOTIFY_ERRORS = {
  enabled: false,
  chatId: null,
  topicId: null,
  minSeverity: "error",
  maxPerHour: 10,
} as const;

export const TELEGRAM_NOTIFY_ERRORS_MAX_PER_HOUR_CEILING = 360;

const telegramNotifyChatTargetSchema = z.object({
  enabled: z.boolean(),
  chatId: z.string().min(1).max(64).nullable(),
  topicId: z.string().min(1).max(64).nullable(),
});

/** The `errors` area of the telegramNotify contract (part C's settings). */
export const telegramNotifyErrorsSchema = telegramNotifyChatTargetSchema
  .extend({
    minSeverity: z.enum(TELEGRAM_NOTIFY_SEVERITIES),
    maxPerHour: z.number().int().min(1).max(TELEGRAM_NOTIFY_ERRORS_MAX_PER_HOUR_CEILING),
  })
  .strict();

export type TelegramNotifyErrorsSettings = z.infer<typeof telegramNotifyErrorsSchema>;

/** PATCH subset of the errors area: absent keys keep their value. */
export const telegramNotifyErrorsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    chatId: z.string().min(1).max(64).nullable().optional(),
    topicId: z.string().min(1).max(64).nullable().optional(),
    minSeverity: z.enum(TELEGRAM_NOTIFY_SEVERITIES).optional(),
    maxPerHour: z.number().int().min(1).max(TELEGRAM_NOTIFY_ERRORS_MAX_PER_HOUR_CEILING).optional(),
  })
  .strict();

export type TelegramNotifyErrorsPatch = z.infer<typeof telegramNotifyErrorsPatchSchema>;

/** Parse a stored/raw value into the canonical errors area, filling safe defaults. */
export function parseTelegramNotifyErrors(raw: unknown): TelegramNotifyErrorsSettings {
  const parsed = telegramNotifyErrorsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Absent or invalid: the safe default — OFF. A hand-edited row never turns
  // the channel on by accident.
  return { ...DEFAULT_TELEGRAM_NOTIFY_ERRORS };
}
