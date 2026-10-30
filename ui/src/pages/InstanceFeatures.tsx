// Instance -> Features (myrmidon FEATURES): the page around FeaturesView.
// Polls the report every 30 seconds; Refresh asks the server for a fresh pass.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { featuresApi, featuresQueryKey } from "@/components/myrmidon/featuresApi";
import { FeaturesView } from "@/components/myrmidon/FeaturesView";
import { useTranslation } from "@/i18n";

const POLL_MS = 30_000;

export function InstanceFeatures() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [toggleError, setToggleError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: t("features.title") }]);
  }, [setBreadcrumbs, t]);

  const query = useQuery({
    queryKey: featuresQueryKey,
    queryFn: () => featuresApi.get(),
    refetchInterval: POLL_MS,
  });

  const refresh = useMutation({
    mutationFn: () => featuresApi.get(true),
    onSuccess: (report) => queryClient.setQueryData(featuresQueryKey, report),
  });

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => featuresApi.setEnabled(key, enabled),
    onMutate: () => setToggleError(null),
    onError: (err) => setToggleError(err instanceof Error ? err.message : t("features.toggleFailed")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: featuresQueryKey }),
  });

  return (
    <FeaturesView
      report={query.data}
      loading={query.isLoading}
      error={query.error ? (query.error instanceof Error ? query.error.message : t("features.loadFailed")) : null}
      toggleError={toggleError}
      togglingKey={toggle.isPending ? (toggle.variables?.key ?? null) : null}
      refreshing={refresh.isPending}
      onToggle={(key, enabled) => toggle.mutate({ key, enabled })}
      onRefresh={() => refresh.mutate()}
    />
  );
}
