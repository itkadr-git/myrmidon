import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { behaviorSettingsApi, behaviorSettingsQueryKey, sourceLabel, type BehaviorSettingValue } from "@/components/myrmidon/behaviorSettingsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";

/** Labels are resolved at call time, not at import, so a language switch applies. */
const lists = () => [
  { key: "bot_image_allowlist", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botImageAllowlist"), json: false },
  { key: "bot_mount_sources", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botMountSources"), json: false },
  { key: "bot_container_github_env_allowlist", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botGithubEnvAllowlist"), json: false },
  { key: "bot_hindsight_allowed_banks", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botHindsightBanks"), json: false },
  { key: "bot_mcp_servers", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botMcpServers"), json: true },
  { key: "browser_fleet", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.browserFleet"), json: true },
];
const numbers = () => [
  { key: "bot_reconcile_interval_sec", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botReconcileIntervalSec") },
  { key: "browser_idle_timeout_min", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.browserIdleTimeoutMin") },
  { key: "browser_max_duration_min", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.browserMaxDurationMin") },
  { key: "stack_check_interval_sec", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.stackCheckIntervalSec") },
];
const flags = () => [
  { key: "bot_containers", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botContainers") },
  { key: "bot_yolo", label: i18n.t("area.settings-guardrails.fleet-guardrails-settings-panel.botYolo") },
];

export function FleetGuardrailsSettingsPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({ queryKey: behaviorSettingsQueryKey, queryFn: behaviorSettingsApi.get });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: Record<string, BehaviorSettingValue>) => behaviorSettingsApi.update(patch),
    onSuccess: async () => { setDraft({}); setError(null); await client.invalidateQueries({ queryKey: behaviorSettingsQueryKey }); },
  });
  const title = <h2 className="text-sm font-semibold">{t("area.settings-guardrails.fleet-guardrails-settings-panel.title")}</h2>;
  if (query.isLoading) return <section>{title}<p>{t("area.settings-guardrails.fleet-guardrails-settings-panel.loading")}</p></section>;
  if (query.error || !query.data) return <section>{title}<p role="alert">{t("area.settings-guardrails.fleet-guardrails-settings-panel.loadFailed")}</p></section>;
  const { settings, sources } = query.data;
  const sourceText = (key: string) => t("area.settings-guardrails.fleet-guardrails-settings-panel.source", { source: sourceLabel(sources[key], {
    env: t("area.settings-guardrails.fleet-guardrails-settings-panel.sourceEnv"), ui: t("area.settings-guardrails.fleet-guardrails-settings-panel.sourceUi"), default: t("area.settings-guardrails.fleet-guardrails-settings-panel.sourceDefault"),
  }) });
  const setField = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  return <section className="space-y-4" data-testid="fleet-guardrails-settings">
    <div>{title}<p className="text-sm text-muted-foreground">{t("area.settings-guardrails.fleet-guardrails-settings-panel.description")}</p></div>
    <div className="grid gap-4 md:grid-cols-2">
      {lists().map(({ key, label, json }) => {
        const value = settings[key];
        const initial = Array.isArray(value) ? (json ? JSON.stringify(value, null, 2) : value.join(", ")) : "";
        return <div key={key} className="space-y-1.5 md:col-span-2"><Label htmlFor={`fleet-${key}`}>{label}</Label>
          <textarea id={`fleet-${key}`} className="min-h-20 w-full rounded-md border border-input bg-background p-2 font-mono text-sm" value={draft[key] ?? initial} onChange={(e) => setField(key, e.target.value)} />
          <p className="text-xs text-muted-foreground">{json ? t("area.settings-guardrails.fleet-guardrails-settings-panel.jsonHint") : t("area.settings-guardrails.fleet-guardrails-settings-panel.commaHint")} {sourceText(key)}</p>
        </div>;
      })}
      {numbers().map(({ key, label }) => <div key={key} className="space-y-1.5"><Label htmlFor={`fleet-${key}`}>{label}</Label><Input id={`fleet-${key}`} type="number" min="0" step="1" value={draft[key] ?? String(settings[key] ?? 0)} onChange={(e) => setField(key, e.target.value)} /><p className="text-xs text-muted-foreground">{sourceText(key)}</p></div>)}
      {flags().map(({ key, label }) => <div key={key} className="space-y-1.5"><Label htmlFor={`fleet-${key}`}>{label}</Label><select id={`fleet-${key}`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft[key] ?? String(Boolean(settings[key]))} onChange={(e) => setField(key, e.target.value)}><option value="false">{t("area.settings-guardrails.fleet-guardrails-settings-panel.off")}</option><option value="true">{t("area.settings-guardrails.fleet-guardrails-settings-panel.on")}</option></select><p className="text-xs text-muted-foreground">{sourceText(key)}</p></div>)}
    </div>
    <Button disabled={mutation.isPending || !Object.keys(draft).length} onClick={() => {
      const risky = Object.keys(draft).some((key) => lists().some((item) => item.key === key && !item.json) || key === "bot_yolo");
      if (risky && !window.confirm(t("area.settings-guardrails.fleet-guardrails-settings-panel.confirm"))) return;
      const patch: Record<string, BehaviorSettingValue> = {};
      for (const { key, json } of lists()) if (key in draft) {
        try { patch[key] = json ? JSON.parse(draft[key]) : draft[key].split(",").map((v) => v.trim()).filter(Boolean); }
        catch { setError(t("area.settings-guardrails.fleet-guardrails-settings-panel.invalidJson")); return; }
      }
      for (const { key } of numbers()) if (key in draft) patch[key] = Number(draft[key]);
      for (const { key } of flags()) if (key in draft) patch[key] = draft[key] === "true";
      mutation.mutate(patch);
    }}>{mutation.isPending ? t("area.settings-guardrails.fleet-guardrails-settings-panel.saving") : t("area.settings-guardrails.fleet-guardrails-settings-panel.save")}</Button>
    {(error || mutation.error) && <p role="alert" className="text-sm text-destructive">{error ?? (mutation.error instanceof Error ? mutation.error.message : t("area.settings-guardrails.fleet-guardrails-settings-panel.saveFailed"))}</p>}
  </section>;
}
