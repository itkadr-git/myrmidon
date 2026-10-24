// myrmidon(1.7 BUDGET-CONFIG D): wire tier of the "Budgets" screen. Owns the
// react-query state — the limits list, the usage rows, the change journal, the
// "signal only" flag and the projects that fill the nest level — plus the error
// surface. The layout lives in BudgetLimitsScreen.tsx.
//
// Every mutation invalidates what it changes, so a saved limit shows its new
// amount, its spend and its journal row without a page reload: the screen edits
// the running API, no server restart (OPE-4164 acceptance).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { projectsApi } from "@/api/projects";
import { ApiError } from "@/api/client";
import { BudgetLimitsScreenView } from "./BudgetLimitsScreen";
import {
  budgetLimitsApi,
  budgetLimitsJournalQueryKey,
  budgetLimitsQueryKey,
  budgetLimitsSignalOnlyQueryKey,
  budgetLimitsUsageQueryKey,
  type BudgetLimitLevel,
  type BudgetLimitUpsertBody,
  type BudgetLimitsSignalOnlyView,
} from "./budgetLimitsApi";
import type { BudgetLimitProjectRef } from "./budgetLimitsConfig";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function BudgetLimitsScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("budgetLimits.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const limitsQuery = useQuery({
    queryKey: budgetLimitsQueryKey(companyId),
    queryFn: () => budgetLimitsApi.list(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const usageQuery = useQuery({
    queryKey: budgetLimitsUsageQueryKey(companyId),
    queryFn: () => budgetLimitsApi.usage(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const journalQuery = useQuery({
    queryKey: budgetLimitsJournalQueryKey(companyId),
    queryFn: () => budgetLimitsApi.journal(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const signalOnlyQuery = useQuery({
    queryKey: budgetLimitsSignalOnlyQueryKey(companyId),
    queryFn: () => budgetLimitsApi.getSignalOnly(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const projectsQuery = useQuery({
    queryKey: ["projects", companyId],
    queryFn: () => projectsApi.list(companyId),
    enabled: companyId.length > 0,
    select: (projects): BudgetLimitProjectRef[] =>
      projects
        .map((project) => ({ id: project.id, name: project.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
  });

  const invalidateLimits = async () => {
    await queryClient.invalidateQueries({ queryKey: budgetLimitsQueryKey(companyId) });
    await queryClient.invalidateQueries({ queryKey: budgetLimitsUsageQueryKey(companyId) });
    await queryClient.invalidateQueries({ queryKey: budgetLimitsJournalQueryKey(companyId) });
  };

  const saveLimit = useMutation({
    mutationFn: ({ level, ref, body }: { level: BudgetLimitLevel; ref: string; body: BudgetLimitUpsertBody }) =>
      budgetLimitsApi.saveLimit(companyId, level, ref, body),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setError(null);
      await invalidateLimits();
    },
    onError: (err) => setError(readable(err)),
  });

  const removeLimit = useMutation({
    mutationFn: ({ level, ref }: { level: BudgetLimitLevel; ref: string }) =>
      budgetLimitsApi.removeLimit(companyId, level, ref),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setError(null);
      await invalidateLimits();
    },
    onError: (err) => setError(readable(err)),
  });

  const saveSignalOnly = useMutation({
    mutationFn: (signalOnly: boolean) => budgetLimitsApi.patchSignalOnly(companyId, signalOnly),
    onMutate: () => setError(null),
    onSuccess: (view: BudgetLimitsSignalOnlyView) => {
      setError(null);
      queryClient.setQueryData(budgetLimitsSignalOnlyQueryKey(companyId), view);
    },
    onError: (err) => setError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-budget-limits-no-company">
        {t("budgetLimits.noCompany")}
      </p>
    );
  }

  if (limitsQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-budget-limits-error">
        {readable(limitsQuery.error)}
      </p>
    );
  }

  return (
    <BudgetLimitsScreenView
      limits={limitsQuery.data}
      usage={usageQuery.data}
      journal={journalQuery.data}
      signalOnly={signalOnlyQuery.data}
      projects={projectsQuery.data ?? []}
      onSaveLimit={(level, ref, body) => saveLimit.mutate({ level, ref, body })}
      onDeleteLimit={(level, ref) => removeLimit.mutate({ level, ref })}
      onToggleSignalOnly={(signalOnly) => saveSignalOnly.mutate(signalOnly)}
      pending={saveLimit.isPending || removeLimit.isPending || saveSignalOnly.isPending}
      error={error}
    />
  );
}