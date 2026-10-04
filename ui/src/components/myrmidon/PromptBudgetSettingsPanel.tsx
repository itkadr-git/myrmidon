// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget settings panel — warn and
// crit thresholds (percent of an agent's model window), the on/off switch and
// the fallback window, editable while the server runs. Saving applies at once:
// the sweep and the status route re-read the row on every pass, no restart.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
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
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
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
    onError: () => setError("Could not save the thresholds. Try again."),
  });

  const submit = () => {
    if (!stored) return;
    const warn = parsePromptPct(warnDraft);
    if (!warn.ok) {
      setError(`Warn threshold: ${warn.message}`);
      return;
    }
    const crit = parsePromptPct(critDraft);
    if (!crit.ok) {
      setError(`Crit threshold: ${crit.message}`);
      return;
    }
    if (crit.value <= warn.value) {
      setError("The crit threshold must be greater than the warn threshold.");
      return;
    }
    const fallback = parseFallbackWindow(fallbackDraft);
    if (!fallback.ok) {
      setError(`Fallback window: ${fallback.message}`);
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
        <h3 className="text-sm font-medium">Prompt budget</h3>
        {stored && !stored.enabled && (
          <span
            className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            data-testid="prompt-budget-disabled"
          >
            Off
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
        <Label htmlFor="prompt-budget-enabled">Signal when a run's prompt crosses a threshold</Label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="prompt-budget-warn">Warn at, % of the model window</Label>
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
        <Label htmlFor="prompt-budget-crit">Crit at, % of the model window</Label>
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
          Fallback window, tokens (used when the model's window is unknown)
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
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {save.isSuccess && !error && <p className="text-xs text-green-600">Saved</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        The signal appears in the attention queue and on the agent card when the last
        run's prompt crosses a level. Applies immediately; the sweep re-reads the
        thresholds on every pass.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
