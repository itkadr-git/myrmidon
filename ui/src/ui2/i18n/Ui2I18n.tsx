// ui/src/ui2/i18n/Ui2I18n.tsx
//
// myrmidon(UI2): the language provider for the ui2 tree. The persistence
// model is intentionally minimal for the first slice: the chosen locale is
// stored client-side (`localStorage`, key `myrmidon.ui2.locale`) and applied
// on mount before the first paint of a ui2 screen. Server-side per-user
// persistence is the i18n part's scope; when that lands, this provider's
// `readStoredLocale` is the single seam to swap for an API read.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { flattenCatalog } from "@myrmidon/shared";
import {
  UI2_DEFAULT_LOCALE,
  UI2_LOCALES,
  formatUi2Message,
  ui2Messages,
  type Ui2Locale,
  type Ui2MessageKey,
} from "./locales";
import { setAppLanguage } from "@/i18n/myrmidon-i18n";

const STORAGE_KEY = "myrmidon.ui2.locale";

const customCatalogRegistry: Record<string, Record<string, string>> = {};
const customLocalesSet = new Set<string>();

export function getRegisteredCustomLocales(): string[] {
  return Array.from(customLocalesSet);
}

export function isUi2Locale(value: unknown): value is Ui2Locale {
  return (
    typeof value === "string" &&
    ((UI2_LOCALES as readonly string[]).includes(value) || customLocalesSet.has(value))
  );
}

export function applyCustomCatalog(
  targetLocale: string,
  catalog: Record<string, unknown>,
  andSwitch = true,
): void {
  const { entries } = flattenCatalog(catalog);
  const flatRecord: Record<string, string> = {};
  for (const [k, v] of entries) {
    flatRecord[k] = v;
  }

  customCatalogRegistry[targetLocale] = {
    ...(customCatalogRegistry[targetLocale] || {}),
    ...flatRecord,
  };
  customLocalesSet.add(targetLocale);

  if (!ui2Messages[targetLocale as Ui2Locale]) {
    (ui2Messages as unknown as Record<string, Record<string, string>>)[targetLocale] = {
      ...ui2Messages.en,
      ...flatRecord,
    };
  } else {
    Object.assign(ui2Messages[targetLocale as Ui2Locale], flatRecord);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i18next = (window as any).i18next;
    if (i18next && typeof i18next.addResourceBundle === "function") {
      i18next.addResourceBundle(targetLocale, "ui2", catalog, true, true);
      i18next.addResourceBundle(targetLocale, "translation", catalog, true, true);
    }
  } catch {
    // ignore
  }

  if (andSwitch) {
    persistLocale(targetLocale as Ui2Locale);
    try {
      window.localStorage.setItem("myrmidon:ui-language", targetLocale);
    } catch {}
    if (typeof document !== "undefined") {
      const root = document.querySelector<HTMLElement>(".myr-ui2") ?? document.documentElement;
      if (root) root.setAttribute("lang", targetLocale);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const i18next = (window as any).i18next;
      if (i18next && typeof i18next.changeLanguage === "function") {
        void i18next.changeLanguage(targetLocale);
      }
    } catch {}
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("myrmidon:locale-applied", {
        detail: { locale: targetLocale, andSwitch },
      }),
    );
  }
}

const APP_LANGUAGE_STORAGE_KEY = "myrmidon:ui-language";

/**
 * The language chosen for the whole interface (`myrmidon:ui-language`). The
 * ui2 screens used to start in English whatever the owner had picked, because
 * they only looked at their own key; the app-wide choice is the fallback when ui2 has none of its own.
 */
export function readAppLanguage(): Ui2Locale | null {
  try {
    const raw = window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    return isUi2Locale(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Read the stored locale without crashing on private-mode/quota failures. */
export function readStoredLocale(): Ui2Locale | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
    return isUi2Locale(raw) ? raw : null;
  } catch {
    return null;
  }
}

function persistLocale(locale: Ui2Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
    window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, locale);
    window.localStorage.setItem("myrmidon:ui2:language", locale);
  } catch {
    // The choice still applies for this session.
  }
}

export interface Ui2I18nContextValue {
  locale: Ui2Locale;
  setLocale: (locale: Ui2Locale | string) => void | Promise<void>;
  availableLocales: string[];
  applyCustomCatalog: (
    targetLocale: string,
    catalog: Record<string, unknown>,
    andSwitch?: boolean,
  ) => void;
  t: (key: Ui2MessageKey, values?: Record<string, string | number>) => string;
}

const Ui2I18nContext = createContext<Ui2I18nContextValue | null>(null);

export function Ui2I18nProvider({
  children,
  initialLocale,
}: {
  children?: ReactNode;
  initialLocale?: Ui2Locale;
}) {
  const [locale, setLocaleState] = useState<Ui2Locale>(
    () => initialLocale ?? readStoredLocale() ?? readAppLanguage() ?? UI2_DEFAULT_LOCALE,
  );
  const [customRevision, setCustomRevision] = useState(0);

  useEffect(() => {
    const syncLocale = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== APP_LANGUAGE_STORAGE_KEY) return;
      const next = isUi2Locale(event.newValue) ? event.newValue : null;
      if (next) setLocaleState(next);
    };
    window.addEventListener("storage", syncLocale);
    return () => window.removeEventListener("storage", syncLocale);
  }, []);

  useEffect(() => {
    const onLocaleApplied = (event: Event) => {
      const ce = event as CustomEvent<{ locale: string; andSwitch?: boolean }>;
      setCustomRevision((rev) => rev + 1);
      if (ce.detail?.locale && ce.detail?.andSwitch) {
        setLocaleState(ce.detail.locale as Ui2Locale);
      }
    };
    window.addEventListener("myrmidon:locale-applied", onLocaleApplied);
    return () => window.removeEventListener("myrmidon:locale-applied", onLocaleApplied);
  }, []);

  const setLocale = useCallback((next: Ui2Locale) => {
    persistLocale(next);
    setLocaleState(next);
    return setAppLanguage(next);
  }, []);

  const availableLocales = useMemo(() => {
    return Array.from(new Set([...UI2_LOCALES, ...Array.from(customLocalesSet)]));
  }, [customRevision]);

  const value = useMemo<Ui2I18nContextValue>(
    () => ({
      locale,
      setLocale,
      availableLocales,
      applyCustomCatalog,
      t: (key, values) => {
        const custom = customCatalogRegistry[locale];
        const template =
          custom?.[key] ??
          ui2Messages[locale]?.[key] ??
          ui2Messages[UI2_DEFAULT_LOCALE]?.[key] ??
          key;
        return formatUi2Message(template, values);
      },
    }),
    [locale, setLocale, availableLocales],
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
