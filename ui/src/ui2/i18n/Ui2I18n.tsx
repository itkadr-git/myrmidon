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
import { flattenCatalog } from "@myrmidon/shared";
import { ui2LanguageApi } from "./api";
import { readVendorI18nInstance, registerUi2Catalogs } from "./index";
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

function applyLocaleToShell(
  locale: Ui2Locale,
  customCatalogs?: Partial<Record<string, Record<string, unknown>>>,
): void {
  registerUi2Catalogs(customCatalogs);
  const root =
    (typeof document !== "undefined" &&
      (document.querySelector<HTMLElement>(".myr-ui2") ?? document.documentElement)) ||
    null;
  if (root) root.setAttribute("lang", locale);
  // Read the vendor instance through the safe accessor: a bare `vendorI18n.i18n`
  // throws on a test's partial `@/i18n` mock (missing export on the namespace),
  // which is what blanked the settings screens in CI (see readVendorI18nInstance).
  const i18nInstance = readVendorI18nInstance();
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
  // Mirror of customCatalogs readable inside mount effects/callbacks without
  // re-running them (upload remounts must keep the custom bundle registered).
  const customCatalogsRef = useRef(customCatalogs);
  customCatalogsRef.current = customCatalogs;

  useEffect(() => {
    applyLocaleToShell(locale, customCatalogsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // The server preference wins over the local mirror even when the shell
    // seeds an explicit initialLocale (the seeded value is only a pre-paint
    // guess; the stored copy is the last known choice, not the truth).
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
  }, []);

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

  const applyCustomCatalog = useCallback(
    (targetLocale: string, catalog: Record<string, unknown>, andSwitch?: boolean) => {
      const shouldSwitch = andSwitch !== false;
      const normalized = targetLocale.trim().toLowerCase() as Ui2Locale;
      if (!normalized || !catalog || typeof catalog !== "object") return;

      // 1. Merge into the in-memory flat catalogs so `t` sees the custom keys
      //    immediately (no reload). A brand-new locale is seeded from the en
      //    base, mirroring the pre-Wave-A behavior of the upload screen.
      const { entries } = flattenCatalog(catalog);
      const flat: Record<string, string> = {};
      for (const [key, entryValue] of entries) {
        flat[key] = entryValue;
      }
      if (!ui2Messages[normalized]) {
        (ui2Messages as unknown as Record<string, Record<string, string>>)[normalized] = {
          ...ui2Messages[UI2_DEFAULT_LOCALE],
          ...flat,
        };
      } else {
        Object.assign(ui2Messages[normalized], flat);
      }
      setCustomCatalogs((current) => ({ ...current, [normalized]: { ...(current[normalized] ?? {}), ...flat } }));

      // 2. Register the vendor bundle with the FLAT custom overlay. The built-in
      //    bundle is registered as a deep tree, but the provider's `t` keys are
      //    flat dotted strings (`ui2.chip.colony`) — registering the nested
      //    upload as-is would leave flat lookups missing in i18next. The flat
      //    shape matches the provider's own ui2Messages (OPE-3986 CI: provider
      //    test expected the flat key inside the vendor bundle).
      registerUi2Catalogs({ [normalized]: flat });

      // 3. Switch the shell to the uploaded locale when asked (the upload
      //    screen's "apply" is a language switch, matching OPE-9646).
      if (shouldSwitch) {
        userSwitched.current = true;
        serverPreferencePromise = Promise.resolve(normalized);
        persistLocale(normalized);
        applyLocaleToShell(normalized);
        setLocaleState(normalized);
      }

      // 4. Tell the rest of the shell (LanguageSwitch's available locales) a
      //    custom locale exists, mirroring main's `myrmidon:locale-applied`.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("myrmidon:locale-applied", { detail: { locale: normalized, andSwitch: shouldSwitch } }),
        );
      }
    },
    [],
  );

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
      availableLocales: Array.from(new Set([...UI2_LOCALES, ...Object.keys(customCatalogs)])) as Ui2Locale[],
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
