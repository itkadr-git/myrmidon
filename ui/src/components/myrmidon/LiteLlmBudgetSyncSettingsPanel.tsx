// myrmidon(SETTINGS-UI-REMAINDER): company-scoped LiteLLM projection switches, distinct from budget enforcement.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { BudgetProjectionSettings } from "@myrmidon/shared";

type View = BudgetProjectionSettings & {
  storedSweepIntervalSec: number | null;
  sweepIntervalSource: "settings" | "env" | "default";
  sweepIntervalEnvName: string;
};

const path = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/litellm-budget-sync/settings`;

export function LiteLlmBudgetSyncSettingsPanelView({ view, onSave, pending, error }: {
  view: View;
  onSave: (settings: BudgetProjectionSettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Partial<BudgetProjectionSettings>>({});
  const [interval, setInterval] = useState<string | null>(null);
  const enabled = draft.enabled ?? view.enabled;
  const signalOnly = draft.signalOnly ?? view.signalOnly;
  const intervalValue = interval ?? String(view.storedSweepIntervalSec ?? "");
  const parsedInterval = intervalValue.trim() === "" ? null : Number(intervalValue);
  const valid = parsedInterval === null || (Number.isInteger(parsedInterval) && parsedInterval >= 10 && parsedInterval <= 3600);
  const changed = enabled !== view.enabled || signalOnly !== view.signalOnly || parsedInterval !== view.storedSweepIntervalSec;

  return <section className="space-y-3 rounded-lg border p-4" data-testid="litellm-budget-sync-settings">
    <h2 className="text-sm font-semibold">{t("liteLlmBudgetSync.title")}</h2>
    <p className="text-xs text-muted-foreground">{t("liteLlmBudgetSync.description")}</p>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    <div className="flex items-center gap-3"><ToggleSwitch checked={enabled} onCheckedChange={(value) => setDraft({ ...draft, enabled: value })} aria-label={t("liteLlmBudgetSync.enabled")} data-testid="litellm-sync-enabled" /><Label>{t("liteLlmBudgetSync.enabled")}</Label></div>
    <div className="flex items-center gap-3"><ToggleSwitch checked={signalOnly} onCheckedChange={(value) => setDraft({ ...draft, signalOnly: value })} aria-label={t("liteLlmBudgetSync.signalOnly")} data-testid="litellm-sync-signal-only" /><Label>{t("liteLlmBudgetSync.signalOnly")}</Label></div>
    <div className="space-y-1"><Label htmlFor="litellm-sync-interval">{t("liteLlmBudgetSync.interval")}</Label>
      <Input id="litellm-sync-interval" type="number" min={10} max={3600} step={1} value={intervalValue} onChange={(event) => setInterval(event.target.value)} disabled={view.sweepIntervalSource === "env"} />
      <p className="text-xs text-muted-foreground">{view.sweepIntervalSource === "env" ? t("liteLlmBudgetSync.envOverride", { name: view.sweepIntervalEnvName, value: view.sweepIntervalSec }) : t("liteLlmBudgetSync.source", { source: view.sweepIntervalSource, value: view.sweepIntervalSec })}</p>
    </div>
    <Button size="sm" disabled={pending || !changed || !valid} onClick={() => onSave({ enabled, signalOnly, limits: view.limits, sweepIntervalSec: parsedInterval })}>{t("liteLlmBudgetSync.save")}</Button>
  </section>;
}

export function LiteLlmBudgetSyncSettingsPanel() {
  const { selectedCompanyId } = useCompany();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const companyId = selectedCompanyId ?? "";
  const key = ["myrmidon", "litellm-budget-sync", companyId];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<View>(path(companyId)), enabled: !!companyId, retry: false });
  const save = useMutation({
    mutationFn: (settings: BudgetProjectionSettings) => api.put<View>(path(companyId), settings),
    onSuccess: async () => { setError(null); await queryClient.invalidateQueries({ queryKey: key }); },
    onError: (err) => setError(err instanceof Error ? err.message : t("liteLlmBudgetSync.saveFailed")),
  });
  if (!companyId) return null;
  if (query.isError) return <p className="text-sm text-destructive">{String(query.error)}</p>;
  return query.data ? <LiteLlmBudgetSyncSettingsPanelView key={JSON.stringify(query.data)} view={query.data} onSave={(settings) => save.mutate(settings)} pending={save.isPending} error={error} /> : null;
}
