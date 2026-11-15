// myrmidon(UI2-I18N): language provider for the 2.0 UI tree (ui/src/ui2).
//
// Owns the user's interface language end to end for the new tree.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as vendorI18n from "@/i18n";
import { UI2_LANGUAGES as SHARED_UI2_LANGUAGES, flattenCatalog, type Ui2Language } from "@myrmidon/shared";
// (the vendor instance is read through readVendorI18nInstance below, never by
// destructuring the namespace — see the comment on that helper)
import { ui2LanguageApi } from "./api";
import { en } from "./catalogs/en";
import { ru } from "./catalogs/ru";
import { mergeCatalog, type CatalogObject } from "./catalog-upload";
import { formatUi2Message, ui2Messages, type Ui2MessageKey } from "./locales";

// myrmidon(OPE-3986): the shared constant is snapshotted into a LOCAL binding
// before re-export. A direct `export { UI2_LANGUAGES }` of an imported binding
// makes the vitest module-runner namespace getter return `undefined` even
// though the binding is alive at eval time (LanguageSettingsPanel crashed at
// `UI2_LANGUAGES.map` in CI while `Object.keys` still listed the export). A
// locally-initialized const gets a getter over the module's own binding and
// keeps the same public value/type.
export const UI2_LANGUAGES: readonly Ui2Language[] = SHARED_UI2_LANGUAGES;
export type { Ui2Language };

/** The slice of the vendor i18next instance the ui2 shell touches. */
type Ui2VendorI18n = {
  language?: string;
  changeLanguage?: (language: string) => Promise<unknown> | void;
  hasResourceBundle?: (locale: string, namespace: string) => boolean;
  addResourceBundle?: (
    locale: string,
    namespace: string,
    resources: unknown,
    deep?: boolean,
    overwrite?: boolean,
  ) => unknown;
};

const UI2_LANGUAGE_STORAGE_KEY = "myrmidon:ui2:language";
const UI2_NAMESPACE = "ui2";

export function isUi2Language(value: unknown): value is Ui2Language {
  return typeof value === "string" && (UI2_LANGUAGES as readonly string[]).includes(value);
}

function readStoredLanguage(): Ui2Language | null {
  try {
    const stored = window.localStorage.getItem(UI2_LANGUAGE_STORAGE_KEY);
    if (isUi2Language(stored)) return stored;
  } catch {}
  return null;
}

function storeLanguage(language: Ui2Language): void {
  try {
    window.localStorage.setItem(UI2_LANGUAGE_STORAGE_KEY, language);
  } catch {}
}

export function ui2LanguageLabel(language: Ui2Language): string {
  return language === "ru" ? "Русский" : "English";
}

export const ui2Catalogs = { en, ru } as const;

/**
 * The vendor i18next instance from `@/i18n`, read WITHOUT property access on
 * the module namespace: a test's partial `vi.mock("@/i18n", ...)` exposes only
 * the exports it defines, and merely touching `.i18n` on such a namespace
 * throws "No "i18n" export is defined on the "@/i18n" mock" — the branch's
 * namespace access is what blanked the settings screens in CI. `Object.hasOwn`
 * answers "is the export present" without reading it, so a partial mock is a
 * safe null and the provider degrades to localStorage-only (as on main).
 */
export function readVendorI18nInstance(): Ui2VendorI18n | null {
  if (!vendorI18n || typeof vendorI18n !== "object") return null;
  return Object.hasOwn(vendorI18n, "i18n") && vendorI18n.i18n ? (vendorI18n.i18n as Ui2VendorI18n) : null;
}

export function registerUi2Catalogs(custom: Partial<Record<string, Record<string, unknown>>> = {}): void {
  const i18nInstance = readVendorI18nInstance();
  if (!i18nInstance) return;
  if (typeof i18nInstance.hasResourceBundle !== "function") return;
  for (const [locale, baseCatalog] of Object.entries(ui2Catalogs)) {
    const customBundle = custom[locale];
    const catalog = customBundle
      ? mergeCatalog(baseCatalog as unknown as CatalogObject, customBundle as CatalogObject)
      : baseCatalog;
    const client = i18nInstance as unknown as Record<string, unknown>;
    if (!customBundle && typeof client.hasResourceBundle === "function" && i18nInstance.hasResourceBundle(locale, UI2_NAMESPACE)) {
      // The catalogs are static per locale: registering again would REPLACE the
      // bundle and silently drop custom keys uploaded through the locale-upload
      // screen (OPE-9646 regression). Register once, then leave it alone.
      continue;
    }
    if (typeof client.addResourceBundle === "function") {
      i18nInstance.addResourceBundle?.(locale, UI2_NAMESPACE, catalog, true, true);
    }
  }
  for (const [locale, customBundle] of Object.entries(custom)) {
    if (locale in ui2Catalogs) continue;
    if (!customBundle) continue;
    const client = i18nInstance as unknown as Record<string, unknown>;
    if (typeof client.addResourceBundle === "function") {
      i18nInstance.addResourceBundle?.(locale, UI2_NAMESPACE, customBundle, true, true);
    }
  }
}

function ui2LangRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(".myr-ui2") ?? document.documentElement;
}

export function applyUi2Language(language: Ui2Language): void {
  storeLanguage(language);
  const root = ui2LangRoot();
  if (root) root.setAttribute("lang", language);
  const i18nInstance = readVendorI18nInstance();
  if (
    i18nInstance &&
    typeof i18nInstance.changeLanguage === "function" &&
    i18nInstance.language !== language
  ) {
    void i18nInstance.changeLanguage(language);
  }
}

