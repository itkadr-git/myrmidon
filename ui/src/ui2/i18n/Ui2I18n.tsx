// ui/src/ui2/i18n/Ui2I18n.tsx
//
// myrmidon(UI2): the language provider for the ui2 tree.

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
import { ui2LanguageApi } from "./api";
import { registerUi2Catalogs } from "./index";
import {
  UI2_DEFAULT_LOCALE,
  UI2_LOCALES,
  formatUi2Message,
  ui2Messages,
  type Ui2Locale,
  type Ui2MessageKey,
} from "./locales";

const STORAGE_KEYS = [
  "myrmidon.ui2.locale",
  "myrmidon:ui2:language",
  "myrmidon:ui-language",
] as const;

export { UI2_LOCALES, UI2_DEFAULT_LOCALE };

export function isUi2Locale(value: unknown): value is Ui2Locale {
  return typeof value === "string" && (UI2_LOCALES as readonly string[]).includes(value);
}

export function readStoredLocale(): Ui2Locale | null {
  try {
    for (const key of STORAGE_KEYS) {
      const raw = window.localStorage.getItem(key);
      if (isUi2Locale(raw)) return raw;
    }
  } catch {
    // localStorage unavailable
  }
  return null;
}

function persistLocale(locale: Ui2Locale): void {
  for (const key of STORAGE_KEYS) {
    try {
      window.localStorage.setItem(key, locale);
    } catch {
      // best-effort
    }
  }
}

function applyLocaleToShell(locale: Ui2Locale): void {
  registerUi2Catalogs();
  const root =
    (typeof document !== "undefined" &&
      (document.querySelector<HTMLElement>(".myr-ui2") ?? document.documentElement)) ||
    null;
  if (root) root.setAttribute("lang", locale);
  const i18nInstance = (vendorI18n as { i18n?: typeof import("@/i18n").i18n }).i18n;
  if (
    i18nInstance &&
    typeof i18nInstance.changeLanguage === "function" &&
    i18nInstance.language !== locale
  ) {
    void i18nInstance.changeLanguage(locale);
  }
}

let serverPreferencePromise: Promise<Ui2Locale | null> | null = null;
function loadServerPreference(): Promise<Ui2Locale | null> {
  if (!serverPreferencePromise) {
    serverPreferencePromise = ui2LanguageApi
      .get()
      .then((preference) => (isUi2Locale(preference?.language) ? preference.language : null))
      .catch(() => null);
  }
  return serverPreferencePromise;
}

export function resetUi2ServerPreferenceCacheForTests(): void {
  serverPreferencePromise = null;
}

export interface Ui2I18nContextValue {
  locale: Ui2Locale;
  language: Ui2Locale;
  setLocale: (locale: Ui2Locale) => void;
  setLanguage: (locale: Ui2Locale) => void;
  t: (key: Ui2MessageKey, values?: Record<string, string | number>) => string;
  availableLocales: readonly Ui2Locale[];
  applyCustomCatalog: (locale: string, catalog: Record<string, unknown>, merge?: boolean) => void;
  customCatalogs: Partial<Record<Ui2Locale, Record<string, unknown>>>;
  setCatalogs: (catalogs: Partial<Record<Ui2Locale, Record<string, unknown>>>) => void;
  saving: boolean;
  saveError: boolean;
}

const Ui2I18nContext = createContext<Ui2I18nContextValue | null>(null);

export function Ui2I18nProvider({
  children,
  initialLocale = readStoredLocale() ?? UI2_DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: Ui2Locale;
}) {
  const [locale, setLocaleState] = useState<Ui2Locale>(initialLocale);
  const [customCatalogs, setCustomCatalogs] = useState<Partial<Record<Ui2Locale, Record<string, unknown>>>>({});
  const [saving] = useState(false);
  const [saveError] = useState(false);
  const userSwitched = useRef(false);

  useEffect(() => {
    applyLocaleToShell(locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialLocale !== undefined) return;
    let active = true;
    void loadServerPreference().then((serverLocale) => {
      if (!active || userSwitched.current || !serverLocale) return;
      if (serverLocale === locale) return;
      setLocaleState(serverLocale);
      persistLocale(serverLocale);
      applyLocaleToShell(serverLocale);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLocale]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (!(STORAGE_KEYS as readonly string[]).includes(event.key ?? "")) return;
      if (!isUi2Locale(event.newValue)) return;
      const next = event.newValue;
      setLocaleState((current: Ui2Locale) => {
        if (current === next) return current;
        applyLocaleToShell(next);
        return next;
      });
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setLocale = useCallback((next: Ui2Locale) => {
    userSwitched.current = true;
    serverPreferencePromise = Promise.resolve(next);
    persistLocale(next);
    applyLocaleToShell(next);
    setLocaleState(next);
    void ui2LanguageApi.put(next).catch(() => undefined);
  }, []);

  const applyCustomCatalog = useCallback((_targetLocale: string, _catalog: Record<string, unknown>, _merge?: boolean) => {
    // no-op stub
  }, []);

  const value = useMemo<Ui2I18nContextValue>(
    () => ({
      locale,
      language: locale,
      setLocale,
      setLanguage: setLocale,
      t: (key, values) => {
        const template = ui2Messages[locale][key] ?? ui2Messages[UI2_DEFAULT_LOCALE][key] ?? key;
        return formatUi2Message(template, values);
      },
      availableLocales: UI2_LOCALES,
      applyCustomCatalog,
      customCatalogs,
      setCatalogs: setCustomCatalogs,
      saving,
      saveError,
    }),
    [locale, setLocale, applyCustomCatalog, customCatalogs, saving, saveError],
  );

  return <Ui2I18nContext.Provider value={value}>{children}</Ui2I18nContext.Provider>;
}

export function useUi2I18n(): Ui2I18nContextValue {
  const ctx = useContext(Ui2I18nContext);
  if (!ctx) throw new Error("useUi2I18n requires a Ui2I18nProvider ancestor");
  return ctx;
}

export function useUi2I18nOptional(): Ui2I18nContextValue | null {
  return useContext(Ui2I18nContext);
}

export function useUi2Language(): Ui2I18nContextValue {
  return useUi2I18n();
}
