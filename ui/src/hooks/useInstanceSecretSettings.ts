// myrmidon(SETTINGS-UI E2.1): one data hook for the secret-ref settings of the instance, used
// by the current UI panel and by the UI2 section so both go through the same API path.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instanceSecretSettingsApi, instanceSecretSettingsQueryKey } from "@/api/instanceSecretSettings";
import { secretsApi } from "@/api/secrets";

export function useInstanceSecretSettings(companyId: string | null) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: instanceSecretSettingsQueryKey,
    queryFn: instanceSecretSettingsApi.list,
    retry: false,
  });
  const secrets = useQuery({
    queryKey: ["instance", "secret-settings", "secrets", companyId],
    queryFn: () => secretsApi.list(companyId as string),
    enabled: Boolean(companyId) && (settings.data?.settings.length ?? 0) > 0,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: instanceSecretSettingsQueryKey });
  const setRef = useMutation({
    mutationFn: (input: { name: string; secretId: string }) =>
      instanceSecretSettingsApi.setRef(input.name, input.secretId),
    onSuccess: refresh,
  });
  const clearRef = useMutation({
    mutationFn: (name: string) => instanceSecretSettingsApi.clearRef(name),
    onSuccess: refresh,
  });
  const plan = useMutation({ mutationFn: instanceSecretSettingsApi.migrationPlan });
  return {
    settings: settings.data?.settings ?? [],
    settingsLoading: settings.isLoading,
    settingsError: settings.isError,
    secrets: (secrets.data ?? []).filter((secret) => secret.status === "active"),
    setRef,
    clearRef,
    plan,
  };
}
