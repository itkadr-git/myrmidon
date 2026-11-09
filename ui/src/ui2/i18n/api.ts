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
import type {
  LocaleValidationResult,
  StoredCustomLocale,
  StoredCustomLocaleSummary,
  Ui2Language,
  Ui2LanguagePreference,
  UploadLocaleResult,
} from "@myrmidon/shared";

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
  catalogs?: Partial<Record<Ui2Language, Record<string, unknown>>>;
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

// myrmidon(1.7 LOCALE-UPLOAD UI, OPE-12118): wire shape of GET /api/locale/current
// (mirrors CurrentLocaleResponse of the OPE-12117 server slice; the panel
// mocks it in component tests until that slice merges).
export interface LocaleCurrentWire {
  locale: string;
  version: number;
  checksum: string;
  uploadedAt: string;
  catalog: Record<string, unknown>;
  keyCount: number;
  active: boolean;
}

export const ui2LanguageApi = {
  get: () => api.get<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me"),
  put: (language: Ui2Language) =>
    api.put<Ui2LanguagePreferenceWire>("/myrmidon/ui2/language/me", { language }),
  putCatalog: (language: Ui2Language, catalog: Record<string, unknown>) =>
    api.put<{ catalogs: Partial<Record<Ui2Language, Record<string, unknown>>> }>("/myrmidon/ui2/language/me/catalog", { language, catalog }),
};

export const bridgeLanguageApi = {
  get: () => api.get<BridgeLanguageWire>("/myrmidon/bridge-language"),
  patch: (language: Ui2Language) =>
    api.patch<BridgeLanguageWire>("/myrmidon/bridge-language", { language }),
};

// myrmidon(1.7 LOCALE-UPLOAD, OPE-10187, OPE-9646): client API for catalog validation and upload
export const localeUploadApi = {
  validate: (payload: {
    locale: string;
    catalog?: Record<string, unknown>;
    content?: string;
    strict?: boolean;
  }) => api.post<LocaleValidationResult>("/myrmidon/locales/validate", payload),
  // myrmidon(1.7 LOCALE-UPLOAD UI, OPE-12118): canonical upload route
  // (POST /api/locale/upload) per the objective; the legacy aliases
  // /myrmidon/locales/upload and /myrmidon/locale-upload stay on the server.
  upload: (payload: {
    locale: string;
    catalog?: Record<string, unknown>;
    content?: string;
    dryRun?: boolean;
    strict?: boolean;
  }) => api.post<UploadLocaleResult>("/locale/upload", payload),
  listCustom: () =>
    api.get<{ locales: StoredCustomLocaleSummary[]; total: number }>("/myrmidon/locales/custom"),
  getCustom: (locale: string) =>
    api.get<StoredCustomLocale>(`/myrmidon/locales/custom/${locale}`),
  deleteCustom: (locale: string) =>
    api.delete<{ deleted: boolean; locale: string }>(`/myrmidon/locales/custom/${locale}`),
  // myrmidon(1.7 LOCALE-UPLOAD UI, OPE-12118): versions list and the active
  // custom locale. The slice contract (OPE-12146-class) is mocked in the
  // component tests until the server slice lands.
  listVersions: () =>
    api.get<{ locales: StoredCustomLocaleSummary[]; total: number; activeLocale: string | null }>(
      "/locale/versions",
    ),
  current: () => api.get<LocaleCurrentWire>("/locale/current"),
  // Activation rides the same /api/locale/current resource; the component
  // applies the returned catalog live via applyCustomCatalog.
  activate: (locale: string) =>
    api.post<LocaleCurrentWire>("/locale/current", { locale }),
};

export function fromWire(preference: Ui2LanguagePreferenceWire): Ui2LanguagePreference {
  return {
    language: preference.language,
    updatedAt: preference.updatedAt ? new Date(preference.updatedAt) : null,
  };
}
