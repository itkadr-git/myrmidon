// Budget enforcement mode (myrmidon 1.7 BUDGET-CONFIG-B): what a crossed spend
// limit does while its incident is open. Saving applies at the next budget
// evaluation — no restart, no run in flight is dropped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import { i18n, useTranslation } from "@/i18n";
import type { BudgetEnforcementMode, BudgetEnforcementPatch } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  describeBudgetEnforcementSource,
  budgetEnforcementApi,
  budgetEnforcementQueryKey,
  type BudgetEnforcementView,
} from "./budgetEnforcementApi";

const modes = (): Array<{
  value: BudgetEnforcementMode;
  title: string;
  description: string;
}> => [
  {
    value: "signal_only",
    title: i18n.t("area.costs-budgets-2.budget-enforcement-settings-panel.modes.signalOnly.title"),
    description: i18n.t("area.costs-budgets-2.budget-enforcement-settings-panel.modes.signalOnly.description"),
  },
  {
    value: "soft",
    title: i18n.t("area.costs-budgets-2.budget-enforcement-settings-panel.modes.soft.title"),
    description: i18n.t("area.costs-budgets-2.budget-enforcement-settings-panel.modes.soft.description"),
  },
  {
    value: "hard",
    title: i18n.t("area.costs-budgets-2.budget-enforcement-settings-panel.modes.hard.title"),
    description: i18n.t("area.costs-budgets-2.budget-enforcement-settings-panel.modes.hard.description"),
  },
];

export function BudgetEnforcementSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: BudgetEnforcementView | null | undefined;
  onSave: (patch: BudgetEnforcementPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<BudgetEnforcementMode | null>(null);
  const current = draft ?? view?.mode ?? null;
  const dirty = draft !== null && view != null && draft !== view.mode;

  return (
    <section className="space-y-4" data-testid="myrmidon-budget-enforcement">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.costs-budgets-2.budget-enforcement-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.costs-budgets-2.budget-enforcement-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel={t("area.costs-budgets-2.budget-enforcement-settings-panel.modeAriaLabel")}
            value={current ?? "signal_only"}
            onValueChange={(value) => setDraft(value as BudgetEnforcementMode)}
            options={modes().map(({ value, title, description }) => ({
              value,
              title,
              description,
              accessibleLabel: t("area.costs-budgets-2.budget-enforcement-settings-panel.modeAccessibleLabel", { title }),
            }))}
          />
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              disabled={pending || !dirty}
              onClick={() => {
                if (draft) onSave({ mode: draft });
              }}
            >
              {pending ? t("area.costs-budgets-2.budget-enforcement-settings-panel.saving") : t("area.costs-budgets-2.budget-enforcement-settings-panel.saveButton")}
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="budget-enforcement-source">
              {describeBudgetEnforcementSource(view.source)}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.costs-budgets-2.budget-enforcement-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function BudgetEnforcementSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: budgetEnforcementQueryKey,
    queryFn: () => budgetEnforcementApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: budgetEnforcementApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : t("area.costs-budgets-2.budget-enforcement-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: budgetEnforcementQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("area.costs-budgets-2.budget-enforcement-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <BudgetEnforcementSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
