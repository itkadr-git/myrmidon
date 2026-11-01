import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { behaviorSettingsApi, behaviorSettingsQueryKey, sourceLabel, type BehaviorSettingValue } from "@/components/myrmidon/behaviorSettingsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";

/** Labels are resolved at call time, not at import, so a language switch applies. */
const fields = () => [
  { key: "bot_egress_mode", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.egressMode"), kind: "select" as const },
  { key: "tool_breaker_failures", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.toolBreakerFailures"), kind: "number" as const },
  { key: "tool_breaker_cooldown_ms", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.toolBreakerCooldownMs"), kind: "number" as const },
  { key: "tool_breaker_window_ms", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.toolBreakerWindowMs"), kind: "number" as const },
  { key: "tool_timeout_max_ms", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.toolTimeoutMaxMs"), kind: "number" as const },
  { key: "tool_timeout_slow_ms", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.toolTimeoutSlowMs"), kind: "number" as const },
];

const listFields = () => [
  { key: "run_env_allow", label: i18n.t("area.settings-guardrails.guardrails-settings-panel.runEnvAllow") },
];

const EGRESS_OPTIONS = ["off", "log"] as const;

export function GuardrailsSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: behaviorSettingsQueryKey, queryFn: behaviorSettingsApi.get });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (patch: Record<string, BehaviorSettingValue>) => behaviorSettingsApi.update(patch),
    onSuccess: async () => { setDrafts({}); await queryClient.invalidateQueries({ queryKey: behaviorSettingsQueryKey }); },
  });
  const title = <h2 className="text-sm font-semibold">{t("area.settings-guardrails.guardrails-settings-panel.title")}</h2>;
  if (query.isLoading) return <section className="space-y-3">{title}<p className="text-sm text-muted-foreground">{t("area.settings-guardrails.guardrails-settings-panel.loading")}</p></section>;
  if (query.error || !query.data) return <section className="space-y-3">{title}<p role="alert" className="text-sm text-destructive">{t("area.settings-guardrails.guardrails-settings-panel.loadFailed")}</p></section>;

  const { settings, sources } = query.data;
  const sourceText = (key: string) => t("area.settings-guardrails.guardrails-settings-panel.source", { source: sourceLabel(sources[key], {
    env: t("area.settings-guardrails.guardrails-settings-panel.sourceEnv"), ui: t("area.settings-guardrails.guardrails-settings-panel.sourceUi"), default: t("area.settings-guardrails.guardrails-settings-panel.sourceDefault"),
  }) });
  return <section className="space-y-4">
    <div>{title}<p className="text-sm text-muted-foreground">{t("area.settings-guardrails.guardrails-settings-panel.description")}</p></div>
    <div className="grid gap-4 md:grid-cols-2">
      {fields().map((field) => {
        const value = String(settings[field.key] ?? "");
        const onChange = (next: string) => setDrafts((current) => ({ ...current, [field.key]: next }));
        return <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`guardrail-${field.key}`}>{field.label}</Label>
          {field.kind === "select"
            ? <select id={`guardrail-${field.key}`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={drafts[field.key] ?? value} onChange={(event) => onChange(event.target.value)}>
              {EGRESS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            : <Input id={`guardrail-${field.key}`} type="number" min="0" step="1" value={drafts[field.key] ?? value} onChange={(event) => onChange(event.target.value)} />}
          <p className="text-xs text-muted-foreground">{sourceText(field.key)}</p>
        </div>;
      })}
      {listFields().map((field) => {
        const value = settings[field.key];
        const current = drafts[field.key] ?? (Array.isArray(value) ? value.join(", ") : String(value ?? ""));
        return <div key={field.key} className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`guardrail-${field.key}`}>{field.label}</Label>
          <Input id={`guardrail-${field.key}`} value={current} onChange={(event) => setDrafts((state) => ({ ...state, [field.key]: event.target.value }))} />
          <p className="text-xs text-muted-foreground">{t("area.settings-guardrails.guardrails-settings-panel.commaHint")} {sourceText(field.key)}</p>
        </div>;
      })}
    </div>
    <Button disabled={mutation.isPending || Object.keys(drafts).length === 0} onClick={() => {
      const patch: Record<string, BehaviorSettingValue> = {};
      for (const field of fields()) {
        if (!(field.key in drafts)) continue;
        patch[field.key] = field.kind === "number" ? Number(drafts[field.key]) : drafts[field.key];
      }
      for (const field of listFields()) {
        if (field.key in drafts) patch[field.key] = drafts[field.key].split(",").map((item) => item.trim()).filter(Boolean);
      }
      mutation.mutate(patch);
    }}>{mutation.isPending ? t("area.settings-guardrails.guardrails-settings-panel.saving") : t("area.settings-guardrails.guardrails-settings-panel.save")}</Button>
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : t("area.settings-guardrails.guardrails-settings-panel.saveFailed")}</p>}
  </section>;
}
