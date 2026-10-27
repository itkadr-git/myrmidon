// myrmidon(SETTINGS-UI E2.1): instance settings that take their value from a secret reference.
// Renders nothing until the server lists at least one registered setting (or for a user who is
// not an instance admin: the list answers 403). Never shows or sends a secret value.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useOptionalCompany } from "@/context/CompanyContext";
import { useInstanceSecretSettings } from "@/hooks/useInstanceSecretSettings";
import type { InstanceSecretSettingStatus } from "@/api/instanceSecretSettings";

export function InstanceSecretSettingsPanel() {
  const { t } = useTranslation();
  const selectedCompanyId = useOptionalCompany()?.selectedCompanyId ?? null;
  const data = useInstanceSecretSettings(selectedCompanyId);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  if (data.settingsLoading || data.settingsError || data.settings.length === 0) return null;

  const save = (setting: InstanceSecretSettingStatus) => {
    const secretId = choice[setting.name];
    if (!secretId) return;
    setError(null);
    data.setRef.mutate(
      { name: setting.name, secretId },
      { onError: () => setError(t("area.secret-settings.instance-secret-settings-panel.saveError")) },
    );
  };
  const clear = (setting: InstanceSecretSettingStatus) => {
    setError(null);
    data.clearRef.mutate(setting.name, {
      onError: () => setError(t("area.secret-settings.instance-secret-settings-panel.clearError")),
    });
  };
  const planned = data.plan.data?.rows.filter((row) => row.outcome === "planned").length ?? 0;

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="instance-secret-settings-panel">
      <header className="flex items-center gap-2">
        <KeyRound className="h-4 w-4" aria-hidden />
        <h3 className="text-sm font-medium">{t("area.secret-settings.instance-secret-settings-panel.title")}</h3>
      </header>
      <p className="text-sm text-muted-foreground">
        {t("area.secret-settings.instance-secret-settings-panel.description")}
      </p>
      {data.settings.map((setting) => (
        <div key={setting.name} className="space-y-2" data-testid={`secret-setting-${setting.name}`}>
          <div className="text-sm font-medium">
            {setting.name.startsWith("tool-oauth.") && setting.name !== "tool-oauth.client-secret"
              ? t("area.secret-settings.instance-secret-settings-panel.toolOauthProvider", {
                  provider: setting.name.slice("tool-oauth.".length, -".client-secret".length).replace(/_/g, " "),
                })
              : t(`area.secret-settings.instance-secret-settings-panel.settingDescriptions.${setting.name.replace(/[.-]/g, "_")}`, { defaultValue: setting.description })}
          </div>
          <div className="font-mono text-xs text-muted-foreground">{setting.name}</div>
          <div className="text-sm" data-testid={`secret-setting-source-${setting.name}`}>
            {t(`area.secret-settings.instance-secret-settings-panel.source.${setting.effectiveSource}`)}
            {setting.ref ? ` · ${setting.ref.secretName ?? setting.ref.secretId}` : ""}
          </div>
          {setting.envOverrideActive ? (
            <p className="text-sm text-muted-foreground">
              {t("area.secret-settings.instance-secret-settings-panel.envOverrideActive", {
                name: setting.envOverride,
              })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`secret-setting-select-${setting.name}`}>
              {t("area.secret-settings.instance-secret-settings-panel.secretLabel")}
            </Label>
            <select
              id={`secret-setting-select-${setting.name}`}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={choice[setting.name] ?? ""}
              onChange={(event) => setChoice((current) => ({ ...current, [setting.name]: event.target.value }))}
            >
              <option value="">{t("area.secret-settings.instance-secret-settings-panel.choose")}</option>
              {data.secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              disabled={!choice[setting.name] || data.setRef.isPending}
              onClick={() => save(setting)}
              data-testid={`secret-setting-save-${setting.name}`}
            >
              {t("common.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!setting.ref || data.clearRef.isPending}
              onClick={() => clear(setting)}
              data-testid={`secret-setting-clear-${setting.name}`}
            >
              {t("common.remove")}
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={data.plan.isPending} onClick={() => data.plan.mutate()} data-testid="secret-settings-plan">
          {t("area.secret-settings.instance-secret-settings-panel.planButton")}
        </Button>
        {data.plan.data ? (
          <span className="text-sm text-muted-foreground" data-testid="secret-settings-plan-result">
            {t("area.secret-settings.instance-secret-settings-panel.planResult", { count: planned })}
          </span>
        ) : null}
        {error ? <span className="text-sm text-destructive">{error}</span> : null}
      </div>
    </section>
  );
}
