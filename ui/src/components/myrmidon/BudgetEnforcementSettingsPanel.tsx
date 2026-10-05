// Budget enforcement mode (myrmidon 1.7 BUDGET-CONFIG-B): what a crossed spend
// limit does while its incident is open. Saving applies at the next budget
// evaluation — no restart, no run in flight is dropped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone } from "lucide-react";
import type { BudgetEnforcementMode, BudgetEnforcementPatch } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  describeBudgetEnforcementSource,
  budgetEnforcementApi,
  budgetEnforcementQueryKey,
  type BudgetEnforcementView,
} from "./budgetEnforcementApi";

const MODES: Array<{
  value: BudgetEnforcementMode;
  title: string;
  description: string;
}> = [
  {
    value: "signal_only",
    title: "Signal only",
    description:
      "A crossed limit opens an incident and signals the owner (issue thread and the decision inbox), but work continues. The default until the owner switches it off.",
  },
  {
    value: "soft",
    title: "Soft: pause and ask",
    description:
      "The scope is paused and the owner gets a card: raise the budget by the amount needed or keep the work stopped. Raising lifts the pause and held work resumes.",
  },
  {
    value: "hard",
    title: "Hard: refuse",
    description:
      "New runs of the over-limit scope are refused with the budget reason before they start. Work already in flight finishes.",
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
  const [draft, setDraft] = useState<BudgetEnforcementMode | null>(null);
  const current = draft ?? view?.mode ?? null;
  const dirty = draft !== null && view != null && draft !== view.mode;

  return (
    <section className="space-y-4" data-testid="myrmidon-budget-enforcement">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Megaphone className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Budget enforcement</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          What a crossed spend budget limit does while its incident is open: only signal, pause the scope with an
          owner card, or refuse new runs. Saving takes effect at the next budget evaluation — no server restart.
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
            ariaLabel="Budget enforcement mode"
            value={current ?? "signal_only"}
            onValueChange={(value) => setDraft(value as BudgetEnforcementMode)}
            options={MODES.map(({ value, title, description }) => ({
              value,
              title,
              description,
              accessibleLabel: `Budget enforcement mode: ${title}`,
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
              {pending ? "Saving..." : "Save enforcement mode"}
            </Button>
            <span className="text-xs text-muted-foreground" data-testid="budget-enforcement-source">
              {describeBudgetEnforcementSource(view.source)}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the budget enforcement mode...</p>
      )}
    </section>
  );
}

export function BudgetEnforcementSettingsPanel() {
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
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the budget enforcement mode failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: budgetEnforcementQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the budget enforcement mode."}
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
