// ui/src/ui2/i18n/LanguageSwitch.tsx
//
// myrmidon(UI2): the language switch for the ui2 shell. The import-path
// contract `ui2/i18n/LanguageSwitch` is owned by the i18n part of the shell work;
// until that part merges, this module is the local implementation the
// Language settings screen imports. When that part lands, this file is the
// single seam to reconcile (reviewer checkpoint: the screen's import must
// match the merged module's path and props).
//
// The switch drives the Ui2I18nProvider directly; it renders the two
// product locales with their native names and the current one marked
// (aria-checked), so it doubles as the accessible control on phone.

import { clsx } from "clsx";
import { UI2_LOCALES, type Ui2Locale } from "./locales";
import { useUi2I18n } from "./Ui2I18n";

export function LanguageSwitch({ compact = false }: { compact?: boolean }) {
  const { t, locale, setLocale, availableLocales } = useUi2I18n();

  return (
    <div
      className={clsx("ui2-language-switch flex flex-wrap gap-2", compact && "ui2-language-switch--compact")}
      role="radiogroup"
      aria-label={t("ui2.settings.language.title")}
    >
      {availableLocales.map((candidate) => {
        const selected = locale === candidate;
        let label = candidate.toUpperCase();
        if (candidate === "ru") {
          label = t("ui2.settings.language.ru");
        } else if (candidate === "en") {
          label = t("ui2.settings.language.en");
        }
        return (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={selected}
            lang={candidate}
            className={clsx(
              "ui2-language-switch-option rounded-md border px-3 py-1 text-xs",
              compact && "ui2-language-switch-option--compact",
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent",
            )}
            onClick={() => {
              void setLocale(candidate);
            }}
          >
            {label}
            {compact ? null : <span className="sr-only">{t("ui2.settings.language.title")}</span>}
          </button>
        );
      })}
    </div>
  );
}
