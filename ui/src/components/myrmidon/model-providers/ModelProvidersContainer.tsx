// myrmidon(1.6.1 MODEL-PROVIDERS C): wire tier of the "Model providers"
// settings screen. Owns the react-query state: the GET view (providers +
// change log), the per-provider model list, and the add / rotate / remove /
// enable-models mutations. The layout lives in ModelProvidersScreen.tsx.
// Split mirrors the AUTONOMY-MATRIX B pattern so tests can drive the wire
// tier against a mocked API client.
//
// Key hygiene: the add and rotate forms hold the raw key in local state only
// for as long as the form is open; after a successful save the form state is
// cleared and only the API's key-free view ({ hasKey }) is rendered. The key
// is never written to any cache, DOM node or log line on this side.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { ShieldAlert } from "lucide-react";
import {
  modelProviderChannelsQueryKey,
  modelProviderModelsQueryKey,
  modelProvidersApi,
  modelProvidersQueryKey,
  type AddModelProviderInput,
  type ModelProviderModelView,
  type ModelProvidersView,
} from "./modelProvidersApi";
import { ModelProvidersScreenView } from "./ModelProvidersScreen";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function ModelProvidersScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";

  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });

  const boardAccessData = boardAccess.data;
  const membership = boardAccessData?.memberships?.find((m) => m.companyId === companyId);
  const isAdmin =
    Boolean(boardAccessData?.isInstanceAdmin) ||
    boardAccessData?.source === "local_implicit" ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin";

  useEffect(() => {
    setBreadcrumbs([{ label: t("modelProviders.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const queryKey = modelProvidersQueryKey(companyId);

  const viewQuery = useQuery({
    queryKey,
    queryFn: () => modelProvidersApi.view(companyId),
    enabled: companyId.length > 0 && Boolean(isAdmin),
  });
  const view: ModelProvidersView | undefined = viewQuery.data;

  const [mutationError, setMutationError] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const addMutation = useMutation({
    mutationFn: (input: AddModelProviderInput) => modelProvidersApi.add(companyId, input),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  const rotateMutation = useMutation({
    mutationFn: (input: { providerId: string; key: string }) =>
      modelProvidersApi.rotate(companyId, input.providerId, { key: input.key }),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  const removeMutation = useMutation({
    mutationFn: (providerId: string) => modelProvidersApi.remove(companyId, providerId),
    onMutate: () => setMutationError(null),
    onSuccess: () => {
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  const updateModelsMutation = useMutation({
    mutationFn: (input: {
      providerId: string;
      models: Array<{ modelName: string; litellmModelName: string; enabled: boolean; free: boolean }>;
    }) => modelProvidersApi.updateModels(companyId, input.providerId, { models: input.models }),
    onMutate: () => setMutationError(null),
    onSuccess: (result, input) => {
      queryClient.setQueryData(
        modelProviderModelsQueryKey(companyId, input.providerId),
        { providerId: input.providerId, models: result.models },
      );
      void invalidate();
    },
    onError: (err) => setMutationError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-no-company">
        {t("modelProviders.noCompany")}
      </p>
    );
  }

  if (boardAccess.isLoading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-loading">
        {t("modelProviders.loading")}
      </p>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-xl py-10" data-testid="myrmidon-model-providers-denied">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t("modelProviders.adminOnlyTitle", { defaultValue: "Admin access required" })}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("modelProviders.adminOnlyBody", {
              defaultValue: "Only company owners and administrators can view or manage model providers.",
            })}
          </p>
        </div>
      </div>
    );
  }

  if (viewQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-model-providers-error">
        {readable(viewQuery.error)}
      </p>
    );
  }

  if (viewQuery.isPending || !view) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-model-providers-loading">
        {t("modelProviders.loading")}
      </p>
    );
  }

  return (
    <ModelProvidersScreenView
      view={view}
      companyId={companyId}
      modelsQuery={(providerId: string) => modelProviderModelsQueryKey(companyId, providerId)}
      channelsQuery={(providerId: string) => modelProviderChannelsQueryKey(companyId, providerId)}
      onAdd={(input) => addMutation.mutate(input)}
      adding={addMutation.isPending}
      addError={addMutation.isError ? readable(addMutation.error) : null}
      onRotate={(providerId, key) => rotateMutation.mutate({ providerId, key })}
      rotating={rotateMutation.isPending}
      onRemove={(providerId) => removeMutation.mutate(providerId)}
      removing={removeMutation.isPending}
      onToggleModel={(providerId, models) => updateModelsMutation.mutate({ providerId, models })}
      savingModels={updateModelsMutation.isPending}
      error={mutationError}
    />
  );
}
