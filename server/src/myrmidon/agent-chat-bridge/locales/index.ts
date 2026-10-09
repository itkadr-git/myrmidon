// myrmidon(1.7-TG-LOCALE): the language of every service text the bridged
// Telegram DM produces (commands, statuses, refusals, notices).
//
// Selection, highest first:
//  1. `MYRMIDON_TELEGRAM_DM_LANGUAGE` env — a forced override for the whole
//     instance (`en` or `ru`); anything else is ignored;
//  2. the linked board user's UI language preference (the `user_ui_language`
//     row the board's Settings → Language screen writes);
//  3. myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default language set on
//     that same screen (`instance_settings.general.bridgeLanguage`) — the
//     fallback for a board user who never chose one;
//  4. English — the fork default.
// The user's preference and the instance setting are read per message, so
// changing either in the interface takes effect on the very next reply without
// a restart. An unlinked Telegram account has no board user and gets the
// instance setting (subject to the env force).
//
// The catalogs (./en.ts, ./ru.ts) are the only place human-readable bridge
// prose lives; a ratchet test forbids Russian literals anywhere else in the
// bridge. Identifiers, command names, model ids and reasoning levels are
// input, not prose, and never enter the catalogs.
import { eq } from "drizzle-orm";
import { instanceSettings, userUiLanguage, type Db } from "@paperclipai/db";
import { BRIDGE_LANGUAGE_SETTINGS_KEY, readStoredBridgeLanguage } from "@paperclipai/shared";
import { bridgeTextEn, type BridgeTextKey } from "./en.js";
import { bridgeTextRu } from "./ru.js";

export const BRIDGE_LOCALE_LANGUAGES_ENV = "MYRMIDON_TELEGRAM_DM_LANGUAGE";

export type BridgeLocale = "en" | "ru";

/** The product default when neither the env force nor a user preference names a language. */
export const DEFAULT_BRIDGE_LOCALE: BridgeLocale = "en";

const CATALOGS: Record<BridgeLocale, Record<BridgeTextKey, string>> = {
  en: bridgeTextEn,
  ru: bridgeTextRu,
};

export function isBridgeLocale(value: unknown): value is BridgeLocale {
  return value === "en" || value === "ru";
}

/** The instance-wide forced locale, or null when the env var is unset or not a known language. */
export function forcedBridgeLocale(
  env: NodeJS.ProcessEnv = process.env,
): BridgeLocale | null {
  const raw = env[BRIDGE_LOCALE_LANGUAGES_ENV]?.trim().toLowerCase();
  return isBridgeLocale(raw) ? raw : null;
}

/** The instance-level locale for the bridged DM's Telegram command menu:
 * myrmidon(1.7-TG-LOCALE) — the env force, else the English default.
 * myrmidon(1.6.5-TG-LOCALE-C): the stored instance language now sits between
 * the two. Telegram shows one private-chat menu per bot, so it cannot follow
 * each user's board preference; per-message replies do. */
export async function telegramDmMenuLocale(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BridgeLocale> {
  const forced = forcedBridgeLocale(env);
  if (forced) return forced;
  return (await instanceBridgeLocale(db)) ?? DEFAULT_BRIDGE_LOCALE;
}

/** The stored UI language preference of a board user, or null when the user never set one. */
export async function userBridgeLocale(db: Db, userId: string): Promise<BridgeLocale | null> {
  const [row] = await db
    .select({ language: userUiLanguage.language })
    .from(userUiLanguage)
    .where(eq(userUiLanguage.userId, userId))
    .limit(1);
  return isBridgeLocale(row?.language) ? row.language : null;
}

/**
 * myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default language of the
 * bridged DM (`instance_settings.general.bridgeLanguage`), or null when the
 * instance never set one. Read directly from the settings row — the reader
 * must not depend on the instance settings service (services/instance-settings
 * imports this module's locale-free sibling), and a missing row is simply
 * "not set".
 */
export async function instanceBridgeLocale(db: Db): Promise<BridgeLocale | null> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .limit(1);
  const general = row?.general;
  if (typeof general !== "object" || general === null) return null;
  return readStoredBridgeLanguage((general as Record<string, unknown>)[BRIDGE_LANGUAGE_SETTINGS_KEY]);
}

/** Where the language of one person's bridge texts came from. */
export type BridgeLocaleSource = "environment" | "user" | "instance" | "default";

export interface BridgeLocaleDecision {
  locale: BridgeLocale;
  source: BridgeLocaleSource;
  /** The env force in play, or null. */
  forcedLanguage: BridgeLocale | null;
}

/**
 * The locale of one person's bridge texts AND where it came from: env force
 * first, then their board preference, then the instance setting, then English.
 */
export async function resolveBridgeLocaleDecision(
  db: Db,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BridgeLocaleDecision> {
  const forced = forcedBridgeLocale(env);
  if (forced) {
    return { locale: forced, source: "environment", forcedLanguage: forced };
  }
  const user = await userBridgeLocale(db, userId);
  if (user) return { locale: user, source: "user", forcedLanguage: null };
  const instance = await instanceBridgeLocale(db);
  if (instance) return { locale: instance, source: "instance", forcedLanguage: null };
  return { locale: DEFAULT_BRIDGE_LOCALE, source: "default", forcedLanguage: null };
}

/**
 * The locale of one person's bridge texts: env force first, then their board
 * preference, then the instance-wide default, then English.
 */
export async function resolveBridgeLocale(
  db: Db,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BridgeLocale> {
  return (await resolveBridgeLocaleDecision(db, userId, env)).locale;
}

/** Substitutes {placeholder} tokens from `params` into a catalog template. */
export function formatBridgeText(
  template: string,
  params: Record<string, string | number> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** The localized bridge string for `key`, with placeholders filled. */
export function t(
  locale: BridgeLocale,
  key: BridgeTextKey,
  params?: Record<string, string | number>,
): string {
  const template = CATALOGS[locale][key];
  return params ? formatBridgeText(template, params) : template;
}

/** The text-locale catalogs, exported for the parity test. */
export const BRIDGE_TEXT_CATALOGS = CATALOGS;
export type { BridgeTextKey };
