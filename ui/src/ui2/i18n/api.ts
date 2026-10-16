// myrmidon(UI2-I18N): language preference client for the 2.0 UI tree.
//
// Wire contract (matches server/src/myrmidon/ui2-language/routes.ts):
//   GET /api/myrmidon/ui2/language/me -> { language: "en" | "ru", updatedAt: Date | null,
//     telegramBridge?: { source: "user" | "instance" | "default" }
//                     | { source: "environment", forcedLanguage: "en" | "ru" } }
//   PUT /api/myrmidon/ui2/language/me { language } -> same shape
// The route is board-user scoped; an agent-key session gets 403 and the
// provider falls back to the local choice.
//
// myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default the screen can change
// lives behind its own route (GET/PATCH /api/myrmidon/bridge-language); reading
// it is open to the board, changing it is instance-admin only.
import { api } from "@/api/client";
import type { Ui2Language, Ui2LanguagePreference } from "@paperclipai/shared";

/**
 * myrmidon(1.7-TG-LOCALE): the SOURCE of the language the bridged Telegram DM
 * answers in — recomputed server-side on every read: "environment" while
 * MYRMIDON_TELEGRAM_DM_LANGUAGE forces one language instance-wide, "user" when
 * the person's own preference decides; myrmidon(1.6.5-TG-LOCALE-C) adds
 * "instance" (the stored instance setting is the fallback) and "default"
 * (nothing decided, English).
 */
export interface TelegramBridgeSourceWire {
  source: "user" | "environment" | "instance" | "default";
  /** The language the bridge actually answers in. */
  language?: Ui2Language;
  forcedLanguage?: Ui2Language;
  instanceLanguage?: Ui2Language;
}

export interface Ui2LanguagePreferenceWire {
  language: Ui2Language;
  updatedAt: string | null;
  telegramBridge?: TelegramBridgeSourceWire;
}

/**
 * myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default language of the
 * bridged Telegram DM as the server applies it (env force → stored setting →
 * English) — the same resolution the chats use.
 */
export interface BridgeLanguageWire {
  language: Ui2Language;
  source: "environment" | "instance" | "default";
  forced: Ui2Language | null;
  stored: Ui2Language | null;
}

export const ui2LanguageApi = {
  get: () => api.get<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me"),
  put: (language: Ui2Language) =>
    api.put<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me", { language }),
};

export const bridgeLanguageApi = {
  get: () => api.get<BridgeLanguageWire>("/myrmidon/bridge-language"),
  patch: (language: Ui2Language) =>
    api.patch<BridgeLanguageWire>("/myrmidon/bridge-language", { language }),
};

export function fromWire(preference: Ui2LanguagePreferenceWire): Ui2LanguagePreference {
  return {
    language: preference.language,
    updatedAt: preference.updatedAt ? new Date(preference.updatedAt) : null,
  };
}
