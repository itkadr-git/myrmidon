// ui/src/ui2/screens/settings/system/Ui2InstanceSecretSettings.tsx
//
// myrmidon(SETTINGS-UI E2.1): the UI2 twin of InstanceSecretSettingsPanel - the instance settings
// that read their value from a secret reference. Same hook, same API path; texts come from the
// UI2 catalog. Renders nothing until the server lists a registered setting (or answers 403).
// A secret value is never shown or sent.
import { useState } from "react";
import { useCompany } from "@/context/CompanyContext";
import { useInstanceSecretSettings } from "@/hooks/useInstanceSecretSettings";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2Section } from "../../../components/ui2Primitives";

const SECRET_REFS_KEYS = {
  title: "ui2.settings.secrets.title",
  hint: "ui2.settings.secrets.hint",
  descriptions: {
    "bot.disk.dockergate_token": "ui2.settings.secrets.descriptions.bot.disk.dockergate_token",
    "bot.egress.proxy_token": "ui2.settings.secrets.descriptions.bot.egress.proxy_token",
    "browser_console.node_token": "ui2.settings.secrets.descriptions.browser_console.node_token",
    "test.connector.client_secret": "ui2.settings.secrets.descriptions.test.connector.client_secret",
  },
} as const;

export function Ui2InstanceSecretSettings() {
  const { t } = useUi2I18n();
  const { selectedCompanyId } = useCompany();
  const data = useInstanceSecretSettings(selectedCompanyId ?? null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  if (data.settingsLoading || data.settingsError || data.settings.length === 0) return null;

  return (
    <Ui2Section title={t(SECRET_REFS_KEYS.title)} footer={t(SECRET_REFS_KEYS.hint)}>
      {data.settings.map((setting) => (
        <div key={setting.name} className="ui2-secret-ref flex flex-col gap-2 rounded-md border border-border p-3" data-testid={`ui2-secret-setting-${setting.name}`}>
          <span className="text-sm font-medium">
            {setting.name.startsWith("tool-oauth.") && setting.name !== "tool-oauth.client-secret"
              ? t("ui2.settings.system.secretRefs.toolOauthProvider", {
                  provider: setting.name.slice("tool-oauth.".length, -".client-secret".length).replace(/_/g, " "),
                })
              : t(
                  SECRET_REFS_KEYS.descriptions[setting.name as keyof typeof SECRET_REFS_KEYS.descriptions] ?? "ui2.settings.secrets.hint",
                )}
          </span>
          <span className="font-mono text-xs text-muted-foreground">{setting.name}</span>
          <span className="text-sm" data-testid={`ui2-secret-setting-source-${setting.name}`}>
            {t(`ui2.settings.system.secretRefs.source.${setting.effectiveSource}`)}
            {setting.ref ? ` · ${setting.ref.secretName ?? setting.ref.secretId}` : ""}
          </span>
          {setting.envOverrideActive ? (
            <span className="text-xs text-muted-foreground">
              {t("ui2.settings.system.secretRefs.envOverrideActive", { name: setting.envOverride })}
            </span>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              aria-label={t("ui2.settings.system.secretRefs.secret")}
              value={choice[setting.name] ?? ""}
              onChange={(event) => setChoice((current) => ({ ...current, [setting.name]: event.target.value }))}
              data-testid={`ui2-secret-setting-select-${setting.name}`}
            >
              <option value="">{t("ui2.settings.system.secretRefs.choose")}</option>
              {data.secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1 text-sm"
              disabled={!choice[setting.name] || data.setRef.isPending}
              onClick={() => {
                setFailed(false);
                data.setRef.mutate(
                  { name: setting.name, secretId: choice[setting.name] as string },
                  { onError: () => setFailed(true) },
                );
              }}
              data-testid={`ui2-secret-setting-save-${setting.name}`}
            >
              {t("ui2.settings.system.secretRefs.save")}
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1 text-sm"
              disabled={!setting.ref || data.clearRef.isPending}
              onClick={() => {
                setFailed(false);
                data.clearRef.mutate(setting.name, { onError: () => setFailed(true) });
              }}
              data-testid={`ui2-secret-setting-clear-${setting.name}`}
            >
              {t("ui2.settings.system.secretRefs.clear")}
            </button>
          </div>
        </div>
      ))}
      {failed ? <span className="text-sm text-destructive">{t("ui2.settings.system.secretRefs.error")}</span> : null}
    </Ui2Section>
  );
}
