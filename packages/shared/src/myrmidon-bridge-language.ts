// myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default language of the
// bridged Telegram DM (OPE-6318 part C).
//
// Until now a board user with no stored `user_ui_language` row got English
// bridge texts (commands, statuses, refusals), even on an instance whose whole
// team works in Russian. This contract adds ONE instance-level language the
// bridge falls back to, stored in `instance_settings.general.bridgeLanguage`
// and changed from Settings → Language without a restart.
//
// Decision order for one person's bridge replies (highest first):
//  1. `MYRMIDON_TELEGRAM_DM_LANGUAGE` env force — wins over everything;
//  2. the person's own board preference (`user_ui_language`);
//  3. the instance setting below;
//  4. English — the product default.
// The instance-level Telegram command menu has no person to follow, so it uses
// the same list minus step 2 (env → instance → default).
//
// The environment variable stays a forced override so a deployment can pin the
// language of the whole instance regardless of any UI value.
import { z } from "zod";
import { UI2_LANGUAGES, ui2LanguageSchema, type Ui2Language } from "./myrmidon-ui2-i18n.js";

/** The stored key inside `instance_settings.general`. */
export const BRIDGE_LANGUAGE_SETTINGS_KEY = "bridgeLanguage";

/** Forced instance-wide override of every bridged DM text (en|ru). */
export const BRIDGE_LANGUAGE_ENV = "MYRMIDON_TELEGRAM_DM_LANGUAGE";

/** The languages the bridge ships catalogs for; English is the base. */
export const BRIDGE_LANGUAGES = UI2_LANGUAGES;
export type BridgeLanguage = Ui2Language;

/** English — the fork default when nothing else names a language. */
export const DEFAULT_BRIDGE_LANGUAGE: BridgeLanguage = "en";

export const bridgeLanguageSchema = ui2LanguageSchema;

/** The canonical stored shape of `general.bridgeLanguage`. Lenient: a row with
 * unknown keys or an invalid value still parses (the resolver then ignores it). */
export const bridgeLanguageSettingsSchema = z.object({
  language: ui2LanguageSchema.optional(),
});

export type BridgeLanguageSettings = z.infer<typeof bridgeLanguageSettingsSchema>;

/** Body of `PATCH /api/myrmidon/bridge-language`. */
export const patchBridgeLanguageSchema = z
  .object({
    language: ui2LanguageSchema,
  })
  .strict();

export type PatchBridgeLanguage = z.infer<typeof patchBridgeLanguageSchema>;

export function isBridgeLanguage(value: unknown): value is BridgeLanguage {
  return typeof value === "string" && (UI2_LANGUAGES as readonly string[]).includes(value);
}

/** The stored instance language, or null when the row never saved a valid one. */
export function readStoredBridgeLanguage(raw: unknown): BridgeLanguage | null {
  const parsed = bridgeLanguageSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) return null;
  return parsed.data.language ?? null;
}

/**
 * The host environment, read without naming `process`: this module reaches every
 * consumer of the shared package, including browser-ish builds whose tsconfig
 * carries no node type definitions.
 */
function ambientEnv(): Record<string, string | undefined> {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env ?? {};
}

/** The forced env language, or null when the variable is unset or unknown. */
export function forcedBridgeLanguage(
  env: Record<string, string | undefined> = ambientEnv(),
): BridgeLanguage | null {
  const raw = env[BRIDGE_LANGUAGE_ENV]?.trim().toLowerCase();
  return isBridgeLanguage(raw) ? raw : null;
}

/** Where the effective instance-level language came from. */
export type BridgeLanguageSource = "environment" | "instance" | "default";

export interface ResolvedBridgeLanguage {
  language: BridgeLanguage;
  source: BridgeLanguageSource;
  /** The env force in play (null when unset). */
  forced: BridgeLanguage | null;
  /** The stored instance value (null when never saved). */
  stored: BridgeLanguage | null;
}

/**
 * Resolve the instance-level bridge language (env force → stored instance
 * setting → English). The per-person preference is applied by the server on
 * top of this, between the force and the instance value.
 */
export function resolveBridgeLanguage(input: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedBridgeLanguage {
  const forced = forcedBridgeLanguage(input.env ?? ambientEnv());
  const stored = readStoredBridgeLanguage(input.stored);
  if (forced) return { language: forced, source: "environment", forced, stored };
  if (stored) return { language: stored, source: "instance", forced: null, stored };
  return { language: DEFAULT_BRIDGE_LANGUAGE, source: "default", forced: null, stored: null };
}

/** Merge a patch over the stored instance setting (the stored shape). */
export function mergeBridgeLanguageSettings(
  current: unknown,
  patch: PatchBridgeLanguage,
): BridgeLanguageSettings {
  const stored = bridgeLanguageSettingsSchema.safeParse(current ?? {});
  return {
    ...(stored.success ? stored.data : {}),
    language: patch.language,
  };
}