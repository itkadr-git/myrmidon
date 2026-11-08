// myrmidon(REVIEW-ROUTING): wire tier of the "Review routing" screen. Owns the
// react-query state (settings GET and PUT) and the error surface; the layout
// lives in ReviewRoutingScreen.tsx.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ApiError } from "@/api/client";
import { ReviewRoutingScreenView } from "./ReviewRoutingScreen";
import { reviewRoutingApi, reviewRoutingSettingsQueryKey } from "./reviewRoutingApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function ReviewRoutingScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("reviewRouting.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const settingsQuery = useQuery({
    queryKey: reviewRoutingSettingsQueryKey(companyId),
    queryFn: () => reviewRoutingApi.getSettings(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const save = useMutation({
    mutationFn: (settings: Parameters<typeof reviewRoutingApi.putSettings>[1]) =>
      reviewRoutingApi.putSettings(companyId, settings),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: reviewRoutingSettingsQueryKey(companyId) });
    },
    onError: (err) => setError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-review-routing-no-company">
        {t("reviewRouting.noCompany")}
      </p>
    );
  }

  if (settingsQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-review-routing-error">
        {readable(settingsQuery.error)}
      </p>
    );
  }

  return (
    <ReviewRoutingScreenView
      settings={settingsQuery.data}
      onSave={(next) => save.mutate(next)}
      pending={save.isPending}
      error={error}
    />
  );
}
