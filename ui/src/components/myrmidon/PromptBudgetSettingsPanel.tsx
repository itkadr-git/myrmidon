// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget settings panel — warn and
// crit thresholds (percent of an agent's model window), the on/off switch and
// the fallback window, editable while the server runs. Saving applies at once:
// the sweep and the status route re-read the row on every pass, no restart.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOptionalCompany } from "@/context/CompanyContext";
import {
  promptBudgetApi,
  promptBudgetSettingsQueryKey,
  type PromptBudgetSettings,
} from "./prompt-budget/promptBudgetApi";
import {
  numberToText,
  parseFallbackWindow,
  parsePromptPct,
} from "./prompt-budget/promptBudgetConfig";

export function PromptBudgetSettingsPanel() {
  const { t } = useTranslation();
  // Non-throwing: the page's vendor test suite renders without a
  // CompanyProvider; outside a company context the panel has nothing to edit.
  const company = useOptionalCompany();
  const companyId = company?.selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const { data: stored } = useQuery({
    queryKey: promptBudgetSettingsQueryKey(companyId),
    queryFn: () => promptBudgetApi.getSettings(companyId),
    enabled: companyId.length > 0,
  });
  const [warnDraft, setWarnDraft] = useState<string>("");
  const [critDraft, setCritDraft] = useState<string>("");
  const [fallbackDraft, setFallbackDraft] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean>(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (stored && !loaded) {
      setWarnDraft(numberToText(stored.warnPct));
      setCritDraft(numberToText(stored.critPct));
      setFallbackDraft(numberToText(stored.fallbackWindowTokens));
      setEnabled(stored.enabled);
      setLoaded(true);
    }
  }, [stored, loaded]);

  const save = useMutation({
    mutationFn: (next: PromptBudgetSettings) => promptBudgetApi.putSettings(companyId, next),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: promptBudgetSettingsQueryKey(companyId) });
    },
    onError: () => setError(t("area.costs-budgets-2.prompt-budget-settings-panel.saveFailed")),
  });

  const submit = () => {
    if (!stored) return;
    const warn = parsePromptPct(warnDraft);
    if (!warn.ok) {
      setError(t("area.costs-budgets-2.prompt-budget-settings-panel.warnInvalid", { message: warn.message }));
      return;
    }
    const crit = parsePromptPct(critDraft);
    if (!crit.ok) {
      setError(t("area.costs-budgets-2.prompt-budget-settings-panel.critInvalid", { message: crit.message }));
      return;
    }
    if (crit.value <= warn.value) {
      setError(t("area.costs-budgets-2.prompt-budget-settings-panel.critNotGreater"));
      return;
    }
    const fallback = parseFallbackWindow(fallbackDraft);
    if (!fallback.ok) {
      setError(t("area.costs-budgets-2.prompt-budget-settings-panel.fallbackInvalid", { message: fallback.message }));
      return;
    }
    save.mutate({
      warnPct: warn.value,
      critPct: crit.value,
      enabled,
      fallbackWindowTokens: fallback.value,
      optimizerAgentId: stored.optimizerAgentId,
    });
  };

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="prompt-budget-panel">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("area.costs-budgets-2.prompt-budget-settings-panel.title")}</h3>
        {stored && !stored.enabled && (
          <span
            className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            data-testid="prompt-budget-disabled"
          >
            {t("area.costs-budgets-2.prompt-budget-settings-panel.off")}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          id="prompt-budget-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          data-testid="prompt-budget-enabled-input"
        />
        <Label htmlFor="prompt-budget-enabled">{t("area.costs-budgets-2.prompt-budget-settings-panel.enabledLabel")}</Label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="prompt-budget-warn">{t("area.costs-budgets-2.prompt-budget-settings-panel.warnLabel")}</Label>
        <Input
          id="prompt-budget-warn"
          inputMode="numeric"
          className="w-24"
          value={warnDraft}
          onChange={(event) => {
            setWarnDraft(event.target.value);
            setError(null);
          }}
          data-testid="prompt-budget-warn-input"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="prompt-budget-crit">{t("area.costs-budgets-2.prompt-budget-settings-panel.critLabel")}</Label>
        <Input
          id="prompt-budget-crit"
          inputMode="numeric"
          className="w-24"
          value={critDraft}
          onChange={(event) => {
            setCritDraft(event.target.value);
            setError(null);
          }}
          data-testid="prompt-budget-crit-input"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="prompt-budget-fallback">
          {t("area.costs-budgets-2.prompt-budget-settings-panel.fallbackLabel")}
        </Label>
        <Input
          id="prompt-budget-fallback"
          inputMode="numeric"
          className="w-32"
          value={fallbackDraft}
          onChange={(event) => {
            setFallbackDraft(event.target.value);
            setError(null);
          }}
          data-testid="prompt-budget-fallback-input"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={submit}
          disabled={save.isPending || !stored}
          data-testid="prompt-budget-save"
        >
          {save.isPending ? t("area.costs-budgets-2.prompt-budget-settings-panel.saving") : t("common.save")}
        </Button>
        {save.isSuccess && !error && <p className="text-xs text-green-600">{t("area.costs-budgets-2.prompt-budget-settings-panel.saved")}</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("area.costs-budgets-2.prompt-budget-settings-panel.hint")}
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
