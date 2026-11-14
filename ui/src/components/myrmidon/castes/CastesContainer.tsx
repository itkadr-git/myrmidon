// myrmidon(1.6.1 CUSTOM-CASTES C): wire tier of the "Agent castes" settings
// screen. Owns the react-query state: the GET directory (the first read
// seeds the 12 built-in castes server-side) and the add / update / remove
// mutations. The layout lives in CastesScreen.tsx. Split mirrors the
// model-providers pattern so tests can drive the wire tier against a mocked
// API client.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { casteCounts } from "./casteCounts";
import {
  castesApi,
  castesQueryKey,
  casteModelEvalApi,
  type AddCasteInput,
  type CasteModelEvalView,
  type CasteView,
  type UpdateCasteInput,
} from "./castesApi";
import { CastesScreenView } from "./CastesScreen";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/** 409 from the DELETE means live agents still hold this role. */
export function isCasteInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 409
  );
}

export function CastesScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: t("castes.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const queryKey = castesQueryKey(companyId);

  const viewQuery = useQuery({
    queryKey,
    queryFn: () => castesApi.view(companyId),
    enabled: companyId.length > 0,
  });
  const castes: CasteView[] | undefined = viewQuery.data?.castes;

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addMutation = useMutation({
    mutationFn: (input: AddCasteInput) => castesApi.add(companyId, input),
    onSuccess: () => {
      void invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { key: string; patch: UpdateCasteInput }) =>
      castesApi.update(companyId, input.key, input.patch),
    onSuccess: () => {
      void invalidate();
    },
  });

  const removeMutation = useMutation({
    // myrmidon(1.6.1 CUSTOM-CASTES C annex): the DELETE may carry
    // { reassignTo } to move live agents to another caste first; without a
    // target the server 409s and the view tier demands the target.
    // myrmidon(1.6.5 F-26 T3): a caste that holds the company default demands
    // the same target — the flag moves with the agents, in one transaction.
    mutationFn: (input: { key: string; reassignTo: string | null }) =>
      castesApi.remove(companyId, input.key, input.reassignTo),
    onSuccess: () => {
      void invalidate();
    },
  });

  // myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the "agents / queue / free"
  // column. The supervisor overview (F-26 T4) will serve these numbers; until
  // that endpoint is in the tree they come from the two lists the company
  // already caches — the full roster and the unclaimed queue (see casteCounts).
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: companyId.length > 0,
  });
  const queueQuery = useQuery({
    // A key of its own: the main issues screen caches ["issues", companyId, …]
    // with a different queryFn, and two queryFns must never share one key.
    queryKey: [...queryKeys.issues.list(companyId), "myrmidon-castes-queue"],
    queryFn: () => issuesApi.listAll(companyId, { status: "todo" }),
    enabled: companyId.length > 0,
  });

  const defaultMutation = useMutation({
    // PATCH { isDefault: true } moves the flag off the previous holder inside
    // the server's transaction, so the matcher reads the new default on its
    // very next pass — no restart, no cache to drop here.
    mutationFn: (key: string) => castesApi.update(companyId, key, { isDefault: true }),
    onSuccess: () => {
      void invalidate();
    },
  });

  // myrmidon(1.8 CASTE-MODEL-EVAL OPE-12948): the reference-run model
  // comparison. Probed per company (one call per caste — the endpoint serves
  // one caste per call, OPE-12933); companies whose server predates the
  // endpoint 404 here and the section simply stays hidden. The key carries
  // the caste list, so a directory change re-probes.
  const [evalSelectedKey, setEvalSelectedKey] = useState<string | null>(null);
  const casteKeyList = castes?.map((caste) => caste.key).join(",") ?? "";
  const evalQuery = useQuery({
    queryKey: ["myrmidon", "castes", companyId, "model-eval", casteKeyList],
    queryFn: async () => {
      const keys = (castes ?? []).map((caste) => caste.key);
      const outcomes = await Promise.all(
        keys.map(async (key) => {
          try {
            return { key, eval: await casteModelEvalApi.view(companyId, key) };
          } catch {
            return { key, eval: null };
          }
        }),
      );
      const perCaste: Record<string, CasteModelEvalView> = {};
      const withEval: string[] = [];
      for (const outcome of outcomes) {
        if (outcome.eval) {
          withEval.push(outcome.key);
          perCaste[outcome.key] = outcome.eval;
        }
      }
      return { withEval, perCaste };
    },
    enabled: companyId.length > 0 && Boolean(castes),
    staleTime: 60_000,
    retry: false,
  });
  const evalData = evalQuery.data ?? null;

  // Default the selection to the first caste that has a comparison.
  const effectiveEvalKey =
    evalSelectedKey !== null && evalData?.withEval.includes(evalSelectedKey)
      ? evalSelectedKey
      : (evalData?.withEval[0] ?? null);

  // The displayed caste model comes from the PATCH response of the explicit
  // confirmation (criterion: "the interface updates the displayed defaultModel
  // from the API response") — not from a blind local guess. Kept per caste:
  // confirming for one caste must not leak onto another.
  const [evalConfirmed, setEvalConfirmed] = useState<{ key: string; model: string } | null>(null);
  const evalConfirmMutation = useMutation({
    mutationFn: (model: string) =>
      castesApi.update(companyId, effectiveEvalKey ?? "", { defaultModel: model }),
    onSuccess: (data) => {
      setEvalConfirmed({ key: effectiveEvalKey ?? "", model: data.caste.defaultModel ?? "" });
      void invalidate();
    },
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-castes-no-company">
        {t("castes.noCompany")}
      </p>
    );
  }

  if (viewQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-castes-error">
        {readable(viewQuery.error)}
      </p>
    );
  }

  if (viewQuery.isPending || !castes) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-castes-loading">
        {t("castes.loading")}
      </p>
    );
  }

  return (
    <CastesScreenView
      castes={castes}
      onAdd={(input) => addMutation.mutate(input)}
      adding={addMutation.isPending}
      addError={addMutation.isError ? readable(addMutation.error) : null}
      onUpdate={(key, patch) => updateMutation.mutate({ key, patch })}
      updating={updateMutation.isPending}
      onRemove={(key, reassignTo) => removeMutation.mutate({ key, reassignTo })}
      removing={removeMutation.isPending}
      error={
        removeMutation.isError
          ? isCasteInUse(removeMutation.error)
            ? t("castes.remove.inUse")
            : readable(removeMutation.error)
          : updateMutation.isError
            ? readable(updateMutation.error)
            : defaultMutation.isError
              ? readable(defaultMutation.error)
              : evalConfirmMutation.isError
                ? readable(evalConfirmMutation.error)
                : null
      }
      removeNeedsTarget={removeMutation.isError ? isCasteInUse(removeMutation.error) : false}
      onSetDefault={(key) => defaultMutation.mutate(key)}
      defaulting={defaultMutation.isPending}
      counts={casteCounts(castes, agentsQuery.data ?? [], queueQuery.data ?? [])}
      modelEval={{
        castesWithEval: evalData?.withEval ?? [],
        selectedKey: effectiveEvalKey,
        onSelect: setEvalSelectedKey,
        loading: evalQuery.isPending,
        loadError: evalQuery.isError ? readable(evalQuery.error) : null,
        results: effectiveEvalKey ? (evalData?.perCaste[effectiveEvalKey]?.results ?? []) : [],
        suggestedModel: effectiveEvalKey
          ? (evalData?.perCaste[effectiveEvalKey]?.suggestedModel ?? null)
          : null,
        // Criterion 3: after the owner confirms, the displayed default model
        // comes from the PATCH response, not a local guess; the directory's
        // value stays the fallback until the invalidated GET agrees.
        displayModel: (key) =>
          evalConfirmed && evalConfirmed.key === key
            ? (evalConfirmed.model || null)
            : (castes.find((caste) => caste.key === key)?.defaultModel ?? null),
        confirming: evalConfirmMutation.isPending,
        onConfirm: (model) => evalConfirmMutation.mutate(model),
        onDecline: () => undefined,
      }}
    />
  );
}
