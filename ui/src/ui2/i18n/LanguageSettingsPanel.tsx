// myrmidon(UI2-I18N): the Settings → Language screen body (2.0 UI tree).
//
// Screen-map 2.16: language choice (English base, Russian translation) with a
// navigation + decision-card preview, the persistence hint, and the honest
// boundary note (agent-written text and identifiers are never translated;
// missing Russian keys fall back to English). Number/date/timezone format
// pickers arrive with the design tokens session — placeholder copy only, the
// card renders behind the flag until then.
//
// myrmidon(1.6.5-TG-LOCALE-C): the panel also owns the
// instance-wide default language of the bridged Telegram DM — the fallback for
// every board member who never chose one. It names the source of the effective
// value (environment force / the person / the instance / the default) and lets
// an instance admin change the instance value; the server enforces that rule
// and answers 403 for anyone else.
//
// The re-skin pass mounts this panel into the shell's settings navigation;
// it also renders standalone in tests.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Languages } from "lucide-react";
import { useUi2T } from "./useUi2T";
import {
  ui2LanguageLabel,
  useUi2Language,
  UI2_LANGUAGES,
  type Ui2Language,
} from ".";
import type { TelegramBridgeSourceWire } from "./api";

export function ui2LanguageQueryKey(): Array<string> {
  return ["myrmidon", "ui2", "language"];
}

export function ui2BridgeLanguageQueryKey(): Array<string> {
  return ["myrmidon", "ui2", "bridge-language"];
}

/** The language the bridged Telegram DM really answers in, as a label. */
function bridgeLanguageLabel(source: TelegramBridgeSourceWire | undefined): string {
  return ui2LanguageLabel(source?.language === "ru" ? "ru" : "en");
}