export interface Ui2LanguageContextValue {
  language: Ui2Language;
  locale: Ui2Language;
  setLanguage: (language: Ui2Language) => void;
  setLocale: (language: Ui2Language) => void;
  t: (key: Ui2MessageKey, values?: Record<string, string | number>) => string;
  availableLocales: readonly Ui2Language[];
  applyCustomCatalog: (locale: string, catalog: Record<string, unknown>, merge?: boolean) => void;
  customCatalogs: Partial<Record<Ui2Language, Record<string, unknown>>>;
  setCatalogs: (catalogs: Partial<Record<Ui2Language, Record<string, unknown>>>) => void;
  saving: boolean;
  saveError: boolean;
}

const Ui2LanguageContext = createContext<Ui2LanguageContextValue | undefined>(undefined);

/** One honest "could not save" toast per failed write; keyed by run id (ADM 27.10: no toast loops). */
let lastSaveFailureToastAt = 0;
function announceSaveFailure(): void {
  if (typeof document === "undefined") return;
  const now = Date.now();
  if (now - lastSaveFailureToastAt < 4000) return;
  lastSaveFailureToastAt = now;
  const template = ru.language.saveFailed ?? en.language.saveFailed ?? "";
  if (!template) return;
  const toast = document.createElement("div");
  toast.setAttribute("role", "alert");
  toast.setAttribute("data-testid", "ui2-language-save-error-toast");
  toast.className = "ui2-toast ui2-toast--error";
  toast.textContent = formatUi2Message(template);
  document.body.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, 4000);
}

export function Ui2LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Ui2Language>(() => readStoredLanguage() ?? "en");
  const [customCatalogs, setCustomCatalogs] = useState<Partial<Record<Ui2Language, Record<string, unknown>>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const mounted = useRef(true);
  const userSwitched = useRef(false);
  // Mirror of customCatalogs readable inside mount effects/callbacks without
  // re-running them (upload remounts must keep the custom bundle registered).
  const customCatalogsRef = useRef(customCatalogs);
  customCatalogsRef.current = customCatalogs;

  useEffect(() => {
    mounted.current = true;
    registerUi2Catalogs(customCatalogsRef.current);
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    ui2LanguageApi
      .get()
      .then((preference) => {
        if (cancelled || userSwitched.current || !isUi2Language(preference?.language)) return;
        setLanguageState(preference.language);
        applyUi2Language(preference.language);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === UI2_LANGUAGE_STORAGE_KEY && isUi2Language(event.newValue)) {
        setLanguageState(event.newValue);
        applyUi2Language(event.newValue);
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setLanguage = useCallback((next: Ui2Language) => {
    userSwitched.current = true;
    setSaveError(false);
    setSaving(true);
    applyUi2Language(next);
    setLanguageState(next);
    ui2LanguageApi
      .put(next)
      .then(() => {
        if (mounted.current) setSaving(false);
      })
      .catch(() => {
        if (mounted.current) {
          setSaving(false);
          setSaveError(true);
          announceSaveFailure();
        }
      });
  }, []);

  const applyCustomCatalog = useCallback(
    (targetLocale: string, catalog: Record<string, unknown>, andSwitch?: boolean) => {
      const shouldSwitch = andSwitch !== false;
      const normalized = targetLocale.trim().toLowerCase() as Ui2Language;
      if (!normalized || !catalog || typeof catalog !== "object") return;

      const { entries } = flattenCatalog(catalog);
      const flat: Record<string, string> = {};
      for (const [key, entryValue] of entries) {
        flat[key] = entryValue;
      }
      if (!flat || Object.keys(flat).length === 0) return;
      if (!ui2Messages[normalized]) {
        (ui2Messages as unknown as Record<string, Record<string, string>>)[normalized] = {
          ...ui2Messages["en"],
          ...flat,
        };
      } else {
        Object.assign(ui2Messages[normalized], flat);
      }
      setCustomCatalogs((current) => ({ ...current, [normalized]: { ...(current[normalized] ?? {}), ...flat } }));

      // Register the vendor bundle with the upload's own shape. For a built-in
      // locale registerUi2Catalogs merges the overlay into the base catalog
      // (additive, so flat uploaded-only keys survive); for a custom locale the
      // raw tree IS the bundle — the flat overlay would replace it with dotted
      // keys i18next never looks up under this namespace (OPE-3986 CI).
      registerUi2Catalogs({ [normalized]: catalog });

      if (shouldSwitch) {
        userSwitched.current = true;
        applyUi2Language(normalized);
        setLanguageState(normalized);
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("myrmidon:locale-applied", { detail: { locale: normalized, andSwitch: shouldSwitch } }),
        );
      }
    },
    [],
  );

  const value = useMemo<Ui2LanguageContextValue>(
    () => ({
      language,
      locale: language,
      setLanguage,
      setLocale: setLanguage,
      t: (key, values) => {
        const template = (ui2Messages[language]?.[key] ?? ui2Messages["en"][key] ?? key);
        return formatUi2Message(template, values);
      },
      availableLocales: Array.from(new Set([...UI2_LANGUAGES, ...Object.keys(customCatalogs)])) as readonly Ui2Language[],
      applyCustomCatalog,
      customCatalogs,
      setCatalogs: setCustomCatalogs,
      saving,
      saveError,
    }),
    [language, setLanguage, applyCustomCatalog, customCatalogs, saving, saveError],
  );

  return <Ui2LanguageContext.Provider value={value}>{children}</Ui2LanguageContext.Provider>;
}

export function useUi2Language(): Ui2LanguageContextValue {
  const context = useContext(Ui2LanguageContext);
  if (!context) {
    throw new Error("useUi2Language must be used inside Ui2LanguageProvider");
  }
  return context;
}

export function useUi2I18n(): Ui2LanguageContextValue {
  return useUi2Language();
}

export function useUi2I18nOptional(): Ui2LanguageContextValue | null {
  return useContext(Ui2LanguageContext) ?? null;
}
