// ui/src/ui2/i18n/Ui2I18n.tsx
//
// myrmidon(UI2): the language provider for the ui2 tree.
//
// myrmidon(UI-2.0 Wave A part 2, owner decision 03.10): the language choice
// now owns the WHOLE shell, not just the flat screen catalog:
//   - `setLocale` applies the locale to the vendor i18next instance
//     (`i18n.changeLanguage`) so the shell components that read vendor
//     `useTranslation` (top bar, rail, phone nav) re-render in the new
//     language WITHOUT a reload;
//   - the choice persists twice: localStorage (mirror, survives reload
//     before the request resolves) and the server preference
//     (`GET/PUT /api/myrmidon/ui2/language/me`, survives re-login and
//     follows the user across browsers);
//   - on mount the server preference wins over the local mirror — a new
//     user (no row) resolves to "en", the instance default (owner decision
//     03.10: язык оболочки по умолчанию — английский);
//   - the `lang` attribute goes on the `.myr-ui2` root (font contract with
//     the shell theme, keyed on [lang="ru"]);
//   - cross-tab sync via the storage event.
//
// The provider stays route-scoped (routes.tsx wraps each screen); the
// server load is a module-level single-flight so navigating between routes
// does not refetch, and StrictMode double-mounts share one request.

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
import { i18n } from "@/i18n";
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

/** Legacy mirror key (kept so existing choices survive) and the shared one. */
const STORAGE_KEYS = ["myrmidon.ui2.locale", "myrmidon:ui2:language"] as const;

export function isUi2Locale(value: unknown): value is Ui2Locale {
  return typeof value === "string" && (UI2_LOCALES as readonly string[]).includes(value);
}

/** Read the stored locale without crashing on private-mode/quota failures. */
export function readStoredLocale(): Ui2Locale | null {
  try {
    for (const key of STORAGE_KEYS) {
      const raw = window.localStorage.getItem(key);
      if (isUi2Locale(raw)) return raw;
    }
  } catch {
    // localStorage unavailable — rely on the server preference.
  }
  return null;
}

function persistLocale(locale: Ui2Locale): void {
  for (const key of STORAGE_KEYS) {
    try {
      window.localStorage.setItem(key, locale);
    } catch {
      // The choice still applies for this session.
    }
  }
}

/**
 * Apply a locale to everything outside this provider's React tree: the
 * vendor i18next instance (shell copy), the ui2 namespace catalogs on it,
 * and the `lang` attribute (RU display-font contract).
 */
function applyLocaleToShell(locale: Ui2Locale): void {
  registerUi2Catalogs();
  const root =
    (typeof document !== "undefined" &&
      (document.querySelector<HTMLElement>(".myr-ui2") ?? document.documentElement)) ||
    null;
  if (root) root.setAttribute("lang", locale);
  if (i18n.language !== locale) void i18n.changeLanguage(locale);
}

/** Single-flight server preference load (module level: one GET per page). */
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

/** Test seam: clear the module-level single-flight so each test owns its
 * own mocked GET. Never called by production code. */
export function resetUi2ServerPreferenceCacheForTests(): void {
  serverPreferencePromise = null;
}

export interface Ui2I18nContextValue {
  locale: Ui2Locale;
  setLocale: (locale: Ui2Locale) => void;
  t: (key: Ui2MessageKey, values?: Record<string, string | number>) => string;
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
  // Once the user has chosen a language in this session, a late server
  // response must not overwrite their choice.
  const userSwitched = useRef(false);

  // Apply the starting locale to the shell immediately (first paint).
  useEffect(() => {
    applyLocaleToShell(locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the server preference once: it wins over the local mirror — but
  // only until the user switches in this session. A new user (no row)
  // resolves to "en", the instance default.
  useEffect(() => {
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

  // Cross-tab sync: another tab switched the language.
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
    persistLocale(next);
    applyLocaleToShell(next);
    setLocaleState(next);
    // Persist the personal choice on the server (survives re-login and
    // other browsers). Failure keeps the local choice applied.
    void ui2LanguageApi.put(next).catch(() => undefined);
  }, []);

  const value = useMemo<Ui2I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, values) => {
        const template = ui2Messages[locale][key] ?? ui2Messages[UI2_DEFAULT_LOCALE][key] ?? key;
        return formatUi2Message(template, values);
      },
    }),
    [locale, setLocale],
  );

  return <Ui2I18nContext.Provider value={value}>{children}</Ui2I18nContext.Provider>;
}

export function useUi2I18n(): Ui2I18nContextValue {
  const ctx = useContext(Ui2I18nContext);
  if (!ctx) throw new Error("useUi2I18n requires a Ui2I18nProvider ancestor");
  return ctx;
}