export function LanguageSettingsPanel() {
  const { t } = useUi2T();
  const { language, setLanguage, saving, saveError } = useUi2Language();
  const queryClient = useQueryClient();
  const preference = useQuery({
    queryKey: ui2LanguageQueryKey(),
    queryFn: () => import("./api").then((m) => m.ui2LanguageApi.get()),
    initialData: { language, updatedAt: null },
  });

  // myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default and its source.
  const instance = useQuery({
    queryKey: ui2BridgeLanguageQueryKey(),
    queryFn: () => import("./api").then((m) => m.bridgeLanguageApi.get()),
  });
  const [instanceChoice, setInstanceChoice] = useState<Ui2Language>("en");
  const [instanceSaving, setInstanceSaving] = useState(false);
  const [instanceSaved, setInstanceSaved] = useState<Ui2Language | null>(null);
  const [instanceError, setInstanceError] = useState(false);

  useEffect(() => {
    if (instance.data?.language) setInstanceChoice(instance.data.language);
  }, [instance.data?.language]);

  const saveInstanceLanguage = async () => {
    setInstanceSaving(true);
    setInstanceError(false);
    try {
      const { bridgeLanguageApi } = await import("./api");
      const result = await bridgeLanguageApi.patch(instanceChoice);
      setInstanceSaved(result.language);
      await queryClient.invalidateQueries({ queryKey: ui2BridgeLanguageQueryKey() });
      await queryClient.invalidateQueries({ queryKey: ui2LanguageQueryKey() });
    } catch {
      setInstanceError(true);
    } finally {
      setInstanceSaving(false);
    }
  };

  const bridge = preference.data?.telegramBridge;
  const bridgeSourceText = (() => {
    if (!bridge) return null;
    if (bridge.source === "environment") {
      return t("language.telegramBridgeEnv", {
        language: bridge.forcedLanguage === "ru" ? ui2LanguageLabel("ru") : ui2LanguageLabel("en"),
      });
    }
    if (bridge.source === "instance") {
      return t("language.telegramBridgeInstance", { language: bridgeLanguageLabel(bridge) });
    }
    if (bridge.source === "default") {
      return t("language.telegramBridgeDefault", { language: bridgeLanguageLabel(bridge) });
    }
    return t("language.telegramBridgeUser");
  })();

  return (
    <section
      className="ui2-language-settings"
      aria-labelledby="ui2-language-settings-title"
      data-testid="ui2-language-settings"
    >
      <header className="ui2-language-settings__header">
        <h2 id="ui2-language-settings-title" className="ui2-language-settings__title">
          {t("language.settingsTitle")}
        </h2>
        <p className="ui2-language-settings__description">{t("language.settingsDescription")}</p>
      </header>

      <fieldset className="ui2-language-settings__choice" role="radiogroup" aria-label={t("language.currentLanguage")}>
        {UI2_LANGUAGES.map((code: Ui2Language) => (
          <label key={code} className="ui2-language-settings__option">
            <input
              type="radio"
              name="ui2-language"
              value={code}
              checked={language === code}
              onChange={() => setLanguage(code)}
              disabled={saving}
              data-testid={`ui2-language-option-${code}`}
            />
            <span className="ui2-language-settings__option-label">{ui2LanguageLabel(code)}</span>
            <Languages
              className="ui2-language-settings__option-icon"
              aria-hidden="true"
              data-selected={language === code}
            />
          </label>
        ))}
      </fieldset>

      <p className="ui2-language-settings__hint" data-testid="ui2-language-server-hint">
        {t("language.serverHint")}
      </p>
      {/* myrmidon(1.7-TG-LOCALE): the source of the value the bridged Telegram
          DM answers with — shown, never silently overridden. "environment"
          while the instance force is set (the user's choice still decides the
          interface and every unforced instance).
          myrmidon(1.6.5-TG-LOCALE-C): "instance" and "default" names the
          remaining two sources instead of describing the instance as "user". */}
      <p className="ui2-language-settings__hint" data-testid="ui2-language-telegram-source">
        {bridgeSourceText}
      </p>

      {/* myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default itself. The
          server keeps reading it while the chats run: a saved change applies
          from the next reply, no restart. */}
      <section
        className="ui2-language-settings__instance"
        aria-labelledby="ui2-language-instance-title"
        data-testid="ui2-language-instance"
      >
        <h3 id="ui2-language-instance-title" className="ui2-language-settings__instance-title">
          {t("language.instanceLanguageTitle")}
        </h3>
        <p className="ui2-language-settings__instance-description">
          {t("language.instanceLanguageDescription")}
        </p>
        <fieldset
          className="ui2-language-settings__choice"
          role="radiogroup"
          aria-label={t("language.instanceLanguageTitle")}
        >
          {UI2_LANGUAGES.map((code: Ui2Language) => (
            <label key={code} className="ui2-language-settings__option">
              <input
                type="radio"
                name="ui2-instance-language"
                value={code}
                checked={instanceChoice === code}
                onChange={() => setInstanceChoice(code)}
                disabled={instanceSaving}
                data-testid={`ui2-language-instance-option-${code}`}
              />
              <span className="ui2-language-settings__option-label">{ui2LanguageLabel(code)}</span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="ui2-language-settings__instance-save"
          onClick={saveInstanceLanguage}
          disabled={instanceSaving}
          data-testid="ui2-language-instance-save"
        >
          {t("language.instanceLanguageSave")}
        </button>
        <p className="ui2-language-settings__instance-source" data-testid="ui2-language-instance-source">
          {instance.data?.source === "environment"
            ? t("language.telegramBridgeEnv", {
                language:
                  instance.data.forced === "ru" ? ui2LanguageLabel("ru") : ui2LanguageLabel("en"),
              })
            : instance.data?.stored
              ? t("language.telegramBridgeInstance", { language: ui2LanguageLabel(instance.data.stored) })
              : t("language.telegramBridgeDefault", { language: ui2LanguageLabel("en") })}
        </p>
        {instanceSaved ? (
          <p className="ui2-language-settings__instance-saved" data-testid="ui2-language-instance-saved">
            {t("language.instanceLanguageSaved", { language: ui2LanguageLabel(instanceSaved) })}
          </p>
        ) : null}
        {instanceError ? (
          <p
            className="ui2-language-settings__error"
            role="alert"
            data-testid="ui2-language-instance-error"
          >
            {t("language.instanceLanguageFailed")}
          </p>
        ) : null}
      </section>

      {saveError ? (
        <p className="ui2-language-settings__error" role="alert" data-testid="ui2-language-save-error">
          {t("language.saveFailed")}
        </p>
      ) : null}

      <div className="ui2-language-settings__preview" data-testid="ui2-language-preview">
        <h3 className="ui2-language-settings__preview-title">{t("language.previewTitle")}</h3>
        <div className="ui2-language-settings__preview-nav" aria-label={t("language.previewNav")}>
          <ul className="ui2-language-settings__preview-nav-list">
            <li>{t("language.previewNavItemDecisions")}</li>
            <li>{t("language.previewNavItemSwarm")}</li>
            <li>{t("language.previewNavItemCosts")}</li>
          </ul>
        </div>
        <div
          className="ui2-language-settings__preview-card"
          aria-label={t("language.previewDecisionCard")}
        >
          <p className="ui2-language-settings__preview-card-title">
            {t("language.previewDecisionCardTitle")}
          </p>
          <p className="ui2-language-settings__preview-card-body">
            {t("language.previewDecisionCardBody", { count: 3 })}
          </p>
        </div>
      </div>

      <p className="ui2-language-settings__saved-at" data-testid="ui2-language-saved-at">
        {preference.data?.updatedAt ? t("time.updated", { time: String(preference.data.updatedAt) }) : ""}
      </p>
    </section>
  );
}