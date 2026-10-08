// server/src/myrmidon/telegram-notify/errors-settings.ts
//
// myrmidon(1.6-TG-NOTIFY-C): the settings read path of the errors channel.
//
// The owner settings (part A) are stored as a company-keyed map under their
// own key of `instance_settings.general`; the shared contract parser fills
// every field, so an absent or corrupt row reads as the all-off defaults —
// the release criterion for 1.6.1. This module only reads: the settings
// routes of part A are the single writer.

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseTelegramNotifyDocument } from "@paperclipai/shared";
import type { ErrorChannelSettings } from "./errors.js";

/** instance_settings.general key of the owner settings (same key as the part A store). */
export const TELEGRAM_NOTIFY_SETTINGS_GENERAL_KEY = "myrmidonTelegramNotifySettings";

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

export async function readTelegramNotifyErrors(db: Runner, companyId: string): Promise<ErrorChannelSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const area = (row?.general as Record<string, unknown> | null | undefined)?.[TELEGRAM_NOTIFY_SETTINGS_GENERAL_KEY];
  const perCompany = typeof area === "object" && area !== null && !Array.isArray(area)
    ? (area as Record<string, unknown>)[companyId]
    : undefined;
  return parseTelegramNotifyDocument(perCompany).settings.errors;
}

/** The production settings source of the errors channel: one row read per company sweep. */
export function dbErrorChannelSettingsSource(db: Runner): {
  read(companyId: string): Promise<ErrorChannelSettings>;
} {
  return { read: (companyId: string) => readTelegramNotifyErrors(db, companyId) };
}
