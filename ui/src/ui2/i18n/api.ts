// myrmidon(UI2-I18N): language preference client for the 2.0 UI tree.
//
// Wire contract (matches server/src/myrmidon/ui2-language/routes.ts):
//   GET /api/myrmidon/ui2/language/me -> { language: "en" | "ru", updatedAt: Date | null,
//     telegramBridge?: { source: "user" } | { source: "environment", forcedLanguage: string } }
//   PUT /api/myrmidon/ui2/language/me { language } -> same shape
// The route is board-user scoped; an agent-key session gets 403 and the
// provider falls back to the local choice.
import { api } from "@/api/client";
import type { Ui2Language, Ui2LanguagePreference } from "@paperclipai/shared";

/**
 * myrmidon(1.7-TG-LOCALE): the SOURCE of the language the bridged Telegram DM
 * answers in — recomputed server-side on every read: "environment" while
 * MYRMIDON_TELEGRAM_DM_LANGUAGE forces one language instance-wide, "user"
 * when the person's own preference decides.
 */
export interface TelegramBridgeSourceWire {
  source: "user" | "environment";
  forcedLanguage?: Ui2Language;
}

export interface Ui2LanguagePreferenceWire {
  language: Ui2Language;
  updatedAt: string | null;
  telegramBridge?: TelegramBridgeSourceWire;
}

export const ui2LanguageApi = {
  get: () => api.get<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me"),
  put: (language: Ui2Language) =>
    api.put<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me", { language }),
};

export function fromWire(preference: Ui2LanguagePreferenceWire): Ui2LanguagePreference {
  return {
    language: preference.language,
    updatedAt: preference.updatedAt ? new Date(preference.updatedAt) : null,
  };
}
